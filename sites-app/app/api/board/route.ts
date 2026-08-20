// @ts-expect-error — vendored CommonJS module from the original Mapforge project.
import Board from "../../../vendor/mapforge/lib/board.js";
// @ts-expect-error — vendored CommonJS module from the original Mapforge project.
import Render from "../../../vendor/mapforge/lib/render.js";

export const runtime = "edge";
export const maxDuration = 300;

type BoardRequest = {
  lat?: number;
  lon?: number;
  bearing?: number;
  name?: string;
  boardCols?: number;
  boardRows?: number;
  targetYear?: number | null;
  minReliefM?: number;
  hillHigh?: number;
  hillLow?: number;
  reliefWeight?: number;
};

function bounded(value: unknown, fallback: number, min: number, max: number) {
  const number = typeof value === "number" ? value : fallback;
  return Math.max(min, Math.min(max, number));
}

function boundedInt(value: unknown, fallback: number, min: number, max: number) {
  return Math.round(bounded(value, fallback, min, max));
}

export async function POST(request: Request) {
  try {
    const params = (await request.json()) as BoardRequest;
    if (typeof params.lat !== "number" || typeof params.lon !== "number") {
      return Response.json({ error: "Latitude and longitude are required." }, { status: 400 });
    }
    if (Math.abs(params.lat) > 85 || Math.abs(params.lon) > 180) {
      return Response.json({ error: "That location is outside the supported map range." }, { status: 400 });
    }

    const log: string[] = [];
    const board = await Board.build({
      lat: params.lat,
      lon: params.lon,
      bearing: bounded(params.bearing, 0, 0, 355),
      name: (params.name || "Board").slice(0, 12),
      boardCols: boundedInt(params.boardCols, 1, 1, 4),
      boardRows: boundedInt(params.boardRows, 1, 1, 4),
      targetYear: params.targetYear === 1985 ? 1985 : null,
      minReliefM: bounded(params.minReliefM, 8, 2, 30),
      hillHigh: bounded(params.hillHigh, 0.66, 0.4, 0.9),
      hillLow: bounded(params.hillLow, 0.48, 0.2, 0.8),
      reliefWeight: bounded(params.reliefWeight, 0.5, 0, 1),
      requireOsm: true,
      log: (message: string) => log.push(message),
    });

    const project = {
      meta: board.meta,
      stats: board.stats,
      hexes: board.hexes.filter((hex: { onBoard: boolean }) => hex.onBoard).map((hex: Record<string, any>) => ({
        id: hex.label,
        i: hex.i,
        j: hex.j,
        terrain: hex.terrain,
        hill: hex.hill,
        obstacleHeight: hex.obstacleHeight,
        unitHeight: hex.unitHeight,
        elevM: +hex.elev.toFixed(1),
        reliefM: +hex.relief.toFixed(1),
        dominance: +hex.dominance.toFixed(3),
      })),
      roads: board.roads.map((edge: Record<string, any>) => ({
        a: edge.a,
        b: edge.b,
        cls: edge.cls,
        bridge: !!edge.bridge,
        source: edge.source,
        confidence: edge.confidence,
      })),
      rivers: board.rivers.map((river: Record<string, any>) => ({
        kind: river.kind,
        name: river.name,
        nodes: river.nodes,
      })),
    };

    return Response.json({
      svg: Render.render(board),
      project,
      stats: board.stats,
      meta: board.meta,
      log,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Board generation failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
