'use strict';
// Minimal PNG decoder — enough for the 8-bit RGB/RGBA tiles the elevation and
// basemap services serve. No interlace support (nobody ships Adam7 tiles).
const zlib = require('zlib');

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decode(buf) {
  if (!buf.slice(0, 8).equals(SIG)) throw new Error('not a PNG');
  let pos = 8, ihdr = null, palette = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], colorType: data[9], interlace: data[12]
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error('no IHDR');
  if (ihdr.depth !== 8) throw new Error('unsupported bit depth ' + ihdr.depth);
  if (ihdr.interlace) throw new Error('interlaced PNG unsupported');

  const ch = CHANNELS[ihdr.colorType];
  if (!ch) throw new Error('unsupported colour type ' + ihdr.colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width: w, height: h } = ihdr;
  const stride = w * ch;
  const out = Buffer.alloc(stride * h);

  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.slice(rp, rp + stride); rp += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
  }

  // Expand a palette so callers always get RGB(A).
  if (ihdr.colorType === 3) {
    if (!palette) throw new Error('paletted PNG without PLTE');
    const rgb = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      const p = out[i] * 3;
      rgb[i * 3] = palette[p]; rgb[i * 3 + 1] = palette[p + 1]; rgb[i * 3 + 2] = palette[p + 2];
    }
    return { width: w, height: h, channels: 3, data: rgb };
  }
  return { width: w, height: h, channels: ch, data: out };
}

module.exports = { decode };
