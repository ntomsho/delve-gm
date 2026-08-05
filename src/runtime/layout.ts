/**
 * MAP GEOMETRY
 * ============
 *
 * The map component consumes a `Layout` and never `graph.rooms[].pos`. Phase A
 * gives force-relaxed POINTS — no room shapes, no sizes, no corridor geometry —
 * but the long-term intent is a real dungeon map with outlines. So the shapes
 * here are a discriminated union from the start: when a geometry pass arrives
 * it implements the same interface and the component does not change.
 *
 * WHAT GENERATION HAS TO SUPPLY. Only three things, and Phase A already emits
 * all of them:
 *
 *   graph.rooms[].pos       force-relaxed x/y, in an arbitrary space
 *   graph.rooms[].entityId  the bridge to the entity layer
 *   graph.edges[].entityId  ditto, plus its `a`/`b` room indices
 *
 * That middle one is the load-bearing detail. The graph talks in numeric
 * indices; everything else in the game talks in entity ids. `entityId` is the
 * only thing joining a dot on the map to the IRoom the player is standing in,
 * so the layout is keyed by it and the numeric indices never escape this file.
 *
 * Positions arrive in whatever coordinate space the relaxation settled into, so
 * they are normalised here into `bounds` once. Nothing downstream should scale
 * them again.
 *
 * This is pure geometry and carries NO run state: no fog, no current position,
 * no gating. Those change every turn while this never does — see
 * `mapView` in the store's selectors, which layers them on top.
 */

import type { Dungeon } from "../engine/index.ts";

export interface Point {
  x: number;
  y: number;
}

export type Shape =
  | { kind: "circle"; at: Point; r: number }
  /** for a future geometry pass — room outlines rather than dots */
  | { kind: "polygon"; points: Point[] };

export type Path =
  | { kind: "line"; from: Point; to: Point }
  /** for a future geometry pass — corridors with corners */
  | { kind: "polyline"; points: Point[] };

export interface LayoutRoom {
  /** the IRoom's id, not the graph index */
  id: string;
  shape: Shape;
  /** which six-room chunk it came from; useful for tinting regions */
  chunk: number;
  label?: string;
}

export interface LayoutConnector {
  /** the IRoomConnector's id */
  id: string;
  path: Path;
  /** room ids, so an endpoint can be checked against run state */
  from: string;
  to: string;
  /** inter-chunk links are the long ones between regions */
  interChunk: boolean;
}

export interface Layout {
  rooms: LayoutRoom[];
  connectors: LayoutConnector[];
  bounds: { w: number; h: number };
}

export interface PointLayoutOptions {
  /** the box positions are normalised into */
  size?: number;
  padding?: number;
  radius?: number;
}

/**
 * Circles and straight lines — the layout Phase A's output can actually
 * support. Everything a richer geometry pass would change lives behind `Shape`
 * and `Path`.
 */
export function pointLayout(graph: Dungeon, opts: PointLayoutOptions = {}): Layout {
  const size = opts.size ?? 760;
  const pad = opts.padding ?? 40;
  const r = opts.radius ?? 11;

  const xs = graph.rooms.map((room) => room.pos.x);
  const ys = graph.rooms.map((room) => room.pos.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  // One uniform scale on both axes, so the relaxed shape is not distorted.
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const scale = (size - 2 * pad) / span;

  const project = (p: Point): Point => ({
    x: pad + (p.x - minX) * scale,
    y: pad + (p.y - minY) * scale,
  });

  const byIndex = new Map(graph.rooms.map((room) => [room.id, room]));
  const at = new Map(graph.rooms.map((room) => [room.id, project(room.pos)]));

  return {
    rooms: graph.rooms.map((room) => ({
      id: room.entityId,
      chunk: room.chunk,
      shape: { kind: "circle", at: at.get(room.id)!, r },
    })),
    connectors: graph.edges.map((edge) => ({
      id: edge.entityId,
      from: byIndex.get(edge.a)!.entityId,
      to: byIndex.get(edge.b)!.entityId,
      interChunk: edge.kind === "inter-chunk",
      path: { kind: "line", from: at.get(edge.a)!, to: at.get(edge.b)! },
    })),
    bounds: {
      w: pad * 2 + (maxX - minX) * scale,
      h: pad * 2 + (maxY - minY) * scale,
    },
  };
}

/** The midpoint of a path — where a lock icon or a label goes. */
export function pathMidpoint(path: Path): Point {
  if (path.kind === "line") {
    return { x: (path.from.x + path.to.x) / 2, y: (path.from.y + path.to.y) / 2 };
  }
  const mid = path.points[Math.floor(path.points.length / 2)];
  return mid ?? { x: 0, y: 0 };
}

/** The centre of a shape — where a marker for the player goes. */
export function shapeCenter(shape: Shape): Point {
  if (shape.kind === "circle") return shape.at;
  const n = shape.points.length || 1;
  return {
    x: shape.points.reduce((s, p) => s + p.x, 0) / n,
    y: shape.points.reduce((s, p) => s + p.y, 0) / n,
  };
}
