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
 * `mapView` in `gameplay/view/map.ts`, which layers them on top.
 */

import type { BlockPlan } from "./blockplan.ts";
import type { Dungeon } from "./graph.ts";
import { pairKey } from "../../shared/utils/grid.ts";
import type { Point } from "../../shared/utils/grid.ts";

export type Shape =
  | { kind: "circle"; at: Point; r: number }
  /**
   * A room outline. `points` is the outer boundary; `holes` are interior
   * boundaries, which a room grown frontier-by-frontier can produce by closing
   * a U on itself. Rare, but a donut drawn as a filled blob is a map that lies
   * about where the floor is, so the renderer fills with `evenodd`.
   */
  | { kind: "polygon"; points: Point[]; holes?: Point[][] };

export type Path =
  | { kind: "line"; from: Point; to: Point }
  /** for a future geometry pass — corridors with corners */
  | { kind: "polyline"; points: Point[] };

/**
 * A way through, as a break in a wall.
 *
 * Under the block plan a connector has no corridor to draw — corridors are
 * rooms, so a connected pair already shares a wall and the connector IS the
 * door in it. `pointLayout` cannot say where a wall is and leaves this off.
 */
export interface LayoutDoor {
  /** the middle of the wall segment the door sits in */
  at: Point;
  /** which way the wall runs, so the door is drawn along it */
  wall: "h" | "v";
  /** the far side, so the renderer knows which way "through" points */
  through: Point;
  /**
   * How long the door is, along the wall.
   *
   * Three quarters of the wall it sits in, so it stops short of the corners at
   * either end and reads as a door in a wall rather than as the whole wall
   * having been left out. The layout supplies it because the layout is what
   * knows the cell size; the renderer should not have to be told.
   */
  length: number;
}

export interface LayoutRoom {
  /** the IRoom's id, not the graph index */
  id: string;
  shape: Shape;
  /**
   * Somewhere inside the room, for the player marker and any label.
   *
   * Not derivable from `shape`: averaging the vertices of an L puts the point
   * in the rock outside it. This is a cell the room actually owns.
   */
  centre: Point;
  /** which six-room chunk it came from; useful for tinting regions */
  chunk: number;
  /** a passage rather than a chamber — drawn lighter */
  corridor?: boolean;
  label?: string;
}

export interface LayoutConnector {
  /** the IRoomConnector's id */
  id: string;
  path: Path;
  /** room ids, so an endpoint can be checked against run state */
  from: string;
  /**
   * The room on the far side, or NULL for the way out of the dungeon — the
   * same convention as `IRoomConnector.endpointB` and `ExitView.toRoomId`.
   */
  to: string | null;
  /** inter-chunk links are the long ones between regions */
  interChunk: boolean;
  /** where it cuts the wall. Absent from a layout that has no walls. */
  door?: LayoutDoor;
}

/**
 * The way out of the dungeon.
 *
 * It carries no connector id because the layout never sees one: the surface
 * connector is minted by the entities pass, not by Phase A, so it is not on
 * `graph.edges` and this module — which knows only geometry — cannot name it.
 * `mapView` joins it to the real connector, which it can find by its null end.
 */
export interface LayoutSurface {
  /** the entrance room it opens out of */
  roomId: string;
  door: LayoutDoor;
}

/**
 * A thing standing in a room, as marks on the map.
 *
 * One entry per PLACED ENTITY, however many cells it occupies — a colonnade is
 * one feature with six dots, not six features. The renderer draws a mark at each
 * cell and the hover reads the one entity, which is what makes "the pillars"
 * something the player can point at as a single thing.
 *
 * MARKERS ARE PLAIN DOTS FOR NOW — author's call. `kind` is carried anyway,
 * because the whole reason fixtures are stored as data rather than baked into
 * SVG at generation time is so a library of line art can arrive later without
 * regenerating a single dungeon.
 */
export interface LayoutFixture {
  /** the entity id — an IRoomFeature, or an IItem loose on the floor */
  id: string;
  roomId: string;
  /** one point per cell it occupies, already in SVG units */
  at: Point[];
  /** the fixture kind, when it came from the menu. Absent on a stocked thing. */
  kind?: string;
  /** how big to draw a mark, so the renderer is not told the cell size twice */
  r: number;
}

export interface Layout {
  rooms: LayoutRoom[];
  connectors: LayoutConnector[];
  bounds: { w: number; h: number };
  /** absent from a layout with no walls to put it in */
  surface?: LayoutSurface;
  /**
   * Everything placed in a room. Empty for `pointLayout`, which has no rooms to
   * put anything in — and empty for a floorplan built before 6c, which is the
   * same nothing and needs no special case.
   *
   * Pure geometry, like everything else here: NO fog and NO concealment. A
   * hidden feature appears in this list and is dropped by `mapView`, exactly as
   * a concealed connector is. Drawing a secret because the layout forgot to
   * filter it is the one failure that cannot be walked back.
   */
  fixtures: LayoutFixture[];
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
      centre: at.get(room.id)!,
    })),
    // Edges only, which means ways BETWEEN rooms. A way out of the dungeon
    // joins a room to nothing and has no second point to draw to; showing it
    // means choosing a direction to point it off the page in, and choosing
    // directions is geometry. It belongs to whatever replaces this (§7), not
    // to a layout that only knows where the circles go.
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
    // No room outlines means nowhere honest to put anything: a dot inside a
    // circle standing for a thirty-foot hall says nothing about where the altar
    // is, and saying nothing is better than saying something invented.
    fixtures: [],
  };
}

// ===========================================================================
// THE FLOORPLAN — real outlines, from the block plan
// ===========================================================================

/**
 * OUTLINE TRACING.
 *
 * A room is a set of grid cells; the drawing wants its boundary. Every cell
 * side with no room cell behind it is a boundary edge, directed so the floor is
 * always on the same hand, and the edges then chain into closed loops.
 *
 * Direction is the whole trick. With every edge wound the same way round its
 * cell, an outer boundary comes out clockwise and a hole comes out
 * anticlockwise, so the shoelace sign sorts them with no point-in-polygon test.
 *
 * The one hard case is a diagonal pinch, where four edges meet at one corner
 * and "which edge comes next" has two answers. Taking the sharpest clockwise
 * turn is the one that keeps the two lobes as separate loops instead of
 * stitching them into a figure eight.
 */
type Corner = string;
const corner = (x: number, y: number): Corner => `${x},${y}`;
const uncorner = (c: Corner): Point => {
  const [x, y] = c.split(",").map(Number);
  return { x, y };
};

interface Edge {
  from: Corner;
  to: Corner;
}

/** Cell (x,y) covers the square from corner (x,y) to (x+1,y+1). */
function boundaryEdges(cells: Iterable<Point>, has: (x: number, y: number) => boolean): Edge[] {
  const edges: Edge[] = [];
  for (const { x, y } of cells) {
    // Wound so the floor is on the right of every edge: top runs +x, right
    // runs +y, bottom runs -x, left runs -y. y is down, so that reads clockwise.
    if (!has(x, y - 1)) edges.push({ from: corner(x, y), to: corner(x + 1, y) });
    if (!has(x + 1, y)) edges.push({ from: corner(x + 1, y), to: corner(x + 1, y + 1) });
    if (!has(x, y + 1)) edges.push({ from: corner(x + 1, y + 1), to: corner(x, y + 1) });
    if (!has(x - 1, y)) edges.push({ from: corner(x, y + 1), to: corner(x, y) });
  }
  return edges;
}

/** Twice the signed area. Positive is clockwise in screen coordinates. */
function shoelace(loop: Point[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

/** Drop the middle of any three points in a line — a wall is one segment. */
function simplify(loop: Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < loop.length; i++) {
    const prev = loop[(i - 1 + loop.length) % loop.length];
    const here = loop[i];
    const next = loop[(i + 1) % loop.length];
    const straight =
      (prev.x === here.x && here.x === next.x) || (prev.y === here.y && here.y === next.y);
    if (!straight) out.push(here);
  }
  return out.length >= 3 ? out : loop;
}

export function traceOutline(cells: Point[]): { outer: Point[]; holes: Point[][] } {
  const present = new Set(cells.map((c) => corner(c.x, c.y)));
  const has = (x: number, y: number) => present.has(corner(x, y));

  // Several edges can leave one corner at a pinch, so this is a multimap and
  // the walk below chooses between them rather than assuming one answer.
  const leaving = new Map<Corner, Edge[]>();
  for (const e of boundaryEdges(cells, has)) {
    const list = leaving.get(e.from);
    if (list) list.push(e);
    else leaving.set(e.from, [e]);
  }

  const loops: Point[][] = [];
  for (const [start, group] of leaving) {
    while (group.length) {
      const loop: Point[] = [];
      let edge: Edge | undefined = group.shift()!;
      let at = start;

      while (edge) {
        loop.push(uncorner(at));
        at = edge.to;
        const next = leaving.get(at);
        if (!next?.length) break;

        // Sharpest clockwise turn first: right, straight, left, back.
        const from = uncorner(edge.from);
        const to = uncorner(edge.to);
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        let pick = 0;
        let bestRank = -Infinity;
        next.forEach((cand, i) => {
          const c = uncorner(cand.to);
          const ex = c.x - to.x;
          const ey = c.y - to.y;
          const cross = dx * ey - dy * ex;
          const dot = dx * ex + dy * ey;
          const rank = cross > 0 ? 3 : cross < 0 ? 1 : dot > 0 ? 2 : 0;
          if (rank > bestRank) {
            bestRank = rank;
            pick = i;
          }
        });
        edge = next.splice(pick, 1)[0];
        if (at === start) break;
      }
      if (loop.length >= 4) loops.push(simplify(loop));
    }
  }

  // A room is one connected piece, so exactly one loop winds clockwise.
  let outer: Point[] = [];
  const holes: Point[][] = [];
  let widest = -Infinity;
  for (const loop of loops) {
    const area = shoelace(loop);
    if (area > 0) {
      if (area > widest) {
        if (outer.length) holes.push(outer);
        widest = area;
        outer = loop;
      } else holes.push(loop);
    } else holes.push(loop);
  }
  return { outer, holes };
}

/**
 * A placed entity, as the layout needs it: an id, a room, and the cells.
 *
 * Structural rather than an import of `IRoomFeature`, so this file keeps knowing
 * only geometry. `mapView` is where a placement meets the entity that owns it.
 */
export interface PlacedThing {
  id: string;
  roomId: string;
  place?: { cells: { x: number; y: number }[]; fixture?: string };
}

export interface FloorplanLayoutOptions {
  /** how many SVG units one grid cell measures */
  cell?: number;
  padding?: number;
  /** graph index -> true when the room is a passage rather than a chamber */
  isCorridor?: (room: number) => boolean;
  /**
   * Everything with a `place` on it — features and loose items alike.
   *
   * Passed in rather than read off the dungeon because this module never sees
   * entities. Anything without a `place`, or in a room the plan did not draw, is
   * skipped; a fixture is an enhancement over the map and never a requirement.
   */
  placed?: readonly PlacedThing[];
}

/**
 * The block plan as a drawing.
 *
 * Cells are scaled by a FIXED factor rather than normalised into a box, which
 * is the opposite of what `pointLayout` does and is deliberate: a wall is the
 * same weight and a door the same width whether the dungeon is six rooms or
 * thirty, and the panel scales the whole thing with a viewBox anyway. Normalise
 * and a size-1 dungeon draws in fat crayon while a size-5 draws in hairline.
 */
export function floorplanLayout(
  plan: BlockPlan,
  graph: Dungeon,
  opts: FloorplanLayoutOptions = {}
): Layout {
  const cell = opts.cell ?? 18;
  const pad = opts.padding ?? 24;
  const corridorAt = opts.isCorridor ?? (() => false);

  // The surface door reaches one cell into the rock, so the bounds have to
  // cover it or the way out is drawn off the edge of the map.
  const all = plan.rooms.flat();
  if (plan.surface) all.push(plan.surface.to);
  const minX = Math.min(...all.map((c) => c.x));
  const minY = Math.min(...all.map((c) => c.y));
  const maxX = Math.max(...all.map((c) => c.x));
  const maxY = Math.max(...all.map((c) => c.y));

  /** A grid CORNER to SVG units. */
  const at = (x: number, y: number): Point => ({
    x: pad + (x - minX) * cell,
    y: pad + (y - minY) * cell,
  });
  /** A grid CELL's middle. */
  const middle = (c: Point): Point => at(c.x + 0.5, c.y + 0.5);

  const rooms: LayoutRoom[] = plan.rooms.map((cells, i) => {
    const { outer, holes } = traceOutline(cells);
    return {
      id: graph.rooms[i].entityId,
      chunk: graph.rooms[i].chunk,
      corridor: corridorAt(i),
      centre: middle(innermost(cells)),
      shape: {
        kind: "polygon",
        points: outer.map((p) => at(p.x, p.y)),
        ...(holes.length ? { holes: holes.map((h) => h.map((p) => at(p.x, p.y))) } : {}),
      },
    };
  });

  /** The door on the edge between two rooms, keyed by the pair. */
  const doorFor = new Map<string, (typeof plan.doors)[number]>();
  for (const d of plan.doors) doorFor.set(pairKey(d.a, d.b), d);

  const connectors: LayoutConnector[] = [];
  for (const edge of graph.edges) {
    const door = doorFor.get(pairKey(edge.a, edge.b));
    if (!door) continue; // no shared wall was found; nothing honest to draw
    connectors.push({
      id: edge.entityId,
      from: graph.rooms[edge.a].entityId,
      to: graph.rooms[edge.b].entityId,
      interChunk: edge.kind === "inter-chunk",
      path: { kind: "line", from: middle(door.from), to: middle(door.to) },
      door: doorway(door.from, door.to, cell, at, middle),
    });
  }

  // A mark is a third of a cell across, so a colonnade reads as a row of
  // columns rather than as a filled stripe. The layout supplies it for the same
  // reason it supplies a door's length: it is the only thing here that knows
  // how big a cell is.
  const known = new Set(rooms.map((r) => r.id));
  const fixtures: LayoutFixture[] = [];
  for (const p of opts.placed ?? []) {
    if (!p.place?.cells.length || !known.has(p.roomId)) continue;
    fixtures.push({
      id: p.id,
      roomId: p.roomId,
      at: p.place.cells.map(middle),
      kind: p.place.fixture,
      r: cell / 3,
    });
  }

  return {
    rooms,
    connectors,
    bounds: {
      w: pad * 2 + (maxX - minX + 1) * cell,
      h: pad * 2 + (maxY - minY + 1) * cell,
    },
    surface: surfaceOf(plan, graph, cell, at, middle),
    fixtures,
  };
}

/**
 * The cell nearest the middle of the room.
 *
 * The mean of a U's cells lands in the notch, which is rock, and a player
 * marker in the rock is worse than no marker. Snapping to the nearest owned
 * cell costs one pass and cannot be outside the room.
 */
function innermost(cells: Point[]): Point {
  const mx = cells.reduce((s, c) => s + c.x, 0) / cells.length;
  const my = cells.reduce((s, c) => s + c.y, 0) / cells.length;
  let best = cells[0];
  let bestD = Infinity;
  for (const c of cells) {
    const d = (c.x - mx) ** 2 + (c.y - my) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** The wall segment between two side-by-side cells, in SVG units. */
function doorway(
  from: Point,
  to: Point,
  cell: number,
  at: (x: number, y: number) => Point,
  middle: (c: Point) => Point
): LayoutDoor {
  const vertical = from.x !== to.x;
  return {
    wall: vertical ? "v" : "h",
    at: vertical
      ? at(Math.max(from.x, to.x), from.y + 0.5)
      : at(from.x + 0.5, Math.max(from.y, to.y)),
    through: middle(to),
    length: cell * 0.75,
  };
}

function surfaceOf(
  plan: BlockPlan,
  graph: Dungeon,
  cell: number,
  at: (x: number, y: number) => Point,
  middle: (c: Point) => Point
): LayoutSurface | undefined {
  if (!plan.surface) return undefined;
  const { room, from, to } = plan.surface;
  return { roomId: graph.rooms[room].entityId, door: doorway(from, to, cell, at, middle) };
}

/** The midpoint of a path — where a lock icon or a label goes. */
export function pathMidpoint(path: Path): Point {
  if (path.kind === "line") {
    return { x: (path.from.x + path.to.x) / 2, y: (path.from.y + path.to.y) / 2 };
  }
  const mid = path.points[Math.floor(path.points.length / 2)];
  return mid ?? { x: 0, y: 0 };
}

