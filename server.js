'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('./lib/net');
const Board = require('./lib/board');
const Render = require('./lib/render');

const PORT = process.env.PORT || 8790;
const HOST = process.env.HOST || '0.0.0.0';

// OpenStreetMap's tile policy does not permit proxying their tiles to third
// parties, so any public deployment MUST point this at a provider that does.
// Local development against the OSM default is within fair use.
const TILE_TEMPLATE = process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_KEY = require('crypto').createHash('sha1').update(TILE_TEMPLATE).digest('hex').slice(0, 6);
const TILE_ATTRIBUTION = process.env.TILE_ATTRIBUTION || '© OpenStreetMap contributors';
const PUBLIC = path.join(__dirname, 'public');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const jobs = new Map();

// --- limits ----------------------------------------------------------------
// Generating a board is 5-60s of CPU and tens of MB of upstream downloads, and
// the tile/Overpass traffic is attributed to whoever is running this. Nothing
// here is security; it is enough to keep a shared link from becoming a problem
// for OpenStreetMap or for this machine.
const LIMITS = {
  concurrentJobs: 2,
  boardsPerHour: 12,        // per client
  tilesPerMinute: 900,      // per client
  jobTtlMs: 30 * 60 * 1000
};

const buckets = new Map();  // ip -> { boards: number[], tiles: number[] }

function clientOf(req) {
  const fwd = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

/** Sliding window. Returns null if allowed, or seconds to wait. */
function takeToken(ip, kind, limit, windowMs) {
  const now = Date.now();
  if (!buckets.has(ip)) buckets.set(ip, { boards: [], tiles: [] });
  const b = buckets.get(ip);
  b[kind] = b[kind].filter((t) => now - t < windowMs);
  if (b[kind].length >= limit) {
    return Math.ceil((windowMs - (now - b[kind][0])) / 1000);
  }
  b[kind].push(now);
  return null;
}

function runningJobs() {
  let n = 0;
  for (const j of jobs.values()) if (j.status === 'running') n++;
  return n;
}

// Drop finished jobs (and their files) so a long-lived tunnel does not grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.status !== 'running' && now - j.started > LIMITS.jobTtlMs) {
      jobs.delete(id);
      for (const ext of ['.svg', '.json']) {
        try { fs.unlinkSync(path.join(OUT, id + ext)); } catch (_) {}
      }
    }
  }
  const cutoff = now - 3600000;
  for (const [ip, b] of buckets) {
    if (!b.boards.some((t) => t > cutoff) && !b.tiles.some((t) => t > cutoff)) buckets.delete(ip);
  }
}, 60000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};

function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8' }, extra || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const c = [];
    req.on('data', (d) => { c.push(d); if (Buffer.concat(c).length > 1e6) reject(new Error('body too large')); });
    req.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // --- basemap tile proxy: keeps a polite User-Agent and caches on disk ---
  const tm = /^\/api\/tile\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(p);
  if (tm) {
    const [, z, x, y] = tm;
    if (+z > 19 || +x < 0 || +y < 0) return send(res, 400, 'bad tile');
    const wait = takeToken(clientOf(req), 'tiles', LIMITS.tilesPerMinute, 60000);
    if (wait !== null) return send(res, 429, 'slow down', 'text/plain', { 'Retry-After': String(wait) });
    try {
      const url = TILE_TEMPLATE.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const buf = await net.cached('basemap', `${TILE_KEY}_${z}_${x}_${y}`, '.png', url);
      return send(res, 200, buf, 'image/png', { 'Cache-Control': 'public, max-age=604800' });
    } catch (e) {
      return send(res, 502, 'tile unavailable: ' + e.message);
    }
  }

  // --- start a generation job ---
  if (p === '/api/board' && req.method === 'POST') {
    let params;
    try { params = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, 'bad JSON'); }
    if (typeof params.lat !== 'number' || typeof params.lon !== 'number') return send(res, 400, 'lat and lon required');
    if (Math.abs(params.lat) > 85 || Math.abs(params.lon) > 180) return send(res, 400, 'lat/lon out of range');

    if (runningJobs() >= LIMITS.concurrentJobs) {
      return send(res, 503, JSON.stringify({ error: 'Two boards are already being built. Try again in a minute.' }), MIME['.json']);
    }
    const wait = takeToken(clientOf(req), 'boards', LIMITS.boardsPerHour, 3600000);
    if (wait !== null) {
      return send(res, 429, JSON.stringify({
        error: `That is ${LIMITS.boardsPerHour} boards this hour — the map data upstream is a shared free service. Try again in ${Math.ceil(wait / 60)} min.`
      }), MIME['.json'], { 'Retry-After': String(wait) });
    }

    const id = crypto.randomBytes(6).toString('hex');
    const job = { id, status: 'running', log: [], started: Date.now() };
    jobs.set(id, job);

    (async () => {
      try {
        const board = await Board.build({
          lat: params.lat, lon: params.lon,
          bearing: params.bearing || 0,
          name: params.name || 'Board',
          minReliefM: params.minReliefM,
          hillHigh: params.hillHigh,
          hillLow: params.hillLow,
          reliefWeight: params.reliefWeight,
          log: (m) => { job.log.push(m); }
        });
        const svg = Render.render(board);
        const project = {
          meta: board.meta, stats: board.stats,
          hexes: board.hexes.filter((h) => h.onBoard).map((h) => ({
            id: h.label, i: h.i, j: h.j, terrain: h.terrain, hill: h.hill,
            obstacleHeight: h.obstacleHeight, unitHeight: h.unitHeight,
            elevM: +h.elev.toFixed(1), reliefM: +h.relief.toFixed(1), dominance: +h.dominance.toFixed(3)
          })),
          roads: board.roads.map((e) => ({ a: e.a, b: e.b, cls: e.cls, bridge: !!e.bridge })),
          rivers: board.rivers.map((r) => ({ kind: r.kind, name: r.name, nodes: r.nodes }))
        };
        fs.writeFileSync(path.join(OUT, id + '.svg'), svg);
        fs.writeFileSync(path.join(OUT, id + '.json'), JSON.stringify(project, null, 1));
        job.status = 'done';
        job.stats = board.stats;
        job.meta = board.meta;
        job.svgUrl = '/out/' + id + '.svg';
        job.jsonUrl = '/out/' + id + '.json';
      } catch (e) {
        job.status = 'error';
        job.error = e.message;
        job.log.push('FAILED: ' + e.message);
      }
    })();

    return send(res, 202, JSON.stringify({ id }), MIME['.json']);
  }

  if (p === '/api/config') {
    return send(res, 200, JSON.stringify({ tileAttribution: TILE_ATTRIBUTION }), MIME['.json']);
  }

  if (p === '/healthz') {
    return send(res, 200, JSON.stringify({ ok: true, running: runningJobs(), uptime: process.uptime() }), MIME['.json']);
  }

  const jm = /^\/api\/job\/([0-9a-f]+)$/.exec(p);
  if (jm) {
    const job = jobs.get(jm[1]);
    if (!job) return send(res, 404, 'no such job');
    return send(res, 200, JSON.stringify(job), MIME['.json']);
  }

  // --- generated files ---
  const om = /^\/out\/([0-9a-f]+\.(svg|json))$/.exec(p);
  if (om) {
    const f = path.join(OUT, om[1]);
    if (!fs.existsSync(f)) return send(res, 404, 'not found');
    return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)]);
  }

  // --- static ---
  let file = p === '/' ? '/index.html' : p;
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) return send(res, 403, 'nope');
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'not found');
  send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => { try { send(res, 500, 'server error: ' + e.message); } catch (_) {} });
}).listen(PORT, HOST, () => {
  console.log(`mapforge listening on http://${HOST}:${PORT}`);
  console.log(`basemap tiles: ${TILE_TEMPLATE}`);
});
