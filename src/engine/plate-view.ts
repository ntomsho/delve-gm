/**
 * PLATE VIEW
 * ==========
 *
 * A room as an illustrator would frame it — where the camera stands, which way
 * it looks, and where everything lands in the picture — computed from the drawn
 * floor, not described by a model.
 *
 * The image model is good at style and poor at spatial bookkeeping: told "a
 * well, an altar, three doors", it puts them wherever it likes. So everything
 * about WHERE is settled here, from the same grid the map draws, and the prompt
 * only has to carry the answers.
 *
 * THE CAMERA IS CHOSEN BY SCORE. Every standing spot on the floor and every
 * heading is tried, and the view that shows the most wins: features above all,
 * then ways out, then floor. Standing in the doorway the player came through
 * was the first rule, and it lost a quarter of the features and most of the
 * exits to the corners of cross-shaped rooms (seed 4201: 74% and 28%). The
 * door they came in by still counts — for less than any other way out, so a
 * view that looks back at it loses to one that looks somewhere new.
 *
 * Pure grid geometry. It knows cells, doors and footprints; it does not know
 * entities, names, or what is hidden. `src/runtime/plates.ts` is where a
 * generated dungeon becomes one of these inputs, and where concealment is
 * filtered out before anything here sees it.
 *
 * COORDINATES: grid cells, x east and y SOUTH (the block plan's convention),
 * scaled to feet by CELL_FEET so every distance here is one the prose may say.
 */

import type { Point } from "./dungeon-blockplan.ts";
import { CELL_FEET } from "./dungeon-geometry.ts";

// ---------------------------------------------------------------------------
// INPUT
// ---------------------------------------------------------------------------

/** A door as the plan stores it: the floor cell on this side, the cell beyond. */
export interface ViewDoor {
  id: string;
  /** the room's own cell the door opens from */
  inside: Point;
  /** the cell on the far side — another room's floor, or rock for the way out */
  outside: Point;
}

/** Something standing in the room, by the cells it covers. */
export interface ViewThing {
  id: string;
  /** empty when the thing was never placed — it is still in the room */
  cells: Point[];
}

export interface PlateViewInput {
  /** every floor cell the room owns */
  floor: Point[];
  /** the way the viewer came in. Scored below every other way out. */
  entry: ViewDoor;
  /** every other way out the viewer could know about */
  exits: ViewDoor[];
  features: ViewThing[];
}

// ---------------------------------------------------------------------------
// OUTPUT
// ---------------------------------------------------------------------------

/**
 * Which wall of the view a door sits in, as the viewer would say it. `away` is
 * a wall whose room side does not face the eye — the far side of an arm of the
 * room — so its door cannot be in the picture.
 */
export type ViewWall = "far" | "left" | "right" | "behind" | "away";
export type Depth = "near" | "middle" | "far";
export type Side = "left" | "centre" | "right";
export type Compass = "north" | "north-east" | "east" | "south-east" | "south" | "south-west" | "west" | "north-west";

export interface Seen {
  id: string;
  /** feet straight ahead of the eye */
  ahead: number;
  /** feet to the right of the line of sight; negative is left */
  across: number;
  depth: Depth;
  side: Side;
  /** a feature in separate places: each piece that is in the picture */
  pieces?: { ahead: number; depth: Depth; side: Side }[];
  /** doors only: the wall it is cut into */
  wall?: ViewWall;
  /** some part of it is inside the horizontal field of view */
  inFrame: boolean;
  /** some part of it is not cut off by the room's own walls */
  inSight: boolean;
  /** some part of it is both — this is what "in the picture" means */
  visible: boolean;
  /** false for a thing with no footprint; nothing else above is meaningful then */
  placed: boolean;
}

/** Where the camera stands and which way it looks, in feet. */
export interface Eye {
  x: number;
  y: number;
  /** unit vector along the line of sight */
  forward: Point;
  /** unit vector to the viewer's right */
  right: Point;
}

export interface PlateView {
  eye: Eye;
  facing: Compass;
  /** where in the room the eye stands, as words: "in the south-west corner" */
  standing: string;
  /** how far the floor runs ahead of the eye, in feet */
  deep: number;
  /** how far the floor runs side to side, in feet */
  wide: number;
  entry: Seen;
  exits: Seen[];
  features: Seen[];
  /** floor cells in the picture */
  tiles: number;
  score: number;
}

// ---------------------------------------------------------------------------
// TUNING
// ---------------------------------------------------------------------------

/**
 * Half the horizontal field of view, in degrees. 100 degrees in all — wider
 * than a lens, about what an illustrator gives a room interior so the side
 * walls show.
 */
export const PLATE_HALF_FOV_DEG = 50;

/**
 * What a view is worth. A feature outweighs any amount of floor a room can
 * have, so the camera never trades one away for a better angle; a way out
 * outweighs a few cells of floor; and the way in is worth a quarter of any
 * other way out, which tips a tie toward looking somewhere the player has not
 * just been.
 */
export const PLATE_SCORE = { tile: 1, feature: 100, exit: 20, entry: 5 } as const;

/** Headings tried at each standing spot: every 10 degrees. */
export const PLATE_HEADINGS = 36;

/** Eye height, in feet. Nothing stores a ceiling or a viewer's height; this is a guess. */
export const PLATE_EYE_FT = 5.5;

/** Wall and doorway heights, in feet. Guesses like the eye height; the drawing and the buttons share them. */
export const PLATE_WALL_FT = 11;
export const PLATE_DOOR_FT = 7.5;

/** The plate's width over its height. 3:2, the space the page reserves for it. */
export const PLATE_ASPECT = 1.5;

/**
 * Nothing nearer the eye than this, in feet, counts as in the picture: the
 * floor only comes into frame here, below the bottom edge before it. Derived
 * rather than chosen — a guess of four feet counted things at the viewer's
 * feet that the frame then cut off.
 */
export const PLATE_MIN_AHEAD_FT =
  PLATE_EYE_FT / (Math.tan((PLATE_HALF_FOV_DEG * Math.PI) / 180) / PLATE_ASPECT);

/**
 * Standing spots within each floor cell, in feet from its corner on each axis:
 * against either wall and in the middle, nine to a cell. Back to a wall or in a
 * corner is where an illustrator stands; the middle is there so a room with no
 * good wall still has somewhere to stand.
 */
const SPOT_OFFSETS_FT = [1, 2.5, 4];

/**
 * Inside this many degrees of the line of sight, a thing is "straight ahead"
 * rather than left or right. About a fifth of the frame either side of centre.
 */
const CENTRE_DEG = 12;

// ---------------------------------------------------------------------------
// SIGHT
// ---------------------------------------------------------------------------

const key = (x: number, y: number) => `${x},${y}`;

/**
 * Every cell the straight line from `a` to `b` passes through is floor.
 *
 * An exact walk of the grid, not sampling: a sampled walk once stepped over
 * the tip of a rock corner and called a door around it visible (seed 4201, The
 * Stone Dormitory). A line through a cell corner exactly needs both cells
 * beside the corner to be floor, so a pinch between two rock cells is a wall.
 */
export function clearLine(a: Point, b: Point, onFloor: (x: number, y: number) => boolean): boolean {
  const ax = a.x / CELL_FEET;
  const ay = a.y / CELL_FEET;
  const bx = b.x / CELL_FEET;
  const by = b.y / CELL_FEET;
  let cx = Math.floor(ax);
  let cy = Math.floor(ay);
  const ex = Math.floor(bx);
  const ey = Math.floor(by);
  const dx = bx - ax;
  const dy = by - ay;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tmx = dx > 0 ? (cx + 1 - ax) * tdx : dx < 0 ? (ax - cx) * tdx : Infinity;
  let tmy = dy > 0 ? (cy + 1 - ay) * tdy : dy < 0 ? (ay - cy) * tdy : Infinity;

  if (!onFloor(cx, cy)) return false;
  let guard = Math.abs(ex - cx) + Math.abs(ey - cy) + 2;
  while ((cx !== ex || cy !== ey) && guard-- > 0) {
    if (Math.abs(tmx - tmy) < 1e-9) {
      if (!onFloor(cx + sx, cy) || !onFloor(cx, cy + sy)) return false;
      cx += sx;
      cy += sy;
      tmx += tdx;
      tmy += tdy;
    } else if (tmx < tmy) {
      cx += sx;
      tmx += tdx;
    } else {
      cy += sy;
      tmy += tdy;
    }
    if (!onFloor(cx, cy)) return false;
  }
  return true;
}

/** The middle of the shared edge between two side-by-side cells, in feet. */
export function doorPoint(d: ViewDoor): Point {
  return {
    x: ((d.inside.x + d.outside.x) / 2 + 0.5) * CELL_FEET,
    y: ((d.inside.y + d.outside.y) / 2 + 0.5) * CELL_FEET,
  };
}

/**
 * Where a door is sighted at: just inside the threshold. The door point itself
 * is on the wall line, and a line ending on a wall is a line into rock.
 */
export function doorTarget(d: ViewDoor): Point {
  const at = doorPoint(d);
  return {
    x: (at.x + (d.inside.x + 0.5) * CELL_FEET) / 2,
    y: (at.y + (d.inside.y + 0.5) * CELL_FEET) / 2,
  };
}

/** Lines of sight from `eye` in this room: clear when every cell crossed is floor. */
export function plateSight(input: PlateViewInput, eye: Point): (p: Point) => boolean {
  const floor = new Set(input.floor.map((c) => key(c.x, c.y)));
  const onFloor = (x: number, y: number) => floor.has(key(x, y));
  return (p) => clearLine(eye, p, onFloor);
}

/** A point in the room, in feet, with its height above the floor. */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Where a point lands in the plate, as fractions of its width and height from
 * the top-left — so it maps onto the final image at any resolution. Null when
 * the point is behind the eye. A point beside the frame comes back outside
 * 0..1 rather than null; whether that matters is the caller's question.
 */
export function projectToFrame(eye: Eye, p: Point3): Point | null {
  const ahead = (p.x - eye.x) * eye.forward.x + (p.y - eye.y) * eye.forward.y;
  if (ahead < 0.3) return null;
  const across = (p.x - eye.x) * eye.right.x + (p.y - eye.y) * eye.right.y;
  const up = p.z - PLATE_EYE_FT;
  const t = 2 * Math.tan((PLATE_HALF_FOV_DEG * Math.PI) / 180);
  return { x: 0.5 + across / ahead / t, y: 0.5 - (up / ahead / t) * PLATE_ASPECT };
}

/**
 * Every place the camera may stand: nine spots in each floor cell, the floor
 * just inside each doorway among them. Never in a doorway itself — standing in
 * one, even back from the room, is a view of the room from somewhere the player
 * has not been: through a door they have not opened, or a sealed one.
 */
function standingSpots(input: PlateViewInput): Point[] {
  const spots: Point[] = [];
  for (const c of input.floor) {
    for (const ox of SPOT_OFFSETS_FT) {
      for (const oy of SPOT_OFFSETS_FT) spots.push({ x: c.x * CELL_FEET + ox, y: c.y * CELL_FEET + oy });
    }
  }
  return spots;
}

/** Cells split into pieces that touch edge to edge. */
export function connectedCells(cells: readonly Point[]): Point[][] {
  const left = new Map(cells.map((c) => [key(c.x, c.y), c]));
  const pieces: Point[][] = [];
  for (const start of cells) {
    if (!left.delete(key(start.x, start.y))) continue;
    const piece: Point[] = [];
    const queue = [start];
    while (queue.length) {
      const c = queue.pop()!;
      piece.push(c);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = left.get(key(c.x + dx, c.y + dy));
        if (n) {
          left.delete(key(n.x, n.y));
          queue.push(n);
        }
      }
    }
    pieces.push(piece);
  }
  return pieces;
}

export const cellMiddle = (c: Point): Point => ({ x: (c.x + 0.5) * CELL_FEET, y: (c.y + 0.5) * CELL_FEET });

const COMPASS: Compass[] = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];

function compass(v: Point): Compass {
  // y points south, so atan2 turns clockwise from east — the order of COMPASS.
  const octant = Math.round(Math.atan2(v.y, v.x) / (Math.PI / 4));
  return COMPASS[(octant + 8) % 8];
}

// ---------------------------------------------------------------------------
// ONE CAMERA
// ---------------------------------------------------------------------------

/**
 * The room as seen from one eye looking one way. `plateView` calls this on the
 * camera it chose; it is exported so a test, or a dev sheet, can ask about any
 * other camera directly.
 */
export function viewFrom(input: PlateViewInput, at: Point, heading: Point): PlateView {
  const len = Math.hypot(heading.x, heading.y) || 1;
  const forward = { x: heading.x / len, y: heading.y / len };
  // Turning the forward vector a quarter clockwise, with y pointing south.
  const right = { x: -forward.y, y: forward.x };
  const eye: Eye = { x: at.x, y: at.y, forward, right };

  const sees = plateSight(input, eye);

  const toView = (p: Point) => ({
    ahead: (p.x - eye.x) * forward.x + (p.y - eye.y) * forward.y,
    across: (p.x - eye.x) * right.x + (p.y - eye.y) * right.y,
  });
  const tanFov = Math.tan((PLATE_HALF_FOV_DEG * Math.PI) / 180);
  const framed = (v: { ahead: number; across: number }) =>
    v.ahead >= PLATE_MIN_AHEAD_FT && Math.abs(v.across) <= v.ahead * tanFov;

  // The floor's extent in the viewer's frame, from cell corners.
  let deep = 0;
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  for (const c of input.floor) {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const v = toView({ x: (c.x + dx) * CELL_FEET, y: (c.y + dy) * CELL_FEET });
      deep = Math.max(deep, v.ahead);
      minAcross = Math.min(minAcross, v.across);
      maxAcross = Math.max(maxAcross, v.across);
    }
  }

  const depthOf = (ahead: number): Depth =>
    ahead < deep / 3 ? "near" : ahead < (deep * 2) / 3 ? "middle" : "far";
  const sideOf = (v: { ahead: number; across: number }): Side => {
    const deg = (Math.atan2(v.across, Math.max(v.ahead, 0.01)) * 180) / Math.PI;
    return deg < -CENTRE_DEG ? "left" : deg > CENTRE_DEG ? "right" : "centre";
  };

  const door = (d: ViewDoor): Seen => {
    const at = doorPoint(d);
    const v = toView(at);
    // The wall's room-side normal. A wall whose room side points away from the
    // eye is seen from behind, if at all — the far side of an arm the viewer is
    // not standing in.
    const n = { x: d.inside.x - d.outside.x, y: d.inside.y - d.outside.y };
    const facesEye = (eye.x - at.x) * n.x + (eye.y - at.y) * n.y > 0;
    const wall: ViewWall =
      v.ahead <= 0
        ? "behind"
        : !facesEye
          ? "away"
          : n.x * forward.x + n.y * forward.y < -0.7
            ? "far"
            : v.across < 0
              ? "left"
              : "right";
    // Framed at the opening itself, on the wall line. Sighted just inside it
    // (a line ending on a wall ends in rock), but framing that point instead
    // counted a door near the camera whose opening was off the frame's edge.
    const inFrame = wall !== "behind" && framed(v);
    const inSight = facesEye && sees(doorTarget(d));
    return {
      id: d.id,
      ...v,
      depth: depthOf(v.ahead),
      side: sideOf(v),
      wall,
      inFrame,
      inSight,
      visible: inFrame && inSight,
      placed: true,
    };
  };

  const features: Seen[] = input.features.map((t) => {
    if (!t.cells.length) {
      return {
        id: t.id, ahead: 0, across: 0, depth: "middle", side: "centre",
        inFrame: true, inSight: true, visible: true, placed: false,
      };
    }
    const mids = t.cells.map(cellMiddle);
    const centre = {
      x: mids.reduce((s, p) => s + p.x, 0) / mids.length,
      y: mids.reduce((s, p) => s + p.y, 0) / mids.length,
    };
    const v = toView(centre);
    const cells = mids.map((p) => ({ framed: framed(toView(p)), sighted: sees(p) }));
    // A thing in separate places — niches round the walls — is said piece by
    // piece; its middle is somewhere none of it stands.
    const parts = connectedCells(t.cells);
    const pieces =
      parts.length < 2
        ? undefined
        : parts.flatMap((part) => {
            const pm = part.map(cellMiddle);
            if (!pm.some((p) => framed(toView(p)) && sees(p))) return [];
            const pv = toView({
              x: pm.reduce((acc, p) => acc + p.x, 0) / pm.length,
              y: pm.reduce((acc, p) => acc + p.y, 0) / pm.length,
            });
            return [{ ahead: pv.ahead, depth: depthOf(pv.ahead), side: sideOf(pv) }];
          });
    return {
      id: t.id,
      ...v,
      depth: depthOf(v.ahead),
      side: sideOf(v),
      ...(pieces ? { pieces } : {}),
      // A spread thing — a colonnade, a row of bunks — is in the picture if any of it is.
      inFrame: cells.some((c) => c.framed),
      inSight: cells.some((c) => c.sighted),
      visible: cells.some((c) => c.framed && c.sighted),
      placed: true,
    };
  });

  let tiles = 0;
  for (const c of input.floor) {
    const m = cellMiddle(c);
    if (framed(toView(m)) && sees(m)) tiles++;
  }

  const entry = door(input.entry);
  const exits = input.exits.map(door);
  const score =
    tiles * PLATE_SCORE.tile +
    features.filter((f) => f.placed && f.visible).length * PLATE_SCORE.feature +
    exits.filter((x) => x.visible).length * PLATE_SCORE.exit +
    (entry.visible ? PLATE_SCORE.entry : 0);

  return {
    eye,
    facing: compass(forward),
    standing: standingPhrase(input.floor, eye),
    deep,
    wide: maxAcross - minAcross,
    entry,
    exits,
    features,
    tiles,
    score,
  };
}

/** Where the eye stands, by thirds of the room's bounding box. */
function standingPhrase(floor: Point[], eye: Point): string {
  const xs = floor.map((c) => c.x);
  const ys = floor.map((c) => c.y);
  const x0 = Math.min(...xs) * CELL_FEET;
  const y0 = Math.min(...ys) * CELL_FEET;
  const w = (Math.max(...xs) + 1) * CELL_FEET - x0;
  const h = (Math.max(...ys) + 1) * CELL_FEET - y0;
  const col = Math.min(2, Math.floor(((eye.x - x0) / w) * 3));
  const row = Math.min(2, Math.floor(((eye.y - y0) / h) * 3));
  const ns = ["north", "", "south"][row];
  const ew = ["west", "", "east"][col];
  if (ns && ew) return `in the ${ns}-${ew} corner`;
  if (ns || ew) return `by the ${ns || ew} wall`;
  return "in the middle";
}

// ---------------------------------------------------------------------------
// THE SEARCH
// ---------------------------------------------------------------------------

/**
 * The best view of the room: every standing spot on the floor, every heading,
 * scored by PLATE_SCORE.
 *
 * Deterministic: spots and headings are tried in a fixed order and a tie keeps
 * the first, so a room's view — and with it the plate's cache key — never
 * changes between calls.
 *
 * The expensive part, sight lines, depends on the spot and not the heading, so
 * it is worked out once per spot and every heading reuses it.
 */
export function plateView(input: PlateViewInput): PlateView {
  const floor = new Set(input.floor.map((c) => key(c.x, c.y)));
  const onFloor = (x: number, y: number) => floor.has(key(x, y));
  const tanFov = Math.tan((PLATE_HALF_FOV_DEG * Math.PI) / 180);

  /** What can score, each with where it is, what it is worth, and which group it counts in. */
  interface Target {
    /** where it is sighted */
    at: Point;
    /** where it must fall inside the frame; `at` unless it is a door */
    frame: Point;
    worth: number;
    /** targets sharing a group count once between them — a feature's cells */
    group: number;
    /** a door, seen only from its room side: the point on its wall line, and that side */
    wall?: Point;
    normal?: Point;
  }
  const targets: Target[] = [];
  let group = 0;
  for (const c of input.floor) {
    const m = cellMiddle(c);
    targets.push({ at: m, frame: m, worth: PLATE_SCORE.tile, group: group++ });
  }
  for (const f of input.features) {
    for (const c of f.cells) {
      const m = cellMiddle(c);
      targets.push({ at: m, frame: m, worth: PLATE_SCORE.feature, group });
    }
    group++;
  }
  const doorTargets = (d: ViewDoor, worth: number) => {
    targets.push({
      at: doorTarget(d),
      frame: doorPoint(d),
      worth,
      group: group++,
      wall: doorPoint(d),
      normal: { x: d.inside.x - d.outside.x, y: d.inside.y - d.outside.y },
    });
  };
  for (const d of input.exits) doorTargets(d, PLATE_SCORE.exit);
  doorTargets(input.entry, PLATE_SCORE.entry);

  const headings: Point[] = [];
  for (let k = 0; k < PLATE_HEADINGS; k++) {
    const a = (k / PLATE_HEADINGS) * 2 * Math.PI;
    headings.push({ x: Math.cos(a), y: Math.sin(a) });
  }

  let best: { at: Point; heading: Point; score: number } | undefined;
  const seenGroups = new Set<number>();
  for (const at of standingSpots(input)) {
    const sees = (p: Point) => clearLine(at, p, onFloor);
    const sighted = targets.filter(
      (t) => (!t.wall || (at.x - t.wall.x) * t.normal!.x + (at.y - t.wall.y) * t.normal!.y > 0) && sees(t.at)
    );
    for (const h of headings) {
      seenGroups.clear();
      let score = 0;
      for (const t of sighted) {
        if (seenGroups.has(t.group)) continue;
        const dx = t.frame.x - at.x;
        const dy = t.frame.y - at.y;
        const ahead = dx * h.x + dy * h.y;
        const across = -dx * h.y + dy * h.x;
        if (ahead < PLATE_MIN_AHEAD_FT || Math.abs(across) > ahead * tanFov) continue;
        seenGroups.add(t.group);
        score += t.worth;
      }
      if (!best || score > best.score) best = { at, heading: h, score };
    }
  }

  // An empty floor has nowhere to stand; look in from the doorway regardless.
  if (!best) {
    const d = input.entry;
    return viewFrom(input, doorTarget(d), { x: d.inside.x - d.outside.x, y: d.inside.y - d.outside.y });
  }
  return viewFrom(input, best.at, best.heading);
}

// ---------------------------------------------------------------------------
// WORDS
// ---------------------------------------------------------------------------

/** Distances are said to the nearest five feet, the grid's own unit. */
const feet = (n: number) => `${Math.max(CELL_FEET, Math.round(n / CELL_FEET) * CELL_FEET)} ft`;

const SIDE_ON_FAR_WALL: Record<Side, string> = {
  left: "to the left",
  centre: "straight ahead",
  right: "to the right",
};
const DEPTH_ON_SIDE_WALL: Record<Depth, string> = {
  near: "close by",
  middle: "partway along",
  far: "toward the back",
};
const DEPTH_IN_ROOM: Record<Depth, string> = {
  near: "in the foreground",
  middle: "in the middle distance",
  far: "at the back",
};
const SIDE_IN_ROOM: Record<Side, string> = {
  left: "on the left",
  centre: "in the centre",
  right: "on the right",
};

/** Where a way out is, as the viewer would point to it. */
export function exitWhere(s: Seen): string {
  if (s.wall === "behind") return "behind the viewer";
  if (s.wall === "far") return `in the facing wall, ${SIDE_ON_FAR_WALL[s.side]}, ${feet(s.ahead)} away`;
  return `in the ${s.wall} wall, ${DEPTH_ON_SIDE_WALL[s.depth]}, ${feet(s.ahead)} in`;
}

/** Where a feature stands, as the viewer would point to it. */
export function featureWhere(s: Seen): string {
  if (!s.placed) return "somewhere in plain view";
  if (s.pieces && s.pieces.length > 1) {
    const at = s.pieces.map((p) => `${DEPTH_IN_ROOM[p.depth]} ${SIDE_IN_ROOM[p.side]} (${feet(p.ahead)})`);
    return `in ${s.pieces.length} places: ${at.join("; ")}`;
  }
  if (s.pieces?.length === 1) {
    const p = s.pieces[0];
    return `${DEPTH_IN_ROOM[p.depth]}, ${SIDE_IN_ROOM[p.side]}, ${feet(p.ahead)} away`;
  }
  return `${DEPTH_IN_ROOM[s.depth]}, ${SIDE_IN_ROOM[s.side]}, ${feet(s.ahead)} away`;
}

/** Why something cannot be in the picture, or null when it is. */
export function unseenReason(s: Seen): string | null {
  if (s.visible) return null;
  if (s.wall === "behind") return "behind the viewer";
  if (s.wall === "away") return "in a wall that faces away from the viewer";
  if (!s.inSight) return "out of sight around a corner";
  return "outside the frame";
}
