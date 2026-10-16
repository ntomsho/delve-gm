/**
 * The CLI behind `dev/cli-sprites.ts`, which teaches Node `?raw` first and then
 * imports this. Usage is in that file.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { fal } from "@fal-ai/client";
import { z } from "zod";
import { CELL_FEET } from "../../generation/floorplan/geometry.ts";
import {
  ILLUSTRATION_MIN_AHEAD_FT,
  doorPoint,
  illustrationSight,
  projectToFrame,
} from "../../illustrations/view.ts";
import { illustrationReferenceNote } from "../../illustrations/prompt.ts";
import { resolveBase, type ICreature } from "../../shared/world/entities.ts";
import type { Point } from "../../shared/utils/grid.ts";
import type { GeneratedDungeon } from "../../generation/generate.ts";
import { callForJson, configureTransport } from "../../llm/client.ts";
import { IMAGE_MODELS } from "../../llm/models.ts";
import { illustrationEntries, roomIllustration, type RoomIllustration } from "../../illustrations/room-illustration.ts";
import { illustrationImagePrompt } from "../../illustrations/visual.ts";
import { guidePng, oneBitPng, ILLUSTRATION_H, ILLUSTRATION_THRESHOLD, ILLUSTRATION_W } from "../../server/illustrations/image.ts";
import { liveIllustrationWork, ILLUSTRATION_REFS_DIR, illustrationKey, illustrationUrl } from "../../server/illustrations/serve.ts";
import { SPRITE_FRAME, SPRITE_STYLE } from "../../prompts/loader.ts";

// ---------------------------------------------------------------------------
// TUNING
// ---------------------------------------------------------------------------

const SPRITE_W = 1024;
const SPRITE_H = 1536;

/** Height in feet for each size word Haiku may answer with. The model picks a word; code owns the number. */
const SIZE_FT = { tiny: 1.5, small: 3.5, medium: 6, large: 10, huge: 16 } as const;
/**
 * Every figure is drawn this much taller than its true height. GPT draws the
 * room larger than the guide's camera says, doorways most of all, so a figure
 * true to the guide reads like a child against them. Judged by eye at ×1,
 * ×1.2 and ×1.4 on four rooms (2026-10-14); ×1.4 read right in all four.
 */
const FIGURE_SCALE = 1.4;
type SizeWord = keyof typeof SIZE_FT;

/** Up to this many nameless figures behind the front row, half on each side. */
const BEHIND_MAX = 4;
/** Behind-row offsets from the front figure, in feet: [ahead, across]. Left, right, then the second rank. */
const BEHIND_FT: [number, number][] = [
  [3, -2.5],
  [3, 2.5],
  [5.5, -4.5],
  [5.5, 4.5],
];
/** Feet between named figures standing side by side: under a body's width, so they overlap a little. */
const SIDE_BY_SIDE_FT = 2;
/** Where a cluster would ideally stand: this far ahead of the eye, in feet. */
const PREFERRED_AHEAD_FT = 13;
/** Clusters in one room stand at least this far apart, in feet. */
const CLUSTER_GAP_FT = 7;
/**
 * Feet a figure keeps from any feature's cells. The drawing does not hold a
 * footprint exactly: a pit or chasm comes out wider than its outline.
 */
const FEATURE_MARGIN_FT = 2.5;
/**
 * How much of a shrunk pixel has to be ink for it to be black, out of 255.
 * A figure drawn 1536 px tall and shown at 300 has lines a fraction of a pixel
 * wide; at the illustration's own middle threshold they vanish and the figure reads
 * faint. Thickening the lines first fills the hatching on small figures.
 */
const INK_COVERAGE = 50;
/** Score per unit of the stage patch that is not open floor: an empty patch costs as much as 40 ft of misplacement. */
const PATCH_WEIGHT = 40;
/** Feet a figure keeps from a doorway, so nobody stands in one. */
const DOOR_MARGIN_FT = 5;
/** Pixels of closing before the flood fill, so a gap in the outline does not let the fill into the figure. */
const CLOSE_PX = 3;

interface Setup {
  id: string;
  label: string;
  usd: number;
  draw(prompt: string, seed: number, refs: string[]): Promise<Buffer>;
}

/** The sprite references the author picked (2026-10-14); see their README. */
const SPRITE_REFS_DIR = "assets/sprite-refs";

/** What the sprite references are for, said the way `illustrationReferenceNote` says it for rooms. */
const spriteReferenceNote = (count: number) =>
  `The ${count} images are style references only: draw in exactly their manner — the same rough pen line, ` +
  "the same sparing hatching, the same amount of white paper. Take nothing else from them: not their " +
  "subjects, clothes, gear or poses.";

/**
 * The look the references were picked for, in words, so the prompt does not
 * pull against them: the style text alone asks for crisp outlines, and round 1
 * of the references showed that comes out too clean. Rags are not asked for —
 * worn only where the figure's own description says so.
 */
const SPRITE_GRIT =
  "The pen line is a working illustrator's: slightly rough and scratchy, never polished or smooth. Nothing " +
  "glamorous or idealised: people look like ordinary people, plain rather than handsome; creatures are " +
  "rough, scarred and unpleasant to look at, but not gory. Clothes and gear are as worn or as well kept as " +
  "the figure's description says.";

const SETUPS: Setup[] = [
  {
    id: "gpt2-srefs",
    label: "GPT Image 2 · low + sprite refs",
    usd: 0.015,
    async draw(prompt, _seed, refs) {
      const res = await fal.subscribe(IMAGE_MODELS["gpt-image-2"].guided, {
        input: {
          prompt: `STYLE REFERENCES\n${spriteReferenceNote(refs.length)}\n\n${prompt}\n\nCHARACTER\n${SPRITE_GRIT}`,
          quality: "low",
          image_size: { width: SPRITE_W, height: SPRITE_H },
          output_format: "png",
          image_urls: refs,
        },
      });
      return fetchImage(res.data);
    },
  },
  {
    id: "gpt2-low",
    label: "GPT Image 2 · low + illustration refs",
    usd: 0.015,
    async draw(prompt, _seed, refs) {
      const res = await fal.subscribe(IMAGE_MODELS["gpt-image-2"].guided, {
        input: {
          prompt: `STYLE REFERENCES\n${illustrationReferenceNote(refs.length, false)}\n\n${prompt}`,
          quality: "low",
          image_size: { width: SPRITE_W, height: SPRITE_H },
          output_format: "png",
          image_urls: refs,
        },
      });
      return fetchImage(res.data);
    },
  },
  {
    id: "klein-4b",
    label: "FLUX.2 [klein] 4B · prompt only",
    usd: 0.014,
    async draw(prompt, seed) {
      const res = await fal.subscribe(IMAGE_MODELS["flux-2-klein-4b"].unguided!, {
        // Its safety checker blanks body horror to solid black (4 of 13 in the
        // first run), and drawing monsters is the job.
        input: { prompt, image_size: { width: SPRITE_W, height: SPRITE_H }, seed, output_format: "png", enable_safety_checker: false },
      });
      return fetchImage(res.data);
    },
  },
];

// ---------------------------------------------------------------------------
// WHO GETS A SPRITE, AND WHO STANDS WHERE
// ---------------------------------------------------------------------------

type Role = "leader" | "named" | "solo" | "group";

interface Sprite {
  /** the template it is drawn from: an entity id for an inline base, else the blueprint id */
  key: string;
  role: Role;
  name: string;
  base: string;
}

interface Cluster {
  /** front row, left to right */
  front: { sprite: Sprite; entityId: string }[];
  /** the nameless behind it, already capped at BEHIND_MAX */
  behind: { sprite: Sprite; entityId: string }[];
  /** what the sheet says about it */
  label: string;
}

function roleOf(c: ICreature): Role {
  if (c.affiliationGroupId) return "leader";
  if (c.base !== undefined) return "named";
  if ((c.count ?? 1) > 1) return "group";
  return "solo";
}

function spriteOf(d: GeneratedDungeon, c: ICreature): Sprite {
  const role = roleOf(c);
  // A named person is keyed by group and name, not entity: generation can
  // write one person into two rooms as two entities (BUILD-PLAN, "One leader,
  // one entity"), and they should still be one drawing.
  const key = c.base !== undefined ? `${c.narrative.blueprintId}:${c.name}` : c.narrative.blueprintId;
  return { key, role, name: c.name, base: resolveBase(c, d.entities.registry) ?? "" };
}

/** A room's creatures, gathered into the clusters they stand in. */
function clustersIn(d: GeneratedDungeon, roomId: string): Cluster[] {
  const here = d.entities.creatures.filter((c) => c.roomId === roomId);
  const packs = here.filter((c) => roleOf(c) === "group");
  const claimed = new Set<string>();
  const out: Cluster[] = [];
  const behindFrom = (pack: ICreature, n: number) =>
    Array.from({ length: Math.min(n, BEHIND_MAX) }, () => ({ sprite: spriteOf(d, pack), entityId: pack.id }));

  for (const leader of here.filter((c) => roleOf(c) === "leader")) {
    const pack = packs.find((p) => !claimed.has(p.id) && p.narrative.blueprintId === leader.affiliationGroupId);
    if (pack) claimed.add(pack.id);
    out.push({
      front: [{ sprite: spriteOf(d, leader), entityId: leader.id }],
      behind: pack ? behindFrom(pack, pack.count ?? 1) : [],
      label: `leader ${leader.name}` + (pack ? ` + ${pack.name} ×${pack.count}` : ""),
    });
  }

  const named = here.filter((c) => roleOf(c) === "named");
  if (named.length) {
    const pack = packs.find((p) => !claimed.has(p.id));
    if (pack) claimed.add(pack.id);
    out.push({
      front: named.map((c) => ({ sprite: spriteOf(d, c), entityId: c.id })),
      behind: pack ? behindFrom(pack, pack.count ?? 1) : [],
      label: `named ${named.map((c) => c.name).join(", ")}` + (pack ? ` + ${pack.name} ×${pack.count}` : ""),
    });
  }

  for (const pack of packs.filter((p) => !claimed.has(p.id))) {
    out.push({
      front: [{ sprite: spriteOf(d, pack), entityId: pack.id }],
      behind: behindFrom(pack, (pack.count ?? 1) - 1),
      label: `${pack.name} ×${pack.count}`,
    });
  }

  for (const solo of here.filter((c) => roleOf(c) === "solo")) {
    out.push({ front: [{ sprite: spriteOf(d, solo), entityId: solo.id }], behind: [], label: `solo ${solo.name}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// WHERE A CLUSTER STANDS
// ---------------------------------------------------------------------------

interface Standing {
  /** floor point in feet */
  at: Point;
  sprite: Sprite;
  /** mirrored, for the right-hand side of the back row */
  flop: boolean;
}

/**
 * A floor point for each cluster, then a floor point for each figure in it.
 * Candidates are on a 2.5 ft grid, off every feature's cells, in sight of the
 * eye, with the feet in the lower part of the frame. The best is the one
 * nearest `PREFERRED_AHEAD_FT` ahead and nearest the middle; ties keep the
 * first, so it is deterministic.
 */
function candidatesFor(p: RoomIllustration): { at: Point; score: number }[] {
  const { eye } = p.view;
  const sight = illustrationSight(p.input, eye);
  const blockedCells = p.input.features.flatMap((f) => f.cells);
  const doors = [p.input.entry, ...p.input.exits].map(doorPoint);
  const blocked = new Set(blockedCells.map((c) => `${c.x},${c.y}`));
  const clearOf = (at: Point) =>
    blockedCells.every((c) => {
      const dx = Math.max(c.x * CELL_FEET - at.x, 0, at.x - (c.x + 1) * CELL_FEET);
      const dy = Math.max(c.y * CELL_FEET - at.y, 0, at.y - (c.y + 1) * CELL_FEET);
      return Math.hypot(dx, dy) >= FEATURE_MARGIN_FT;
    }) &&
    doors.every((d) => Math.hypot(d.x - at.x, d.y - at.y) >= DOOR_MARGIN_FT);
  const floorSet = new Set(p.input.floor.map((c) => `${c.x},${c.y}`));
  /** The share of the patch around `at`, sampled every foot, that is floor in sight with nothing standing on it. */
  const openFloor = (at: Point) => {
    let open = 0;
    let all = 0;
    for (let a = -STAGE_FT.behind; a <= STAGE_FT.ahead; a++) {
      for (let c = -STAGE_FT.side; c <= STAGE_FT.side; c++) {
        const q = { x: at.x + eye.forward.x * a + eye.right.x * c, y: at.y + eye.forward.y * a + eye.right.y * c };
        const cell = `${Math.floor(q.x / CELL_FEET)},${Math.floor(q.y / CELL_FEET)}`;
        all++;
        if (floorSet.has(cell) && !blocked.has(cell) && sight(q)) open++;
      }
    }
    return open / all;
  };
  const step = CELL_FEET / 2;
  const candidates: { at: Point; score: number }[] = [];
  for (const c of p.input.floor) {
    if (blocked.has(`${c.x},${c.y}`)) continue;
    for (const ox of [step / 2, step * 1.5]) {
      for (const oy of [step / 2, step * 1.5]) {
        const at = { x: c.x * CELL_FEET + ox, y: c.y * CELL_FEET + oy };
        const ahead = (at.x - eye.x) * eye.forward.x + (at.y - eye.y) * eye.forward.y;
        if (ahead < ILLUSTRATION_MIN_AHEAD_FT + 2 || !sight(at)) continue;
        const foot = projectToFrame(eye, { ...at, z: 0 });
        if (!foot || foot.x < 0.15 || foot.x > 0.85 || foot.y > 0.97) continue;
        // Most of all, the whole patch a cluster needs (`STAGE_FT`) should be
        // open floor in sight: a clear point at the lip of a chasm is no
        // place for a pack. Then a point clear of features and doors.
        candidates.push({
          at,
          score:
            Math.abs(ahead - PREFERRED_AHEAD_FT) +
            10 * Math.abs(foot.x - 0.5) +
            PATCH_WEIGHT * (1 - openFloor(at)) +
            (clearOf(at) ? 0 : 20),
        });
      }
    }
  }
  return candidates.sort((a, b) => a.score - b.score);
}

function standings(p: RoomIllustration, clusters: Cluster[]): Standing[] {
  const { eye } = p.view;
  const candidates = candidatesFor(p);
  const out: Standing[] = [];
  const taken: Point[] = [];
  for (const cl of clusters) {
    const pick = candidates.find((c) => taken.every((t) => Math.hypot(t.x - c.at.x, t.y - c.at.y) >= CLUSTER_GAP_FT));
    if (!pick) continue; // nowhere left to stand: the spike shows it as missing
    taken.push(pick.at);
    const place = (ahead: number, across: number): Point => ({
      x: pick.at.x + eye.forward.x * ahead + eye.right.x * across,
      y: pick.at.y + eye.forward.y * ahead + eye.right.y * across,
    });
    cl.behind.forEach((b, i) => {
      const [ahead, across] = BEHIND_FT[i];
      out.push({ at: place(ahead, across), sprite: b.sprite, flop: across > 0 });
    });
    cl.front.forEach((f, i) => {
      out.push({ at: place(0, (i - (cl.front.length - 1) / 2) * SIDE_BY_SIDE_FT), sprite: f.sprite, flop: false });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CUTTING A SPRITE OUT
// ---------------------------------------------------------------------------

interface Cutout {
  w: number;
  h: number;
  /** 1 where the figure is (paper or ink): what hides the illustration behind it */
  body: Uint8Array;
  /** 1 where the figure's ink is */
  ink: Uint8Array;
}

/** Max (dilate) or min (erode) over a square of radius r, done as two passes. */
function morph(src: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  const pass = (a: Uint8Array, horizontal: boolean) => {
    const b = new Uint8Array(a.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? x + k : x;
          const yy = horizontal ? y : y + k;
          const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : a[yy * w + xx];
          if (dilate ? s : !s) {
            v = dilate ? 1 : 0;
            break;
          }
        }
        b[y * w + x] = v;
      }
    }
    return b;
  };
  return pass(pass(src, true), false);
}

/**
 * Threshold to 1-bit, close small gaps in the outline, flood the white from
 * the border, and keep the largest piece: the background goes, the paper
 * inside the figure stays. Then trim to the figure.
 */
async function cutOut(image: Buffer): Promise<Cutout> {
  const { data, info } = await sharp(image)
    .flatten({ background: "#ffffff" })
    .greyscale()
    .threshold(ILLUSTRATION_THRESHOLD)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) ink[i] = data[i * info.channels] < 128 ? 1 : 0;
  const closed = morph(morph(ink, w, h, CLOSE_PX, true), w, h, CLOSE_PX, false);

  // Flood the outside.
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (i: number) => {
    if (!closed[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) (seed(x), seed((h - 1) * w + x));
  for (let y = 0; y < h; y++) (seed(y * w), seed(y * w + w - 1));
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < w * (h - 1)) seed(i + w);
  }

  // The largest connected piece of what is left is the figure; specks go.
  const label = new Int32Array(w * h);
  let best = 0;
  let bestSize = 0;
  let next = 0;
  for (let start = 0; start < w * h; start++) {
    if (outside[start] || label[start]) continue;
    next++;
    let size = 0;
    stack.push(start);
    label[start] = next;
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j >= 0 && j < w * h && !outside[j] && !label[j]) {
          label[j] = next;
          stack.push(j);
        }
      }
    }
    if (size > bestSize) (best = next), (bestSize = size);
  }

  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < w * h; i++) {
    if (label[i] !== best) continue;
    const x = i % w, y = (i / w) | 0;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const body = new Uint8Array(cw * ch);
  const inkOut = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = (y + y0) * w + (x + x0);
      if (label[i] === best) {
        body[y * cw + x] = 1;
        inkOut[y * cw + x] = ink[i];
      }
    }
  }
  return { w: cw, h: ch, body, ink: inkOut };
}

/**
 * The cut-out at a figure's size, as RGBA. Ink and body are shrunk apart as
 * coverage: ink at `INK_COVERAGE`, so thin lines survive; body at half.
 */
async function sized(c: Cutout, w: number, h: number, flop: boolean): Promise<Buffer> {
  const shrink = async (mask: Uint8Array) => {
    const grey = Buffer.alloc(mask.length);
    for (let i = 0; i < mask.length; i++) grey[i] = mask[i] ? 255 : 0;
    let img = sharp(grey, { raw: { width: c.w, height: c.h, channels: 1 } });
    if (flop) img = img.flop();
    // sharp may hand back more than the one channel it was given.
    const { data, info } = await img.resize(w, h, { kernel: "cubic" }).raw().toBuffer({ resolveWithObject: true });
    return (i: number) => data[i * info.channels];
  };
  const [inkAt, bodyAt] = await Promise.all([shrink(c.ink), shrink(c.body)]);
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const isInk = inkAt(i) >= INK_COVERAGE;
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = isInk ? 0 : 255;
    rgba[i * 4 + 3] = isInk || bodyAt(i) >= 128 ? 255 : 0;
  }
  return sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/** The cut-out as RGBA: black ink and white paper where the figure is, transparent elsewhere. */
function cutoutPng(c: Cutout, flop = false): Promise<Buffer> {
  const rgba = Buffer.alloc(c.w * c.h * 4);
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const i = y * c.w + (flop ? c.w - 1 - x : x);
      const o = (y * c.w + x) * 4;
      const v = c.ink[i] ? 0 : 255;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
      rgba[o + 3] = c.body[i] ? 255 : 0;
    }
  }
  return sharp(rgba, { raw: { width: c.w, height: c.h, channels: 4 } }).png().toBuffer();
}

/** The illustration with every standing figure on it, back to front, re-thresholded so it stays 1-bit. */
/** Stands every figure on the illustration, each `scale` times its height in feet (see `FIGURE_SCALE`). */
async function composite(
  illustration: Buffer,
  p: RoomIllustration,
  stands: Standing[],
  cut: Map<string, Cutout>,
  sizes: Record<string, SizeWord>,
  scale = FIGURE_SCALE
) {
  const { eye } = p.view;
  const aheadOf = (s: Standing) => (s.at.x - eye.x) * eye.forward.x + (s.at.y - eye.y) * eye.forward.y;
  const layers: OverlayOptions[] = [];
  for (const s of [...stands].sort((a, b) => aheadOf(b) - aheadOf(a))) {
    const c = cut.get(s.sprite.key);
    if (!c) continue;
    const ft = SIZE_FT[sizes[s.sprite.key] ?? "medium"] * scale;
    const foot = projectToFrame(eye, { ...s.at, z: 0 });
    const head = projectToFrame(eye, { ...s.at, z: ft });
    if (!foot || !head) continue;
    const hPx = Math.max(8, Math.round((foot.y - head.y) * ILLUSTRATION_H));
    const wPx = Math.max(4, Math.round((c.w / c.h) * hPx));
    const input = await sized(c, wPx, hPx, s.flop);
    const left = Math.round(foot.x * ILLUSTRATION_W - wPx / 2);
    const top = Math.round(foot.y * ILLUSTRATION_H - hPx);
    // sharp refuses an overlay that leaves the image; crop what hangs off.
    const cx0 = Math.max(0, -left), cy0 = Math.max(0, -top);
    const cw = Math.min(wPx, ILLUSTRATION_W - left) - cx0, ch = Math.min(hPx, ILLUSTRATION_H - top) - cy0;
    if (cw <= 0 || ch <= 0) continue;
    const cropped = await sharp(input).extract({ left: cx0, top: cy0, width: cw, height: ch }).toBuffer();
    layers.push({ input: cropped, left: left + cx0, top: top + cy0 });
  }
  const flat = await sharp(illustration).flatten({ background: "#ffffff" }).resize(ILLUSTRATION_W, ILLUSTRATION_H).png().toBuffer();
  return oneBitPng(await sharp(flat).composite(layers).png().toBuffer());
}

// ---------------------------------------------------------------------------
// THE RESERVED FLOOR (--stage)
// ---------------------------------------------------------------------------

/**
 * The patch of floor an illustration keeps clear for figures, around the spot the
 * first cluster stands on (`candidatesFor(p)[0]`): a little behind the front
 * row, deep enough for both ranks behind it, wide enough for two on each side.
 */
const STAGE_FT = { behind: 1.5, ahead: 7.5, side: 6 };

// The patch itself, its dots in the guide and its line in the prompt are the
// game's now (`illustrationStage`, `stageOutline`, `ILLUSTRATION_OPEN_FLOOR_NOTE`): every
// illustration keeps one, so --stage draws exactly what the server draws.

// ---------------------------------------------------------------------------
// WORDS
// ---------------------------------------------------------------------------

/**
 * THE SPIKE'S OWN BRIEF, kept apart on purpose: it differs from the one the
 * server sends (`prompts/illustrations/sprite-look-system.md`), so the spike
 * can be tried against it without changing what players get.
 */
const SPRITE_LOOK_SYSTEM =
  "You brief an illustrator who will draw one creature as a single standing figure. From the " +
  "creature's description, write what can be SEEN: body, build, skin or hide, clothing, gear, posture, " +
  "anything held. 20 to 35 words, plain and concrete. Leave out its name, history, purpose, sounds, " +
  "smells and anything it is doing to others. If it is a member of a group, describe one typical " +
  "member. Also choose its size: tiny (rat, cat), small (dog, child, goblin), medium (a person), large " +
  "(ogre, horse), huge (giant, dragon).";

const lookSchema = z.object({
  look: z.string().min(1),
  size: z.enum(["tiny", "small", "medium", "large", "huge"]),
});

async function requestLook(s: Sprite, theme: string) {
  // Reuses illustration-visual's model: this is a spike, and the task registry gains
  // its own entry only if sprites are built.
  const res = await callForJson({
    task: "illustration-visual",
    system: SPRITE_LOOK_SYSTEM,
    messages: [
      {
        role: "user",
        content: `DUNGEON\n${theme}\n\nCREATURE (${s.role === "group" ? "one member of a group" : "an individual"})\n${s.name}\n${s.base}`,
      },
    ],
    schema: lookSchema,
    toolName: "sprite_look",
    toolDescription: "What the figure looks like, and its size.",
  });
  return res.value;
}

const spritePrompt = (look: string) => `${SPRITE_STYLE}\n\n${SPRITE_FRAME}\n\nTHE FIGURE\n${look}`;

// ---------------------------------------------------------------------------
// PLUMBING
// ---------------------------------------------------------------------------

function envInto(names: string[]) {
  let text = "";
  try {
    text = readFileSync(resolve(".env.local"), "utf8");
  } catch {
    // no .env.local: the caller says what is missing
  }
  for (const name of names) {
    if (process.env[name]) continue;
    const m = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, "m"));
    if (m) process.env[name] = m[1].replace(/^["']|["']$/g, "");
  }
}

async function fetchImage(data: unknown): Promise<Buffer> {
  const url = (data as { images?: { url: string }[] }).images?.[0]?.url;
  if (!url) throw new Error(`no image in the response: ${JSON.stringify(data).slice(0, 300)}`);
  const got = await fetch(url);
  if (!got.ok) throw new Error(`fetching the image failed (${got.status})`);
  const png = Buffer.from(await got.arrayBuffer());
  // A safety checker's answer is a black square, not an error.
  if ((await sharp(png).greyscale().stats()).channels[0].mean < 5) throw new Error("blank image (safety checker?)");
  return png;
}

const readJson = <T>(path: string): T | undefined => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined);
const write = (path: string, data: string | Buffer) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
};
/** A sprite key as a file name. Keys hold a colon and a name. */
const fileOf = (key: string) => key.replace(/[^\w-]/g, "_");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A stable small number from a string, for the image seed. */
const seedOf = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 1_000_000;

interface Args {
  dry: boolean;
  force: boolean;
  dungeons: string[];
  setups: string[];
  /** also redraw each illustration with the reserved floor */
  stage: boolean;
  /** draw this round of style-reference candidates instead (see STYLE REFERENCE CANDIDATES) */
  refs?: number;
  /** extra composites of the reserved-floor illustrations at these figure scales, in place of FIGURE_SCALE */
  scales: number[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dry: false,
    force: false,
    dungeons: ["out/live-4201.json", "out/dungeon-2001-s2.json", "out/dungeon-1006-s1.json"],
    setups: SETUPS.map((s) => s.id),
    stage: false,
    scales: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--dry") a.dry = true;
    else if (f === "--force") a.force = true;
    else if (f === "--dungeons") a.dungeons = argv[++i].split(",");
    else if (f === "--setups") a.setups = argv[++i].split(",");
    else if (f === "--stage") a.stage = true;
    else if (f === "--scales") a.scales = argv[++i].split(",").map(Number);
    else if (f === "--refs") a.refs = /^\d+$/.test(argv[i + 1] ?? "") ? Number(argv[++i]) : 1;
    else throw new Error(`unknown flag ${f}`);
  }
  return a;
}

// ---------------------------------------------------------------------------
// STYLE REFERENCE CANDIDATES (--refs)
// ---------------------------------------------------------------------------

/**
 * Figures drawn from the style text alone, no references, for the author to
 * pick sprite references from — the way `assets/illustration-refs/` was made. Ours
 * from words, never anyone's art. Generic subjects, no named monsters, chosen
 * for spread: size, silhouette (upright, hunched, four- and many-legged) and
 * surface (cloth, armour, bone, scale, fur). Nothing gory: klein blanks it.
 */
const REF_SUBJECTS_1: { id: string; figure: string }[] = [
  { id: "P1", figure: "A human fighter in a mail shirt and open-faced helm, a round shield on one arm and a sword held low." },
  { id: "P2", figure: "An elderly scholar in long layered robes, holding a thick book against his chest, spectacles on a cord." },
  { id: "P3", figure: "A lean thief in a hooded cloak and soft boots, a dagger at the belt and a coil of rope over one shoulder." },
  { id: "P4", figure: "An old peasant woman in a shawl and patched skirts, leaning on a crooked walking stick, a basket on her arm." },
  { id: "P5", figure: "A cultist in a deep cowl that shadows the face, plain belted robe, hands clasped around a carved idol." },
  { id: "P6", figure: "A short, broad, bearded miner in a leather jerkin and heavy boots, a pick over one shoulder and a lantern in hand." },
  { id: "C1", figure: "A goblin: small, wiry, long-eared and sharp-toothed, in scraps of leather, gripping a crude spear." },
  { id: "C2", figure: "A hulking brute twice a man's height: heavy brow, thick limbs, hide loincloth, dragging a tree-branch club." },
  { id: "C3", figure: "A skeleton warrior in rusted half-armour, a notched sword in its bony hand, empty eye sockets." },
  { id: "C4", figure: "A giant rat the size of a dog, on all fours, coarse fur, long naked tail, whiskers and bared incisors." },
  { id: "C5", figure: "A scaled lizard-man standing upright, long tail, crested head, carrying a stone-tipped spear and a hide shield." },
  { id: "C6", figure: "A crawling insect-thing the size of a pony: segmented armoured body, many jointed legs, long feelers." },
];

interface RefVariant {
  id: string;
  label: string;
  usd: number;
  draw(prompt: string): Promise<Buffer>;
}

const REF_VARIANTS: RefVariant[] = [
  ...[1, 2].map((seed) => ({
    id: `klein-s${seed}`,
    label: `FLUX.2 [klein] 4B · seed ${seed}`,
    usd: 0.014,
    async draw(prompt: string) {
      const res = await fal.subscribe(IMAGE_MODELS["flux-2-klein-4b"].unguided!, {
        input: { prompt, image_size: { width: SPRITE_W, height: SPRITE_H }, seed, output_format: "png", enable_safety_checker: false },
      });
      return fetchImage(res.data);
    },
  })),
  {
    id: "gpt2-low",
    label: "GPT Image 2 · low · prompt only",
    usd: 0.015,
    async draw(prompt: string) {
      const res = await fal.subscribe(IMAGE_MODELS["gpt-image-2"].unguided!, {
        input: { prompt, quality: "low", image_size: { width: SPRITE_W, height: SPRITE_H }, output_format: "png" },
      });
      return fetchImage(res.data);
    },
  },
];

/** The illustrations' sparse style, said for a figure: mostly white, outlines, hatching only in the deepest shadow. */
const REF_STYLE_1 =
  SPRITE_STYLE +
  " Mostly white paper: the figure is carried by its outlines, with only a few hatched strokes where the " +
  "shadow is deepest, as in a 1970s-80s fantasy rulebook's bestiary or character illustration.";

/**
 * Round 2, after the author's look at round 1: GPT only (its row was liked
 * best), but grubbier. "Too clean and nice": the people less attractive, the
 * monsters gnarlier without being body horror, the pen line rougher.
 */
const REF_STYLE_2 =
  REF_STYLE_1 +
  " The pen line is a working illustrator's: slightly rough and scratchy, never polished or smooth. Nothing " +
  "glamorous or idealised: people are ordinary, weathered, plain or ugly, dirty and worn; creatures are " +
  "rough, mangy, scarred and unpleasant to look at, but not gory.";

const REF_SUBJECTS_2: { id: string; figure: string }[] = [
  { id: "P1", figure: "A battered sellsword in a dented, ill-fitting mail shirt and a scratched open-faced helm: broken nose, stubble, a chipped round shield and a notched sword held low." },
  { id: "P2", figure: "A stooped, gaunt old scholar with a crooked nose, sparse wild hair and ink-stained fingers, in a fraying, stained robe, clutching a swollen, battered book." },
  { id: "P3", figure: "A wiry, pockmarked thief with a sly, unshaven face, in a ragged hooded cloak and worn-through boots, a dagger at the belt and frayed rope over one shoulder." },
  { id: "P4", figure: "A wizened, toothless old peasant woman with a hooked nose and warts, in a patched shawl and muddy skirts, hunched over a crooked stick, a basket on her arm." },
  { id: "P5", figure: "A cultist in a filthy, frayed cowl that hides all but a gaunt, unshaven jaw; a stained rope-belted robe, bare dirty feet, hands clasped round a crude carved idol." },
  { id: "P6", figure: "A squat, scarred, heavy-bellied dwarf miner with a matted beard and a soot-blackened face, in a battered leather jerkin, a worn pick over one shoulder and a dented lantern in hand." },
  { id: "C1", figure: "A goblin: scrawny and pot-bellied, mottled warty skin, ragged ears, crooked yellow teeth, in filthy scraps of hide, gripping a crude spear lashed with sinew." },
  { id: "C2", figure: "A hulking brute twice a man's height: lumpen and lopsided, heavy brow, broken tusks, scarred hide, matted hair, a filthy loincloth, dragging a knotted tree-branch club." },
  { id: "C3", figure: "A skeleton warrior with yellowed, cracked bones and a hanging jaw, scraps of rotted cloth and rusted, broken half-armour hanging off it, a notched sword in its bony hand." },
  { id: "C4", figure: "A giant rat the size of a dog, on all fours: mangy, patchy fur, a torn ear, a scarred snout, a long scaly tail, bared yellow incisors." },
  { id: "C5", figure: "A scaled lizard-man, hunched and lean: scarred, cracked scales, a ragged crest, a necklace of small bones, a stone-tipped spear and a battered hide shield." },
  { id: "C6", figure: "A crawling insect-thing the size of a pony, low to the ground: chipped and pitted armour illustrations, many spiny jointed legs, twitching feelers, dripping mandibles." },
];

/**
 * Round 3: round 2 put everyone in rags, and a reference set that is all rags
 * would dress every sprite in them. The scholar and the thief again, as
 * ordinary people whose clothes and gear are kept in good order — still
 * plain faces and the rough pen line, not models.
 */
const REF_STYLE_3 =
  REF_STYLE_1 +
  " The pen line is a working illustrator's: slightly rough and scratchy, never polished or smooth. The " +
  "person is ordinary-looking: plain rather than handsome or beautiful, a real face with its lines and " +
  "flaws. But their clothes and gear are whole, clean and well cared for: no rags, tears or patches.";

const REF_SUBJECTS_3: { id: string; figure: string }[] = [
  { id: "P2", figure: "A middle-aged scholar with a plain, lined face and thinning hair, in a well-kept, neatly belted scholar's robe of good cloth, holding a sturdy leather-bound book, a pen case and a pouch at the belt." },
  { id: "P3", figure: "A thief who looks like any working person: plain, unremarkable face, a fitted hooded cloak in good repair, a snug jerkin, sound boots, a sheathed dagger, and a neatly coiled rope over one shoulder." },
];

/**
 * Round 4: the thief as an ordinary woman. Round 3 kept the clothes neat but
 * lost round 2's grit — smooth line, pleasant faces — so the face and the
 * line are asked for in so many words.
 */
const REF_STYLE_4 =
  REF_STYLE_3 +
  " Draw with visible, scratchy pen strokes and a little hatching in the shadows of the face and folds. " +
  "The face is weathered and everyday, the kind seen in any market crowd.";

const REF_SUBJECTS_4: { id: string; figure: string }[] = [
  { id: "P3", figure: "A thief who is an ordinary working woman in her thirties: plain, weathered face, hair tied back, a fitted hooded cloak in good repair, a snug jerkin, sound boots, a sheathed dagger, and a neatly coiled rope over one shoulder." },
];

/** GPT has no seed, so two takes of the same prompt are two different drawings. */
const gptTake = (take: string): RefVariant => ({
  id: `gpt2-low-${take}`,
  label: `GPT Image 2 · low · take ${take}`,
  usd: 0.015,
  async draw(prompt: string) {
    const res = await fal.subscribe(IMAGE_MODELS["gpt-image-2"].unguided!, {
      input: { prompt, quality: "low", image_size: { width: SPRITE_W, height: SPRITE_H }, output_format: "png" },
    });
    return fetchImage(res.data);
  },
});

interface RefRound {
  dir: string;
  style: string;
  /** round 1 was drawn before the framing stopped saying "standing" */
  frame: string;
  subjects: { id: string; figure: string }[];
  variants: RefVariant[];
}

const REF_ROUNDS: Record<number, RefRound> = {
  1: {
    dir: "out/sprite-refs",
    style: REF_STYLE_1,
    frame:
      "Draw ONE figure, full length from head to feet, standing, in three-quarter view toward the viewer, " +
      "centred, with white paper all around it. Nothing else: no floor, no ground line, no cast shadow, no " +
      "background, no scenery, no frame, no border.",
    subjects: REF_SUBJECTS_1,
    variants: REF_VARIANTS,
  },
  2: { dir: "out/sprite-refs-2", style: REF_STYLE_2, frame: SPRITE_FRAME, subjects: REF_SUBJECTS_2, variants: [gptTake("a"), gptTake("b")] },
  3: { dir: "out/sprite-refs-3", style: REF_STYLE_3, frame: SPRITE_FRAME, subjects: REF_SUBJECTS_3, variants: [gptTake("a"), gptTake("b")] },
  4: { dir: "out/sprite-refs-4", style: REF_STYLE_4, frame: SPRITE_FRAME, subjects: REF_SUBJECTS_4, variants: [gptTake("a"), gptTake("b")] },
};

async function runRefs(round: number, force: boolean) {
  const r = REF_ROUNDS[round];
  if (!r) throw new Error(`no reference round ${round}; one of ${Object.keys(REF_ROUNDS).join(", ")}`);
  if (!process.env.FAL_KEY) throw new Error("need FAL_KEY");
  fal.config({ credentials: process.env.FAL_KEY });
  const root = resolve(r.dir);
  let spent = 0;
  await Promise.all(
    r.subjects.flatMap((subject) =>
      r.variants.map(async (v) => {
        const raw = join(root, subject.id, `${v.id}.png`);
        if (!existsSync(raw) || force) {
          try {
            write(raw, await v.draw(`${r.style}\n\n${r.frame}\n\nTHE FIGURE\n${subject.figure}`));
            spent += v.usd;
            console.log(`  drew ${subject.id} ${v.id}`);
          } catch (e) {
            spent += v.usd; // a blank is still billed
            console.error(`  ${subject.id} ${v.id} failed: ${(e as Error).message}`);
            return;
          }
        }
        const png = readFileSync(raw);
        write(join(root, subject.id, `${v.id}.1bit.png`), await oneBitPng(png));
        write(join(root, subject.id, `${v.id}.cut.png`), await cutoutPng(await cutOut(png)));
      })
    )
  );

  const rows = r.subjects.map((subject) => {
    const cells = r.variants.map((v) => {
      const base = `${subject.id}/${v.id}`;
      return existsSync(join(root, `${base}.png`))
        ? `<figure><div class="pair"><img src="${base}.1bit.png"><img class="cut" src="${base}.cut.png"></div><figcaption>${esc(v.label)}</figcaption></figure>`
        : `<figure><div class="missing">failed</div><figcaption>${esc(v.label)}</figcaption></figure>`;
    });
    return `<h3>${subject.id} <small>${esc(subject.figure)}</small></h3><div class="row">${cells.join("")}</div>`;
  });
  write(
    join(root, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Sprite reference candidates</title><style>
body{font:14px system-ui;margin:16px;background:#f4f1ea;color:#222}
.row{display:flex;gap:12px;flex-wrap:wrap}.row figure{margin:0;width:31%}
.pair{display:flex;gap:4px}.pair img{width:50%;background:#fff}.pair img.cut{background:#c9c3b6}
.missing{height:200px;display:grid;place-items:center;background:#ddd}
figcaption{font-size:12px}small{color:#777;font-weight:normal}
</style><h1>Sprite reference candidates · round ${round}</h1><p>Each: 1-bit, then cut out (on grey, so the kept paper shows). Prompt: <i>${esc(r.style)} ${esc(r.frame)}</i></p>${rows.join("\n")}`
  );
  console.log(`\nestimated spend this run: $${spent.toFixed(3)} → ${r.dir}/index.html`);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const setups = SETUPS.filter((s) => args.setups.includes(s.id));
  envInto(["ANTHROPIC_API_KEY", "FAL_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  if (args.refs !== undefined) return runRefs(args.refs, args.force);
  const root = resolve("out/sprites");
  let spent = 0;
  const html: string[] = [];

  if (!args.dry) {
    if (!process.env.ANTHROPIC_API_KEY || !process.env.FAL_KEY) throw new Error("need ANTHROPIC_API_KEY and FAL_KEY (or run --dry)");
    configureTransport({
      baseUrl: "https://api.anthropic.com",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    });
    fal.config({ credentials: process.env.FAL_KEY });
  }
  const work = args.dry ? undefined : liveIllustrationWork();
  const refsDir = resolve(ILLUSTRATION_REFS_DIR);
  let spriteRefUrls: string[] | undefined;
  const spriteRefs = async () =>
    (spriteRefUrls ??= await Promise.all(
      readdirSync(resolve(SPRITE_REFS_DIR))
        .filter((f) => f.endsWith(".png"))
        .sort()
        .map((f) => fal.storage.upload(new Blob([readFileSync(join(resolve(SPRITE_REFS_DIR), f))], { type: "image/png" })))
    ));
  let refUrls: string[] | undefined;
  const refs = async () =>
    (refUrls ??= await Promise.all(
      ["I10.png", "I7.png", "I8.png", "I9.png"].map((f) =>
        fal.storage.upload(new Blob([readFileSync(join(refsDir, f))], { type: "image/png" }))
      )
    ));

  for (const file of args.dungeons) {
    const d = JSON.parse(readFileSync(resolve(file), "utf8")) as GeneratedDungeon;
    const dir = join(root, basename(file, ".json"));
    const theme = d.pass.theme;
    console.log(`\n== ${file}: ${d.pass.name}`);

    // Every room with creatures, its clusters, and the sprites they need.
    const rooms = d.entities.rooms
      .map((r) => ({ room: r, clusters: clustersIn(d, r.id) }))
      .filter((r) => r.clusters.length);
    const sprites = new Map<string, Sprite>();
    for (const r of rooms) for (const cl of r.clusters) for (const f of [...cl.front, ...cl.behind]) sprites.set(f.sprite.key, f.sprite);
    console.log(`  ${rooms.length} rooms with creatures, ${sprites.size} sprites:`);
    for (const s of sprites.values()) console.log(`    ${s.role.padEnd(6)} ${s.name}`);
    for (const r of rooms) console.log(`  ${r.room.name}: ${r.clusters.map((c) => c.label).join(" | ")}`);
    if (args.dry) continue;

    // Looks and sizes, one Haiku call per sprite.
    const looksPath = join(dir, "looks.json");
    const looks = readJson<Record<string, { look: string; size: SizeWord }>>(looksPath) ?? {};
    for (const s of sprites.values()) {
      if (looks[s.key]) continue;
      looks[s.key] = await requestLook(s, theme);
      write(looksPath, JSON.stringify(looks, null, 2));
    }
    const sizes = Object.fromEntries(Object.entries(looks).map(([k, v]) => [k, v.size]));

    // Sprites, per setup.
    const cuts = new Map<string, Map<string, Cutout>>();
    for (const setup of setups) {
      const cut = new Map<string, Cutout>();
      cuts.set(setup.id, cut);
      await Promise.all(
        [...sprites.values()].map(async (s) => {
          const raw = join(dir, setup.id, `${fileOf(s.key)}.png`);
          if (!existsSync(raw) || args.force) {
            try {
              write(raw, await setup.draw(spritePrompt(looks[s.key].look), seedOf(s.key), setup.id === "gpt2-low" ? await refs() : setup.id === "gpt2-srefs" ? await spriteRefs() : []));
              spent += setup.usd;
              console.log(`  drew ${setup.id} ${s.name}`);
            } catch (e) {
              console.error(`  ${setup.id} ${s.name} failed: ${(e as Error).message}`);
              return;
            }
          }
          const c = await cutOut(readFileSync(raw));
          cut.set(s.key, c);
          write(join(dir, setup.id, `${fileOf(s.key)}.cut.png`), await cutoutPng(c));
        })
      );
    }

    // Illustrations: the stored one if the bucket has it, else drawn here like the server would.
    const illustrations = new Map<string, { p: RoomIllustration; png: Buffer; source: string }>();
    await Promise.all(
      rooms.map(async ({ room }) => {
        const entry = illustrationEntries(d, room.id)[0];
        const p = entry ? roomIllustration(d, room.id, entry) : undefined;
        if (!p) return;
        const path = join(dir, "illustrations", `${room.id}.png`);
        let source = "cached";
        if (!existsSync(path)) {
          const url = illustrationUrl(`${illustrationKey(p, theme, 4)}.png`);
          const got = url ? await fetch(url) : undefined;
          if (got?.ok) {
            write(path, Buffer.from(await got.arrayBuffer()));
            source = "stored";
          } else if (work) {
            const setting = await work.setting(theme);
            const visual = await work.visual(p);
            write(path, await work.draw(illustrationImagePrompt(p, "marks", setting, visual, undefined, work.references), await guidePng(p, true)));
            spent += 0.015;
            source = "drawn";
          } else return;
        }
        console.log(`  illustration ${room.name} (${source})`);
        illustrations.set(room.id, { p, png: readFileSync(path), source });
      })
    );

    // The same rooms redrawn with the reserved floor: same words, same model,
    // the patch added to the guide and the prompt.
    const staged = new Map<string, Buffer>();
    if (args.stage && work) {
      const setting = await work.setting(theme);
      await Promise.all(
        [...illustrations.entries()].map(async ([roomId, { p }]) => {
          const at = candidatesFor(p)[0]?.at;
          if (!at) return;
          const path = join(dir, "illustrations-stage", `${roomId}.png`);
          const guide = await guidePng(p, true);
          write(join(dir, "illustrations-stage", `${roomId}.guide.png`), guide);
          if (!existsSync(path)) {
            const visual = await work.visual(p);
            const prompt = illustrationImagePrompt(p, "marks", setting, visual, undefined, work.references);
            write(join(dir, "illustrations-stage", `${roomId}.prompt.txt`), prompt);
            write(path, await work.draw(prompt, guide));
            spent += 0.015;
            console.log(`  staged illustration ${p.roomName}`);
          }
          staged.set(roomId, readFileSync(path));
        })
      );
    }

    // The sheet.
    html.push(`<h2>${esc(d.pass.name)} <small>${esc(file)}</small></h2>`);
    html.push(`<div class="sprites">`);
    for (const s of sprites.values()) {
      html.push(`<figure><figcaption><b>${esc(s.name)}</b> · ${s.role} · ${looks[s.key].size}<br><i>${esc(looks[s.key].look)}</i></figcaption>`);
      for (const setup of setups) {
        const rel = `${basename(dir)}/${setup.id}/${fileOf(s.key)}`;
        html.push(`<div class="pair"><img src="${rel}.png" title="${setup.id} raw"><img class="cut" src="${rel}.cut.png" title="${setup.id} cut out"></div>`);
      }
      html.push(`</figure>`);
    }
    html.push(`</div>`);
    for (const { room, clusters } of rooms) {
      const illustration = illustrations.get(room.id);
      if (!illustration) continue;
      const stands = standings(illustration.p, clusters);
      html.push(`<h3>${esc(room.name)} <small>${clusters.map((c) => esc(c.label)).join(" · ")} · illustration ${illustration.source}</small></h3><div class="row">`);
      html.push(`<figure><img src="${basename(dir)}/illustrations/${room.id}.png"><figcaption>illustration</figcaption></figure>`);
      for (const setup of setups) {
        const out = join(dir, "composite", setup.id, `${room.id}.png`);
        write(out, await composite(illustration.png, illustration.p, stands, cuts.get(setup.id)!, sizes));
        html.push(`<figure><img src="${basename(dir)}/composite/${setup.id}/${room.id}.png"><figcaption>${esc(setup.label)}</figcaption></figure>`);
      }
      const stagedPng = staged.get(room.id);
      if (stagedPng) {
        html.push(`</div><div class="row">`);
        html.push(`<figure><img src="${basename(dir)}/illustrations-stage/${room.id}.guide.png"><figcaption>guide with the reserved floor</figcaption></figure>`);
        html.push(`<figure><img src="${basename(dir)}/illustrations-stage/${room.id}.png"><figcaption>illustration, floor reserved</figcaption></figure>`);
        for (const setup of setups) {
          const out = join(dir, "composite-stage", setup.id, `${room.id}.png`);
          write(out, await composite(stagedPng, illustration.p, stands, cuts.get(setup.id)!, sizes));
          html.push(`<figure><img src="${basename(dir)}/composite-stage/${setup.id}/${room.id}.png"><figcaption>${esc(setup.label)}, floor reserved</figcaption></figure>`);
          for (const k of args.scales) {
            const rel = `composite-stage-x${k}/${setup.id}/${room.id}.png`;
            write(join(dir, rel), await composite(stagedPng, illustration.p, stands, cuts.get(setup.id)!, sizes, k));
            html.push(`<figure><img src="${basename(dir)}/${rel}"><figcaption>${esc(setup.label)}, floor reserved, figures ×${k} (default ×${FIGURE_SCALE})</figcaption></figure>`);
          }
        }
      }
      html.push(`</div>`);
    }
  }

  if (args.dry) return;
  write(
    join(root, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Creature sprites</title><style>
body{font:14px system-ui;margin:16px;background:#f4f1ea;color:#222}
.row{display:flex;gap:8px;flex-wrap:wrap}.row figure{margin:0;width:32%}.row img{width:100%;background:#fff}
.sprites{display:flex;gap:12px;flex-wrap:wrap}.sprites figure{margin:0;width:300px}
.pair{display:flex;gap:4px}.pair img{width:50%;background:#fff}.pair img.cut{background:#c9c3b6}
figcaption{font-size:12px}small{color:#777;font-weight:normal}
</style><h1>Creature sprites</h1><p>Cut-outs are shown on grey so the kept paper shows.</p>${html.join("\n")}`
  );
  console.log(`\nestimated spend this run: $${spent.toFixed(3)} → out/sprites/index.html`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
