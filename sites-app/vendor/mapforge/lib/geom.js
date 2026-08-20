'use strict';
// Small 2D helpers. Everything here works in board pixel space.

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  }
  return Math.abs(a) / 2;
}

function dist2ToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx, qy = ay + t * dy;
  return (px - qx) ** 2 + (py - qy) ** 2;
}

/** Insert points so no segment is longer than `step`. */
function resample(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1], b = pts[i];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}

/**
 * Douglas-Peucker. Roads routed hex-centre to hex-centre climb a staircase
 * whenever the real road runs at a shallow angle to the lattice; dropping the
 * points that sit on the line straightens the run without moving the ends.
 */
function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    let far = -1, farD = tol2;
    for (let i = a + 1; i < b; i++) {
      const d = dist2ToSegment(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d > farD) { farD = d; far = i; }
    }
    if (far !== -1) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Which side of a directed segment a point falls on. Board space has y running
 * down, which flips the usual handedness: here a POSITIVE result means the
 * point is to the right of a->b.
 */
function sideOfSegment(px, py, ax, ay, bx, by) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

/** Uniform bucket index over polygons, so per-point tests stay cheap. */
class PolyIndex {
  constructor(items, cell) {
    this.cell = cell || 400;
    this.buckets = new Map();
    this.items = items;
    items.forEach((it, idx) => {
      const [x0, y0, x1, y1] = bboxOf(it.pts);
      it._bbox = [x0, y0, x1, y1];
      for (let bx = Math.floor(x0 / this.cell); bx <= Math.floor(x1 / this.cell); bx++) {
        for (let by = Math.floor(y0 / this.cell); by <= Math.floor(y1 / this.cell); by++) {
          const k = bx + ',' + by;
          if (!this.buckets.has(k)) this.buckets.set(k, []);
          this.buckets.get(k).push(idx);
        }
      }
    });
  }

  /** Every indexed item whose polygon contains the point. */
  hits(x, y) {
    const k = Math.floor(x / this.cell) + ',' + Math.floor(y / this.cell);
    const cand = this.buckets.get(k);
    if (!cand) return [];
    const out = [];
    for (const idx of cand) {
      const it = this.items[idx];
      const b = it._bbox;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (pointInPoly(x, y, it.pts)) out.push(it);
    }
    return out;
  }
}

/** Chaikin corner cutting. `closed` keeps the ring closed. */
function chaikin(pts, iterations, closed) {
  let cur = pts;
  for (let it = 0; it < (iterations || 1); it++) {
    const next = [];
    const n = cur.length;
    const last = closed ? n : n - 1;
    if (!closed) next.push(cur[0]);
    for (let i = 0; i < last; i++) {
      const a = cur[i], b = cur[(i + 1) % n];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) next.push(cur[n - 1]);
    cur = next;
  }
  return cur;
}

/** Push a closed ring outward along its vertex normals. */
function outset(ring, d) {
  const n = ring.length;
  return ring.map((p, i) => {
    const a = ring[(i - 1 + n) % n], b = ring[(i + 1) % n];
    let nx = b[1] - a[1], ny = -(b[0] - a[0]);
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    return [p[0] + nx * d, p[1] + ny * d];
  });
}

/** Signed area; positive means counter-clockwise in screen coords (y down). */
function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

/** Cheap deterministic value noise, so a given board always renders the same. */
function makeNoise(seed) {
  let s = (seed || 1) >>> 0;
  const rand = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const table = new Float64Array(512);
  for (let i = 0; i < 512; i++) table[i] = rand() * 2 - 1;
  return function noise1(t) {
    const i = Math.floor(t), f = t - i;
    const a = table[((i % 512) + 512) % 512], b = table[(((i + 1) % 512) + 512) % 512];
    const u = f * f * (3 - 2 * f);
    return a * (1 - u) + b * u;
  };
}

function pathD(pts, closed) {
  if (!pts.length) return '';
  let d = 'M' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
  for (let i = 1; i < pts.length; i++) d += 'L' + pts[i][0].toFixed(1) + ',' + pts[i][1].toFixed(1);
  return closed ? d + 'Z' : d;
}

module.exports = {
  bboxOf, pointInPoly, polyArea, dist2ToSegment, resample, simplify, sideOfSegment,
  PolyIndex, chaikin, outset, signedArea, makeNoise, pathD
};
