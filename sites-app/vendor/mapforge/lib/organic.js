'use strict';
// Turn a set of hexes into the kind of soft, hand-drawn outline the printed
// boards use — while guaranteeing the shape still contains exactly the hexes
// it is supposed to. The contour is rules-load-bearing, so art is never
// allowed to disagree with state.
const H = require('./hexgrid');
const G = require('./geom');

function vkey(p) { return Math.round(p[0] / 2) + ',' + Math.round(p[1] / 2); }

/** Boundary rings of a hex set, as closed polygons of hex vertices. */
function rings(hexKeys) {
  const set = hexKeys instanceof Set ? hexKeys : new Set(hexKeys);
  const edges = new Map();   // "a|b" -> [ptA, ptB]
  for (const k of set) {
    const [i, j] = H.unkey(k);
    const poly = H.polygon(i, j);
    const nb = H.neighbours(i, j);
    for (let e = 0; e < 6; e++) {
      // Edge e runs between vertex e and vertex e+1; it is shared with the
      // neighbour that lies on that side.
      const a = poly[e], b = poly[(e + 1) % 6];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      let owner = null;
      for (const [ni, nj] of nb) {
        const [ncx, ncy] = H.center(ni, nj);
        const [cx, cy] = H.center(i, j);
        const mx = (cx + ncx) / 2, my = (cy + ncy) / 2;
        if (Math.abs(mx - mid[0]) < 2 && Math.abs(my - mid[1]) < 2) { owner = H.key(ni, nj); break; }
      }
      if (owner && set.has(owner)) continue;      // interior edge
      const ka = vkey(a), kb = vkey(b);
      edges.set(ka + '|' + kb, [a, b]);
    }
  }

  // Chain the boundary edges head-to-tail.
  const outgoing = new Map();
  for (const [id, seg] of edges) {
    const [ka] = id.split('|');
    if (!outgoing.has(ka)) outgoing.set(ka, []);
    outgoing.get(ka).push({ id, seg });
  }
  const used = new Set();
  const out = [];
  for (const [id, seg] of edges) {
    if (used.has(id)) continue;
    const ring = [seg[0]];
    let cur = id, guard = 0;
    while (cur && !used.has(cur) && guard++ < 20000) {
      used.add(cur);
      const s = edges.get(cur);
      ring.push(s[1]);
      const nextKey = vkey(s[1]);
      const cand = (outgoing.get(nextKey) || []).find((c) => !used.has(c.id));
      cur = cand ? cand.id : null;
    }
    if (ring.length > 3) {
      // Drop the duplicated closing point.
      if (vkey(ring[0]) === vkey(ring[ring.length - 1])) ring.pop();
      out.push(ring);
    }
  }
  return out;
}

/** Smooth one ring and give it a hand-drawn wobble. */
function buildRing(ring, push, amp, smooth, noiseScale, seed) {
  const noise = G.makeNoise(seed);
  // A hole winds the opposite way to its outer ring, so the same push value
  // grows the filled area in both cases.
  let pts = G.chaikin(G.outset(ring, push), smooth, true);
  if (amp > 0.5) {
    let t = 0;
    const wobbled = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], prev = pts[(i - 1 + pts.length) % pts.length], next = pts[(i + 1) % pts.length];
      if (i > 0) t += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      const nx = next[1] - prev[1], ny = -(next[0] - prev[0]);
      const len = Math.hypot(nx, ny) || 1;
      const d = noise(t / noiseScale) * amp;
      wobbled.push([p[0] + (nx / len) * d, p[1] + (ny / len) * d]);
    }
    pts = wobbled;
  }
  return G.chaikin(pts, 1, true);
}

/**
 * Smooth and rough up every ring of one component together, then verify the
 * combined even-odd shape still separates `inside` centres from `outside`
 * ones. A component with enclosed holes is only correct when its outline and
 * its holes are judged as one shape. Noise is backed off until it holds.
 */
function organicComponent(compRings, opts) {
  const o = Object.assign({
    outset: 6, smooth: 2, noiseAmp: 14, noiseScale: 140, seed: 1,
    inside: [], outside: []
  }, opts || {});

  for (let attempt = 0; attempt < 5; attempt++) {
    const amp = o.noiseAmp * (1 - attempt * 0.25);
    const push = o.outset * (1 - attempt * 0.15);
    const built = compRings.map((r, n) => buildRing(r, push, amp, o.smooth, o.noiseScale, o.seed + n));
    const covers = (x, y) => built.reduce((n, pts) => n + (G.pointInPoly(x, y, pts) ? 1 : 0), 0) % 2 === 1;
    const okIn = o.inside.every((c) => covers(c[0], c[1]));
    const okOut = o.outside.every((c) => !covers(c[0], c[1]));
    if (okIn && okOut) return { rings: built, attempt, amp };
  }
  // Last resort: the raw hex outlines always satisfy the constraint.
  return { rings: compRings.map((r) => G.chaikin(r, 1, true)), attempt: 5, amp: 0 };
}

/** Connected components of a hex set, under hex adjacency. */
function components(hexKeys) {
  const set = hexKeys instanceof Set ? hexKeys : new Set(hexKeys);
  const seen = new Set(), out = [];
  for (const k of set) {
    if (seen.has(k)) continue;
    const comp = [], stack = [k];
    seen.add(k);
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      const [i, j] = H.unkey(c);
      for (const [ni, nj] of H.neighbours(i, j)) {
        const nk = H.key(ni, nj);
        if (set.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    out.push(comp);
  }
  return out;
}

/**
 * Full pipeline for one terrain class: components -> boundary rings ->
 * organic outlines that still contain the right hex centres.
 */
function shapesFor(hexKeys, opts) {
  const set = hexKeys instanceof Set ? hexKeys : new Set(hexKeys);
  const out = [];
  let seed = (opts && opts.seed) || 1;
  for (const comp of components(set)) {
    const compSet = new Set(comp);
    const inside = comp.map((k) => { const [i, j] = H.unkey(k); return H.center(i, j); });
    const outsideKeys = new Set();
    for (const k of comp) {
      const [i, j] = H.unkey(k);
      for (const [ni, nj] of H.neighbours(i, j)) {
        const nk = H.key(ni, nj);
        if (!set.has(nk)) outsideKeys.add(nk);
      }
    }
    const outside = Array.from(outsideKeys).map((k) => { const [i, j] = H.unkey(k); return H.center(i, j); });
    const compRings = rings(compSet);
    const res = organicComponent(compRings, Object.assign({}, opts, { seed: seed, inside, outside }));
    seed += compRings.length + 1;
    out.push({ rings: res.rings, hexes: comp, fallback: res.attempt >= 5 });
    void compSet;
  }
  return out;
}

/** Even-odd containment test against a whole component (outline minus holes). */
function shapeCovers(shape, x, y) {
  return shape.rings.reduce((n, pts) => n + (G.pointInPoly(x, y, pts) ? 1 : 0), 0) % 2 === 1;
}

module.exports = { rings, buildRing, organicComponent, components, shapesFor, shapeCovers };
