/**
 * ROOM PLATES — drawing one, once
 * ===============================
 *
 * What `GET /api/runs/:id/plates/:roomId` does once the route has checked the
 * run and found the way in (BUILD-PLAN, *Illustrations*, "Storage"):
 *
 *   1. build the plate from the dungeon as GENERATED (`roomPlate`), and its key
 *   2. ready      → the URL
 *      pending    → "ask again", unless the claim is stale
 *      missing    → claim it, draw it, store it, return the URL
 *      failed     → claim it again while attempts are left; past that, none
 *
 * THE KEY IS A HASH OF WHAT THE PLATE IS DRAWN FROM, not of the final prompt.
 * The final prompt carries words Haiku wrote, and Haiku does not answer twice
 * the same way, so a key made from it would never be found again. Everything
 * hashed here is a pure function of the generated dungeon and of code: the
 * requests Haiku is sent, the layout and positions, the guide, the style, the
 * model and the references. A copy of the dungeon builds the same key.
 *
 * Three paid calls in one request — the setting line (once per dungeon, then
 * kept in `plate_words`), the room's words, and the image — against the API's
 * usual one. All three together run about 25 s, well inside `maxDuration`.
 *
 * A failure is a missing picture, never an error: the answer is `none` and the
 * page closes the space it held.
 *
 * Node only.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fal } from "@fal-ai/client";
import {
  exteriorPlatePrompt,
  PLATE_EXTERIOR_SYSTEM,
  PLATE_SETTING_SYSTEM,
  PLATE_STYLE_VERSION,
  PLATE_VISUAL_SYSTEM,
  plateSettingMessage,
  plateVisualMessage,
} from "../engine/index.ts";
import type { GeneratedDungeon } from "../runtime/generate.ts";
import { COVER_MODEL, IMAGE_MODELS, PLATE_MODEL } from "../runtime/llm/models.ts";
import { plateSketchSvg } from "../runtime/plate-sketch.ts";
import {
  plateImagePrompt,
  rawVisual,
  requestPlateExterior,
  requestPlateSetting,
  requestPlateVisual,
  visualSubjects,
  type PlateVisual,
} from "../runtime/plate-visual.ts";
import { coverDescription, roomPlate, type PlateAnswer, type RoomPlate } from "../runtime/plates.ts";
import * as repo from "./repo.ts";
import { guidePng, inkPng, PLATE_H, PLATE_W } from "./plate-image.ts";

/** A plate is tried this many times in all, across every run that asks. */
export const PLATE_MAX_ATTEMPTS = 3;
/** A `pending` claim this old is taken to be a request that died; the next asker draws it. */
export const PLATE_CLAIM_STALE_MS = 3 * 60_000;
/** GPT Image 2's quality setting. The spike found medium no better than low, at four times the price. */
export const PLATE_QUALITY = "low";
/** The style references, sent after the guide. Bundled with the function — see `vercel.json`. */
export const PLATE_REFS_DIR = "assets/plate-refs";

export type { PlateAnswer };

/** Where a plate's words and pixels come from. The real ones are `livePlateWork`; tests pass fakes. */
export interface PlateWork {
  setting(theme: string): Promise<string>;
  visual(p: RoomPlate): Promise<PlateVisual>;
  /** the picture, from the prompt and the guide; the references are the worker's own */
  draw(prompt: string, guide: Buffer): Promise<Buffer>;
  /** store the finished PNG at `path` in the bucket */
  upload(path: string, png: Buffer): Promise<void>;
  /** the public URL of a stored path */
  urlOf(path: string): string;
  /** how many style references `draw` sends, which the prompt has to say */
  references: number;
  /** the cover's words: the place and its way in, from outside */
  scene(description: string): Promise<string>;
  /** the cover's picture, from the prompt alone */
  drawScene(prompt: string, seed: number): Promise<Buffer>;
}

/** The statements, as `repo.ts` has them; a parameter so tests need no database. */
export type PlateStore = Pick<
  typeof repo,
  "getPlate" | "claimPlate" | "finishPlate" | "failPlate" | "getPlateWords" | "savePlateWords"
>;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The key of the setting line a dungeon's plates share. */
export const settingKey = (theme: string) => `setting:${sha(PLATE_SETTING_SYSTEM + "\n" + plateSettingMessage(theme))}`;

/** What a plate is drawn from, hashed. See the header for why not the prompt. */
export function plateKey(p: RoomPlate, theme: string, references: number): string {
  const { subjects } = visualSubjects(p);
  return sha(
    JSON.stringify({
      style: PLATE_STYLE_VERSION,
      model: `${IMAGE_MODELS[PLATE_MODEL].guided} ${PLATE_QUALITY} ${PLATE_W}x${PLATE_H}`,
      references,
      setting: settingKey(theme),
      visual: PLATE_VISUAL_SYSTEM + "\n" + plateVisualMessage(p.roomName, p.roomBase, subjects),
      // The layout half of the prompt, with the fiction uncut standing in for
      // the words: every position, tag and the style text, and nothing Haiku wrote.
      layout: plateImagePrompt(p, "marks", "", rawVisual(p), undefined, references),
      guide: plateSketchSvg(p, { marks: true }),
    })
  );
}

export async function servePlate(
  d: GeneratedDungeon,
  roomId: string,
  entryId: string,
  work: PlateWork,
  store: PlateStore = repo
): Promise<PlateAnswer> {
  const p = roomPlate(d, roomId, entryId);
  if (!p) return { status: "none" };
  const theme = d.pass.theme;
  return serveKeyed(plateKey(p, theme, work.references), PLATE_MODEL, p.roomName, work, store, async () => {
    const sKey = settingKey(theme);
    const setting = (await store.getPlateWords(sKey)) ?? (await store.savePlateWords(sKey, await work.setting(theme)));
    const visual = await work.visual(p);
    const prompt = plateImagePrompt(p, "marks", setting, visual, undefined, work.references);
    return work.draw(prompt, await guidePng(p, true));
  });
}

// ---------------------------------------------------------------------------
// THE COVER
// ---------------------------------------------------------------------------

/**
 * The dungeon from outside: the cover on its library card and above its
 * opening. Klein, prompt only, sparse style — the spike's exterior setup.
 *
 * Keyed like a plate, by what it is drawn from. The key is written onto the
 * dungeon row (`dungeons.cover`) when the dungeon is finished; a dungeon with
 * no key has no cover and never gets one drawn.
 */
export function coverKey(d: GeneratedDungeon): string | undefined {
  const description = coverDescription(d);
  if (!description) return undefined;
  return sha(
    JSON.stringify({
      style: PLATE_STYLE_VERSION,
      model: `${IMAGE_MODELS[COVER_MODEL].unguided} ${PLATE_W}x${PLATE_H}`,
      seed: d.seeds.dungeonSeed,
      scene: PLATE_EXTERIOR_SYSTEM + "\n" + description,
      prompt: exteriorPlatePrompt({ scene: "" }),
    })
  );
}

export async function serveCover(
  d: GeneratedDungeon,
  key: string,
  work: PlateWork,
  store: PlateStore = repo
): Promise<PlateAnswer> {
  const description = coverDescription(d);
  if (!description) return { status: "none" };
  return serveKeyed(key, COVER_MODEL, `${d.pass.name} (cover)`, work, store, async () => {
    const scene = await work.scene(description);
    return work.drawScene(exteriorPlatePrompt({ scene }), d.seeds.dungeonSeed);
  });
}

/**
 * The claim, the draw and the store, for anything kept in `plates`.
 *
 *   ready    → the URL
 *   pending  → "ask again", unless the claim is stale
 *   missing  → claim it, draw it, store it, return the URL
 *   failed   → claim it again while attempts are left; past that, none
 */
async function serveKeyed(
  key: string,
  model: string,
  label: string,
  work: PlateWork,
  store: PlateStore,
  make: () => Promise<Buffer>
): Promise<PlateAnswer> {
  const row = await store.getPlate(key);
  if (row?.status === "ready" && row.path) return { status: "ready", url: work.urlOf(row.path) };
  if (row?.status === "pending" && row.ageMs < PLATE_CLAIM_STALE_MS) return { status: "pending" };
  if (row?.status === "failed" && row.attempts >= PLATE_MAX_ATTEMPTS) return { status: "none" };

  const mine = await store.claimPlate(key, model, {
    staleMs: PLATE_CLAIM_STALE_MS,
    maxAttempts: PLATE_MAX_ATTEMPTS,
  });
  if (!mine) {
    // Somebody else's claim landed between the read and this. Say whatever it is now.
    const now = await store.getPlate(key);
    if (now?.status === "ready" && now.path) return { status: "ready", url: work.urlOf(now.path) };
    return now?.status === "pending" ? { status: "pending" } : { status: "none" };
  }

  try {
    const picture = await make();
    const path = `${key}.png`;
    await work.upload(path, await inkPng(picture));
    await store.finishPlate(key, path);
    return { status: "ready", url: work.urlOf(path) };
  } catch (e) {
    const body = (e as { body?: unknown }).body;
    const why = `${(e as Error).message}${body ? ` ${JSON.stringify(body).slice(0, 400)}` : ""}`;
    console.error(`[plate] ${label} (${key.slice(0, 12)}) failed: ${why}`);
    await store.failPlate(key, why);
    return { status: "none" };
  }
}

// ---------------------------------------------------------------------------
// THE REAL THING
// ---------------------------------------------------------------------------

/**
 * The live worker, or undefined when the server is not set up to draw — no
 * `FAL_KEY`, or no service-role key to store with. Then every room simply has
 * no plate, which is also the off switch.
 */
export function livePlateWork(): PlateWork | undefined {
  const falKey = process.env.FAL_KEY;
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!falKey || !supabaseUrl || !serviceKey) return undefined;
  fal.config({ credentials: falKey });

  const dir = resolve(process.cwd(), PLATE_REFS_DIR);
  const refFiles = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  // Uploaded to fal once per process, not once per plate.
  let refUrls: Promise<string[]> | undefined;
  const refs = () =>
    (refUrls ??= Promise.all(
      refFiles.map((f) => fal.storage.upload(new Blob([readFileSync(resolve(dir, f))], { type: "image/png" })))
    ).catch((e) => {
      refUrls = undefined;
      throw e;
    }));

  return {
    references: refFiles.length,
    setting: async (theme) => (await requestPlateSetting(theme)).value,
    visual: async (p) => (await requestPlateVisual(p)).value,
    async draw(prompt, guide) {
      const guideUrl = await fal.storage.upload(new Blob([new Uint8Array(guide)], { type: "image/png" }));
      const res = await fal.subscribe(IMAGE_MODELS[PLATE_MODEL].guided, {
        input: {
          prompt,
          quality: PLATE_QUALITY,
          image_size: { width: PLATE_W, height: PLATE_H },
          output_format: "png",
          image_urls: [guideUrl, ...(await refs())],
        },
      });
      return fetchImage(res.data);
    },
    scene: async (description) => (await requestPlateExterior(description)).value,
    async drawScene(prompt, seed) {
      const endpoint = IMAGE_MODELS[COVER_MODEL].unguided;
      if (!endpoint) throw new Error(`${COVER_MODEL} has no prompt-only endpoint`);
      const res = await fal.subscribe(endpoint, {
        input: { prompt, image_size: { width: PLATE_W, height: PLATE_H }, seed, output_format: "png" },
      });
      return fetchImage(res.data);
    },
    async upload(path, png) {
      const res = await fetch(`${supabaseUrl}/storage/v1/object/plates/${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
          "content-type": "image/png",
          // The key changes whenever the picture would, so a file never does.
          "cache-control": "max-age=31536000, immutable",
          "x-upsert": "true",
        },
        body: new Uint8Array(png),
      });
      if (!res.ok) throw new Error(`storing the plate failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    },
    urlOf: (path) => plateUrl(path)!,
  };
}

/** The image a fal endpoint answered with. */
async function fetchImage(data: unknown): Promise<Buffer> {
  const url = (data as { images?: { url: string }[] }).images?.[0]?.url;
  if (!url) throw new Error(`no image in the response: ${JSON.stringify(data).slice(0, 300)}`);
  const got = await fetch(url);
  if (!got.ok) throw new Error(`fetching the image failed (${got.status})`);
  return Buffer.from(await got.arrayBuffer());
}

/** The public URL of a stored plate or cover, or undefined when Storage is not configured. */
export function plateUrl(path: string): string | undefined {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  return base ? `${base}/storage/v1/object/public/plates/${path}` : undefined;
}
