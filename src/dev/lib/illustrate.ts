/**
 * The CLI behind `dev/cli-illustrate.ts`, which teaches Node `?raw` first and then
 * imports this. Usage is in that file.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { fal } from "@fal-ai/client";
import { connectedCells } from "../../illustrations/view.ts";
import { illustrationVisualMessage, type GuideMode } from "../../illustrations/prompt.ts";
import {
  ILLUSTRATION_EXTERIOR_SYSTEM,
  ILLUSTRATION_STYLE,
  ILLUSTRATION_VISUAL_SYSTEM,
} from "../../prompts/loader.ts";
import { touches } from "../../shared/world/entities.ts";
import { generateOffline } from "../../fixtures/offline.ts";
import type { GeneratedDungeon } from "../../generation/generate.ts";
import { configureTransport } from "../../llm/client.ts";
import { IMAGE_MODELS, type ImageModel } from "../../llm/models.ts";
import { guidePng, oneBitPng, ILLUSTRATION_H, ILLUSTRATION_THRESHOLD, ILLUSTRATION_W } from "../../server/illustrations/image.ts";
import {
  exteriorIllustrationPrompt,
  illustrationImagePrompt,
  requestIllustrationExterior,
  visualSubjects,
  requestIllustrationSetting,
  requestIllustrationVisual,
  type IllustrationVisual,
} from "../../illustrations/visual.ts";
import { illustrationBrief, illustrationEntries, roomIllustration, type RoomIllustration } from "../../illustrations/room-illustration.ts";
import { hotspotMarks } from "./illustration-overlay.ts";
import { EXTERIORS, INTERIORS, THEMES, type Candidate, type InteriorSubject } from "./illustration-subjects.ts";

// ---------------------------------------------------------------------------
// SETUPS
// ---------------------------------------------------------------------------

const SIZE = { width: ILLUSTRATION_W, height: ILLUSTRATION_H };

interface Setup {
  id: string;
  label: string;
  model: ImageModel;
  /** guide modes it is run with on interiors; "none" means from the prompt alone */
  modes: GuideMode[];
  /** run on the exteriors (prompt only) */
  exteriors: boolean;
  /** estimated USD per illustration */
  usd: number;
  /** most images the endpoint takes at once, guide and references together */
  maxImages?: number;
  /** the request body; `images` is the guide (if any) followed by any style references */
  input: (prompt: string, images: string[], seed: number) => Record<string, unknown>;
}

const withImages = (images: string[]) => (images.length ? { image_urls: images } : {});

const SETUPS: Setup[] = [
  {
    id: "gpt2-low",
    label: "GPT Image 2 · low",
    model: "gpt-image-2",
    modes: ["marks", "plain", "none"],
    exteriors: true,
    usd: 0.015,
    maxImages: 16,
    input: (prompt, images) => ({ prompt, quality: "low", image_size: SIZE, output_format: "png", ...withImages(images) }),
  },
  {
    id: "gpt2-medium",
    label: "GPT Image 2 · medium",
    model: "gpt-image-2",
    modes: ["marks", "plain"],
    exteriors: true,
    usd: 0.06,
    maxImages: 16,
    input: (prompt, images) => ({ prompt, quality: "medium", image_size: SIZE, output_format: "png", ...withImages(images) }),
  },
  {
    id: "klein-4b",
    label: "FLUX.2 [klein] 4B",
    model: "flux-2-klein-4b",
    modes: ["marks", "plain", "none"],
    exteriors: true,
    usd: 0.03,
    maxImages: 4,
    input: (prompt, images, seed) => ({
      prompt,
      image_size: SIZE,
      seed,
      output_format: "png",
      ...(images.length ? { image_urls: images, num_inference_steps: 8 } : {}),
    }),
  },
  {
    id: "flux2-pro",
    label: "FLUX.2 [pro]",
    model: "flux-2-pro",
    modes: ["marks", "plain"],
    exteriors: true,
    usd: 0.075,
    maxImages: 9,
    input: (prompt, images, seed) => ({ prompt, image_size: SIZE, seed, output_format: "png", ...withImages(images) }),
  },
  {
    // A structure lock: it follows the guide's edges, so it only ever gets the
    // plain guide — the marks would come back as edges in the drawing.
    id: "flux1-canny",
    label: "FLUX.1 [pro] Canny",
    model: "flux-1-pro-canny",
    modes: ["plain"],
    exteriors: false,
    usd: 0.08,
    maxImages: 1,
    input: (prompt, images, seed) => ({ prompt, control_image_url: images[0], image_size: SIZE, seed, output_format: "png" }),
  },
];

/**
 * Style texts, for comparing. `v2` is ILLUSTRATION_STYLE, the default. `v1` was round
 * 1's: the ink was right but too heavy — dense cross-hatching that turned busy
 * or black at 1-bit. `sparse` and `outline` were the trial that answered it;
 * sparse won and became v2, with a firmer "no border" for klein.
 */
const STYLES: Record<string, string> = {
  v2: ILLUSTRATION_STYLE,
  v1:
    "Black-and-white pen-and-ink illustration in the manner of a 1970s-80s fantasy " +
    "adventure module's illustration booklet. Pure black ink on white paper: confident " +
    "line work, with cross-hatching and stippling for shadow and texture. No grey wash, " +
    "no colour, no gradients, no frame or border. Any lettering only in an invented " +
    "script, never a readable alphabet. No people, no creatures, no loose objects.",
  sparse:
    "Clean black ink line art in the manner of a 1970s-80s fantasy adventure module's illustration " +
    "booklet. Mostly white paper. Crisp, confident outlines define every form. Shading is sparing: a few " +
    "hatched strokes only in the deepest shadows, no dense cross-hatching, no stippled texture, no large " +
    "areas of solid black. Walls, floors and sky stay largely white. No grey, no colour. The drawing runs " +
    "to the edges of the image: no frame, border or vignette. No lettering. No people, no creatures, no " +
    "loose objects.",
  outline:
    "A clean pen-and-ink line drawing in the manner of a 1970s-80s fantasy adventure module. Black outlines " +
    "on white paper, almost no shading: a handful of short hatching strokes at most, only where a shadow is " +
    "deepest, and no solid black areas. Surfaces are suggested by a few lines, never filled with texture. " +
    "No grey, no colour. The drawing runs to the edges of the image: no frame, border or vignette. No " +
    "lettering. No people, no creatures, no loose objects.",
};

const CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// ARGS AND KEYS
// ---------------------------------------------------------------------------

interface Args {
  dry: boolean;
  style: string;
  /**
   * Which guide modes each setup runs on interiors: "setup=mode+mode", or a
   * bare mode for every setup. A setup named here is the only kind that runs.
   * Exteriors are always prompt-only and follow the setups, not the modes.
   */
  modes?: Map<string, Set<GuideMode>>;
  force: boolean;
  only?: Set<string>;
  setups?: Set<string>;
  maxUsd: number;
  out: string;
  /**
   * Interior subjects whose klein no-guide illustration (1-bit) is sent as a style
   * reference after the guide. A subject is never given its own: it would
   * just copy it. Interiors only — the exteriors' endpoint takes no images.
   */
  refs?: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dry: false, style: "v2", force: false, maxUsd: 12, out: "" };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const next = () => argv[++i];
    if (f === "--dry") a.dry = true;
    else if (f === "--force") a.force = true;
    else if (f === "--only") a.only = new Set(next().split(","));
    else if (f === "--setups") a.setups = new Set(next().split(","));
    else if (f === "--max-usd") a.maxUsd = Number(next());
    else if (f === "--out") a.out = next();
    else if (f === "--style") a.style = next();
    else if (f === "--refs") a.refs = next().split(",");
    else if (f === "--modes") {
      a.modes = new Map();
      for (const part of next().split(",")) {
        const [setup, list] = part.includes("=") ? part.split("=") : ["*", part];
        a.modes.set(setup, new Set(list.split("+") as GuideMode[]));
      }
    }
    else throw new Error(`unknown flag ${f}`);
  }
  if (!STYLES[a.style]) throw new Error(`unknown style ${a.style}; one of ${Object.keys(STYLES).join(", ")}`);
  if (!a.out) a.out = (a.style === "v1" ? "out/illustrate" : `out/illustrate-${a.style}`) + (a.refs ? "-refs" : "");
  return a;
}

function envKey(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    for (const line of readFileSync(resolve(".env.local"), "utf8").split("\n")) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`));
      if (m) return m[1].replace(/^["']|["']$/g, "") || undefined;
    }
  } catch {
    // no .env.local: the caller says what is missing
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// BINDING: each interior to a real room
// ---------------------------------------------------------------------------

/** The door the viewer comes in by: any but the way out, so the way out can be in the picture. */
function entryFor(d: GeneratedDungeon, roomId: string): string | undefined {
  const entries = illustrationEntries(d, roomId);
  const surface = new Set(d.entities.connectors.filter((c) => c.endpointB === null).map((c) => c.id));
  return entries.find((id) => !surface.has(id)) ?? entries[0];
}

function candidateOf(d: GeneratedDungeon, roomId: string): { c: Candidate; p: RoomIllustration } | undefined {
  const entry = entryFor(d, roomId);
  if (!entry) return undefined;
  const p = roomIllustration(d, roomId, entry);
  if (!p) return undefined;
  const i = d.graph.rooms.findIndex((r) => r.entityId === roomId);
  const f = p.input.floor;
  const xs = f.map((q) => q.x);
  const ys = f.map((q) => q.y);
  const w = Math.max(...xs) - Math.min(...xs) + 1;
  const h = Math.max(...ys) - Math.min(...ys) + 1;
  const feats = d.entities.features.filter((x) => x.roomId === roomId && x.place?.cells.length);
  const surfaceId = [...p.exits, p.entry].find((x) => x.surface)?.id;
  const allDoors = [...p.view.exits, p.view.entry];
  return {
    p,
    c: {
      cells: f.length,
      w,
      h,
      corridor: d.stocked.rooms.some((r) => r.index === i && r.isCorridor),
      fixtures: feats.map((x) => x.place?.fixture).filter((k): k is NonNullable<typeof k> => !!k),
      placed: feats.length,
      multiPiece: feats.some((x) => connectedCells(x.place!.cells).length >= 2),
      fill: f.length / (w * h),
      surfaceExit: surfaceId !== undefined,
      surfaceShown: surfaceId !== undefined && allDoors.some((s) => s.id === surfaceId && s.visible),
      around: p.hotspots.filter((x) => x.status === "around").length,
      featuresShown: p.view.features.filter((s) => s.placed && s.visible).length,
    },
  };
}

/**
 * Write the subject's fiction onto a copy of the dungeon: the room, its doors,
 * and its features matched to footprints that suit them. Undefined when the
 * room has no footprint a spec needs.
 */
function dress(source: GeneratedDungeon, roomId: string, s: InteriorSubject): GeneratedDungeon | undefined {
  const d = structuredClone(source);
  const room = d.entities.rooms.find((r) => r.id === roomId)!;
  room.name = s.room.name;
  (room as { base?: string }).base = s.room.base;

  const mine = d.entities.features.filter((f) => f.roomId === roomId && f.place?.cells.length);
  const used = new Set<string>();
  const kept: typeof d.entities.features = [];
  // Most particular first, so "any" cannot take the footprint a kind or a
  // one-piece spec needed.
  const rank = (fits: string | undefined) => (fits === "any" ? 2 : fits === "one-piece" ? 1 : 0);
  const onePiece = (x: (typeof mine)[number]) => connectedCells(x.place!.cells).length === 1;
  for (const spec of s.features.filter((x) => !x.spread).sort((a, b) => rank(a.fits) - rank(b.fits))) {
    const free = mine.filter((x) => !used.has(x.id));
    const f =
      spec.fits === "any"
        ? free[0]
        : spec.fits === "one-piece"
          ? free.find(onePiece)
          : free.find((x) => x.place?.fixture === spec.fits);
    if (!f) return undefined;
    used.add(f.id);
    f.name = spec.name;
    (f as { base?: string }).base = spec.base;
    f.isHidden = false;
    // Objects, all of them: a fixture by its kind, anything else by an entry
    // no presence list names. A footprint placed "throughout" is moved to the
    // centre word so it is not read as a surface; its cells do not change.
    f.keywords = spec.rolled ?? (f.place?.fixture ? { Fixture: f.place.fixture } : { Object: spec.name });
    if (f.place?.position === "throughout") f.place = { ...f.place, position: "centre" };
    kept.push(f);
  }
  s.features
    .filter((x) => x.spread)
    .forEach((spec, k) => {
      kept.push({
        id: `${s.id}-spread-${k}`,
        name: spec.name,
        type: "RoomFeature",
        roomId,
        base: spec.base,
        keywords: spec.rolled ?? {},
        place: { cells: [], position: "throughout" },
      } as (typeof d.entities.features)[number]);
    });
  d.entities.features = [...d.entities.features.filter((f) => f.roomId !== roomId), ...kept];

  let k = 0;
  for (const c of d.entities.connectors.filter((x) => touches(x, roomId))) {
    // A way out the subject wrote nothing for is just another door to it: no placeholder words may survive.
    const prose = (c.endpointB === null ? s.wayOut : undefined) ?? s.exits[k++ % s.exits.length];
    c.name = prose.name;
    (c as { base?: string }).base = prose.base;
  }
  return d;
}

interface Bound {
  subject: InteriorSubject;
  d: GeneratedDungeon;
  illustration: RoomIllustration;
  from: string;
}

function bindAll(subjects: InteriorSubject[]): Bound[] {
  const pool: { d: GeneratedDungeon; label: string }[] = [];
  for (let seed = 1; seed <= 60; seed++) {
    for (const size of [1, 2, 3] as const) {
      try {
        const d = generateOffline(seed, size);
        if (d.blockplan) pool.push({ d, label: `offline seed ${seed} size ${size}` });
      } catch {
        // a seed whose graph would not lay out: the generator throws it away too
      }
    }
  }
  const taken = new Set<string>();
  const out: Bound[] = [];
  for (const s of subjects) {
    let found: Bound | undefined;
    search: for (const { d, label } of pool) {
      for (const gr of d.graph.rooms) {
        const key = `${label}/${gr.entityId}`;
        if (taken.has(key)) continue;
        const before = candidateOf(d, gr.entityId);
        if (!before || !s.pick(before.c)) continue;
        const dressed = dress(d, gr.entityId, s);
        if (!dressed) continue;
        // Dressing changes what is in the room, and so where the camera goes:
        // the room has to pass again as it will actually be drawn.
        const after = candidateOf(dressed, gr.entityId);
        if (!after || !s.pick(after.c)) continue;
        taken.add(key);
        found = { subject: s, d: dressed, illustration: after.p, from: `${label}, room ${d.graph.rooms.indexOf(gr)}` };
        break search;
      }
    }
    if (!found) console.error(`[bind] ${s.id} ${s.title}: no room in the pool fits`);
    else {
      out.push(found);
      console.error(`[bind] ${s.id} ${s.title} <- ${found.from} (${found.illustration.input.floor.length} cells, standing ${found.illustration.view.standing})`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// FILES
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

async function writeGuide(p: RoomIllustration, marks: boolean, path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await guidePng(p, marks));
}

/** Where a reference's source illustration can be: the runs it was drawn in, newest style first. */
const REF_SOURCES = ["out/illustrate-v2", "out/illustrate-sparse"];
/** A reference is sent at about a quarter of a megapixel: style survives, input cost does not. */
const REF_SIZE = { width: 768, height: 512 };

/**
 * A subject's klein no-guide illustration, ready to send as a style reference:
 * any drawn frame cut away (a reference is copied, border and all), then
 * shrunk. Klein sometimes rules a box round the picture; it shows as an edge
 * row or column that is nearly all ink, a little way in from the image edge.
 */
async function prepareRef(id: string, outDir: string): Promise<string> {
  const src = REF_SOURCES.map((d) => resolve(d, id, "klein-4b-none.1bit.png")).find((p) => existsSync(p));
  if (!src) throw new Error(`no klein-4b-none illustration for reference ${id} in ${REF_SOURCES.join(" or ")}`);
  const { data, info } = await sharp(src).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const inkRow = (y: number) => {
    let n = 0;
    for (let x = 0; x < w; x++) if (data[y * w + x] < 128) n++;
    return n / w > 0.85;
  };
  const inkCol = (x: number) => {
    let n = 0;
    for (let y = 0; y < h; y++) if (data[y * w + x] < 128) n++;
    return n / h > 0.85;
  };
  // Search the outer 8% of each side for a ruled line, and cut just inside it.
  const find = (from: number, to: number, step: number, test: (i: number) => boolean) => {
    for (let i = from; i !== to; i += step) if (test(i)) return i;
    return undefined;
  };
  const top = find(0, Math.round(h * 0.08), 1, inkRow);
  const bottom = find(h - 1, Math.round(h * 0.92), -1, inkRow);
  const left = find(0, Math.round(w * 0.08), 1, inkCol);
  const right = find(w - 1, Math.round(w * 0.92), -1, inkCol);
  const inset = 6;
  const box = {
    left: left !== undefined ? left + inset : 0,
    top: top !== undefined ? top + inset : 0,
    right: right !== undefined ? right - inset : w - 1,
    bottom: bottom !== undefined ? bottom - inset : h - 1,
  };
  const out = join(outDir, "refs", `${id}.png`);
  mkdirSync(dirname(out), { recursive: true });
  await sharp(src)
    .extract({ left: box.left, top: box.top, width: box.right - box.left + 1, height: box.bottom - box.top + 1 })
    .resize(REF_SIZE.width, REF_SIZE.height, { fit: "inside", background: "#ffffff" })
    .png()
    .toFile(out);
  const framed = [top, bottom, left, right].some((x) => x !== undefined);
  console.error(`[ref] ${id} <- ${src}${framed ? " (frame cut away)" : ""}`);
  return out;
}

async function toOneBit(raw: string, out: string): Promise<void> {
  writeFileSync(out, await oneBitPng(readFileSync(raw)));
}

/**
 * A model's answer is cached with a hash of the text it was asked about, and
 * reused only while that text is unchanged: rewrite a subject's fiction and its
 * words are asked for again.
 */
const sourceOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
function fresh<T>(entry: unknown, source: string): T | undefined {
  const e = entry as { source?: string; value?: T } | undefined;
  return e?.source === source ? e.value : undefined;
}

const seedOf = (s: string) => createHash("sha256").update(s).digest().readUInt32BE(0) % 1_000_000;

// ---------------------------------------------------------------------------
// JOBS
// ---------------------------------------------------------------------------

interface Job {
  subject: string;
  setup: Setup;
  mode: GuideMode;
  prompt: string;
  guidePath?: string;
  /** style references, sent after the guide */
  refPaths: string[];
  /** where the raw image lands; the 1-bit copy sits beside it */
  file: string;
}

interface Result {
  ms?: number;
  usd?: number;
  error?: string;
  /**
   * A hash of everything the image was asked with. An image on disk is
   * redrawn when this no longer matches — a rewritten prompt must not
   * silently reuse the old picture. Absent on images drawn before it was
   * recorded, which are taken as current.
   */
  source?: string;
}

const jobSource = (j: Job) =>
  sourceOf([j.setup.id, j.mode, j.prompt, j.guidePath ?? "", ...j.refPaths].join("\n"));

async function runJobs(jobs: Job[], dir: string, manifest: Record<string, Result>): Promise<void> {
  const uploaded = new Map<string, string>();
  const upload = async (path: string) => {
    let url = uploaded.get(path);
    if (!url) {
      url = await fal.storage.upload(new Blob([readFileSync(path)], { type: "image/png" }));
      uploaded.set(path, url);
    }
    return url;
  };
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const job = jobs[next++];
      if (!job) return;
      const key = job.file;
      const started = Date.now();
      try {
        const images = await Promise.all([...(job.guidePath ? [job.guidePath] : []), ...job.refPaths].map(upload));
        if (images.length > (job.setup.maxImages ?? 0)) {
          throw new Error(`${job.setup.label} takes at most ${job.setup.maxImages ?? 0} images; this job has ${images.length}`);
        }
        const ids = IMAGE_MODELS[job.setup.model];
        const endpoint = images.length ? ids.guided : ids.unguided;
        if (!endpoint) throw new Error(`${job.setup.model} has no ${images.length ? "guided" : "unguided"} endpoint`);
        const res = await fal.subscribe(endpoint, { input: job.setup.input(job.prompt, images, seedOf(job.subject)) });
        const url = (res.data as { images?: { url: string }[] }).images?.[0]?.url;
        if (!url) throw new Error(`no image in the response: ${JSON.stringify(res.data).slice(0, 300)}`);
        const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
        const raw = join(dir, job.file);
        mkdirSync(dirname(raw), { recursive: true });
        writeFileSync(raw, bytes);
        await toOneBit(raw, raw.replace(/\.png$/, ".1bit.png"));
        manifest[key] = { ms: Date.now() - started, usd: job.setup.usd, source: jobSource(job) };
      } catch (e) {
        const body = (e as { body?: unknown }).body;
        manifest[key] = { ms: Date.now() - started, error: `${(e as Error).message}${body ? ` ${JSON.stringify(body).slice(0, 400)}` : ""}` };
      }
      done++;
      console.error(`[img] ${done}/${jobs.length} ${job.subject} ${job.setup.id} ${job.mode}${manifest[key].error ? " FAILED" : ""} (${Math.round((manifest[key].ms ?? 0) / 1000)}s)`);
      writeJson(join(dir, "manifest.json"), manifest);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(args.out);
  const wanted = (id: string) => !args.only || args.only.has(id);
  const named = args.modes && [...args.modes.keys()].filter((k) => k !== "*");
  const setups = SETUPS.filter((s) => (!args.setups || args.setups.has(s.id)) && (!named?.length || named.includes(s.id))).map((s) => {
    const allowed = args.modes?.get(s.id) ?? args.modes?.get("*");
    return { ...s, modes: s.modes.filter((m) => !allowed || allowed.has(m)) };
  });
  const style = STYLES[args.style];
  // A style trial reuses round 1's words, so the style is the only thing that differs.
  const round1 = resolve("out/illustrate");
  const cached = (rel: string) => (dir !== round1 ? readJson<unknown>(join(round1, rel)) : undefined);

  const anthropic = envKey("ANTHROPIC_API_KEY");
  if (!anthropic) throw new Error("no ANTHROPIC_API_KEY in the environment or .env.local");
  configureTransport({
    baseUrl: "https://api.anthropic.com",
    headers: { "x-api-key": anthropic, "anthropic-version": "2023-06-01" },
  });

  const interiors = bindAll(INTERIORS.filter((s) => wanted(s.id)));
  const exteriors = EXTERIORS.filter((s) => wanted(s.id));

  // SETTINGS, once per theme, cached.
  const settingsPath = join(dir, "settings.json");
  const settings = readJson<Record<string, string>>(settingsPath) ?? (cached("settings.json") as Record<string, string> | undefined) ?? {};
  for (const [key, text] of interiors.map((b) => [b.subject.theme, THEMES[b.subject.theme]] as const)) {
    if (settings[key]) continue;
    settings[key] = (await requestIllustrationSetting(text)).value;
    writeJson(settingsPath, settings);
  }

  const jobs: Job[] = [];
  const sheet: string[] = [];
  const refPaths = new Map<string, string>();
  for (const id of args.refs ?? []) refPaths.set(id, await prepareRef(id, dir));
  if (args.refs) sheet.push(refsSection([...refPaths.keys()]));

  for (const b of interiors) {
    // Every reference but this room's own: given itself, a model just copies it.
    const refs = [...refPaths].filter(([id]) => id !== b.subject.id).map(([, path]) => path);
    const sdir = join(dir, b.subject.id);
    const visualPath = join(sdir, "visual.json");
    const visualSource = sourceOf(ILLUSTRATION_VISUAL_SYSTEM + illustrationVisualMessage(b.illustration.roomName, b.illustration.roomBase, visualSubjects(b.illustration).subjects));
    let visual =
      fresh<IllustrationVisual>(readJson(visualPath), visualSource) ?? fresh<IllustrationVisual>(cached(`${b.subject.id}/visual.json`), visualSource);
    if (!visual) {
      visual = (await requestIllustrationVisual(b.illustration)).value;
      writeJson(visualPath, { source: visualSource, value: visual });
    }
    await writeGuide(b.illustration, true, join(sdir, "guide-marks.png"));
    await writeGuide(b.illustration, false, join(sdir, "guide-plain.png"));
    const setting = settings[b.subject.theme];
    const prompts = Object.fromEntries(
      (["marks", "plain", "none"] as GuideMode[]).map((m) => [m, illustrationImagePrompt(b.illustration, m, setting, visual!, style, refs.length)])
    ) as Record<GuideMode, string>;
    writeJson(join(sdir, "prompts.json"), prompts);
    for (const s of setups) {
      for (const m of s.modes) {
        jobs.push({
          subject: b.subject.id,
          setup: s,
          mode: m,
          prompt: prompts[m],
          guidePath: m === "none" ? undefined : join(sdir, `guide-${m}.png`),
          refPaths: refs,
          file: `${b.subject.id}/${s.id}-${m}.png`,
        });
      }
    }
    sheet.push(interiorSection(b, visual, setting, prompts, setups));
  }

  for (const e of exteriors) {
    const sdir = join(dir, e.id);
    const scenePath = join(sdir, "scene.json");
    const sceneSource = sourceOf(ILLUSTRATION_EXTERIOR_SYSTEM + e.description);
    let scene = fresh<string>(readJson(scenePath), sceneSource) ?? fresh<string>(cached(`${e.id}/scene.json`), sceneSource);
    if (!scene) {
      scene = (await requestIllustrationExterior(e.description)).value;
      writeJson(scenePath, { source: sceneSource, value: scene });
    }
    const prompt = exteriorIllustrationPrompt({ scene, style });
    writeJson(join(sdir, "prompts.json"), { none: prompt });
    for (const s of setups.filter((x) => x.exteriors)) {
      jobs.push({ subject: e.id, setup: s, mode: "none", prompt, refPaths: [], file: `${e.id}/${s.id}-none.png` });
    }
    sheet.push(exteriorSection(e.id, e.title, e.description, scene, prompt, setups.filter((x) => x.exteriors)));
  }

  const manifestPath = join(dir, "manifest.json");
  const manifest = readJson<Record<string, Result>>(manifestPath) ?? {};
  const stale = (j: Job) => {
    const was = manifest[j.file]?.source;
    return was !== undefined && was !== jobSource(j);
  };
  const todo = jobs.filter((j) => args.force || !existsSync(join(dir, j.file)) || stale(j));
  const estimate = todo.reduce((sum, j) => sum + j.setup.usd, 0);
  console.error(`[plan] ${jobs.length} images, ${todo.length} to draw, est. $${estimate.toFixed(2)}`);

  writeSheet(dir, sheet, jobs, manifest, args.style);

  if (args.dry) {
    console.error(`[dry] no images drawn. Sheet: ${join(dir, "index.html")}`);
    return;
  }
  const falKey = envKey("FAL_KEY");
  if (!falKey) throw new Error("no FAL_KEY in the environment or .env.local (run with --dry to skip images)");
  if (estimate > args.maxUsd) throw new Error(`estimate $${estimate.toFixed(2)} is over --max-usd ${args.maxUsd}`);
  fal.config({ credentials: falKey });

  await runJobs(todo, dir, manifest);
  writeSheet(dir, sheet, jobs, manifest, args.style);
  const failed = todo.filter((j) => manifest[j.file]?.error).length;
  console.error(`[done] ${todo.length - failed} drawn, ${failed} failed. Sheet: ${join(dir, "index.html")}`);
}

// ---------------------------------------------------------------------------
// THE SHEET
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MODE_LABEL: Record<GuideMode, string> = { marks: "Guide with marks", plain: "Guide, no marks", none: "No guide" };

/** Image cells are filled in at write time from the manifest; this leaves a token per cell. */
const cellToken = (file: string) => `<!--cell:${file}-->`;

function overlay(p: RoomIllustration | undefined): string {
  if (!p) return "";
  return `<svg class="buttons" viewBox="0 0 480 320" preserveAspectRatio="none">${hotspotMarks(p, 480, 320)}</svg>`;
}

function grid(subject: string, setups: Setup[], modes: GuideMode[], p?: RoomIllustration): string {
  const head = modes.map((m) => `<th>${MODE_LABEL[m]}</th>`).join("");
  const rows = setups
    .map((s) => {
      const cells = modes
        .map((m) => (s.modes.includes(m) || (!p && m === "none") ? `<td>${cellToken(`${subject}/${s.id}-${m}.png`)}${overlay(p)}</td>` : `<td class="na">—</td>`))
        .join("");
      return `<tr><th class="setup">${esc(s.label)}</th>${cells}</tr>`;
    })
    .join("");
  return `<table class="grid"><tr><th></th>${head}</tr>${rows}</table>`;
}

function interiorSection(b: Bound, visual: IllustrationVisual, setting: string, prompts: Record<GuideMode, string>, setups: Setup[]): string {
  const s = b.subject;
  const v = s.vibe;
  return `
<section id="${s.id}">
  <h2>${s.id} · ${esc(s.title)} <small>${esc(s.tests)}</small></h2>
  <p class="meta">${[v.walls, v.condition, v.moisture, v.life].map((x) => `<span class="chip">${esc(x)}</span>`).join("")}
    bound to ${esc(b.from)} · ${b.illustration.input.floor.length} cells · standing ${esc(b.illustration.view.standing)}, facing ${b.illustration.view.facing}</p>
  <div class="top">
    <figure><img src="${s.id}/guide-marks.png"><figcaption>Guide with marks</figcaption></figure>
    <figure><img src="${s.id}/guide-plain.png"><figcaption>Guide, no marks</figcaption></figure>
    <div class="words">
      <p><b>Setting</b> ${esc(setting)}</p>
      <p><b>Room</b> ${esc(visual.room)}</p>
      <ul>${Object.entries(visual.looks).map(([k, l]) => `<li><b>${esc(k)}</b> ${esc(l)}</li>`).join("")}</ul>
      <details><summary>Prompt (marks)</summary><pre>${esc(prompts.marks)}</pre></details>
      <details><summary>Brief, with what was left out</summary><pre>${esc(illustrationBrief(b.illustration))}</pre></details>
      <details><summary>Written fiction</summary><p>${esc(s.room.base)}</p>${[...s.exits, ...(s.wayOut ? [s.wayOut] : []), ...s.features]
        .map((x) => `<p><b>${esc(x.name)}</b> ${esc(x.base)}</p>`)
        .join("")}</details>
    </div>
  </div>
  ${grid(s.id, setups, ["marks", "plain", "none"], b.illustration)}
</section>`;
}

function refsSection(ids: string[]): string {
  return `
<section id="refs">
  <h2>Style references <small>each subject gets all of these but its own</small></h2>
  <div class="refs">${ids.map((id) => `<figure><img src="refs/${id}.png"><figcaption>${id} · klein, no guide</figcaption></figure>`).join("")}</div>
</section>`;
}

function exteriorSection(id: string, title: string, description: string, scene: string, prompt: string, setups: Setup[]): string {
  return `
<section id="${id}">
  <h2>${id} · ${esc(title)} <small>exterior, prompt only</small></h2>
  <div class="words wide">
    <p><b>Scene</b> ${esc(scene)}</p>
    <details><summary>Prompt</summary><pre>${esc(prompt)}</pre></details>
    <details><summary>Written fiction</summary><p>${esc(description)}</p></details>
  </div>
  ${grid(id, setups, ["none"])}
</section>`;
}

function writeSheet(dir: string, sections: string[], jobs: Job[], manifest: Record<string, Result>, styleName: string): void {
  let body = sections.join("\n");
  let spent = 0;
  for (const j of jobs) {
    const r = manifest[j.file];
    const bw = j.file.replace(/\.png$/, ".1bit.png");
    let cell: string;
    if (r?.error) cell = `<div class="err">${esc(r.error)}</div>`;
    else if (existsSync(join(dir, j.file))) {
      spent += r?.usd ?? 0;
      const meta = r ? `${Math.round((r.ms ?? 0) / 1000)}s · ~$${(r.usd ?? 0).toFixed(3)}` : "";
      cell = `<a href="${j.file}" target="_blank"><img class="bw" src="${bw}"><img class="raw" src="${j.file}"></a><div class="cost">${meta}</div>`;
    } else cell = `<div class="pending">not drawn yet</div>`;
    body = body.replace(cellToken(j.file), cell);
  }
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Illustration spike, style ${styleName}</title>
<style>
  body { font: 14px/1.45 Georgia, serif; background: #F6F2E8; color: #22201C; margin: 20px; }
  h1 { font-size: 22px; margin: 0 0 6px; } h2 { font-size: 17px; margin: 28px 0 4px; } h2 small { font-weight: normal; color: #6b655a; font-size: 13px; }
  .controls { position: sticky; top: 0; background: #F6F2E8; padding: 8px 0; border-bottom: 1px solid #d6cfbf; z-index: 2; }
  .meta { color: #6b655a; font-size: 12px; margin: 0 0 8px; } .chip { background: #e9e2d2; border-radius: 3px; padding: 1px 6px; margin-right: 4px; color: #22201C; }
  .top { display: grid; grid-template-columns: 300px 300px 1fr; gap: 14px; align-items: start; }
  .top img { width: 100%; border: 1px solid #d6cfbf; background: #fff; }
  .refs { display: flex; gap: 10px; } .refs img { width: 300px; border: 1px solid #d6cfbf; } figure { margin: 0; } figcaption { font-size: 12px; color: #6b655a; }
  .words p { margin: 0 0 6px; } .words ul { margin: 0 0 6px; padding-left: 18px; } .words.wide { max-width: 900px; }
  pre { white-space: pre-wrap; font-size: 12px; background: #fff; padding: 8px; border: 1px solid #e0d9c9; }
  table.grid { border-collapse: collapse; margin-top: 10px; }
  table.grid th { font-weight: normal; color: #6b655a; font-size: 12px; text-align: left; padding: 2px 6px; }
  table.grid th.setup { width: 120px; vertical-align: top; padding-top: 8px; color: #22201C; }
  table.grid td { position: relative; width: 384px; padding: 4px; vertical-align: top; }
  table.grid td img { width: 384px; height: 256px; object-fit: contain; display: block; background: #fff; border: 1px solid #d6cfbf; }
  td svg.buttons { position: absolute; left: 4px; top: 4px; width: 386px; height: 258px; pointer-events: none; display: none; }
  td.na { color: #b9b1a2; text-align: center; vertical-align: middle; }
  .cost { font-size: 11px; color: #6b655a; } .err { font-size: 11px; color: #a3311b; width: 384px; word-break: break-word; } .pending { width: 384px; height: 256px; border: 1px dashed #d6cfbf; color: #b9b1a2; display: flex; align-items: center; justify-content: center; }
  table.grid td img.raw { display: none; }
  body:has(#show-raw:checked) table.grid td img.raw { display: block; } body:has(#show-raw:checked) table.grid td img.bw { display: none; }
  body:has(#show-buttons:checked) td svg.buttons { display: block; }
</style></head><body>
<h1>Room illustration spike — style: ${styleName}</h1>
<p class="meta">${esc(STYLES[styleName])}</p>
<div class="controls">
  <label><input type="checkbox" id="show-raw"> Show raw output (default: converted to 1-bit at ${ILLUSTRATION_THRESHOLD})</label>
  &nbsp; <label><input type="checkbox" id="show-buttons"> Show the page's buttons</label>
  &nbsp; <span class="meta">${jobs.length} images · ~$${spent.toFixed(2)} spent so far (estimate) · click an image for full size</span>
</div>
${body}
</body></html>`;
  writeFileSync(join(dir, "index.html"), html);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
