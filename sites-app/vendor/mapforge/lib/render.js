'use strict';
// Board -> layered SVG, in the WaW85 draw order. Every layer is a top-level
// <g id="..."> so it maps one-to-one onto a PSD layer later.
const H = require('./hexgrid');
const G = require('./geom');

const PALETTE = {
  clear: '#6C793B',
  clearAlt: '#75824A',
  woods: '#3E4D26',
  woodsLight: '#4C5E30',
  hill: '#B3B768',
  cultivated: '#8C8A4E',
  cultivatedAlt: '#9C9A5C',
  rough: '#7D815C',
  city: '#6A6A52',
  water: '#71A08C',
  bank: '#B2A06A',
  road: '#7C7C74',
  roadMajor: '#8A8A82',
  trail: '#A79A72',
  bridge: '#4A463C',
  roofA: '#9A4A2A',
  roofB: '#61645C',
  grid: '#FFFFFF',
  shadow: '#28301A'
};

function esc(s) { return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

function rng(seed) {
  let s = (seed || 1) >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function clipToBoard(inner) {
  return `<g clip-path="url(#board)">${inner}</g>`;
}

function shapeD(s) { return s.rings.map((r) => G.pathD(r, true)).join(' '); }
function shapePath(shapes) { return shapes.map(shapeD).join(' '); }

function render(board, opts) {
  const o = Object.assign({ labels: true, grid: true, buildings: true, maxBuildings: 6000 }, opts || {});
  const W = board.meta.widthPx || H.BOARD_W;
  const Ht = board.meta.heightPx || H.BOARD_H;
  const boardCols = board.meta.boardCols || 1;
  const boardRows = board.meta.boardRows || 1;
  const totalCols = board.meta.totalCols || H.COLS;
  const totalRows = board.meta.totalRows || H.ROWS;
  const L = [];
  const onBoard = board.hexes.filter((h) => h.onBoard);
  const byKey = new Map(board.hexes.map((h) => [h.key, h]));

  // ---------------------------------------------------------------- defs
  L.push(`<defs>
    <clipPath id="board"><rect x="0" y="0" width="${W}" height="${Ht}"/></clipPath>
    <filter id="hillShadow" x="-25%" y="-25%" width="150%" height="160%">
      <feDropShadow dx="0" dy="30" stdDeviation="38" flood-color="${PALETTE.shadow}" flood-opacity="0.42"/>
    </filter>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="18"/>
    </filter>
    <filter id="softer" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="34"/>
    </filter>
  </defs>`);

  // ------------------------------------------------------------- 1 ground
  {
    const r = rng(9001);
    let blobs = '';
    for (let n = 0; n < 260; n++) {
      const x = r() * W, y = r() * Ht, rr = 60 + r() * 190;
      blobs += `<ellipse cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" rx="${rr.toFixed(0)}" ry="${(rr * 0.7).toFixed(0)}" fill="${PALETTE.clearAlt}" opacity="0.28"/>`;
    }
    L.push(`<g id="ground"><rect x="0" y="0" width="${W}" height="${Ht}" fill="${PALETTE.clear}"/>${clipToBoard(`<g filter="url(#soft)">${blobs}</g>`)}</g>`);
  }

  // --------------------------------------------------------------- 2 hill
  if (board.shapes.hill.length) {
    const d = shapePath(board.shapes.hill);
    L.push(`<g id="hill">${clipToBoard(
      `<path d="${d}" fill="${PALETTE.hill}" fill-opacity="0.62" filter="url(#hillShadow)" fill-rule="evenodd"/>` +
      `<path d="${d}" fill="${PALETTE.hill}" fill-opacity="0.30" filter="url(#softer)" fill-rule="evenodd"/>`
    )}</g>`);
    L.push(`<g id="hill-contours">${clipToBoard(
      `<path d="${d}" fill="none" stroke="${PALETTE.grid}" stroke-opacity="0.72" stroke-width="3.8" fill-rule="evenodd"/>`
    )}</g>`);
  } else {
    L.push('<g id="hill"></g><g id="hill-contours"></g>');
  }

  // -------------------------------------------------------- 3 cultivated
  {
    let inner = '';
    const r = rng(4242);
    for (const s of board.shapes.cultivated) {
      inner += `<path d="${shapeD(s)}" fill="${PALETTE.cultivated}" fill-opacity="0.92" fill-rule="evenodd"/>`;
      // Field parcels: chop each hex into a couple of tinted quads.
      for (const k of s.hexes) {
        const [i, j] = H.unkey(k);
        const poly = H.polygon(i, j);
        const [cx, cy] = H.center(i, j);
        for (let n = 0; n < 3; n++) {
          const a = r() * Math.PI, w1 = 40 + r() * 90, h1 = 50 + r() * 110;
          const ox = (r() - 0.5) * 90, oy = (r() - 0.5) * 90;
          inner += `<rect x="${(cx + ox - w1 / 2).toFixed(0)}" y="${(cy + oy - h1 / 2).toFixed(0)}" width="${w1.toFixed(0)}" height="${h1.toFixed(0)}" ` +
                   `transform="rotate(${(a * 57.3).toFixed(1)} ${(cx + ox).toFixed(0)} ${(cy + oy).toFixed(0)})" ` +
                   `fill="${PALETTE.cultivatedAlt}" fill-opacity="${(0.25 + r() * 0.4).toFixed(2)}"/>`;
        }
        void poly;
      }
    }
    L.push(`<g id="cultivated">${clipToBoard(inner)}</g>`);
  }

  // -------------------------------------------------------------- 4 rough
  {
    let inner = '';
    const r = rng(818);
    for (const s of board.shapes.rough) {
      inner += `<path d="${shapeD(s)}" fill="${PALETTE.rough}" fill-opacity="0.95" fill-rule="evenodd"/>`;
      for (const k of s.hexes) {
        const [i, j] = H.unkey(k);
        const [cx, cy] = H.center(i, j);
        for (let n = 0; n < 90; n++) {
          const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * H.R * 0.85;
          inner += `<circle cx="${(cx + Math.cos(a) * rad).toFixed(0)}" cy="${(cy + Math.sin(a) * rad * 0.87).toFixed(0)}" r="${(2 + r() * 5).toFixed(1)}" fill="#9AA07C" opacity="${(0.2 + r() * 0.4).toFixed(2)}"/>`;
        }
      }
    }
    L.push(`<g id="rough">${clipToBoard(inner)}</g>`);
  }

  // ---------------------------------------------------- 4b built-up ground
  {
    let inner = '';
    for (const s of board.shapes.city) {
      inner += `<path d="${shapeD(s)}" fill="${PALETTE.city}" fill-opacity="0.5" fill-rule="evenodd"/>`;
    }
    L.push(`<g id="built-up">${clipToBoard(inner)}</g>`);
  }

  // -------------------------------------------------------------- 5 woods
  {
    let inner = '';
    const r = rng(1357);
    for (const s of board.shapes.woods) {
      inner += `<path d="${shapeD(s)}" fill="${PALETTE.woods}" fill-rule="evenodd"/>`;
    }
    for (const s of board.shapes.woods) {
      for (const k of s.hexes) {
        const [i, j] = H.unkey(k);
        const [cx, cy] = H.center(i, j);
        for (let n = 0; n < 26; n++) {
          const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * H.R * 0.9;
          const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad * 0.86;
          const rr = 14 + r() * 22;
          inner += `<circle cx="${x.toFixed(0)}" cy="${(y + rr * 0.35).toFixed(0)}" r="${rr.toFixed(0)}" fill="#26301A" opacity="0.5"/>`;
          inner += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${rr.toFixed(0)}" fill="${PALETTE.woodsLight}" opacity="${(0.55 + r() * 0.4).toFixed(2)}"/>`;
        }
      }
    }
    L.push(`<g id="woods">${clipToBoard(inner)}</g>`);
  }

  // -------------------------------------------------------------- 6 water
  {
    let inner = '';
    for (const s of board.shapes.water) {
      inner += `<path d="${shapeD(s)}" fill="${PALETTE.bank}" stroke="${PALETTE.bank}" stroke-width="26" fill-rule="evenodd"/>`;
    }
    for (const s of board.shapes.water) {
      inner += `<path d="${shapeD(s)}" fill="${PALETTE.water}" fill-rule="evenodd"/>`;
    }
    L.push(`<g id="water">${clipToBoard(inner)}</g>`);
  }

  // ------------------------------------------------------------- 7 rivers
  {
    let banks = '', flow = '';
    for (const ch of board.rivers) {
      // The snapped path is a hard hexside zigzag; four rounds of corner
      // cutting turn it into something that looks like water.
      const pts = G.chaikin(ch.pts, 4, false);
      const d = G.pathD(pts, false);
      const wide = ch.kind === 'river' || ch.kind === 'canal';
      banks += `<path d="${d}" fill="none" stroke="${PALETTE.bank}" stroke-width="${wide ? 46 : 32}" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>`;
      flow += `<path d="${d}" fill="none" stroke="${PALETTE.water}" stroke-width="${wide ? 24 : 13}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    L.push(`<g id="rivers">${clipToBoard(banks + flow)}</g>`);
  }

  // ---------------------------------------------------------- 8 buildings
  if (o.buildings && board.osm.buildings.length) {
    const r = rng(2468);
    let inner = '';
    let n = 0;
    for (const b of board.osm.buildings) {
      if (n++ > o.maxBuildings) break;
      const bb = G.bboxOf(b.pts);
      if (bb[2] < -100 || bb[0] > W + 100 || bb[3] < -100 || bb[1] > Ht + 100) continue;
      const [i, j] = H.hexAt((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2);
      const hx = byKey.get(H.key(i, j));
      if (!hx || (hx.base !== 'city' && hx.buildingFrac < 0.05)) continue;
      const fill = r() < 0.5 ? PALETTE.roofA : PALETTE.roofB;
      inner += `<path d="${G.pathD(b.pts, true)}" fill="${fill}" fill-opacity="0.92" stroke="#241F19" stroke-width="1.2" stroke-opacity="0.45"/>`;
    }
    L.push(`<g id="buildings">${clipToBoard(inner)}</g>`);
  } else L.push('<g id="buildings"></g>');

  // -------------------------------------------------------------- 9 roads
  {
    const widths = { major: 24, rail: 17, road: 16, minor: 11, trail: 8 };
    const colours = { major: PALETTE.roadMajor, rail: '#312d28', road: PALETTE.road, minor: PALETTE.road, trail: PALETTE.trail };
    // Roads are drawn as whole runs, not per-edge, so junctions flow instead of
    // meeting at hard hex angles.
    const noise = G.makeNoise(31337);
    let inner = '';
    for (const ch of board.roadChains) {
      let pts = ch.nodes.map((k, n) => {
        const [i, j] = H.unkey(k);
        const [cx, cy] = H.center(i, j);
        // Interior points wander; the ends stay pinned to their hex centres.
        const edge = n === 0 || n === ch.nodes.length - 1;
        const w = edge ? 0 : 20;
        return [cx + noise((i * 3.1 + j * 1.7)) * w, cy + noise((i * 2.3 + j * 4.1) + 99) * w];
      });
      if (pts.length < 2) continue;
      // Drop the staircase steps a hex-centre route creates when the real road
      // runs at a shallow angle to the lattice; the ends stay pinned.
      pts = G.simplify(pts, H.R * 0.42);
      pts = G.chaikin(pts, 3, false);
      const d = G.pathD(pts, false);
      const provenance = ` data-source="${ch.source || 'openstreetmap'}" data-confidence="${ch.confidence || 'current'}"`;
      const fallbackOpacity = ch.confidence === 'present-day-fallback' ?
        ` stroke-opacity="${ch.cls === 'trail' ? '0.65' : '0.78'}"` :
        (ch.cls === 'trail' ? ' stroke-opacity="0.75"' : '');
      inner += `<path d="${d}" fill="none" stroke="${colours[ch.cls]}" stroke-width="${widths[ch.cls]}" ` +
               `stroke-linecap="round" stroke-linejoin="round"${provenance}${fallbackOpacity}` +
               (ch.cls === 'trail' ? ' stroke-dasharray="30 20"' : '') + '/>';
      if (ch.cls === 'rail') {
        inner += `<path d="${d}" fill="none" stroke="#c3b98e" stroke-width="5" stroke-dasharray="8 14" ` +
                 `stroke-linecap="butt" stroke-linejoin="round"${provenance}${fallbackOpacity}/>`;
      }
    }
    L.push(`<g id="roads">${clipToBoard(inner)}</g>`);
  }

  // ----------------------------------------------------------- 10 bridges
  {
    let inner = '';
    for (const br of board.bridges) {
      const [ai, aj] = H.unkey(br.edge.a), [bi, bj] = H.unkey(br.edge.b);
      const a = H.center(ai, aj), b = H.center(bi, bj);
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const hl = 34;
      inner += `<line x1="${(br.at[0] - Math.cos(ang) * hl).toFixed(1)}" y1="${(br.at[1] - Math.sin(ang) * hl).toFixed(1)}" ` +
               `x2="${(br.at[0] + Math.cos(ang) * hl).toFixed(1)}" y2="${(br.at[1] + Math.sin(ang) * hl).toFixed(1)}" ` +
               `stroke="${PALETTE.bridge}" stroke-width="34"/>`;
    }
    L.push(`<g id="bridges">${clipToBoard(inner)}</g>`);
  }

  // -------------------------------------------------------------- 11 grid
  if (o.grid) {
    // As printed: three ~30 px spurs at every vertex, not continuous outlines.
    const drawn = new Set();
    let inner = '';
    const t = 30 / H.R;
    for (const hx of board.hexes) {
      if (hx.i < -1 || hx.i > totalCols || hx.j < 0 || hx.j > totalRows + 1) continue;
      const poly = H.polygon(hx.i, hx.j);
      for (let k = 0; k < 6; k++) {
        const a = poly[k], b = poly[(k + 1) % 6];
        const id = [a, b].map((p) => Math.round(p[0] / 3) + '_' + Math.round(p[1] / 3)).sort().join('#');
        if (drawn.has(id)) continue;
        drawn.add(id);
        const a2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const b2 = [b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t];
        inner += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${a2[0].toFixed(1)}" y2="${a2[1].toFixed(1)}"/>`;
        inner += `<line x1="${b[0].toFixed(1)}" y1="${b[1].toFixed(1)}" x2="${b2[0].toFixed(1)}" y2="${b2[1].toFixed(1)}"/>`;
      }
    }
    L.push(`<g id="grid">${clipToBoard(`<g stroke="${PALETTE.grid}" stroke-opacity="0.42" stroke-width="3.6" stroke-linecap="round">${inner}</g>`)}</g>`);
  } else L.push('<g id="grid"></g>');

  // -------------------------------------------------------- 11b board seams
  if (boardCols > 1 || boardRows > 1) {
    let inner = '';
    for (let col = 1; col < boardCols; col++) {
      const x = H.BOARD_W * col;
      inner += `<line x1="${x}" y1="0" x2="${x}" y2="${Ht}"/>`;
    }
    for (let row = 1; row < boardRows; row++) {
      const y = H.BOARD_H * row;
      inner += `<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`;
    }
    L.push(`<g id="board-seams" stroke="${PALETTE.grid}" stroke-opacity="0.62" stroke-width="7" stroke-dasharray="30 20">${inner}</g>`);
  } else L.push('<g id="board-seams"></g>');

  // ------------------------------------------------------------ 12 labels
  if (o.labels) {
    let inner = '';
    for (const hx of onBoard) {
      inner += `<text x="${hx.cx.toFixed(0)}" y="${(hx.cy - 62).toFixed(0)}" text-anchor="middle" ` +
               `font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="600" ` +
               `fill="${PALETTE.grid}" fill-opacity="0.55">${hx.label}</text>`;
    }
    L.push(`<g id="labels">${clipToBoard(inner)}</g>`);
  } else L.push('<g id="labels"></g>');

  // ------------------------------------------------------------ 13 margin
  {
    let inner = '';
    for (let row = 0; row < boardRows; row++) {
      for (let col = 0; col < boardCols; col++) {
        const suffix = boardCols === 1 && boardRows === 1 ? '' : ` ${row + 1}-${col + 1}`;
        inner += `<text x="${col * H.BOARD_W + 86}" y="${(row + 1) * H.BOARD_H - 60}" font-family="Arial, Helvetica, sans-serif" font-size="120" font-weight="700" fill="${PALETTE.grid}" fill-opacity="0.72">${esc(board.meta.name).slice(0, 12)}${suffix}</text>`;
        if (board.meta.targetYear) {
          inner += `<text x="${(col + 1) * H.BOARD_W - 86}" y="${(row + 1) * H.BOARD_H - 60}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="44" font-weight="600" letter-spacing="5" fill="${PALETTE.grid}" fill-opacity="0.66">${board.meta.targetYear} · RECONSTRUCTED</text>`;
        }
      }
    }
    L.push(`<g id="sheet-id">${inner}</g>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Ht}" viewBox="0 0 ${W} ${Ht}">\n${L.join('\n')}\n</svg>`;
}

module.exports = { render, PALETTE };
