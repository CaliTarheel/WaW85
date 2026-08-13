#!/usr/bin/env node
'use strict';
// node cli.js --lat 50.552 --lon 9.677 --bearing 0 --name "Fulda 01" --out out/fulda
const fs = require('fs');
const path = require('path');
const Board = require('./lib/board');
const Render = require('./lib/render');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    a[k] = v;
  }
  return a;
}

(async () => {
  const a = parseArgs(process.argv);
  if (!a.lat || !a.lon) {
    console.error('usage: node cli.js --lat <deg> --lon <deg> [--bearing <deg>] [--name X] [--out prefix]');
    console.error('       optional tuning: --minRelief --hillHigh --hillLow --reliefWeight');
    process.exit(1);
  }
  const params = {
    lat: +a.lat, lon: +a.lon, bearing: +(a.bearing || 0),
    name: a.name || 'Board',
    log: (m) => console.log('  ' + m)
  };
  if (a.minRelief) params.minReliefM = +a.minRelief;
  if (a.hillHigh) params.hillHigh = +a.hillHigh;
  if (a.hillLow) params.hillLow = +a.hillLow;
  if (a.reliefWeight) params.reliefWeight = +a.reliefWeight;

  console.log(`Generating board at ${params.lat}, ${params.lon} bearing ${params.bearing}deg`);
  const board = await Board.build(params);

  const out = a.out || path.join('out', 'board');
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const svg = Render.render(board);
  fs.writeFileSync(out + '.svg', svg);

  // The project file: everything needed to reload and edit, minus the art.
  const project = {
    meta: board.meta,
    stats: board.stats,
    hexes: board.hexes.filter((h) => h.onBoard).map((h) => ({
      id: h.label, i: h.i, j: h.j, terrain: h.terrain, hill: h.hill,
      obstacleHeight: h.obstacleHeight, unitHeight: h.unitHeight,
      elevM: +h.elev.toFixed(1), reliefM: +h.relief.toFixed(1), dominance: +h.dominance.toFixed(3)
    })),
    roads: board.roads.map((e) => ({ a: e.a, b: e.b, cls: e.cls, bridge: !!e.bridge })),
    rivers: board.rivers.map((r) => ({ kind: r.kind, name: r.name, nodes: r.nodes }))
  };
  fs.writeFileSync(out + '.json', JSON.stringify(project, null, 1));

  console.log('\n' + JSON.stringify(board.stats, null, 2));
  console.log(`\nwrote ${out}.svg (${(svg.length / 1024).toFixed(0)} KB) and ${out}.json`);
  console.log(`took ${(board.meta.timingMs / 1000).toFixed(1)}s`);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
