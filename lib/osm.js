'use strict';
// OpenStreetMap features via Overpass, projected into board pixel space.
const net = require('./net');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

// Footways, cycleways and driveways are below the resolution of a 150 m hex,
// so they never make it onto a board.
const ROAD_CLASS = {
  motorway: 'major', motorway_link: 'major', trunk: 'major', trunk_link: 'major',
  primary: 'major', primary_link: 'major',
  secondary: 'road', secondary_link: 'road', tertiary: 'road', tertiary_link: 'road',
  unclassified: 'road', residential: 'road', living_street: 'road',
  track: 'trail'
};

// Landuse / natural tags mapped onto the WaW85 vocabulary.
const COVER = {
  forest: 'woods', wood: 'woods',
  farmland: 'cultivated', orchard: 'cultivated', vineyard: 'cultivated',
  allotments: 'cultivated', farmyard: 'cultivated', greenhouse_horticulture: 'cultivated',
  meadow: 'open', grass: 'open', village_green: 'open', recreation_ground: 'open',
  residential: 'built', commercial: 'built', retail: 'built', industrial: 'built',
  military: 'built', construction: 'built',
  quarry: 'rough', scrub: 'rough', heath: 'rough', bare_rock: 'rough',
  scree: 'rough', shingle: 'rough', landfill: 'rough', brownfield: 'rough',
  wetland: 'rough'
};

function query(bbox) {
  const b = `${bbox.south.toFixed(6)},${bbox.west.toFixed(6)},${bbox.north.toFixed(6)},${bbox.east.toFixed(6)}`;
  return `[out:json][timeout:90];
(
  way["highway"](${b});
  way["waterway"~"^(river|stream|canal)$"](${b});
  way["natural"="water"](${b});
  way["natural"="coastline"](${b});
  relation["natural"="water"](${b});
  way["landuse"](${b});
  way["natural"~"^(wood|scrub|heath|bare_rock|scree|shingle|wetland|grassland)$"](${b});
  way["building"](${b});
);
out geom;`;
}

async function fetchRaw(bbox, log) {
  const q = query(bbox);
  // The query text is part of the key, so editing the query invalidates the cache.
  const qh = require('crypto').createHash('sha1').update(q).digest('hex').slice(0, 8);
  const id = `${bbox.south.toFixed(4)}_${bbox.west.toFixed(4)}_${bbox.north.toFixed(4)}_${bbox.east.toFixed(4)}_${qh}`;
  const errors = [];
  // Overpass mirrors are frequently busy; try each twice before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const ep of ENDPOINTS) {
      try {
        const body = await net.cached('osm', id, '.json', ep + '?data=' + encodeURIComponent(q));
        return JSON.parse(body.toString('utf8'));
      } catch (e) {
        errors.push(`${new URL(ep).host}: ${e.message.slice(0, 120)}`);
        if (log) log(`  overpass ${new URL(ep).host} failed — ${e.message.slice(0, 90)}`);
      }
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('Overpass unreachable — ' + errors.join(' | '));
}

/**
 * Fetch and project. Returns geometry already in board pixel coordinates, so
 * nothing downstream has to think about the globe.
 */
async function load(footprint, marginM, log) {
  const bbox = footprint.bbox(marginM === undefined ? 400 : marginM);
  const raw = await fetchRaw(bbox, log);

  const roads = [], waterways = [], water = [], cover = [], buildings = [], coastlines = [];
  let skipped = 0;

  for (const el of raw.elements) {
    // Big water bodies (bays, reservoirs) are multipolygon relations, not ways.
    if (el.type === 'relation') {
      const t = el.tags || {};
      if (t.natural !== 'water' && t.water === undefined) { skipped++; continue; }
      const outers = (el.members || [])
        .filter((m) => m.type === 'way' && m.geometry && m.role !== 'inner')
        .map((m) => m.geometry.map((g) => footprint.latLonToPixel(g.lat, g.lon)));
      for (const ring of stitch(outers)) if (ring.length > 3) water.push({ pts: ring, name: t.name });
      continue;
    }
    if (el.type !== 'way' || !el.geometry) { skipped++; continue; }
    const pts = el.geometry.map((g) => footprint.latLonToPixel(g.lat, g.lon));
    const t = el.tags || {};
    const closed = pts.length > 2 &&
      Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-6 &&
      Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-6;

    if (t.highway) {
      const cls = ROAD_CLASS[t.highway];
      if (cls) roads.push({ pts, cls, name: t.name, bridge: !!t.bridge, tunnel: !!t.tunnel });
      continue;
    }
    if (t.waterway) { waterways.push({ pts, kind: t.waterway, name: t.name }); continue; }
    // OSM convention: walking a coastline way, the sea is on your right.
    if (t.natural === 'coastline') { coastlines.push({ pts, name: t.name }); continue; }
    if (t.natural === 'water' || t.water) { if (closed) water.push({ pts, name: t.name }); continue; }
    if (t.building) { if (closed) buildings.push({ pts }); continue; }

    const cls = COVER[t.landuse] || COVER[t.natural];
    if (cls && closed) cover.push({ pts, cls, tag: t.landuse || t.natural });
  }

  return { bbox, roads, waterways, water, cover, buildings, coastlines, skipped, elements: raw.elements.length };
}

/** Join open way fragments end to end into rings, for multipolygon relations. */
function stitch(fragments) {
  const k = (p) => Math.round(p[0]) + ',' + Math.round(p[1]);
  const open = fragments.filter((f) => f.length > 1);
  const rings = [];
  while (open.length) {
    let cur = open.shift().slice();
    let joined = true;
    while (joined) {
      joined = false;
      if (k(cur[0]) === k(cur[cur.length - 1])) break;
      for (let i = 0; i < open.length; i++) {
        const f = open[i];
        if (k(cur[cur.length - 1]) === k(f[0])) { cur = cur.concat(f.slice(1)); open.splice(i, 1); joined = true; break; }
        if (k(cur[cur.length - 1]) === k(f[f.length - 1])) { cur = cur.concat(f.slice().reverse().slice(1)); open.splice(i, 1); joined = true; break; }
        if (k(cur[0]) === k(f[f.length - 1])) { cur = f.slice(0, -1).concat(cur); open.splice(i, 1); joined = true; break; }
        if (k(cur[0]) === k(f[0])) { cur = f.slice().reverse().slice(0, -1).concat(cur); open.splice(i, 1); joined = true; break; }
      }
    }
    rings.push(cur);
  }
  return rings;
}

module.exports = { load, stitch, COVER, ROAD_CLASS };
