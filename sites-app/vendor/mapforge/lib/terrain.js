'use strict';
// Turn a DEM plus OSM features into a WaW85 board: per-hex terrain, the hill
// mask, the road graph and the river hexsides.
const H = require('./hexgrid');
const G = require('./geom');

// ---------------------------------------------------------------- elevation

/**
 * Resample the DEM onto a regular raster in board pixel space, covering the
 * board plus a margin. Everything elevation-related reads this, so the globe
 * only gets touched once.
 */
function buildRaster(footprint, dem, opts) {
  const stride = (opts && opts.stride) || 24;         // px between samples (~18 m)
  const margin = (opts && opts.marginPx) || 1400;     // ~1 km of context
  const x0 = -margin, y0 = -margin;
  const w = Math.ceil((footprint.widthPx + margin * 2) / stride) + 1;
  const h = Math.ceil((footprint.heightPx + margin * 2) / stride) + 1;
  const data = new Float32Array(w * h);
  let min = Infinity, max = -Infinity, missing = 0;
  for (let yi = 0; yi < h; yi++) {
    for (let xi = 0; xi < w; xi++) {
      const [lat, lon] = footprint.pixelToLatLon(x0 + xi * stride, y0 + yi * stride);
      const v = dem.at(lat, lon);
      if (v === null) { missing++; data[yi * w + xi] = NaN; continue; }
      data[yi * w + xi] = v;
      if (v < min) min = v; if (v > max) max = v;
    }
  }
  // Patch any holes with the mean so downstream maths never sees NaN.
  if (missing) {
    const mean = (min + max) / 2;
    for (let i = 0; i < data.length; i++) if (Number.isNaN(data[i])) data[i] = mean;
  }
  return {
    x0, y0, stride, w, h, data, min, max, missing,
    at(px, py) {
      const fx = (px - x0) / stride, fy = (py - y0) / stride;
      let ix = Math.floor(fx), iy = Math.floor(fy);
      if (ix < 0) ix = 0; if (iy < 0) iy = 0;
      if (ix > w - 2) ix = w - 2; if (iy > h - 2) iy = h - 2;
      const tx = Math.min(1, Math.max(0, fx - ix)), ty = Math.min(1, Math.max(0, fy - iy));
      const a = data[iy * w + ix], b = data[iy * w + ix + 1];
      const c = data[(iy + 1) * w + ix], d = data[(iy + 1) * w + ix + 1];
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  };
}

/** Separable box blur over the raster; radius in board pixels. */
function blurRaster(raster, radiusPx) {
  const r = Math.max(1, Math.round(radiusPx / raster.stride));
  const { w, h, data } = raster;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += data[y * w + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / (r * 2 + 1);
      const leaving = Math.min(w - 1, Math.max(0, x - r));
      const entering = Math.min(w - 1, Math.max(0, x + r + 1));
      sum += data[y * w + entering] - data[y * w + leaving];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / (r * 2 + 1);
      const leaving = Math.min(h - 1, Math.max(0, y - r));
      const entering = Math.min(h - 1, Math.max(0, y + r + 1));
      sum += tmp[entering * w + x] - tmp[leaving * w + x];
    }
  }
  return Object.assign({}, raster, {
    data: out,
    at(px, py) {
      const fx = (px - raster.x0) / raster.stride, fy = (py - raster.y0) / raster.stride;
      let ix = Math.floor(fx), iy = Math.floor(fy);
      if (ix < 0) ix = 0; if (iy < 0) iy = 0;
      if (ix > w - 2) ix = w - 2; if (iy > h - 2) iy = h - 2;
      const tx = Math.min(1, Math.max(0, fx - ix)), ty = Math.min(1, Math.max(0, fy - iy));
      const a = out[iy * w + ix], b = out[iy * w + ix + 1];
      const c = out[(iy + 1) * w + ix], d = out[(iy + 1) * w + ix + 1];
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  });
}

/**
 * Viewshed dominance: from a 2 m observer at the hex centre, what fraction of
 * the sample points within `rangeM` are visible? This is the LOS-driven read of
 * "high ground" — a hex is a hill because it commands, not because it is tall.
 */
function dominance(raster, cx, cy, opts) {
  const rays = (opts && opts.rays) || 24;
  const rangeM = (opts && opts.rangeM) || 1800;
  const stepM = (opts && opts.stepM) || 60;
  const eye = (opts && opts.eyeM) || 2;
  const mPerPx = H.M_PER_PX;
  const steps = Math.floor(rangeM / stepM);
  const stepPx = stepM / mPerPx;
  const base = raster.at(cx, cy) + eye;
  let visible = 0, total = 0;
  for (let r = 0; r < rays; r++) {
    const a = (r / rays) * Math.PI * 2;
    const dx = Math.cos(a) * stepPx, dy = Math.sin(a) * stepPx;
    let maxSlope = -Infinity;
    for (let s = 1; s <= steps; s++) {
      const px = cx + dx * s, py = cy + dy * s;
      const distM = s * stepM;
      const slope = (raster.at(px, py) + eye - base) / distM;
      total++;
      if (slope >= maxSlope) { visible++; maxSlope = slope; }
    }
  }
  return total ? visible / total : 0;
}

// -------------------------------------------------------------- hill mask

function normalise(values) {
  const arr = Array.from(values).filter((v) => Number.isFinite(v));
  if (!arr.length) return () => 0;
  arr.sort((a, b) => a - b);
  const lo = arr[Math.floor(arr.length * 0.05)];
  const hi = arr[Math.floor(arr.length * 0.95)];
  const span = hi - lo || 1;
  return (v) => Math.min(1, Math.max(0, (v - lo) / span));
}

/**
 * Seed on the confident hexes, then grow into anything connected that clears
 * the lower bar. Single thresholding produces confetti; this produces landforms.
 */
function hysteresis(hexes, scoreOf, tHigh, tLow) {
  const hill = new Set();
  const stack = [];
  for (const hx of hexes) {
    if (scoreOf(hx) >= tHigh) { hill.add(hx.key); stack.push(hx); }
  }
  const byKey = new Map(hexes.map((hx) => [hx.key, hx]));
  while (stack.length) {
    const hx = stack.pop();
    for (const [ni, nj] of H.neighbours(hx.i, hx.j)) {
      const nb = byKey.get(H.key(ni, nj));
      if (!nb || hill.has(nb.key)) continue;
      if (scoreOf(nb) >= tLow) { hill.add(nb.key); stack.push(nb); }
    }
  }
  return hill;
}

/** Fill pinholes, shave spurs, drop specks — on hex adjacency, not a square grid. */
function cleanMask(hexes, mask, minComponent) {
  const byKey = new Map(hexes.map((hx) => [hx.key, hx]));
  const nbCount = (hx, set) => {
    let n = 0;
    for (const [ni, nj] of H.neighbours(hx.i, hx.j)) if (set.has(H.key(ni, nj))) n++;
    return n;
  };

  let cur = new Set(mask);
  for (let pass = 0; pass < 2; pass++) {
    const add = [], del = [];
    for (const hx of hexes) {
      const inMask = cur.has(hx.key);
      const n = nbCount(hx, cur);
      if (!inMask && n >= 5) add.push(hx.key);            // fill a pinhole
      if (inMask && n <= 1) del.push(hx.key);             // shave a spur
    }
    for (const k of add) cur.add(k);
    for (const k of del) cur.delete(k);
  }

  // Drop components below the minimum size. The rules' own worked example shows
  // a three-hex hill, so that is the floor.
  const seen = new Set(), keep = new Set();
  for (const k of cur) {
    if (seen.has(k)) continue;
    const comp = [], stack = [k];
    seen.add(k);
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      const [i, j] = H.unkey(c);
      for (const [ni, nj] of H.neighbours(i, j)) {
        const nk = H.key(ni, nj);
        if (cur.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    if (comp.length >= (minComponent || 3)) for (const c of comp) keep.add(c);
  }
  return keep;
}

// -------------------------------------------------------------- land cover

const COVER_PRIORITY = ['water', 'built', 'woods', 'cultivated', 'rough', 'open'];

/**
 * Coastlines are open ways, not polygons, so there is nothing to test a point
 * against. OSM's convention saves us: walking a coastline way, the sea is on
 * your right. Find the nearest coastline segment and check which side you fall.
 */
function seaTest(coastlines) {
  const segs = [];
  for (const c of coastlines || []) {
    for (let i = 1; i < c.pts.length; i++) segs.push([c.pts[i - 1], c.pts[i]]);
  }
  if (!segs.length) return null;
  return (x, y) => {
    let best = null, bestD = Infinity;
    for (const s of segs) {
      const d = G.dist2ToSegment(x, y, s[0][0], s[0][1], s[1][0], s[1][1]);
      if (d < bestD) { bestD = d; best = s; }
    }
    // Positive is the right-hand side in y-down board space, which is the sea.
    return G.sideOfSegment(x, y, best[0][0], best[0][1], best[1][0], best[1][1]) > 0;
  };
}

/** 19-point sample of each hex against the OSM polygons. */
function coverFractions(hexes, osm) {
  const coverIdx = new G.PolyIndex(osm.cover);
  const waterIdx = new G.PolyIndex(osm.water);
  const buildIdx = new G.PolyIndex(osm.buildings, 200);
  const isSea = seaTest(osm.coastlines);

  const offsets = [[0, 0]];
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 3 * k;
    offsets.push([Math.cos(a) * H.R * 0.45, Math.sin(a) * H.R * 0.45]);
  }
  for (let k = 0; k < 12; k++) {
    const a = Math.PI / 6 * k + Math.PI / 12;
    offsets.push([Math.cos(a) * H.R * 0.78, Math.sin(a) * H.R * 0.78]);
  }

  for (const hx of hexes) {
    const [cx, cy] = H.center(hx.i, hx.j);
    const tally = { water: 0, built: 0, woods: 0, cultivated: 0, rough: 0, open: 0 };
    let buildingHits = 0;
    for (const [ox, oy] of offsets) {
      const x = cx + ox, y = cy + oy;
      if (waterIdx.hits(x, y).length || (isSea && isSea(x, y))) { tally.water++; continue; }
      if (buildIdx.hits(x, y).length) buildingHits++;
      const c = coverIdx.hits(x, y);
      if (c.length) {
        // Most specific wins when polygons overlap.
        let best = c[0];
        for (const it of c) if (COVER_PRIORITY.indexOf(it.cls) < COVER_PRIORITY.indexOf(best.cls)) best = it;
        tally[best.cls]++;
      } else tally.open++;
    }
    const n = offsets.length;
    hx.cover = {};
    for (const k of Object.keys(tally)) hx.cover[k] = tally[k] / n;
    hx.buildingFrac = buildingHits / n;
  }
}

/** Buildings alone can make a village even where landuse is not tagged. */
function classify(hexes, opts) {
  const t = Object.assign({
    water: 0.5, built: 0.45, buildings: 0.24, woods: 0.4, cultivated: 0.45, rough: 0.35
  }, opts || {});
  for (const hx of hexes) {
    const c = hx.cover;
    let base = 'clear';
    if (c.water >= t.water) base = 'water';
    else if (c.built >= t.built || hx.buildingFrac >= t.buildings) base = 'city';
    else if (c.woods >= t.woods) base = 'woods';
    else if (c.cultivated >= t.cultivated) base = 'cultivated';
    else if (c.rough >= t.rough) base = 'rough';
    hx.base = base;
  }
}

// -------------------------------------------------------- linear features

/** Walk each road through the hex field and emit centre-to-centre edges. */
function roadGraph(hexes, roads) {
  const onBoard = new Set(hexes.map((hx) => hx.key));
  const edges = new Map();
  for (const road of roads) {
    if (road.tunnel) continue;
    const pts = G.resample(road.pts, H.R * 0.35);
    let prev = null;
    for (const [x, y] of pts) {
      const [i, j] = H.hexAt(x, y);
      const k = H.key(i, j);
      if (prev && prev !== k) {
        const [pi, pj] = H.unkey(prev);
        const adjacent = H.neighbours(pi, pj).some(([ni, nj]) => ni === i && nj === j);
        if (adjacent && (onBoard.has(k) || onBoard.has(prev))) {
          const id = prev < k ? prev + '|' + k : k + '|' + prev;
          const existing = edges.get(id);
          const rank = { major: 3, rail: 3, road: 2, minor: 1, trail: 0 }[road.cls];
          const confidenceRank = { 'dated-history': 3, 'dated-current-map': 2, current: 1, 'present-day-fallback': 0 }[road.confidence] || 0;
          if (!existing || rank > existing.rank || (rank === existing.rank && confidenceRank > existing.confidenceRank)) {
            edges.set(id, {
              a: prev < k ? prev : k, b: prev < k ? k : prev,
              cls: road.cls, rank,
              source: road.source || 'openstreetmap',
              confidence: road.confidence || 'current',
              confidenceRank
            });
          }
        }
      }
      if (prev !== k) prev = k;
    }
  }
  return Array.from(edges.values());
}

/**
 * OSM gives every driveway and farm track; a WaW85 board shows the road net a
 * battalion would use. Keep the through routes, cap the rest by hex degree.
 */
function pruneRoads(edges, maxDegree) {
  const cap = maxDegree || 3;
  const sorted = edges.slice().sort((a, b) => b.rank - a.rank);
  const degree = new Map();
  const deg = (k) => degree.get(k) || 0;
  const keep = [];
  for (const e of sorted) {
    const always = e.rank >= 2;                       // major and ordinary roads
    if (always || (deg(e.a) < cap && deg(e.b) < cap)) {
      keep.push(e);
      degree.set(e.a, deg(e.a) + 1);
      degree.set(e.b, deg(e.b) + 1);
    }
  }
  return keep;
}

/**
 * Stitch individual hex-to-hex edges into runs, so a road can be drawn as one
 * flowing spline instead of a series of independent segments meeting at angles.
 */
function chainEdges(edges) {
  const byCls = new Map();
  for (const e of edges) {
    const group = `${e.cls}|${e.source || 'openstreetmap'}|${e.confidence || 'current'}`;
    if (!byCls.has(group)) byCls.set(group, []);
    byCls.get(group).push(e);
  }
  const chains = [];
  for (const [group, list] of byCls) {
    const [cls, source, confidence] = group.split('|');
    const adj = new Map();
    for (const e of list) {
      if (!adj.has(e.a)) adj.set(e.a, []);
      if (!adj.has(e.b)) adj.set(e.b, []);
      adj.get(e.a).push(e.b);
      adj.get(e.b).push(e.a);
    }
    const used = new Set();
    const edgeId = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

    const walk = (start, first) => {
      const path = [start];
      let prev = start, cur = first;
      while (true) {
        used.add(edgeId(prev, cur));
        path.push(cur);
        const nexts = adj.get(cur).filter((n) => !used.has(edgeId(cur, n)));
        // Only keep flowing through a plain two-way junction.
        if (adj.get(cur).length !== 2 || nexts.length !== 1) break;
        prev = cur; cur = nexts[0];
      }
      return path;
    };

    // Start at every endpoint and junction first, so chains run end to end.
    for (const [node, nbs] of adj) {
      if (nbs.length === 2) continue;
      for (const n of nbs) {
        if (used.has(edgeId(node, n))) continue;
        chains.push({ cls, source, confidence, nodes: walk(node, n) });
      }
    }
    // Anything left over is a closed loop.
    for (const [node, nbs] of adj) {
      for (const n of nbs) {
        if (used.has(edgeId(node, n))) continue;
        chains.push({ cls, source, confidence, nodes: walk(node, n) });
      }
    }
  }
  return chains;
}

/** Build the graph of hex vertices, so rivers can be snapped onto hexsides. */
function vertexGraph(hexes) {
  const nodes = new Map();     // key -> {x, y, adj:Set}
  const vkey = (p) => Math.round(p[0] / 2) + ',' + Math.round(p[1] / 2);
  const edgeHexes = new Map(); // edgeKey -> [hexKey, hexKey]
  for (const hx of hexes) {
    const poly = H.polygon(hx.i, hx.j);
    for (let k = 0; k < 6; k++) {
      const a = poly[k], b = poly[(k + 1) % 6];
      const ka = vkey(a), kb = vkey(b);
      if (!nodes.has(ka)) nodes.set(ka, { x: a[0], y: a[1], adj: new Set() });
      if (!nodes.has(kb)) nodes.set(kb, { x: b[0], y: b[1], adj: new Set() });
      nodes.get(ka).adj.add(kb);
      nodes.get(kb).adj.add(ka);
      const ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      if (!edgeHexes.has(ek)) edgeHexes.set(ek, []);
      edgeHexes.get(ek).push(hx.key);
    }
  }
  // Spatial buckets, so snapping a river point to the nearest vertex is a
  // real proximity search rather than a hash lookup that never hits.
  const CELL = 200;
  const buckets = new Map();
  for (const [k, n] of nodes) {
    const bk = Math.floor(n.x / CELL) + ',' + Math.floor(n.y / CELL);
    if (!buckets.has(bk)) buckets.set(bk, []);
    buckets.get(bk).push(k);
  }
  return { nodes, edgeHexes, vkey, buckets, cell: CELL };
}

function nearestNode(graph, x, y) {
  const bx = Math.floor(x / graph.cell), by = Math.floor(y / graph.cell);
  let best = null, bestD = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const list = graph.buckets.get((bx + dx) + ',' + (by + dy));
      if (!list) continue;
      for (const k of list) {
        const n = graph.nodes.get(k);
        const d = (n.x - x) ** 2 + (n.y - y) ** 2;
        if (d < bestD) { bestD = d; best = k; }
      }
    }
  }
  return best;
}

function shortestPath(graph, from, to, limit) {
  if (from === to) return [from];
  const prev = new Map([[from, null]]);
  let frontier = [from];
  for (let depth = 0; depth < (limit || 6) && frontier.length; depth++) {
    const next = [];
    for (const k of frontier) {
      for (const nk of graph.nodes.get(k).adj) {
        if (prev.has(nk)) continue;
        prev.set(nk, k);
        if (nk === to) {
          const path = [];
          for (let c = to; c !== null; c = prev.get(c)) path.push(c);
          return path.reverse();
        }
        next.push(nk);
      }
    }
    frontier = next;
  }
  return null;
}

/** Snap each waterway onto a chain of hexsides. */
function riverChains(hexes, waterways, graph) {
  const chains = [];
  for (const wway of waterways) {
    // Anything shorter than a couple of hexes is a farm ditch, not a feature.
    let len = 0;
    for (let i = 1; i < wway.pts.length; i++) {
      len += Math.hypot(wway.pts[i][0] - wway.pts[i - 1][0], wway.pts[i][1] - wway.pts[i - 1][1]);
    }
    if (len < H.DY * 2) continue;
    const pts = G.resample(wway.pts, H.R * 0.5);
    const seq = [];
    for (const [x, y] of pts) {
      const k = nearestNode(graph, x, y);
      if (k && seq[seq.length - 1] !== k) seq.push(k);
    }
    if (seq.length < 2) continue;
    const full = [seq[0]];
    for (let i = 1; i < seq.length; i++) {
      const path = shortestPath(graph, full[full.length - 1], seq[i], 5);
      if (!path) { continue; }
      for (let k = 1; k < path.length; k++) full.push(path[k]);
    }
    if (full.length >= 2) {
      chains.push({
        kind: wway.kind,
        name: wway.name,
        nodes: full,
        pts: full.map((k) => { const n = graph.nodes.get(k); return [n.x, n.y]; })
      });
    }
  }
  return chains;
}

module.exports = {
  buildRaster, blurRaster, dominance, normalise, hysteresis, cleanMask,
  coverFractions, seaTest, classify, roadGraph, pruneRoads, chainEdges, vertexGraph,
  riverChains, nearestNode, shortestPath
};
