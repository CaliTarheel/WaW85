'use strict';
// OpenStreetMap features via Overpass, projected into board pixel space.
const net = require('./net');

const ENDPOINTS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter'
];

const OHM_OVERPASS_ENDPOINT = 'https://overpass-api.openhistoricalmap.org/api/interpreter';

// Footways, cycleways and driveways are below the resolution of a 150 m hex,
// so they never make it onto a board.
const ROAD_CLASS = {
  motorway: 'major', motorway_link: 'major', trunk: 'major', trunk_link: 'major',
  primary: 'major', primary_link: 'major',
  secondary: 'road', secondary_link: 'road', tertiary: 'road', tertiary_link: 'road',
  unclassified: 'road', residential: 'road', living_street: 'road',
  track: 'trail'
};

// Landuse / natural tags mapped onto the WaW85 vocabulary.
const COVER = {
  forest: 'woods', wood: 'woods',
  farmland: 'cultivated', orchard: 'cultivated', vineyard: 'cultivated',
  allotments: 'cultivated', farmyard: 'cultivated', greenhouse_horticulture: 'cultivated',
  meadow: 'open', grass: 'open', village_green: 'open', recreation_ground: 'open',
  residential: 'built', commercial: 'built', retail: 'built', industrial: 'built',
  military: 'built', construction: 'built',
  quarry: 'rough', scrub: 'rough', heath: 'rough', bare_rock: 'rough',
  scree: 'rough', shingle: 'rough', landfill: 'rough', brownfield: 'rough',
  wetland: 'rough'
};

function query(bbox) {
  const b = `${bbox.south.toFixed(6)},${bbox.west.toFixed(6)},${bbox.north.toFixed(6)},${bbox.east.toFixed(6)}`;
  return `[out:json][timeout:90];
(
  way["highway"](${b});
  way["railway"~"^(rail|light_rail|narrow_gauge|disused|abandoned)$"](${b});
  way["waterway"~"^(river|stream|canal)$"](${b});
  way["natural"="water"](${b});
  way["natural"="coastline"](${b});
  relation["natural"="water"](${b});
  way["landuse"](${b});
  way["natural"~"^(wood|scrub|heath|bare_rock|scree|shingle|wetland|grassland)$"](${b});
  way["building"](${b});
);
out geom qt;`;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function xmlAttr(source, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(source);
  return match ? decodeXml(match[1]) : undefined;
}

function xmlTags(body) {
  const tags = {};
  const pattern = /<tag\b([^>]*?)\/?\s*>/g;
  let match;
  while ((match = pattern.exec(body))) {
    const key = xmlAttr(match[1], 'k');
    const value = xmlAttr(match[1], 'v');
    if (key !== undefined && value !== undefined) tags[key] = value;
  }
  return tags;
}

/** Convert OSM map API XML into the subset of Overpass JSON consumed below. */
function mapXmlToOverpass(xml) {
  const nodes = new Map();
  const nodePattern = /<node\b([^>]*?)(?:\/?>)/g;
  let match;
  while ((match = nodePattern.exec(xml))) {
    const id = xmlAttr(match[1], 'id');
    const lat = Number(xmlAttr(match[1], 'lat'));
    const lon = Number(xmlAttr(match[1], 'lon'));
    if (id && Number.isFinite(lat) && Number.isFinite(lon)) nodes.set(id, { lat, lon });
  }

  const ways = [];
  const waysById = new Map();
  const wayPattern = /<way\b([^>]*)>([\s\S]*?)<\/way>/g;
  while ((match = wayPattern.exec(xml))) {
    const id = xmlAttr(match[1], 'id');
    const geometry = [];
    const ndPattern = /<nd\b([^>]*?)\/?\s*>/g;
    let nd;
    while ((nd = ndPattern.exec(match[2]))) {
      const point = nodes.get(xmlAttr(nd[1], 'ref'));
      if (point) geometry.push(point);
    }
    const way = { type: 'way', id, geometry, tags: xmlTags(match[2]) };
    ways.push(way);
    if (id) waysById.set(id, way);
  }

  const relations = [];
  const relationPattern = /<relation\b([^>]*)>([\s\S]*?)<\/relation>/g;
  while ((match = relationPattern.exec(xml))) {
    const members = [];
    const memberPattern = /<member\b([^>]*?)\/?\s*>/g;
    let member;
    while ((member = memberPattern.exec(match[2]))) {
      if (xmlAttr(member[1], 'type') !== 'way') continue;
      const way = waysById.get(xmlAttr(member[1], 'ref'));
      if (way) members.push({ type: 'way', role: xmlAttr(member[1], 'role') || '', geometry: way.geometry });
    }
    relations.push({ type: 'relation', id: xmlAttr(match[1], 'id'), members, tags: xmlTags(match[2]) });
  }

  return { elements: ways.concat(relations) };
}

async function fetchRaw(bbox, log) {
  const q = query(bbox);
  // The query text is part of the key, so editing the query invalidates the cache.
  const qh = require('crypto').createHash('sha1').update(q).digest('hex').slice(0, 8);
  const id = `${bbox.south.toFixed(4)}_${bbox.west.toFixed(4)}_${bbox.north.toFixed(4)}_${bbox.east.toFixed(4)}_${qh}`;
  const errors = [];
  // Public Overpass mirrors can be busy. POST keeps larger geometry queries out
  // of URLs, and Private.coffee replaces the retired Kumi hostname.
  for (let attempt = 0; attempt < 1; attempt++) {
    for (const ep of ENDPOINTS) {
      try {
        const body = await net.cachedPost('osm', id, '.json', ep, 'data=' + encodeURIComponent(q));
        return JSON.parse(body.toString('utf8'));
      } catch (e) {
        errors.push(`${new URL(ep).host}: ${e.message.slice(0, 120)}`);
        if (log) log(`  overpass ${new URL(ep).host} failed — ${e.message.slice(0, 90)}`);
      }
    }
  }
  try {
    if (log) log('  public detail mirrors are busy — trying the OpenStreetMap map service');
    const bounds = `${bbox.west.toFixed(6)},${bbox.south.toFixed(6)},${bbox.east.toFixed(6)},${bbox.north.toFixed(6)}`;
    const body = await net.cached('osm-map', id, '.osm', `https://api.openstreetmap.org/api/0.6/map?bbox=${bounds}`);
    return mapXmlToOverpass(body.toString('utf8'));
  } catch (e) {
    errors.push(`api.openstreetmap.org: ${e.message.slice(0, 120)}`);
  }
  throw new Error('OpenStreetMap detail services unreachable — ' + errors.join(' | '));
}

/** OpenHistoricalMap's dedicated Overpass service returns geometry and date tags. */
async function fetchHistoricalRaw(bbox, log) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    if (log) log('  checking OpenHistoricalMap for dated features…');
    const response = await fetch(OHM_OVERPASS_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
      },
      body: 'data=' + encodeURIComponent(query(bbox)),
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseYear(value, boundary) {
  if (value === undefined || value === null || value === '') return null;
  const years = String(value).match(/-?\d{3,4}/g);
  if (!years || !years.length) return null;
  const selected = boundary === 'end' ? years[years.length - 1] : years[0];
  const year = Number(selected);
  return Number.isFinite(year) ? year : null;
}

function validity(tags) {
  const t = tags || {};
  const startRaw = t.start_date || t.opening_date || t.opening || t.construction_date;
  const endRaw = t.end_date || t.demolished_date || t.demolition_date || t.closed_date || t.disused_date;
  return {
    startYear: parseYear(startRaw, 'start'),
    endYear: parseYear(endRaw, 'end'),
    startRaw,
    endRaw,
    dated: !!(startRaw || endRaw)
  };
}

function activeAtYear(tags, targetYear) {
  if (!targetYear) return true;
  const dates = validity(tags);
  return (dates.startYear === null || dates.startYear <= targetYear) &&
    (dates.endYear === null || dates.endYear >= targetYear);
}

function featureMeta(tags, source, targetYear) {
  const dates = validity(tags);
  return {
    source,
    confidence: source === 'openhistoricalmap' ? 'dated-history' :
      (targetYear && !dates.dated ? 'present-day-fallback' : targetYear ? 'dated-current-map' : 'current'),
    startYear: dates.startYear,
    endYear: dates.endYear
  };
}

function decode(raw, footprint, options) {
  const o = Object.assign({ source: 'openstreetmap', targetYear: null, requireDate: false }, options || {});
  const roads = [], waterways = [], water = [], cover = [], buildings = [], coastlines = [];
  const counters = { elements: 0, includedElements: 0, includedFeatures: 0, excludedByDate: 0, excludedUndated: 0, skipped: 0 };

  for (const el of raw.elements || []) {
    counters.elements++;
    const t = el.tags || {};
    const dates = validity(t);
    if (o.requireDate && !dates.dated) { counters.excludedUndated++; continue; }
    if (!activeAtYear(t, o.targetYear)) { counters.excludedByDate++; continue; }
    const meta = featureMeta(t, o.source, o.targetYear);
    let added = 0;

    // Big water bodies (bays, reservoirs) are multipolygon relations, not ways.
    if (el.type === 'relation') {
      if (t.natural !== 'water' && t.water === undefined) { counters.skipped++; continue; }
      const outers = (el.members || [])
        .filter((m) => m.type === 'way' && m.geometry && m.role !== 'inner')
        .map((m) => m.geometry.map((g) => footprint.latLonToPixel(g.lat, g.lon)));
      for (const ring of stitch(outers)) {
        if (ring.length > 3) { water.push(Object.assign({ pts: ring, name: t.name }, meta)); added++; }
      }
      if (added) counters.includedElements++;
      counters.includedFeatures += added;
      continue;
    }
    if (el.type !== 'way' || !el.geometry) { counters.skipped++; continue; }
    const pts = el.geometry.map((g) => footprint.latLonToPixel(g.lat, g.lon));
    const closed = pts.length > 2 &&
      Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-6 &&
      Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-6;

    if (t.highway) {
      const cls = ROAD_CLASS[t.highway];
      if (cls) { roads.push(Object.assign({ pts, cls, name: t.name, bridge: !!t.bridge, tunnel: !!t.tunnel }, meta)); added++; }
    } else if (t.railway) {
      roads.push(Object.assign({ pts, cls: 'rail', name: t.name, bridge: !!t.bridge, tunnel: !!t.tunnel }, meta)); added++;
    } else if (t.waterway) {
      waterways.push(Object.assign({ pts, kind: t.waterway, name: t.name }, meta)); added++;
    } else if (t.natural === 'coastline') {
      coastlines.push(Object.assign({ pts, name: t.name }, meta)); added++;
    } else if (t.natural === 'water' || t.water) {
      if (closed) { water.push(Object.assign({ pts, name: t.name }, meta)); added++; }
    } else if (t.building) {
      if (closed) { buildings.push(Object.assign({ pts }, meta)); added++; }
    } else {
      const cls = COVER[t.landuse] || COVER[t.natural];
      if (cls && closed) { cover.push(Object.assign({ pts, cls, tag: t.landuse || t.natural }, meta)); added++; }
    }

    if (added) counters.includedElements++;
    else counters.skipped++;
    counters.includedFeatures += added;
  }

  return { roads, waterways, water, cover, buildings, coastlines, counters };
}

/**
 * Fetch and project. Returns geometry already in board pixel coordinates, so
 * nothing downstream has to think about the globe.
 */
async function load(footprint, marginM, log, options) {
  const bbox = footprint.bbox(marginM === undefined ? 400 : marginM);
  const raw = await fetchRaw(bbox, log);
  const targetYear = options && Number.isFinite(options.targetYear) ? Math.round(options.targetYear) : null;
  const current = decode(raw, footprint, { source: 'openstreetmap', targetYear });

  if (!targetYear) {
    return Object.assign({ bbox, skipped: current.counters.skipped, elements: current.counters.elements }, current, {
      provenance: {
        mode: 'present', targetYear: null,
        historicalFeatures: 0,
        datedCurrentFeatures: 0,
        fallbackFeatures: 0,
        currentFeatures: current.counters.includedFeatures,
        datedExcluded: 0,
        historicalAvailable: false
      }
    });
  }

  let historical = { roads: [], waterways: [], water: [], cover: [], buildings: [], coastlines: [], counters: { elements: 0, includedFeatures: 0, excludedByDate: 0, excludedUndated: 0, skipped: 0 } };
  let historicalError = null;
  try {
    const historicalRaw = await fetchHistoricalRaw(bbox, log);
    historical = decode(historicalRaw, footprint, { source: 'openhistoricalmap', targetYear, requireDate: true });
  } catch (error) {
    historicalError = error instanceof Error ? error.message : String(error);
    if (log) log(`  OpenHistoricalMap unavailable — using transparent present-day fallback (${historicalError.slice(0, 90)})`);
  }

  const merged = {};
  for (const key of ['roads', 'waterways', 'water', 'cover', 'buildings', 'coastlines']) {
    merged[key] = historical[key].concat(current[key]);
  }
  const currentDated = current.roads.concat(current.waterways, current.water, current.cover, current.buildings, current.coastlines)
    .filter((feature) => feature.confidence === 'dated-current-map').length;
  const fallbackFeatures = current.counters.includedFeatures - currentDated;
  const provenance = {
    mode: 'reconstruction', targetYear,
    historicalFeatures: historical.counters.includedFeatures,
    datedCurrentFeatures: currentDated,
    fallbackFeatures,
    currentFeatures: current.counters.includedFeatures,
    datedExcluded: current.counters.excludedByDate + historical.counters.excludedByDate,
    undatedHistoricalExcluded: historical.counters.excludedUndated,
    historicalAvailable: historical.counters.includedFeatures > 0,
    historicalError
  };
  if (log) log(`  ${targetYear} provenance: ${provenance.historicalFeatures} dated historical, ${provenance.datedCurrentFeatures} dated current-map, ${provenance.fallbackFeatures} undated fallback`);
  return Object.assign({
    bbox,
    skipped: current.counters.skipped + historical.counters.skipped,
    elements: current.counters.elements + historical.counters.elements,
    provenance
  }, merged);
}

/** Join open way fragments end to end into rings, for multipolygon relations. */
function stitch(fragments) {
  const k = (p) => Math.round(p[0]) + ',' + Math.round(p[1]);
  const open = fragments.filter((f) => f.length > 1);
  const rings = [];
  while (open.length) {
    let cur = open.shift().slice();
    let joined = true;
    while (joined) {
      joined = false;
      if (k(cur[0]) === k(cur[cur.length - 1])) break;
      for (let i = 0; i < open.length; i++) {
        const f = open[i];
        if (k(cur[cur.length - 1]) === k(f[0])) { cur = cur.concat(f.slice(1)); open.splice(i, 1); joined = true; break; }
        if (k(cur[cur.length - 1]) === k(f[f.length - 1])) { cur = cur.concat(f.slice().reverse().slice(1)); open.splice(i, 1); joined = true; break; }
        if (k(cur[0]) === k(f[f.length - 1])) { cur = f.slice(0, -1).concat(cur); open.splice(i, 1); joined = true; break; }
        if (k(cur[0]) === k(f[0])) { cur = f.slice().reverse().slice(0, -1).concat(cur); open.splice(i, 1); joined = true; break; }
      }
    }
    rings.push(cur);
  }
  return rings;
}

module.exports = { load, stitch, mapXmlToOverpass, parseYear, validity, activeAtYear, decode, COVER, ROAD_CLASS };
