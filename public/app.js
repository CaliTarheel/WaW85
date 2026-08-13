'use strict';
// Slippy map + footprint overlay. Hand-rolled so the footprint rectangle can be
// rotated and dragged as one object without fighting a mapping library.

const BOARD_W = 3864, BOARD_H = 2638, M_PER_PX = 150 / 202.89999999999566;
const BOARD_W_M = BOARD_W * M_PER_PX;   // 2856.6
const BOARD_H_M = BOARD_H * M_PER_PX;   // 1950.2

const TERRAIN_COLOURS = {
  clear: '#6C793B', cultivated: '#8C8A4E', rough: '#7D815C', city: '#6A6A52',
  woods: '#3E4D26', hill: '#B3B768', 'hill-city': '#8F8F5E', 'hill-woods': '#63713E',
  water: '#71A08C'
};

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;

const view = { lat: 50.718, lon: 9.910, zoom: 14, bearing: 0 };

// ---------------------------------------------------------------- projection
function lonToWorld(lon, z) { return (lon + 180) / 360 * 256 * 2 ** z; }
function latToWorld(lat, z) {
  const r = lat * D2R;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 256 * 2 ** z;
}
function worldToLon(x, z) { return x / (256 * 2 ** z) * 360 - 180; }
function worldToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / (256 * 2 ** z);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
function metresPerDegree(lat) {
  const p = lat * D2R;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p)
  };
}

const tiles = $('tiles'), foot = $('foot'), mapEl = $('map');
const tctx = tiles.getContext('2d'), fctx = foot.getContext('2d');
const tileCache = new Map();
let size = { w: 0, h: 0 };

function resize() {
  const r = mapEl.getBoundingClientRect();
  size = { w: Math.max(1, r.width | 0), h: Math.max(1, r.height | 0) };
  for (const c of [tiles, foot]) {
    c.width = size.w * devicePixelRatio;
    c.height = size.h * devicePixelRatio;
    c.style.width = size.w + 'px';
    c.style.height = size.h + 'px';
    c.getContext('2d').setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }
  draw();
}

function getTile(z, x, y) {
  const k = z + '/' + x + '/' + y;
  if (tileCache.has(k)) return tileCache.get(k);
  const img = new Image();
  img.onload = () => draw();
  img.onerror = () => { img.failed = true; };
  img.src = `/api/tile/${z}/${x}/${y}.png`;
  tileCache.set(k, img);
  return img;
}

function drawTiles() {
  const z = Math.round(view.zoom);
  const cx = lonToWorld(view.lon, z), cy = latToWorld(view.lat, z);
  const scale = 2 ** (view.zoom - z);
  tctx.save();
  tctx.fillStyle = '#0d0f0a';
  tctx.fillRect(0, 0, size.w, size.h);
  tctx.translate(size.w / 2, size.h / 2);
  tctx.scale(scale, scale);
  const halfW = size.w / 2 / scale, halfH = size.h / 2 / scale;
  const x0 = Math.floor((cx - halfW) / 256), x1 = Math.floor((cx + halfW) / 256);
  const y0 = Math.floor((cy - halfH) / 256), y1 = Math.floor((cy + halfH) / 256);
  const n = 2 ** z;
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= n) continue;
      const img = getTile(z, ((x % n) + n) % n, y);
      if (!img.complete || img.failed || !img.naturalWidth) continue;
      tctx.drawImage(img, x * 256 - cx, y * 256 - cy, 256, 256);
    }
  }
  tctx.restore();
  // Dim the basemap so the footprint reads clearly on top of it.
  tctx.fillStyle = 'rgba(18,21,14,0.35)';
  tctx.fillRect(0, 0, size.w, size.h);
}

/** Screen position of a lat/lon under the current view. */
function project(lat, lon) {
  const z = view.zoom;
  return [
    size.w / 2 + (lonToWorld(lon, z) - lonToWorld(view.lon, z)),
    size.h / 2 + (latToWorld(lat, z) - latToWorld(view.lat, z))
  ];
}

/** Corners of the board footprint, in lat/lon. */
function footprintCorners() {
  const b = view.bearing * D2R;
  const ax = [Math.cos(b), -Math.sin(b)];          // board +x as (east, north)
  const ay = [-Math.sin(b), -Math.cos(b)];         // board +y as (east, north)
  const mpd = metresPerDegree(view.lat);
  const hw = BOARD_W_M / 2, hh = BOARD_H_M / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => {
    const e = dx * ax[0] + dy * ay[0];
    const n = dx * ax[1] + dy * ay[1];
    return [view.lat + n / mpd.lat, view.lon + e / mpd.lon];
  });
}

function drawFootprint() {
  fctx.clearRect(0, 0, size.w, size.h);
  const pts = footprintCorners().map(([la, lo]) => project(la, lo));

  // Everything outside the footprint gets knocked back.
  fctx.save();
  fctx.beginPath();
  fctx.rect(0, 0, size.w, size.h);
  fctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = pts.length - 1; i >= 1; i--) fctx.lineTo(pts[i][0], pts[i][1]);
  fctx.closePath();
  fctx.fillStyle = 'rgba(10,12,8,0.55)';
  fctx.fill('evenodd');
  fctx.restore();

  fctx.beginPath();
  fctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < 4; i++) fctx.lineTo(pts[i][0], pts[i][1]);
  fctx.closePath();
  fctx.strokeStyle = '#E4643F';
  fctx.lineWidth = 2;
  fctx.stroke();

  // "Top of board" tick, so the orientation is never ambiguous.
  const mid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
  const c = project(view.lat, view.lon);
  fctx.beginPath();
  fctx.moveTo(mid[0], mid[1]);
  fctx.lineTo(mid[0] + (mid[0] - c[0]) * 0.22, mid[1] + (mid[1] - c[1]) * 0.22);
  fctx.lineWidth = 3;
  fctx.stroke();

  fctx.fillStyle = '#E4643F';
  fctx.beginPath();
  fctx.arc(c[0], c[1], 4, 0, Math.PI * 2);
  fctx.fill();
}

function draw() {
  drawTiles();
  drawFootprint();
  $('mapinfo').textContent =
    `${view.lat.toFixed(5)}, ${view.lon.toFixed(5)}\n` +
    `bearing ${view.bearing}°   zoom ${view.zoom.toFixed(1)}\n` +
    `${(BOARD_W_M / 1000).toFixed(2)} x ${(BOARD_H_M / 1000).toFixed(2)} km`;
}

// ------------------------------------------------------------------ interaction
let drag = null;
mapEl.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, lat: view.lat, lon: view.lon };
  mapEl.classList.add('dragging');
  mapEl.setPointerCapture(e.pointerId);
});
mapEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const z = view.zoom;
  const wx = lonToWorld(drag.lon, z) - (e.clientX - drag.x);
  const wy = latToWorld(drag.lat, z) - (e.clientY - drag.y);
  view.lon = worldToLon(wx, z);
  view.lat = Math.max(-85, Math.min(85, worldToLat(wy, z)));
  syncInputs();
  draw();
});
const endDrag = (e) => { drag = null; mapEl.classList.remove('dragging'); if (e && e.pointerId != null) { try { mapEl.releasePointerCapture(e.pointerId); } catch (_) {} } };
mapEl.addEventListener('pointerup', endDrag);
mapEl.addEventListener('pointercancel', endDrag);

mapEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  view.zoom = Math.max(8, Math.min(17, view.zoom - Math.sign(e.deltaY) * 0.4));
  draw();
}, { passive: false });

// ------------------------------------------------------------------ controls
function syncInputs() {
  $('lat').value = view.lat.toFixed(5);
  $('lon').value = view.lon.toFixed(5);
}
for (const id of ['lat', 'lon']) {
  $(id).addEventListener('change', () => {
    const v = parseFloat($(id).value);
    if (Number.isFinite(v)) { view[id] = v; draw(); }
  });
}
const sliders = {
  bearing: (v) => v + '°',
  minRelief: (v) => v + ' m',
  hillHigh: (v) => (+v).toFixed(2),
  hillLow: (v) => (+v).toFixed(2),
  reliefWeight: (v) => (+v).toFixed(2)
};
for (const id of Object.keys(sliders)) {
  const el = $(id), out = $(id + 'V');
  const upd = () => {
    out.textContent = sliders[id](el.value);
    if (id === 'bearing') { view.bearing = +el.value; draw(); }
  };
  el.addEventListener('input', upd);
  upd();
}
document.querySelectorAll('.preset button').forEach((b) => {
  b.addEventListener('click', () => {
    const [la, lo] = b.dataset.go.split(',').map(Number);
    view.lat = la; view.lon = lo;
    $('name').value = b.textContent;
    syncInputs(); draw();
  });
});

// ------------------------------------------------------------------ generate
let current = null;

function showStats(stats, meta) {
  const total = stats.hexes;
  const entries = Object.entries(stats.terrain).sort((a, b) => b[1] - a[1]);
  $('stats').innerHTML =
    `<b>${total}</b> hexes · <b>${stats.hillPercent}%</b> hill<br>` +
    `<b>${stats.roadEdges}</b> road hexsides · <b>${stats.riverChains}</b> rivers · <b>${stats.bridges}</b> bridges<br>` +
    `elevation <b>${meta.elevationRange.map((v) => v.toFixed(0)).join('–')} m</b><br>` +
    `built in <b>${(meta.timingMs / 1000).toFixed(1)}s</b>` +
    (stats.fallbackShapes ? `<br><span style="color:#E4643F">${stats.fallbackShapes} shape(s) fell back to hard hex edges</span>` : '');
  $('bar').innerHTML = entries.map(([k, v]) =>
    `<span style="width:${(100 * v / total).toFixed(2)}%;background:${TERRAIN_COLOURS[k] || '#888'}" title="${k} ${v}"></span>`).join('');
  $('legend').innerHTML = entries.map(([k, v]) =>
    `<div><i style="background:${TERRAIN_COLOURS[k] || '#888'}"></i>${k} ${v}</div>`).join('');
}

async function generate() {
  const btn = $('go');
  btn.disabled = true;
  btn.textContent = 'Working…';
  $('log').textContent = 'starting…';
  $('dlSvg').disabled = $('dlJson').disabled = true;

  const body = {
    lat: view.lat, lon: view.lon, bearing: view.bearing,
    name: $('name').value || 'Board',
    minReliefM: +$('minRelief').value,
    hillHigh: +$('hillHigh').value,
    hillLow: +$('hillLow').value,
    reliefWeight: +$('reliefWeight').value
  };

  try {
    const r = await fetch('/api/board', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!r.ok) {
      const txt = await r.text();
      let msg = txt;
      try { msg = JSON.parse(txt).error || txt; } catch (_) {}
      throw new Error(msg);
    }
    const { id } = await r.json();

    for (;;) {
      await new Promise((res) => setTimeout(res, 700));
      const j = await (await fetch('/api/job/' + id)).json();
      $('log').textContent = j.log.join('\n') || 'working…';
      if (j.status === 'done') {
        current = j;
        showStats(j.stats, j.meta);
        $('preview').innerHTML = `<img src="${j.svgUrl}" alt="generated board">`;
        $('dlSvg').disabled = $('dlJson').disabled = false;
        break;
      }
      if (j.status === 'error') { $('log').textContent = j.log.join('\n'); break; }
    }
  } catch (e) {
    $('log').textContent = 'failed: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Make the board';
  }
}

$('go').addEventListener('click', generate);
$('dlSvg').addEventListener('click', () => { if (current) location.href = current.svgUrl; });
$('dlJson').addEventListener('click', () => { if (current) location.href = current.jsonUrl; });

window.addEventListener('resize', resize);
resize();
syncInputs();
