'use strict';
// Cached HTTP fetching. Everything we pull is public open data, but it is
// somebody else's bandwidth, so nothing is ever fetched twice.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const CACHE = path.join(__dirname, '..', 'cache');
const UA = 'waw85-mapforge/0.1 (personal hex wargame map tool)';

function cachePath(kind, id, ext) {
  const dir = path.join(CACHE, kind);
  fs.mkdirSync(dir, { recursive: true });
  const safe = /^[\w.-]{1,80}$/.test(id) ? id : crypto.createHash('sha1').update(id).digest('hex');
  return path.join(dir, safe + ext);
}

function httpGet(url, headers, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 4;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ 'User-Agent': UA }, headers || {}) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, url).toString(), headers, redirectsLeft - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}: ${body.slice(0, 200)}`));
        resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(240000, () => req.destroy(new Error('timeout: ' + url)));
  });
}

/** Fetch with an on-disk cache. `kind` is a subfolder, `id` the cache key. */
async function cached(kind, id, ext, url, headers) {
  const p = cachePath(kind, id, ext);
  if (fs.existsSync(p)) return fs.readFileSync(p);
  const body = await httpGet(url, headers);
  fs.writeFileSync(p, body);
  return body;
}

module.exports = { httpGet, cached, cachePath, CACHE, UA };
