'use strict';
// The contour is rules-load-bearing: a hex is a hill hex because its centre is
// inside the line. This checks that the smoothed, wobbled art still agrees with
// the hex state it was generated from — for every terrain class, not just hills.
const H = require('./lib/hexgrid');
const G = require('./lib/geom');
const Organic = require('./lib/organic');
const Board = require('./lib/board');

const SITES = [
  { name: 'Rasdorf', lat: 50.7180, lon: 9.9100, bearing: 0 },
  { name: 'Rasdorf-rot', lat: 50.7180, lon: 9.9100, bearing: 25 },
  { name: 'Fulda', lat: 50.5520, lon: 9.6770, bearing: 0 }
];

const CLASS_OF = {
  hill: (h) => h.hill,
  woods: (h) => h.base === 'woods',
  cultivated: (h) => h.base === 'cultivated',
  rough: (h) => h.base === 'rough',
  city: (h) => h.base === 'city',
  water: (h) => h.base === 'water'
};

(async () => {
  let failures = 0;
  for (const site of SITES) {
    const board = await Board.build(Object.assign({ log: () => {} }, site));
    const byKey = new Map(board.hexes.map((h) => [h.key, h]));
    const lines = [];

    for (const [cls, pred] of Object.entries(CLASS_OF)) {
      const shapes = board.shapes[cls];
      if (!shapes || !shapes.length) continue;
      let wrongIn = 0, wrongOut = 0, checked = 0;

      for (const s of shapes) {
        const member = new Set(s.hexes);
        // Every hex of this component must be inside its own outline.
        for (const k of s.hexes) {
          const [i, j] = H.unkey(k);
          const [cx, cy] = H.center(i, j);
          checked++;
          if (!Organic.shapeCovers(s, cx, cy)) wrongIn++;
        }
        // Every neighbouring hex that is NOT of this class must be outside it.
        for (const k of s.hexes) {
          const [i, j] = H.unkey(k);
          for (const [ni, nj] of H.neighbours(i, j)) {
            const nk = H.key(ni, nj);
            if (member.has(nk)) continue;
            const nb = byKey.get(nk);
            if (!nb || pred(nb)) continue;
            const [cx, cy] = H.center(ni, nj);
            checked++;
            if (Organic.shapeCovers(s, cx, cy)) wrongOut++;
          }
        }
      }
      const bad = wrongIn + wrongOut;
      failures += bad;
      lines.push(`    ${cls.padEnd(11)} ${String(shapes.length).padStart(3)} shapes  ${String(checked).padStart(4)} centres checked  ` +
                 (bad ? `FAIL  ${wrongIn} missing, ${wrongOut} intruding` : 'ok'));
    }

    console.log(`\n  ${site.name}  (${site.lat}, ${site.lon} @ ${site.bearing}deg)`);
    console.log(`    hexes ${board.stats.hexes}, hill ${board.stats.hillPercent}%, ` +
                `fallback shapes ${board.stats.fallbackShapes}`);
    lines.forEach((l) => console.log(l));
  }
  console.log(failures ? `\n${failures} CENTRE(S) ON THE WRONG SIDE OF AN OUTLINE` : '\nall outlines agree with hex state');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
