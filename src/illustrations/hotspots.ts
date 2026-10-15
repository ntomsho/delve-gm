/**
 * ILLUSTRATION HOTSPOTS
 * ==============
 *
 * Where each way out and each feature lands in a room illustration, so the page can
 * lay buttons over the finished image — and, for the ones the picture cannot
 * show, which way the player would have to go.
 *
 * Every position is a fraction of the illustration's width and height from its
 * top-left (`projectToFrame`), so the same numbers fit the image at any size.
 * They come from the same camera the guide image was drawn from, so a button
 * sits on the doorway the image model was told to draw there.
 *
 * Four outcomes, from best to least:
 *
 *   shown        in the picture and unobstructed. A button at each point —
 *                one for a door, one per visible piece of a feature.
 *   around       hidden behind the room's own wall, with the corner to go round
 *                in the picture. An arrow at the corner, turning left or right.
 *   behind-wall  in the frame's field of view but walled off, and no corner in
 *                the picture leads to it. A dashed button where it would be.
 *   off-frame    beside or behind the camera. An arrow on the left, right or
 *                bottom edge of the illustration.
 *
 * Each outcome is exactly one control: buttons, a corner arrow, a dashed
 * button, or an edge arrow. The arrow is the way to the thing, so it is also
 * the thing's button.
 *
 * Pure geometry, like `illustrationView`; it knows ids and cells, not entities.
 */

import { CELL_FEET } from "../generation/floorplan/geometry.ts";
import type { Point } from "../generation/floorplan/blockplan.ts";
import {
  cellMiddle,
  clearLine,
  connectedCells,
  doorPoint,
  doorTarget,
  ILLUSTRATION_DOOR_FT,
  ILLUSTRATION_HALF_FOV_DEG,
  illustrationSight,
  projectToFrame,
  type Eye,
  type IllustrationView,
  type IllustrationViewInput,
  type ViewDoor,
} from "./view.ts";

export type HotspotRole = "entry" | "exit" | "feature";
export type HotspotEdge = "left" | "right" | "bottom";

export interface Hotspot {
  id: string;
  role: HotspotRole;
  status: "shown" | "around" | "behind-wall" | "off-frame";
  /**
   * shown: a button at each. behind-wall: the dashed button, where it would be.
   * Empty for around (the corner arrow is the button) and off-frame.
   */
  points: Point[];
  /** around: the corner to go round, and which way the path turns there */
  around?: { x: number; y: number; turn: "left" | "right" };
  /** off-frame: the edge of the illustration to put the arrow on */
  edge?: HotspotEdge;
  /**
   * off-frame: where along that edge, 0 to 1, from the bearing — top to bottom
   * on a side (the further behind, the lower), left to right on the bottom.
   * The page uses it to order the arrows sharing an edge.
   */
  along?: number;
}

/**
 * Beyond this many degrees from the line of sight, a thing is behind the
 * viewer and its arrow goes on the bottom edge rather than a side. Past 120°
 * it is more behind than beside.
 */
export const HOTSPOT_BEHIND_DEG = 120;

/** Height a feature's button sits at, in feet: the floor, where its outline is. */
const FEATURE_Z = 0;
/** Height a corner arrow sits at, in feet: about a hand's height on the wall. */
const CORNER_Z = 4;

const key = (x: number, y: number) => `${x},${y}`;

const inFrame = (q: Point | null): q is Point => q !== null && q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1;

/** Within the horizontal field of view and in front of the eye, whatever the height. */
function inFieldOfView(eye: Eye, p: Point): boolean {
  const ahead = (p.x - eye.x) * eye.forward.x + (p.y - eye.y) * eye.forward.y;
  const across = (p.x - eye.x) * eye.right.x + (p.y - eye.y) * eye.right.y;
  return ahead > 0 && Math.abs(across) <= ahead * Math.tan((ILLUSTRATION_HALF_FOV_DEG * Math.PI) / 180);
}

function edgeToward(eye: Eye, p: Point, z: number): { edge: HotspotEdge; along: number } {
  const ahead = (p.x - eye.x) * eye.forward.x + (p.y - eye.y) * eye.forward.y;
  const across = (p.x - eye.x) * eye.right.x + (p.y - eye.y) * eye.right.y;
  const deg = (Math.abs(Math.atan2(across, ahead)) * 180) / Math.PI;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  // Behind: dead behind is the middle of the bottom, more to one side is further toward it.
  if (deg > HOTSPOT_BEHIND_DEG) {
    const off = (0.5 * (180 - deg)) / (180 - HOTSPOT_BEHIND_DEG);
    return { edge: "bottom", along: clamp(across < 0 ? 0.5 - off : 0.5 + off) };
  }
  // Straight ahead but under the frame — a thing at the viewer's feet — is
  // down, not to one side, and as far across as it is.
  if (deg <= ILLUSTRATION_HALF_FOV_DEG) {
    const q = projectToFrame(eye, { ...p, z });
    if (!q || q.y > 1) return { edge: "bottom", along: q ? clamp(q.x) : 0.5 };
  }
  const along = clamp((deg - ILLUSTRATION_HALF_FOV_DEG) / (HOTSPOT_BEHIND_DEG - ILLUSTRATION_HALF_FOV_DEG));
  return { edge: across < 0 ? "left" : "right", along };
}

/**
 * Inside corners of the room: lattice points with floor on three sides and
 * rock on the fourth — the corners a path bends round. Each is nudged half a
 * foot off the rock so a sight line to it does not graze the wall.
 */
function cornersOf(floor: readonly Point[]): Point[] {
  const on = new Set(floor.map((c) => key(c.x, c.y)));
  const seen = new Set<string>();
  const out: Point[] = [];
  for (const c of floor) {
    for (const [i, j] of [[c.x, c.y], [c.x + 1, c.y], [c.x, c.y + 1], [c.x + 1, c.y + 1]]) {
      if (seen.has(key(i, j))) continue;
      seen.add(key(i, j));
      const around = [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]];
      const rock = around.filter(([x, y]) => !on.has(key(x, y)));
      if (rock.length !== 1) continue;
      const [rx, ry] = rock[0];
      out.push({
        x: i * CELL_FEET + (rx < i ? 0.5 : -0.5),
        y: j * CELL_FEET + (ry < j ? 0.5 : -0.5),
      });
    }
  }
  return out;
}

/**
 * The shortest walk from the eye to `target` that keeps to the floor, as the
 * corners it bends round. Empty when the target is in plain sight; null when
 * nothing reaches it. Dijkstra over the eye, the inside corners and the target,
 * joined wherever a straight line between them stays on the floor — the taut
 * string a walk round the room's corners makes.
 */
function route(input: IllustrationViewInput, eye: Point, target: Point, corners: Point[]): Point[] | null {
  const on = new Set(input.floor.map((c) => key(c.x, c.y)));
  const onFloor = (x: number, y: number) => on.has(key(x, y));
  const fromEye = illustrationSight(input, eye);
  const nodes = [eye, ...corners, target];
  const last = nodes.length - 1;
  const clear = (a: number, b: number) =>
    a === 0 ? fromEye(nodes[b]) : b === 0 ? fromEye(nodes[a]) : clearLine(nodes[a], nodes[b], onFloor);

  const dist = nodes.map(() => Infinity);
  const prev = nodes.map(() => -1);
  const done = nodes.map(() => false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity) return null;
    if (u === last) break;
    done[u] = true;
    for (let v = 0; v < nodes.length; v++) {
      if (done[v] || v === u) continue;
      const d = dist[u] + Math.hypot(nodes[u].x - nodes[v].x, nodes[u].y - nodes[v].y);
      if (d < dist[v] && clear(u, v)) {
        dist[v] = d;
        prev[v] = u;
      }
    }
  }
  const path: Point[] = [];
  for (let v = prev[last]; v > 0; v = prev[v]) path.unshift(nodes[v]);
  return path;
}

/** Which way a walk turns at `corner`, heading on to `next`, seen from above. */
function turnAt(from: Point, corner: Point, next: Point): "left" | "right" {
  // y points south, so a positive cross product is a clockwise turn: right.
  const cross = (corner.x - from.x) * (next.y - corner.y) - (corner.y - from.y) * (next.x - corner.x);
  return cross > 0 ? "right" : "left";
}

/**
 * Where something not in the picture is, as the illustration can say it: round a
 * corner in view, walled off where it stands, or off one edge.
 */
function unseen(
  input: IllustrationViewInput,
  eye: Eye,
  sighted: Point,
  anchor: { x: number; y: number; z: number },
  corners: Point[]
): Omit<Hotspot, "id" | "role"> {
  const wouldBe = projectToFrame(eye, anchor);
  const points = inFieldOfView(eye, anchor) && inFrame(wouldBe) ? [wouldBe] : [];
  const path = route(input, eye, sighted, corners);
  if (path && path.length) {
    const corner = path[0];
    const at = projectToFrame(eye, { ...corner, z: CORNER_Z });
    if (inFieldOfView(eye, corner) && inFrame(at)) {
      // The arrow is the button: no dashed one where the thing itself would be.
      return { status: "around", points: [], around: { ...at, turn: turnAt(eye, corner, path[1] ?? sighted) } };
    }
    // The corner is off the frame too: point the way the walk starts.
    if (!points.length) return { status: "off-frame", points, ...edgeToward(eye, corner, CORNER_Z) };
  }
  if (points.length) return { status: "behind-wall", points };
  return { status: "off-frame", points, ...edgeToward(eye, anchor, anchor.z) };
}

/**
 * Every way out (the way in among them) and every placed feature, as the page
 * should show it on the illustration. Features with no footprint are left out: there
 * is nowhere to put their button.
 */
export function illustrationHotspots(input: IllustrationViewInput, view: IllustrationView): Hotspot[] {
  const { eye } = view;
  const corners = cornersOf(input.floor);
  const sees = illustrationSight(input, eye);
  const out: Hotspot[] = [];

  const door = (d: ViewDoor, role: HotspotRole, visible: boolean) => {
    const at = doorPoint(d);
    const anchor = { ...at, z: ILLUSTRATION_DOOR_FT / 2 };
    if (visible) {
      const q = projectToFrame(eye, anchor);
      if (q) {
        out.push({ id: d.id, role, status: "shown", points: [q] });
        return;
      }
    }
    out.push({ id: d.id, role, ...unseen(input, eye, doorTarget(d), anchor, corners) });
  };
  input.exits.forEach((d, i) => door(d, "exit", view.exits[i].visible));
  door(input.entry, "entry", view.entry.visible);

  input.features.forEach((f, i) => {
    if (!f.cells.length) return;
    const pieces = connectedCells(f.cells);
    if (view.features[i].visible) {
      // A button per piece in the picture, at the middle of the part of it that shows.
      const points: Point[] = [];
      for (const piece of pieces) {
        const shows = piece.map(cellMiddle).filter((m) => {
          const q = projectToFrame(eye, { ...m, z: FEATURE_Z });
          return inFieldOfView(eye, m) && inFrame(q) && sees(m);
        });
        if (!shows.length) continue;
        const c = { x: shows.reduce((s, m) => s + m.x, 0) / shows.length, y: shows.reduce((s, m) => s + m.y, 0) / shows.length };
        const q = projectToFrame(eye, { ...c, z: FEATURE_Z });
        if (q) points.push(q);
      }
      if (points.length) {
        out.push({ id: f.id, role: "feature", status: "shown", points });
        return;
      }
    }
    // Not in the picture: route to its nearest cell.
    const mids = f.cells.map(cellMiddle);
    const nearest = mids.reduce((a, b) => (Math.hypot(a.x - eye.x, a.y - eye.y) <= Math.hypot(b.x - eye.x, b.y - eye.y) ? a : b));
    out.push({ id: f.id, role: "feature", ...unseen(input, eye, nearest, { ...nearest, z: FEATURE_Z }, corners) });
  });

  return out;
}
