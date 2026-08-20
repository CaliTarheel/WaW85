import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const H = require("../vendor/mapforge/lib/hexgrid.js");
const Render = require("../vendor/mapforge/lib/render.js");
const Board = require("../vendor/mapforge/lib/board.js");
const Dem = require("../vendor/mapforge/lib/dem.js");
const Osm = require("../vendor/mapforge/lib/osm.js");
const Terrain = require("../vendor/mapforge/lib/terrain.js");

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the finished Mapforge site", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Mapforge — Real terrain, playable hex boards<\/title>/i);
  assert.match(html, /Choose the ground\./);
  assert.match(html, /Shape the board\./);
  assert.match(html, /Read the terrain\./);
  assert.match(html, /Make the board/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("renders accessible controls and source attribution", async () => {
  const html = await (await render()).text();
  assert.match(html, /aria-label="Draggable map for choosing a board footprint"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-label="Boards wide"/);
  assert.match(html, /aria-label="Boards high"/);
  assert.match(html, /aria-label="Map data era"/);
  assert.match(html, /1985 uses dated/);
  assert.match(html, /OpenHistoricalMap/);
  assert.match(html, /full-resolution PNG/);
  assert.match(html, /OpenStreetMap/);
  assert.match(html, /github\.com\/CaliTarheel\/WaW85/);
  assert.match(html, /Stephen G\. Rider/);
  assert.match(html, /mailto:rider\.sg@gmail\.com/);
  assert.match(html, /MIT licensed/);
});

test("filters mapped features against the requested historical year", () => {
  assert.equal(Osm.parseYear("1985-07-12", "start"), 1985);
  assert.equal(Osm.parseYear("1978..1991", "end"), 1991);
  assert.equal(Osm.activeAtYear({ start_date: "1987" }, 1985), false);
  assert.equal(Osm.activeAtYear({ start_date: "1920", end_date: "1989" }, 1985), true);
  assert.equal(Osm.activeAtYear({ end_date: "1982" }, 1985), false);
  assert.equal(Osm.activeAtYear({}, 1985), true);
});

test("historical decoding keeps dated 1985 roads and excludes later or undated OHM geometry", () => {
  const footprint = { latLonToPixel: (lat, lon) => [lon, lat] };
  const geometry = [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }];
  const decoded = Osm.decode({ elements: [
    { type: "way", geometry, tags: { highway: "primary", start_date: "1950" } },
    { type: "way", geometry, tags: { highway: "secondary", start_date: "1990" } },
    { type: "way", geometry, tags: { highway: "track" } },
  ] }, footprint, { source: "openhistoricalmap", targetYear: 1985, requireDate: true });
  assert.equal(decoded.roads.length, 1);
  assert.equal(decoded.roads[0].confidence, "dated-history");
  assert.equal(decoded.counters.excludedByDate, 1);
  assert.equal(decoded.counters.excludedUndated, 1);
});

test("renders a continuous 4 by 4 board mosaic", () => {
  const board = {
    meta: {
      name: "Test",
      widthPx: H.BOARD_W * 4,
      heightPx: H.BOARD_H * 4,
      boardCols: 4,
      boardRows: 4,
      totalCols: 89,
      totalRows: 52,
      targetYear: 1985,
    },
    hexes: [],
    shapes: { hill: [], cultivated: [], rough: [], city: [], woods: [], water: [] },
    rivers: [],
    roadChains: [],
    bridges: [],
    osm: { buildings: [] },
  };
  const svg = Render.render(board);
  assert.match(svg, /width="15456" height="10552"/);
  assert.match(svg, /id="board-seams"/);
  assert.match(svg, />Test 4-4<\/text>/);
  assert.match(svg, />1985 · RECONSTRUCTED<\/text>/);
  assert.equal(H.label(88, 52), "CK52");
});

test("builds the full continuous 4 by 4 hex field", async () => {
  const originalDemLoad = Dem.load;
  const originalOsmLoad = Osm.load;
  Dem.load = async () => ({ tileCount: 0, z: 0, resolution: 1, at: () => 100 });
  Osm.load = async () => ({
    roads: [], waterways: [], water: [], cover: [], buildings: [], coastlines: [], elements: 0,
  });
  try {
    const board = await Board.build({
      lat: 50,
      lon: 9,
      boardCols: 4,
      boardRows: 4,
      rasterStride: 1024,
      rasterMarginPx: 1024,
      detrendRadiusPx: 1024,
      viewRays: 1,
      viewRangeM: 60,
      requireOsm: true,
    });
    assert.equal(board.meta.widthPx, 15456);
    assert.equal(board.meta.heightPx, 10552);
    assert.equal(board.meta.totalCols, 89);
    assert.equal(board.meta.totalRows, 52);
    assert.equal(board.stats.hexes, 4628);
  } finally {
    Dem.load = originalDemLoad;
    Osm.load = originalOsmLoad;
  }
});

test("fast terrain blur preserves the original clamped box filter", () => {
  const w = 5;
  const h = 4;
  const data = Float32Array.from({ length: w * h }, (_, index) => index * 1.75 - 4);
  const raster = { x0: 0, y0: 0, stride: 1, w, h, data };
  const actual = Terrain.blurRaster(raster, 2).data;
  const horizontal = new Float32Array(w * h);
  const expected = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++) sum += data[y * w + Math.min(w - 1, Math.max(0, x + k))];
      horizontal[y * w + x] = sum / 5;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++) sum += horizontal[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      expected[y * w + x] = sum / 5;
    }
  }
  assert.deepEqual(Array.from(actual), Array.from(expected));
});
