'use strict';
// Orchestrator: a lat/lon and a bearing in, a WaW85 board out.
const H = require('./hexgrid');
const G = require('./geom');
const { Footprint } = require('./geo');
const Dem = require('./dem');
const Osm = require('./osm');
const T = require('./terrain');
const Organic = require('./organic');

const DEFAULTS = {
  bearing: 0,
  hexMargin: 3,             // rings of context hexes beyond the board
  rasterStride: 24,         // px between elevation samples (~18 m)
  rasterMarginPx: 2400,     // ~1.8 km of context so detrending is not edge-biased
  detrendRadiusPx: 1900,    // ~1.4 km — comfortably wider than one hill
  minReliefM: 8,            // absolute floor; stops flat ground growing hills
  reliefWeight: 0.5,        // relief vs viewshed dominance in the hill score
  hillHigh: 0.66,           // seed threshold on the combined score
  hillLow: 0.48,            // grow threshold
  minHillHexes: 3,
  viewRangeM: 1800,
  viewRays: 24
};

async function build(params) {
  // An explicit `undefined` from a caller must not wipe out a default.
  const given = {};
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) given[k] = v;
  const o = Object.assign({}, DEFAULTS, given);
  const log = o.log || (() => {});
  const t0 = Date.now();

  const footprint = new Footprint(o.lat, o.lon, o.bearing);
  const demMarginM = o.rasterMarginPx * H.M_PER_PX + 400;

  log('fetching elevation…');
  const dem = await Dem.load(footprint.bbox(demMarginM), o.demTargetM || 14);
  log(`  ${dem.tileCount} tiles at z${dem.z}, ${dem.resolution.toFixed(1)} m/px`);

  log('fetching OpenStreetMap features…');
  let osm;
  try {
    osm = await Osm.load(footprint, 400, log);
    log(`  ${osm.elements} elements: ${osm.roads.length} roads, ${osm.waterways.length} waterways, ` +
        `${osm.water.length} water bodies, ${osm.cover.length} landcover, ${osm.buildings.length} buildings`);
  } catch (e) {
    log('  OSM unavailable (' + e.message + ') — elevation only');
    osm = { roads: [], waterways: [], water: [], cover: [], buildings: [], elements: 0 };
  }

  log('sampling elevation…');
  const raster = T.buildRaster(footprint, dem, { stride: o.rasterStride, marginPx: o.rasterMarginPx });
  const base = T.blurRaster(raster, o.detrendRadiusPx);
  log(`  ${raster.w}x${raster.h} samples, ${raster.min.toFixed(0)}–${raster.max.toFixed(0)} m`);

  // --- hex field ------------------------------------------------------------
  const hexes = H.field(o.hexMargin).map(([i, j]) => {
    const [cx, cy] = H.center(i, j);
    return { i, j, key: H.key(i, j), cx, cy, label: H.label(i, j), onBoard: H.onBoard(i, j) };
  });

  log('computing relief and viewshed dominance…');
  for (const hx of hexes) {
    hx.elev = raster.at(hx.cx, hx.cy);
    hx.relief = hx.elev - base.at(hx.cx, hx.cy);
    hx.dominance = T.dominance(raster, hx.cx, hx.cy, { rangeM: o.viewRangeM, rays: o.viewRays });
  }

  const nR = T.normalise(hexes.map((h) => h.relief));
  const nD = T.normalise(hexes.map((h) => h.dominance));
  const w = o.reliefWeight;
  for (const hx of hexes) hx.score = w * nR(hx.relief) + (1 - w) * nD(hx.dominance);

  const scoreOf = (hx) => (hx.relief >= o.minReliefM ? hx.score : -1);
  let hillMask = T.hysteresis(hexes, scoreOf, o.hillHigh, o.hillLow);
  hillMask = T.cleanMask(hexes, hillMask, o.minHillHexes);
  for (const hx of hexes) hx.hill = hillMask.has(hx.key);

  // --- land cover -----------------------------------------------------------
  log('classifying land cover…');
  T.coverFractions(hexes, osm);
  T.classify(hexes, o.coverThresholds);

  // --- linear features ------------------------------------------------------
  log('tracing roads and rivers…');
  const allRoads = T.roadGraph(hexes, osm.roads);
  const roads = T.pruneRoads(allRoads, o.maxRoadDegree || 3);
  const roadChains = T.chainEdges(roads);
  const graph = T.vertexGraph(hexes);
  const rivers = T.riverChains(hexes, osm.waterways, graph);
  log(`  ${allRoads.length} road edges -> ${roads.length} kept in ${roadChains.length} runs, ${rivers.length} river chains`);

  // Bridges: a road edge whose shared hexside carries a river.
  const riverEdges = new Set();
  for (const ch of rivers) {
    for (let i = 1; i < ch.nodes.length; i++) {
      const a = ch.nodes[i - 1], b = ch.nodes[i];
      riverEdges.add(a < b ? a + '|' + b : b + '|' + a);
    }
  }
  const bridges = [];
  for (const e of roads) {
    const [ai, aj] = H.unkey(e.a), [bi, bj] = H.unkey(e.b);
    const shared = H.sharedEdge(ai, aj, bi, bj);
    if (!shared) continue;
    const ka = graph.vkey(shared[0]), kb = graph.vkey(shared[1]);
    const id = ka < kb ? ka + '|' + kb : kb + '|' + ka;
    if (riverEdges.has(id)) {
      bridges.push({ at: [(shared[0][0] + shared[1][0]) / 2, (shared[0][1] + shared[1][1]) / 2], edge: e });
      e.bridge = true;
    }
  }

  // --- final terrain names --------------------------------------------------
  for (const hx of hexes) {
    if (hx.base === 'water') hx.terrain = 'water';
    else if (hx.hill && hx.base === 'city') hx.terrain = 'hill-city';
    else if (hx.hill && hx.base === 'woods') hx.terrain = 'hill-woods';
    else if (hx.hill) hx.terrain = 'hill';
    else hx.terrain = hx.base;
    hx.obstacleHeight = { clear: 0, cultivated: 0, rough: 0, city: 1, woods: 1, hill: 2, 'hill-city': 3, 'hill-woods': 3, water: -1 }[hx.terrain];
    hx.unitHeight = hx.terrain === 'water' ? -1 : hx.hill ? 2 : 0;
  }

  // --- organic shapes for the renderer -------------------------------------
  log('growing organic shapes…');
  const onBoardOf = (pred) => new Set(hexes.filter((hx) => pred(hx)).map((hx) => hx.key));
  const shapes = {
    hill: Organic.shapesFor(onBoardOf((h) => h.hill), { outset: 10, smooth: 2, noiseAmp: 16, noiseScale: 150, seed: 11 }),
    woods: Organic.shapesFor(onBoardOf((h) => h.base === 'woods'), { outset: 4, smooth: 2, noiseAmp: 20, noiseScale: 90, seed: 23 }),
    cultivated: Organic.shapesFor(onBoardOf((h) => h.base === 'cultivated'), { outset: 2, smooth: 1, noiseAmp: 8, noiseScale: 200, seed: 37 }),
    rough: Organic.shapesFor(onBoardOf((h) => h.base === 'rough'), { outset: 3, smooth: 2, noiseAmp: 18, noiseScale: 110, seed: 53 }),
    city: Organic.shapesFor(onBoardOf((h) => h.base === 'city'), { outset: 2, smooth: 2, noiseAmp: 10, noiseScale: 130, seed: 67 }),
    water: Organic.shapesFor(onBoardOf((h) => h.base === 'water'), { outset: 4, smooth: 3, noiseAmp: 12, noiseScale: 160, seed: 71 })
  };

  const counts = {};
  for (const hx of hexes) if (hx.onBoard) counts[hx.terrain] = (counts[hx.terrain] || 0) + 1;
  const boardHexes = hexes.filter((h) => h.onBoard);

  return {
    meta: {
      name: o.name || 'Untitled',
      lat: o.lat, lon: o.lon, bearing: o.bearing,
      widthPx: H.BOARD_W, heightPx: H.BOARD_H,
      mPerPx: H.M_PER_PX, mPerHex: H.M_PER_HEX,
      widthM: footprint.widthM, heightM: footprint.heightM,
      bbox: footprint.bbox(0),
      demZoom: dem.z, demResolutionM: dem.resolution,
      elevationRange: [raster.min, raster.max],
      generatedAt: new Date().toISOString(),
      options: o,
      timingMs: Date.now() - t0
    },
    stats: {
      hexes: boardHexes.length,
      terrain: counts,
      hillHexes: boardHexes.filter((h) => h.hill).length,
      hillPercent: +(100 * boardHexes.filter((h) => h.hill).length / boardHexes.length).toFixed(1),
      roadEdges: roads.length,
      riverChains: rivers.length,
      bridges: bridges.length,
      fallbackShapes: Object.values(shapes).flat().filter((s) => s.fallback).length
    },
    hexes, roads, roadChains, rivers, bridges, shapes,
    osm: { buildings: osm.buildings, roads: osm.roads }
  };
}

module.exports = { build, DEFAULTS };
