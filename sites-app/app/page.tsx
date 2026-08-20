"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const BASE_BOARD_WIDTH_METRES = 2856.6;
const BASE_BOARD_HEIGHT_METRES = 1950.2;
const DEG = Math.PI / 180;

const PRESETS = [
  { name: "Rasdorf", lat: 50.718, lon: 9.91 },
  { name: "Fulda", lat: 50.552, lon: 9.677 },
  { name: "Kassel", lat: 51.32, lon: 9.49 },
  { name: "Leine", lat: 52.44, lon: 9.63 },
  { name: "Gießen", lat: 50.587, lon: 8.678 },
];

const TERRAIN_COLOURS: Record<string, string> = {
  clear: "#727f3e",
  cultivated: "#a5a45d",
  rough: "#8a8e67",
  city: "#757461",
  woods: "#3f5128",
  hill: "#bdc36a",
  "hill-city": "#959563",
  "hill-woods": "#667640",
  water: "#70a894",
};

type ViewState = { lat: number; lon: number; zoom: number; bearing: number };
type DataEra = "present" | "1985";
type Provenance = {
  mode: "present" | "reconstruction";
  targetYear: number | null;
  historicalFeatures: number;
  datedCurrentFeatures: number;
  fallbackFeatures: number;
  currentFeatures: number;
  datedExcluded: number;
  undatedHistoricalExcluded?: number;
  historicalAvailable: boolean;
  historicalError?: string | null;
};
type Result = {
  svg: string;
  project: Record<string, unknown>;
  stats: {
    hexes: number;
    hillPercent: number;
    roadEdges: number;
    railEdges: number;
    riverChains: number;
    bridges: number;
    historicalFeatures: number;
    fallbackFeatures: number;
    datedExcluded: number;
    terrain: Record<string, number>;
  };
  meta: {
    elevationRange: number[];
    timingMs: number;
    widthPx: number;
    heightPx: number;
    widthM: number;
    heightM: number;
    boardCols: number;
    boardRows: number;
    totalCols: number;
    totalRows: number;
    dataMode: "present" | "reconstruction";
    targetYear: number | null;
    provenance: Provenance;
  };
  log: string[];
};

function lonToWorld(lon: number, zoom: number) {
  return ((lon + 180) / 360) * 256 * 2 ** zoom;
}

function latToWorld(lat: number, zoom: number) {
  const radians = lat * DEG;
  return ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * 256 * 2 ** zoom;
}

function worldToLon(x: number, zoom: number) {
  return (x / (256 * 2 ** zoom)) * 360 - 180;
}

function worldToLat(y: number, zoom: number) {
  const n = Math.PI - (2 * Math.PI * y) / (256 * 2 ** zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function metresPerDegree(lat: number) {
  const radians = lat * DEG;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * radians) + 1.175 * Math.cos(4 * radians),
    lon: 111412.84 * Math.cos(radians) - 93.5 * Math.cos(3 * radians),
  };
}

export default function Home() {
  const mapRef = useRef<HTMLDivElement>(null);
  const tilesRef = useRef<HTMLCanvasElement>(null);
  const footprintRef = useRef<HTMLCanvasElement>(null);
  const tileCache = useRef(new Map<string, HTMLImageElement>());
  const dragRef = useRef<{ x: number; y: number; lat: number; lon: number } | null>(null);
  const viewRef = useRef<ViewState>({ lat: 50.718, lon: 9.91, zoom: 14, bearing: 0 });

  const [view, setView] = useState<ViewState>(viewRef.current);
  const [name, setName] = useState("Rasdorf");
  const [boardCols, setBoardCols] = useState(1);
  const [boardRows, setBoardRows] = useState(1);
  const [dataEra, setDataEra] = useState<DataEra>("present");
  const [minRelief, setMinRelief] = useState(8);
  const [hillHigh, setHillHigh] = useState(0.66);
  const [hillLow, setHillLow] = useState(0.48);
  const [reliefWeight, setReliefWeight] = useState(0.5);
  const [result, setResult] = useState<Result | null>(null);
  const [working, setWorking] = useState(false);
  const [exportingPng, setExportingPng] = useState(false);
  const [status, setStatus] = useState("Idle — ready for coordinates.");

  const footprintWidthMetres = BASE_BOARD_WIDTH_METRES * boardCols;
  const footprintHeightMetres = BASE_BOARD_HEIGHT_METRES * boardRows;
  const totalHexCols = 22 * boardCols + 1;
  const totalHexRows = 13 * boardRows;

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const draw = useCallback(() => {
    const map = mapRef.current;
    const tiles = tilesRef.current;
    const footprint = footprintRef.current;
    if (!map || !tiles || !footprint) return;

    const bounds = map.getBoundingClientRect();
    const width = Math.max(1, Math.floor(bounds.width));
    const height = Math.max(1, Math.floor(bounds.height));
    const ratio = window.devicePixelRatio || 1;
    for (const canvas of [tiles, footprint]) {
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio;
        canvas.height = height * ratio;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
    }

    const tileContext = tiles.getContext("2d");
    const footContext = footprint.getContext("2d");
    if (!tileContext || !footContext) return;
    tileContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    footContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    tileContext.clearRect(0, 0, width, height);
    footContext.clearRect(0, 0, width, height);

    const current = viewRef.current;
    const roundedZoom = Math.round(current.zoom);
    const centreX = lonToWorld(current.lon, roundedZoom);
    const centreY = latToWorld(current.lat, roundedZoom);
    const scale = 2 ** (current.zoom - roundedZoom);
    tileContext.fillStyle = "#11140d";
    tileContext.fillRect(0, 0, width, height);
    tileContext.save();
    tileContext.translate(width / 2, height / 2);
    tileContext.scale(scale, scale);
    const xStart = Math.floor((centreX - width / 2 / scale) / 256);
    const xEnd = Math.floor((centreX + width / 2 / scale) / 256);
    const yStart = Math.floor((centreY - height / 2 / scale) / 256);
    const yEnd = Math.floor((centreY + height / 2 / scale) / 256);
    const tileCount = 2 ** roundedZoom;

    for (let x = xStart; x <= xEnd; x++) {
      for (let y = yStart; y <= yEnd; y++) {
        if (y < 0 || y >= tileCount) continue;
        const wrappedX = ((x % tileCount) + tileCount) % tileCount;
        const key = `${roundedZoom}/${wrappedX}/${y}`;
        let image = tileCache.current.get(key);
        if (!image) {
          image = new Image();
          image.crossOrigin = "anonymous";
          image.onload = draw;
          image.src = `https://tile.openstreetmap.org/${key}.png`;
          tileCache.current.set(key, image);
        }
        if (image.complete && image.naturalWidth) {
          tileContext.drawImage(image, x * 256 - centreX, y * 256 - centreY, 256, 256);
        }
      }
    }
    tileContext.restore();
    tileContext.fillStyle = "rgba(14, 17, 10, 0.42)";
    tileContext.fillRect(0, 0, width, height);

    const project = (lat: number, lon: number) => [
      width / 2 + lonToWorld(lon, current.zoom) - lonToWorld(current.lon, current.zoom),
      height / 2 + latToWorld(lat, current.zoom) - latToWorld(current.lat, current.zoom),
    ];
    const bearing = current.bearing * DEG;
    const axisX = [Math.cos(bearing), -Math.sin(bearing)];
    const axisY = [-Math.sin(bearing), -Math.cos(bearing)];
    const metres = metresPerDegree(current.lat);
    const corners = [
      [-footprintWidthMetres / 2, -footprintHeightMetres / 2],
      [footprintWidthMetres / 2, -footprintHeightMetres / 2],
      [footprintWidthMetres / 2, footprintHeightMetres / 2],
      [-footprintWidthMetres / 2, footprintHeightMetres / 2],
    ].map(([dx, dy]) => {
      const east = dx * axisX[0] + dy * axisY[0];
      const north = dx * axisX[1] + dy * axisY[1];
      return project(current.lat + north / metres.lat, current.lon + east / metres.lon);
    });

    footContext.beginPath();
    footContext.rect(0, 0, width, height);
    footContext.moveTo(corners[0][0], corners[0][1]);
    for (let index = corners.length - 1; index >= 1; index--) footContext.lineTo(corners[index][0], corners[index][1]);
    footContext.closePath();
    footContext.fillStyle = "rgba(8, 10, 6, 0.56)";
    footContext.fill("evenodd");

    footContext.beginPath();
    footContext.moveTo(corners[0][0], corners[0][1]);
    corners.slice(1).forEach((corner) => footContext.lineTo(corner[0], corner[1]));
    footContext.closePath();
    footContext.strokeStyle = "#f07145";
    footContext.lineWidth = 2;
    footContext.stroke();

    footContext.save();
    footContext.setLineDash([7, 5]);
    footContext.strokeStyle = "rgba(240, 113, 69, 0.72)";
    footContext.lineWidth = 1;
    const interpolate = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for (let col = 1; col < boardCols; col++) {
      const t = col / boardCols;
      const topEdge = interpolate(corners[0], corners[1], t);
      const bottomEdge = interpolate(corners[3], corners[2], t);
      footContext.beginPath();
      footContext.moveTo(topEdge[0], topEdge[1]);
      footContext.lineTo(bottomEdge[0], bottomEdge[1]);
      footContext.stroke();
    }
    for (let row = 1; row < boardRows; row++) {
      const t = row / boardRows;
      const leftEdge = interpolate(corners[0], corners[3], t);
      const rightEdge = interpolate(corners[1], corners[2], t);
      footContext.beginPath();
      footContext.moveTo(leftEdge[0], leftEdge[1]);
      footContext.lineTo(rightEdge[0], rightEdge[1]);
      footContext.stroke();
    }
    footContext.restore();

    const centre = project(current.lat, current.lon);
    const top = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
    footContext.beginPath();
    footContext.moveTo(top[0], top[1]);
    footContext.lineTo(top[0] + (top[0] - centre[0]) * 0.22, top[1] + (top[1] - centre[1]) * 0.22);
    footContext.lineWidth = 4;
    footContext.stroke();
    footContext.fillStyle = "#f07145";
    footContext.beginPath();
    footContext.arc(centre[0], centre[1], 4, 0, Math.PI * 2);
    footContext.fill();
  }, [boardCols, boardRows, footprintHeightMetres, footprintWidthMetres]);

  useEffect(() => {
    draw();
    const observer = new ResizeObserver(draw);
    if (mapRef.current) observer.observe(mapRef.current);
    return () => observer.disconnect();
  }, [draw, view]);

  const setLocation = (next: Partial<ViewState>) => setView((current) => ({ ...current, ...next }));

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { x: event.clientX, y: event.clientY, lat: view.lat, lon: view.lon };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const zoom = viewRef.current.zoom;
    const x = lonToWorld(drag.lon, zoom) - (event.clientX - drag.x);
    const y = latToWorld(drag.lat, zoom) - (event.clientY - drag.y);
    setLocation({ lon: worldToLon(x, zoom), lat: Math.max(-85, Math.min(85, worldToLat(y, zoom))) });
  };

  const generate = async () => {
    setWorking(true);
    setResult(null);
    setStatus(dataEra === "1985" ? "Reconstructing 1985 from dated historical and present-day map evidence…" : "Fetching elevation and OpenStreetMap features…");
    try {
      const response = await fetch("/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: view.lat, lon: view.lon, bearing: view.bearing, name, boardCols, boardRows, targetYear: dataEra === "1985" ? 1985 : null, minReliefM: minRelief, hillHigh, hillLow, reliefWeight }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Board generation failed.");
      setResult(data);
      const evidence = dataEra === "1985" ? ` ${data.meta.provenance.historicalFeatures} dated historical features; ${data.meta.provenance.fallbackFeatures} undated fallbacks.` : "";
      setStatus(`${boardCols} × ${boardRows} ${boardCols * boardRows === 1 ? "board" : "board mosaic"} ready.${evidence} Export SVG, PNG, or project data.`);
    } catch (error) {
      setStatus(error instanceof Error ? `Generation failed — ${error.message}` : "Generation failed.");
    } finally {
      setWorking(false);
    }
  };

  const download = (kind: "svg" | "json") => {
    if (!result) return;
    const content = kind === "svg" ? result.svg : JSON.stringify(result.project, null, 2);
    const blob = new Blob([content], { type: kind === "svg" ? "image/svg+xml" : "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "board"}.${kind}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const downloadPng = async () => {
    if (!result || exportingPng) return;
    setExportingPng(true);
    setStatus("Rendering a full-resolution PNG…");
    const sourceUrl = URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" }));
    try {
      const image = new Image();
      image.decoding = "async";
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("The generated artwork could not be rasterized."));
        image.src = sourceUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = result.meta.widthPx || image.naturalWidth;
      canvas.height = result.meta.heightPx || image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("PNG rendering is not supported by this browser.");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error("The PNG was too large for this browser to encode.")), "image/png");
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "board"}-${boardCols}x${boardRows}.png`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(`PNG downloaded at ${canvas.width.toLocaleString()} × ${canvas.height.toLocaleString()} px.`);
    } catch (error) {
      setStatus(error instanceof Error ? `PNG export failed — ${error.message}` : "PNG export failed.");
    } finally {
      URL.revokeObjectURL(sourceUrl);
      setExportingPng(false);
    }
  };

  const updateLayout = (axis: "cols" | "rows", value: number) => {
    if (axis === "cols") setBoardCols(value);
    else setBoardRows(value);
    setResult(null);
    setStatus("Layout updated — forge the terrain again for this footprint.");
  };

  const updateEra = (era: DataEra) => {
    setDataEra(era);
    setResult(null);
    setStatus(era === "1985" ? "1985 reconstruction selected — forge again to inspect source confidence." : "Present-day map selected — forge again for current features.");
  };

  const svgUrl = result ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}` : null;
  const terrain = result ? Object.entries(result.stats.terrain).sort((a, b) => b[1] - a[1]) : [];

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#workspace" aria-label="Mapforge home">
          <span className="brandMark">MF</span>
          <span><b>Mapforge</b><small>World at War ’85 terrain lab</small></span>
        </a>
        <div className="topMeta"><span>{dataEra === "1985" ? "1985 reconstruction" : "present-day map"}</span><span>{boardCols} × {boardRows} {boardCols * boardRows === 1 ? "board" : "boards"}</span><span>{totalHexCols} × {totalHexRows} hex field · 150 m scale</span></div>
        <a className="sourceLink" href="https://github.com/CaliTarheel/WaW85" target="_blank" rel="noreferrer">View source ↗</a>
      </header>

      <section id="workspace" className="workspace">
        <article className="panel mapPanel">
          <div className="panelHead">
            <div><span className="eyebrow">01 / footprint</span><h1>Choose the ground.</h1></div>
            <span className="liveDot">Live map</span>
          </div>
          <div ref={mapRef} className="map" onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} onWheel={(event) => { event.preventDefault(); setLocation({ zoom: Math.max(8, Math.min(17, view.zoom - Math.sign(event.deltaY) * 0.4)) }); }} role="application" aria-label="Draggable map for choosing a board footprint">
            <canvas ref={tilesRef} aria-hidden="true" />
            <canvas ref={footprintRef} aria-hidden="true" />
            <div className="mapReadout"><b>{view.lat.toFixed(5)}, {view.lon.toFixed(5)}</b><span>{view.bearing}° bearing · z{view.zoom.toFixed(1)}</span><span>{(footprintWidthMetres / 1000).toFixed(2)} × {(footprintHeightMetres / 1000).toFixed(2)} km · {boardCols} × {boardRows} boards</span></div>
            {dataEra === "1985" && <div className="eraMapNotice"><b>1985 target</b><span>background map is present-day reference</span></div>}
            <div className="attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors</div>
          </div>
        </article>

        <aside className="panel controlsPanel">
          <div className="panelHead compact"><div><span className="eyebrow">02 / tune</span><h2>Shape the board.</h2></div></div>
          <div className="controlsScroll">
            <div className="fieldGroup"><label htmlFor="board-name">Sheet name</label><input id="board-name" value={name} maxLength={12} onChange={(event) => setName(event.target.value)} /></div>
            <div className="fieldGroup">
              <label>Data era</label>
              <div className="eraToggle" role="group" aria-label="Map data era">
                <button type="button" aria-pressed={dataEra === "present"} className={dataEra === "present" ? "active" : ""} onClick={() => updateEra("present")}><b>Present day</b><span>current OSM</span></button>
                <button type="button" aria-pressed={dataEra === "1985"} className={dataEra === "1985" ? "active" : ""} onClick={() => updateEra("1985")}><b>1985</b><span>reconstruction</span></button>
              </div>
              <p className="eraHelp">1985 uses dated <a href="https://www.openhistoricalmap.org/" target="_blank" rel="noreferrer">OpenHistoricalMap</a> features where available, filters known later features, and labels undated OSM geometry as fallback evidence.</p>
            </div>
            <div className="fieldGroup">
              <label>Board layout</label>
              <div className="layoutFields">
                <label><span>Wide</span><select aria-label="Boards wide" value={boardCols} onChange={(event) => updateLayout("cols", Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                <span className="layoutBy" aria-hidden="true">×</span>
                <label><span>High</span><select aria-label="Boards high" value={boardRows} onChange={(event) => updateLayout("rows", Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              </div>
              <p className="layoutSummary"><b>{boardCols * boardRows} {boardCols * boardRows === 1 ? "board" : "boards"}</b><span>{(footprintWidthMetres / 1000).toFixed(2)} × {(footprintHeightMetres / 1000).toFixed(2)} km</span></p>
            </div>
            <div className="fieldGroup">
              <label>Centre coordinates</label>
              <div className="fieldRow">
                <input aria-label="Latitude" type="number" step="0.0001" value={view.lat.toFixed(5)} onChange={(event) => setLocation({ lat: Number(event.target.value) })} />
                <input aria-label="Longitude" type="number" step="0.0001" value={view.lon.toFixed(5)} onChange={(event) => setLocation({ lon: Number(event.target.value) })} />
              </div>
              <div className="presets">
                {PRESETS.map((preset) => <button key={preset.name} type="button" onClick={() => { setName(preset.name); setLocation({ lat: preset.lat, lon: preset.lon }); }}>{preset.name}</button>)}
              </div>
            </div>
            <RangeControl label="Board top faces" value={view.bearing} min={0} max={355} step={5} suffix="°" onChange={(value) => setLocation({ bearing: value })} />
            <div className="fieldGroup">
              <div className="groupLabel"><span>Hill detection</span><i>advanced</i></div>
              <RangeControl label="Minimum local relief" value={minRelief} min={2} max={30} step={1} suffix=" m" onChange={setMinRelief} nested />
              <RangeControl label="Seed confidence" value={hillHigh} min={0.4} max={0.9} step={0.01} digits={2} onChange={setHillHigh} nested />
              <RangeControl label="Skirt growth" value={hillLow} min={0.2} max={0.8} step={0.01} digits={2} onChange={setHillLow} nested />
              <RangeControl label="Relief ↔ viewshed" value={reliefWeight} min={0} max={1} step={0.05} digits={2} onChange={setReliefWeight} nested />
            </div>
            <button className="primaryButton" type="button" disabled={working} onClick={generate}>{working ? "Forging terrain…" : boardCols * boardRows === 1 ? "Make the board" : `Make ${boardCols} × ${boardRows} boards`}</button>
            <p className="status" aria-live="polite">{status}</p>
          </div>
        </aside>

        <article className="panel resultPanel">
          <div className="panelHead"><div><span className="eyebrow">03 / output</span><h2>Read the terrain.</h2></div>{result && <span className="liveDot ready">{result.meta.targetYear === 1985 ? "1985 estimate" : "Ready"}</span>}</div>
          <div className="preview">
            {svgUrl ? <img src={svgUrl} alt={`Generated ${name} ${boardCols} by ${boardRows} hex board mosaic`} /> : (
              <div className="emptyState">
                <span className="hexGlyph" aria-hidden="true">⬡</span>
                <h3>One real place.<br />One playable board.</h3>
                <p>Move the footprint, choose a 1 × 1 through 4 × 4 layout, then forge open terrain data into layered SVG, full-resolution PNG, and project JSON.</p>
                <img src="/rasdorf.png" alt="Example Mapforge board generated for Rasdorf, Germany" />
              </div>
            )}
          </div>
          {result && (
            <div className="resultDock">
              <div className="stats"><div><b>{result.stats.hexes}</b><span>hexes</span></div><div><b>{result.stats.hillPercent}%</b><span>hill</span></div><div><b>{result.stats.roadEdges}</b><span>road sides</span></div><div><b>{result.stats.bridges}</b><span>bridges</span></div></div>
              <div className="terrainBar">{terrain.map(([key, count]) => <span key={key} title={`${key}: ${count}`} style={{ width: `${(count / result.stats.hexes) * 100}%`, background: TERRAIN_COLOURS[key] || "#888" }} />)}</div>
              {result.meta.targetYear === 1985 && <ProvenancePanel provenance={result.meta.provenance} railEdges={result.stats.railEdges} />}
              <div className="exportRow"><button type="button" className="pngButton" disabled={exportingPng} onClick={downloadPng}>{exportingPng ? "Rendering PNG…" : "Download PNG"}</button><button type="button" onClick={() => download("svg")}>Layered SVG</button><button type="button" onClick={() => download("json")}>Project JSON</button></div>
            </div>
          )}
        </article>
      </section>

      <footer><p>Real elevation + present or reconstructed map evidence → a geomorphic World at War ’85 board.</p><p>Historical mode exposes its assumptions in every project JSON.</p><p>Created by <strong>Stephen G. Rider</strong> · <a href="mailto:rider.sg@gmail.com">rider.sg@gmail.com</a> · <a href="https://github.com/CaliTarheel/WaW85" target="_blank" rel="noreferrer">source on GitHub</a> · MIT licensed—retain attribution.</p></footer>
    </main>
  );
}

function ProvenancePanel({ provenance, railEdges }: { provenance: Provenance; railEdges: number }) {
  const note = provenance.historicalError
    ? "The historical service did not answer, so this run uses date-filtered present-day map evidence only."
    : provenance.historicalAvailable
      ? "Dated historical features take priority where they overlap modern fallback geometry."
      : "No dated historical features were returned for this footprint; treat the board as an informed estimate.";
  return (
    <section className="provenance" aria-label="1985 reconstruction confidence">
      <div className="provenanceHead"><b>1985 evidence ledger</b><span>{railEdges} rail sides</span></div>
      <div className="provenanceCounts">
        <span><i className="confidenceDot historical" />{provenance.historicalFeatures}<small>dated OHM</small></span>
        <span><i className="confidenceDot dated" />{provenance.datedCurrentFeatures}<small>dated OSM</small></span>
        <span><i className="confidenceDot fallback" />{provenance.fallbackFeatures}<small>undated fallback</small></span>
        <span><i className="confidenceDot excluded" />{provenance.datedExcluded}<small>excluded by date</small></span>
      </div>
      <p>{note} The exported JSON records source and confidence for every retained road or rail side.</p>
    </section>
  );
}

function RangeControl({ label, value, min, max, step, suffix = "", digits, onChange, nested = false }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; digits?: number; onChange: (value: number) => void; nested?: boolean }) {
  const output = digits === undefined ? value : value.toFixed(digits);
  return (
    <div className={`fieldGroup rangeGroup ${nested ? "nested" : ""}`}>
      <div className="rangeLabel"><label>{label}</label><output>{output}{suffix}</output></div>
      <input type="range" value={value} min={min} max={max} step={step} aria-label={label} onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  );
}
