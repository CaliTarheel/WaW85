'use strict';
// Board footprint on the globe. Everything downstream works in board pixel
// space (0..3864 x 0..2638); this module is the only place that knows about
// latitude and longitude.
const H = require('./hexgrid');

const D2R = Math.PI / 180;

// Metres per degree at a given latitude (WGS84 series, ample for a 3 km board).
function metresPerDegree(lat) {
  const p = lat * D2R;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p)
  };
}

class Footprint {
  /**
   * @param lat,lon  centre of the board
   * @param bearing  compass direction the top edge of the board faces (0 = north up)
   */
  constructor(lat, lon, bearing) {
    this.lat = lat;
    this.lon = lon;
    this.bearing = bearing || 0;
    this.mPerPx = H.M_PER_PX;
    this.widthM = H.BOARD_W * this.mPerPx;
    this.heightM = H.BOARD_H * this.mPerPx;
    this.mpd = metresPerDegree(lat);
    const b = this.bearing * D2R;
    // Board +x runs 90 degrees clockwise of the bearing; board +y runs down the
    // image, which is the reciprocal of the bearing. Both as (east, north).
    this.ax = [Math.cos(b), -Math.sin(b)];
    this.ay = [-Math.sin(b), -Math.cos(b)];
  }

  // Board pixel -> metres east/north of centre.
  pixelToMetres(px, py) {
    const dx = (px - H.BOARD_W / 2) * this.mPerPx;
    const dy = (py - H.BOARD_H / 2) * this.mPerPx;
    return [dx * this.ax[0] + dy * this.ay[0], dx * this.ax[1] + dy * this.ay[1]];
  }

  metresToPixel(e, n) {
    // ax and ay are orthonormal, so the inverse is the transpose.
    const dx = e * this.ax[0] + n * this.ax[1];
    const dy = e * this.ay[0] + n * this.ay[1];
    return [dx / this.mPerPx + H.BOARD_W / 2, dy / this.mPerPx + H.BOARD_H / 2];
  }

  pixelToLatLon(px, py) {
    const [e, n] = this.pixelToMetres(px, py);
    return [this.lat + n / this.mpd.lat, this.lon + e / this.mpd.lon];
  }

  latLonToPixel(lat, lon) {
    const n = (lat - this.lat) * this.mpd.lat;
    const e = (lon - this.lon) * this.mpd.lon;
    return this.metresToPixel(e, n);
  }

  /** Lat/lon bounding box covering the board plus `marginM` metres all round. */
  bbox(marginM) {
    marginM = marginM || 0;
    let s = 90, w = 180, nMax = -90, eMax = -180;
    const corners = [[0, 0], [H.BOARD_W, 0], [H.BOARD_W, H.BOARD_H], [0, H.BOARD_H]];
    for (const [px, py] of corners) {
      const [la, lo] = this.pixelToLatLon(px, py);
      s = Math.min(s, la); nMax = Math.max(nMax, la);
      w = Math.min(w, lo); eMax = Math.max(eMax, lo);
    }
    const dLat = marginM / this.mpd.lat, dLon = marginM / this.mpd.lon;
    return { south: s - dLat, west: w - dLon, north: nMax + dLat, east: eMax + dLon };
  }
}

// --- Web Mercator tile helpers ---------------------------------------------

function lonToTileX(lon, z) { return (lon + 180) / 360 * 2 ** z; }
function latToTileY(lat, z) {
  const r = lat * D2R;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
}
function tileXToLon(x, z) { return x / 2 ** z * 360 - 180; }
function tileYToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Ground resolution in metres/pixel for 256px tiles at zoom z and latitude lat. */
function tileResolution(lat, z) {
  return 156543.03392 * Math.cos(lat * D2R) / 2 ** z;
}

/** Smallest zoom whose resolution is at least as fine as targetM metres/pixel. */
function zoomFor(lat, targetM, min, max) {
  for (let z = (min || 1); z <= (max || 16); z++) if (tileResolution(lat, z) <= targetM) return z;
  return max || 16;
}

module.exports = {
  Footprint, metresPerDegree,
  lonToTileX, latToTileY, tileXToLon, tileYToLat, tileResolution, zoomFor
};
