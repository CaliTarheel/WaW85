'use strict';
// Elevation from AWS Terrain Tiles ("terrarium" encoding):
//   metres = (R * 256 + G + B / 256) - 32768
// Global, no key, and a bare-earth-ish blend. Good enough to find which ground
// commands; see SPEC for why a true DTM would be better.
const png = require('./png');
const net = require('./net');
const geo = require('./geo');

const BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

async function tile(z, x, y) {
  const buf = await net.cached('dem', `${z}_${x}_${y}`, '.png', `${BASE}/${z}/${x}/${y}.png`);
  const img = png.decode(buf);
  const { width: w, height: h, channels: ch, data } = img;
  const elev = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    elev[i] = (data[i * ch] * 256 + data[i * ch + 1] + data[i * ch + 2] / 256) - 32768;
  }
  return { z, x, y, w, h, elev };
}

class Dem {
  constructor(z, tiles) {
    this.z = z;
    this.tiles = tiles;                       // Map "x,y" -> tile
    this.resolution = null;                   // metres/pixel, set by load()
  }

  /** Bilinear elevation at a lat/lon. Returns null outside the loaded tiles. */
  at(lat, lon) {
    const z = this.z;
    const fx = geo.lonToTileX(lon, z) * 256;
    const fy = geo.latToTileY(lat, z) * 256;
    const x0 = Math.floor(fx - 0.5), y0 = Math.floor(fy - 0.5);
    const tx = fx - 0.5 - x0, ty = fy - 0.5 - y0;
    let sum = 0, any = false;
    const c = [];
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const v = this.pixel(x0 + dx, y0 + dy);
        if (v === null) { c.push(null); } else { c.push(v); any = true; }
      }
    }
    if (!any) return null;
    // Fill any missing corner with the mean of the ones we have, so the board
    // edge degrades instead of punching a hole.
    let n = 0; for (const v of c) if (v !== null) { sum += v; n++; }
    const mean = sum / n;
    for (let i = 0; i < 4; i++) if (c[i] === null) c[i] = mean;
    const top = c[0] * (1 - tx) + c[1] * tx;
    const bot = c[2] * (1 - tx) + c[3] * tx;
    return top * (1 - ty) + bot * ty;
  }

  /** Elevation at an absolute pixel coordinate in the zoom level's pixel plane. */
  pixel(px, py) {
    const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
    const t = this.tiles.get(tx + ',' + ty);
    if (!t) return null;
    const ix = px - tx * 256, iy = py - ty * 256;
    return t.elev[iy * t.w + ix];
  }
}

/**
 * Load every tile covering `bbox` at a zoom fine enough for `targetM` m/px.
 * 12 m/px is plenty against 150 m hexes and matches the underlying source data.
 */
async function load(bbox, targetM) {
  const midLat = (bbox.north + bbox.south) / 2;
  const z = geo.zoomFor(midLat, targetM || 12, 8, 14);
  const x0 = Math.floor(geo.lonToTileX(bbox.west, z));
  const x1 = Math.floor(geo.lonToTileX(bbox.east, z));
  const y0 = Math.floor(geo.latToTileY(bbox.north, z));
  const y1 = Math.floor(geo.latToTileY(bbox.south, z));
  const tiles = new Map();
  const jobs = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push(tile(z, x, y).then((t) => tiles.set(x + ',' + y, t)).catch(() => {}));
    }
  }
  await Promise.all(jobs);
  if (!tiles.size) throw new Error('no elevation tiles could be loaded for this area');
  const dem = new Dem(z, tiles);
  dem.resolution = geo.tileResolution(midLat, z);
  dem.tileCount = tiles.size;
  return dem;
}

module.exports = { load, Dem };
