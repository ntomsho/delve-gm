/**
 * ROOM ILLUSTRATIONS — THE FIGURES IN THEM
 * =================================
 *
 * An illustration is drawn once and shared; the creatures in a room change every turn.
 * So the illustration is drawn with no one in it and the creatures are stood in it
 * afterwards, each a sprite drawn once per kind (BUILD-PLAN, *Illustrations*,
 * "2. Creature sprites"). Everything here is geometry and rules, no pixels:
 *
 *   illustrationStage     the patch of open floor every illustration keeps clear for figures,
 *                  chosen before the illustration is drawn and marked in its guide
 *   roomClusters   a room's creatures, gathered by the author's rules into who
 *                  stands in front and who behind
 *   illustrationFigures   where each figure stands in the picture, through the same
 *                  camera that drew the guide
 *
 * WHO GETS A SPRITE. Solos, leaders and named individuals: one each. A group's
 * nameless members, in every variant: one for the whole group (`spriteKeyOf`).
 *
 * HOW A ROOM'S CREATURES STAND. The front row is the leader; or, with no
 * leader, the named creatures side by side, slightly overlapping; or, with
 * neither, one copy of the group. The nameless stand behind it, at most two on
 * each side. Anything unrelated is a cluster of its own.
 *
 * WHY THE STAGE IS CHOSEN FIRST. With the spot picked after the illustration was
 * drawn, the drawing drifted from the guide enough to stand figures over a
 * widened chasm or in a doorway, in 3 of 10 rooms. Reserved before drawing, 9
 * of 10 read right.
 */

import { CELL_FEET } from "../generation/floorplan/geometry.ts";
import type { ICreature } from "../shared/world/entities.ts";
import {
  doorPoint,
  ILLUSTRATION_MIN_AHEAD_FT,
  illustrationSight,
  projectToFrame,
  type IllustrationView,
  type IllustrationViewInput,
} from "./view.ts";
import type { Point } from "../generation/floorplan/blockplan.ts";

// ---------------------------------------------------------------------------
// TUNING
// ---------------------------------------------------------------------------

/** A size word, which a model may choose; the feet are code's. */
export type FigureSize = "tiny" | "small" | "medium" | "large" | "huge";

/** Height in feet for each size word. */
export const FIGURE_SIZE_FT: Record<FigureSize, number> = { tiny: 1.5, small: 3.5, medium: 6, large: 10, huge: 16 };

/**
 * Every figure is shown this much taller than its true height. The image model
 * draws the room larger than the guide's camera says, doorways most of all, so
 * a figure true to the guide read like a child beside them. Judged by eye at
 * ×1, ×1.2 and ×1.4 on four rooms (2026-10-14); ×1.4 read right in all four.
 */
export const FIGURE_SCALE = 1.4;

/**
 * The patch of floor an illustration keeps clear, around the stage point, in feet: a
 * little behind the front row, deep enough for both ranks behind it, wide
 * enough for two on each side.
 */
export const STAGE_FT = { behind: 1.5, ahead: 7.5, side: 6 } as const;

/** At most this many nameless figures behind a front row, two on each side. */
export const FIGURES_BEHIND_MAX = 4;

/** Behind-row offsets from the front, in feet, [ahead, across]: left, right, then the second rank. */
const BEHIND_FT: [number, number][] = [
  [3, -2.5],
  [3, 2.5],
  [5.5, -4.5],
  [5.5, 4.5],
];

/** Feet between named figures side by side: under a body's width, so they overlap a little. */
const SIDE_BY_SIDE_FT = 2;
/** Where a cluster would ideally stand: this far ahead of the eye. */
const PREFERRED_AHEAD_FT = 13;
/** Clusters in one room stand at least this far apart. */
const CLUSTER_GAP_FT = 7;
/** Feet a stand point keeps from a feature's cells: a drawn footprint is wider than its outline. */
const FEATURE_MARGIN_FT = 2.5;
/** Feet a stand point keeps from a doorway, so nobody stands in one. */
const DOOR_MARGIN_FT = 5;
/** Score per unit of the stage patch that is not open floor: an empty patch costs as much as 40 ft of misplacement. */
const PATCH_WEIGHT = 40;
/** Score for a stand point too near a feature or door, when the patch around it is otherwise fine. */
const CROWDED_COST = 20;
/** Feet into the frame the first stand point must be, past the floor's first visible line. */
const STAND_MIN_EXTRA_FT = 2;
/** The feet stay this far inside the frame's sides and bottom, as fractions of it. */
const FOOT_FRAME = { side: 0.15, bottom: 0.97 } as const;

// ---------------------------------------------------------------------------
// THE STAGE
// ---------------------------------------------------------------------------

/** A place a cluster could stand, best first. */
export interface StandPoint {
  /** feet, in the plan */
  at: Point;
  score: number;
}

const aheadOf = (view: IllustrationView, q: Point) =>
  (q.x - view.eye.x) * view.eye.forward.x + (q.y - view.eye.y) * view.eye.forward.y;

/** A point `ahead` feet further from the eye and `across` feet to its right of `at`. */
function offset(view: IllustrationView, at: Point, ahead: number, across: number): Point {
  const { forward, right } = view.eye;
  return { x: at.x + forward.x * ahead + right.x * across, y: at.y + forward.y * ahead + right.y * across };
}

/**
 * Every place a cluster could stand, best first. Candidates sit on a 2.5 ft
 * grid, off every feature's cells, in sight, with the feet in the lower part of
 * the frame. Most of all the whole patch around one (`STAGE_FT`) should be open
 * floor in sight — a clear point at the lip of a chasm is no place for a pack —
 * then it should be about `PREFERRED_AHEAD_FT` ahead and near the middle. Ties
 * keep the first, so it is deterministic.
 */
export function standPoints(input: IllustrationViewInput, view: IllustrationView): StandPoint[] {
  const sight = illustrationSight(input, view.eye);
  const cellKey = (x: number, y: number) => `${x},${y}`;
  const floor = new Set(input.floor.map((c) => cellKey(c.x, c.y)));
  const blockedCells = input.features.flatMap((f) => f.cells);
  const blocked = new Set(blockedCells.map((c) => cellKey(c.x, c.y)));
  const doors = [input.entry, ...input.exits].map(doorPoint);
  const cellOf = (q: Point) => cellKey(Math.floor(q.x / CELL_FEET), Math.floor(q.y / CELL_FEET));

  const clearOfThings = (at: Point) =>
    blockedCells.every((c) => {
      const dx = Math.max(c.x * CELL_FEET - at.x, 0, at.x - (c.x + 1) * CELL_FEET);
      const dy = Math.max(c.y * CELL_FEET - at.y, 0, at.y - (c.y + 1) * CELL_FEET);
      return Math.hypot(dx, dy) >= FEATURE_MARGIN_FT;
    }) && doors.every((d) => Math.hypot(d.x - at.x, d.y - at.y) >= DOOR_MARGIN_FT);

  /** The share of the patch around `at`, sampled every foot, that is floor in sight with nothing on it. */
  const openFloor = (at: Point) => {
    let open = 0;
    let all = 0;
    for (let a = -STAGE_FT.behind; a <= STAGE_FT.ahead; a++) {
      for (let c = -STAGE_FT.side; c <= STAGE_FT.side; c++) {
        const q = offset(view, at, a, c);
        all++;
        if (floor.has(cellOf(q)) && !blocked.has(cellOf(q)) && sight(q)) open++;
      }
    }
    return open / all;
  };

  const step = CELL_FEET / 2;
  const out: StandPoint[] = [];
  for (const c of input.floor) {
    if (blocked.has(cellKey(c.x, c.y))) continue;
    for (const ox of [step / 2, step * 1.5]) {
      for (const oy of [step / 2, step * 1.5]) {
        const at = { x: c.x * CELL_FEET + ox, y: c.y * CELL_FEET + oy };
        const ahead = aheadOf(view, at);
        if (ahead < ILLUSTRATION_MIN_AHEAD_FT + STAND_MIN_EXTRA_FT || !sight(at)) continue;
        const foot = projectToFrame(view.eye, { ...at, z: 0 });
        if (!foot || foot.x < FOOT_FRAME.side || foot.x > 1 - FOOT_FRAME.side || foot.y > FOOT_FRAME.bottom) continue;
        out.push({
          at,
          score:
            Math.abs(ahead - PREFERRED_AHEAD_FT) +
            10 * Math.abs(foot.x - 0.5) +
            PATCH_WEIGHT * (1 - openFloor(at)) +
            (clearOfThings(at) ? 0 : CROWDED_COST),
        });
      }
    }
  }
  // A stable sort, so equal scores keep the floor's own order.
  return out.sort((a, b) => a.score - b.score);
}

/** The spot the illustration keeps clear for figures, or undefined when nowhere in the frame will do. */
export function illustrationStage(input: IllustrationViewInput, view: IllustrationView): Point | undefined {
  return standPoints(input, view)[0]?.at;
}

/**
 * The stage patch's outline, as runs of floor points in feet: only where it
 * lies on floor the eye can see, so the guide never marks rock or a wall.
 * Sampled every quarter foot.
 */
export function stageOutline(input: IllustrationViewInput, view: IllustrationView, at: Point): Point[][] {
  const sight = illustrationSight(input, view.eye);
  const floor = new Set(input.floor.map((c) => `${c.x},${c.y}`));
  const onFloor = (q: Point) => floor.has(`${Math.floor(q.x / CELL_FEET)},${Math.floor(q.y / CELL_FEET)}`);
  const { behind, ahead, side } = STAGE_FT;
  const corners = [
    offset(view, at, -behind, -side),
    offset(view, at, -behind, side),
    offset(view, at, ahead, side),
    offset(view, at, ahead, -side),
  ];
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (let k = 0; k < 4; k++) {
    const a = corners[k];
    const b = corners[(k + 1) % 4];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.25);
    for (let i = 0; i <= n; i++) {
      const q = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n };
      if (onFloor(q) && sight(q)) run.push(q);
      else if (run.length) {
        runs.push(run);
        run = [];
      }
    }
  }
  if (run.length) runs.push(run);
  return runs.filter((r) => r.length > 1);
}

// ---------------------------------------------------------------------------
// WHO STANDS WHERE
// ---------------------------------------------------------------------------

export type FigureRole = "leader" | "named" | "solo" | "group";

/** Which part a creature plays in its room's arrangement. */
export function figureRole(c: ICreature): FigureRole {
  if (c.affiliationGroupId) return "leader";
  if (c.base !== undefined) return "named";
  if ((c.count ?? 1) > 1) return "group";
  return "solo";
}

/**
 * The sprite a creature is drawn with. A named person is keyed by template and
 * name, not by entity: generation can write one person into two rooms as two
 * entities (BUILD-PLAN, "One leader, one entity"), and they should still be one
 * drawing. Everyone else is their template, so a group's nameless members in
 * every room — and a pack worn down to one — share a drawing.
 */
export function spriteKeyOf(c: ICreature): string {
  return c.base !== undefined ? `${c.narrative.blueprintId}:${c.name}` : c.narrative.blueprintId;
}

/** The creatures that can be drawn: there, seen, and at least one of them. */
export function drawableCreatures(creatures: ICreature[], roomId: string): ICreature[] {
  return creatures.filter((c) => c.roomId === roomId && c.isHidden !== true && (c.count ?? 1) > 0);
}

/** One cluster: a front row, left to right, and the nameless behind it. Sprite keys, not entities. */
export interface FigureCluster {
  front: string[];
  /** already capped at `FIGURES_BEHIND_MAX` */
  behind: string[];
}

/**
 * A room's creatures as the clusters they stand in. Pass only the drawable ones
 * (`drawableCreatures`). Leaders first, each with its own group's pack behind
 * it; then the named, with any unclaimed pack behind them as if they were one
 * leader; then each unclaimed pack on its own, one copy in front; then solos.
 */
export function roomClusters(creatures: ICreature[]): FigureCluster[] {
  const packs = creatures.filter((c) => figureRole(c) === "group");
  const claimed = new Set<string>();
  const behindOf = (pack: ICreature | undefined, n: number) =>
    pack ? Array.from({ length: Math.max(0, Math.min(n, FIGURES_BEHIND_MAX)) }, () => spriteKeyOf(pack)) : [];
  const claim = (pick: (p: ICreature) => boolean) => {
    const pack = packs.find((p) => !claimed.has(p.id) && pick(p));
    if (pack) claimed.add(pack.id);
    return pack;
  };
  const out: FigureCluster[] = [];

  for (const leader of creatures.filter((c) => figureRole(c) === "leader")) {
    const pack = claim((p) => p.narrative.blueprintId === leader.affiliationGroupId);
    out.push({ front: [spriteKeyOf(leader)], behind: behindOf(pack, pack?.count ?? 0) });
  }

  const named = creatures.filter((c) => figureRole(c) === "named");
  if (named.length) {
    const pack = claim(() => true);
    out.push({ front: named.map(spriteKeyOf), behind: behindOf(pack, pack?.count ?? 0) });
  }

  for (const pack of packs.filter((p) => !claimed.has(p.id))) {
    out.push({ front: [spriteKeyOf(pack)], behind: behindOf(pack, (pack.count ?? 1) - 1) });
  }

  for (const solo of creatures.filter((c) => figureRole(c) === "solo")) out.push({ front: [spriteKeyOf(solo)], behind: [] });
  return out;
}

// ---------------------------------------------------------------------------
// WHERE EACH FIGURE STANDS IN THE PICTURE
// ---------------------------------------------------------------------------

/**
 * One figure, as the page lays it down. Fractions of the illustration from its
 * top-left, so it fits the picture at any size.
 */
export interface IllustrationFigure {
  sprite: string;
  /** the feet, bottom-centre of the figure */
  x: number;
  y: number;
  /**
   * The figure's height per foot of true height, as a fraction of the illustration's
   * height. Times the sprite's size in feet and `FIGURE_SCALE` gives its height.
   */
  perFoot: number;
  /** mirrored: the right-hand side of the back row, so copies do not look stamped */
  flop: boolean;
}

/** The top of a figure's head stays at least this far inside the frame, as a fraction of its height. */
export const FIGURE_HEADROOM = 0.03;

/**
 * How tall a figure is drawn, as a fraction of the illustration's height: its size in
 * feet, times `FIGURE_SCALE`, through the camera at its feet — and no taller
 * than reaches `FIGURE_HEADROOM` from the top. A large creature near the eye
 * otherwise ran off the top of the picture, head and all; capped, it still
 * fills the frame, which is what a giant should do.
 */
export function figureHeight(f: IllustrationFigure, size: FigureSize): number {
  return Math.min(f.perFoot * FIGURE_SIZE_FT[size] * FIGURE_SCALE, f.y - FIGURE_HEADROOM);
}

/**
 * Every figure in the room, back to front so the nearer is laid down last. The
 * first cluster stands on the stage the illustration kept clear; the rest take the
 * next best stand points at least `CLUSTER_GAP_FT` from any other. A cluster
 * with nowhere left to stand is left out.
 */
export function illustrationFigures(input: IllustrationViewInput, view: IllustrationView, clusters: FigureCluster[]): IllustrationFigure[] {
  if (!clusters.length) return [];
  const points = standPoints(input, view);
  const taken: Point[] = [];
  const placed: { at: Point; sprite: string; flop: boolean }[] = [];
  for (const cl of clusters) {
    const pick = points.find((p) => taken.every((t) => Math.hypot(t.x - p.at.x, t.y - p.at.y) >= CLUSTER_GAP_FT));
    if (!pick) continue;
    taken.push(pick.at);
    cl.behind.forEach((sprite, i) => {
      const [ahead, across] = BEHIND_FT[i];
      placed.push({ at: offset(view, pick.at, ahead, across), sprite, flop: across > 0 });
    });
    cl.front.forEach((sprite, i) => {
      const across = (i - (cl.front.length - 1) / 2) * SIDE_BY_SIDE_FT;
      placed.push({ at: offset(view, pick.at, 0, across), sprite, flop: false });
    });
  }

  const out: (IllustrationFigure & { ahead: number })[] = [];
  for (const p of placed) {
    const foot = projectToFrame(view.eye, { ...p.at, z: 0 });
    const oneUp = projectToFrame(view.eye, { ...p.at, z: 1 });
    if (!foot || !oneUp) continue;
    out.push({ sprite: p.sprite, x: foot.x, y: foot.y, perFoot: foot.y - oneUp.y, flop: p.flop, ahead: aheadOf(view, p.at) });
  }
  return out.sort((a, b) => b.ahead - a.ahead).map(({ ahead: _, ...f }) => f);
}
