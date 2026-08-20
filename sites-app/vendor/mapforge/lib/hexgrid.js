'use strict';
// The World at War 85 hex grid, exactly as the VASSAL module defines it.
// Flat-top hexes in vertical columns; odd columns sit half a hex lower.

const DX = 175.52562584220442;   // column pitch
const DY = 202.89999999999566;   // row pitch, and centre-to-centre in every direction
const X0 = 3;                    // column A centre x
const Y0 = -102;                 // row 0 centre y for even columns
const R = DX / 1.5;              // 117.017 — circumradius, and the length of one side

const BOARD_W = 3864;
const BOARD_H = 2638;
const COLS = 23;                 // A..W; A and W are half-columns shared with neighbouring boards
const ROWS = 13;                 // 1..13

const M_PER_HEX = 150;                 // rules §1.3, flat-to-flat
const M_PER_PX = M_PER_HEX / DY;       // 0.73928

function center(i, j) {
  return [X0 + DX * i, Y0 + DY * j + ((i & 1) ? DY / 2 : 0)];
}

function vertex(i, j, k) {
  const [cx, cy] = center(i, j), a = Math.PI / 3 * k;
  return [cx + R * Math.cos(a), cy + (DY / 2) * Math.sin(a) / Math.sin(Math.PI / 3)];
}

function polygon(i, j) {
  const p = [];
  for (let k = 0; k < 6; k++) p.push(vertex(i, j, k));
  return p;
}

// Returned in compass order: N, NE, SE, S, SW, NW.
function neighbours(i, j) {
  const odd = i & 1;
  return [
    [i, j - 1],                      // N
    [i + 1, odd ? j : j - 1],        // NE
    [i + 1, odd ? j + 1 : j],        // SE
    [i, j + 1],                      // S
    [i - 1, odd ? j + 1 : j],        // SW
    [i - 1, odd ? j : j - 1]         // NW
  ];
}

function columnLabel(i) {
  let value = i + 1;
  let out = '';
  while (value > 0) {
    value--;
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26);
  }
  return out;
}

function label(i, j) {
  return columnLabel(i) + j;
}

function parseLabel(s) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(s.trim());
  if (!m) return null;
  let column = 0;
  for (const char of m[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
  return [column - 1, parseInt(m[2], 10)];
}

function key(i, j) { return i + ':' + j; }
function unkey(k) { const p = k.split(':'); return [+p[0], +p[1]]; }

function onBoard(i, j) { return i >= 0 && i < COLS && j >= 1 && j <= ROWS; }

// Every hex on the board, plus `margin` rings beyond it. The margin exists so
// detrending and viewshed have context that does not stop at the board edge.
function field(margin) {
  margin = margin | 0;
  const out = [];
  for (let i = -margin; i < COLS + margin; i++) {
    for (let j = 1 - margin; j <= ROWS + margin; j++) out.push([i, j]);
  }
  return out;
}

// Shared edge between two adjacent hexes, as a pair of vertex points.
// Returns null if the hexes are not neighbours.
function sharedEdge(i1, j1, i2, j2) {
  const a = polygon(i1, j1), b = polygon(i2, j2);
  const hits = [];
  for (const p of a) {
    for (const q of b) {
      if (Math.abs(p[0] - q[0]) < 0.5 && Math.abs(p[1] - q[1]) < 0.5) { hits.push(p); break; }
    }
  }
  return hits.length === 2 ? hits : null;
}

// Snap a point to the nearest hex, by centre distance.
function hexAt(x, y) {
  const iApprox = (x - X0) / DX;
  let best = null, bestD = Infinity;
  for (let i = Math.floor(iApprox) - 1; i <= Math.ceil(iApprox) + 1; i++) {
    const shift = (((i % 2) + 2) % 2) ? DY / 2 : 0;
    const jApprox = (y - Y0 - shift) / DY;
    for (let j = Math.floor(jApprox) - 1; j <= Math.ceil(jApprox) + 1; j++) {
      const [cx, cy] = center(i, j);
      const d = (cx - x) ** 2 + (cy - y) ** 2;
      if (d < bestD) { bestD = d; best = [i, j]; }
    }
  }
  return best;
}

module.exports = {
  DX, DY, X0, Y0, R, BOARD_W, BOARD_H, COLS, ROWS, M_PER_HEX, M_PER_PX,
  center, vertex, polygon, neighbours, columnLabel, label, parseLabel, key, unkey,
  onBoard, field, sharedEdge, hexAt
};
