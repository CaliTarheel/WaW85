'use strict';

// Cloudflare-friendly fetch adapter for the original Mapforge pipeline.
// Sites supplies caching at the edge; this module intentionally avoids Node's
// filesystem so generation can run inside the deployed worker.
const UA = 'Mapforge/1.0 (+https://github.com/CaliTarheel/WaW85)';

async function httpGet(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch(url, {
      headers: Object.assign({ Accept: '*/*', 'User-Agent': UA }, headers || {}),
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 200)}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function httpPost(url, body, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: Object.assign({
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': UA,
      }, headers || {}),
      body,
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 200)}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function cached(_kind, _id, _ext, url, headers) {
  return httpGet(url, headers);
}

async function cachedPost(_kind, _id, _ext, url, body, headers) {
  return httpPost(url, body, headers);
}

module.exports = { httpGet, httpPost, cached, cachedPost, UA };
