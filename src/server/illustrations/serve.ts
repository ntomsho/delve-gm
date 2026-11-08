/**
 * ROOM ILLUSTRATIONS — drawing one, once
 * ===============================
 *
 * What `GET /api/runs/:id/illustrations/:roomId` does once the route has checked the
 * run and found the way in (ARCHITECTURE §10.3):
 *
 *   1. build the illustration from the dungeon as GENERATED (`roomIllustration`), and its key
 *   2. ready      → the URL
 *      pending    → "ask again", unless the claim is stale
 *      missing    → claim it, draw it, store it, return the URL
 *      failed     → claim it again while attempts are left; past that, none
 *
 * THE KEY IS A HASH OF WHAT THE ILLUSTRATION IS DRAWN FROM, not of the final prompt.
 * The final prompt carries words Haiku wrote, and Haiku does not answer twice
 * the same way, so a key made from it would never be found again. Everything
 * hashed here is a pure function of the generated dungeon and of code: the
 * requests Haiku is sent, the layout and positions, the guide, the style, the
 * model and the references. A copy of the dungeon builds the same key.
 *
 * Four paid calls in one request — the setting line (once per dungeon, then
 * kept in `plate_words`), the room's words, the image, and Haiku moving the
 * buttons onto what the image shows — against the API's usual one. All four
 * together run about 30 s, well inside `maxDuration`.
 *
 * THE BUTTONS. Haiku's corrected buttons are kept in `plate_words` under
 * `spotsKey(key)`, written only by the request that drew the picture, so they
 * always belong to the picture stored under that key. A picture with none —
 * drawn before placement existed, or whose placement failed — gets the
 * geometry's buttons, as every picture did before.
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
  exteriorIllustrationPrompt,
  ILLUSTRATION_STYLE_VERSION,
  illustrationSettingMessage,
  illustrationVisualMessage,
} from "../../illustrations/prompt.ts";
import {
  ILLUSTRATION_EXTERIOR_SYSTEM,
  ILLUSTRATION_SETTING_SYSTEM,
  ILLUSTRATION_VISUAL_SYSTEM,
} from "../../prompts/loader.ts";
import type { GeneratedDungeon } from "../../generation/generate.ts";
import { COVER_MODEL, IMAGE_MODELS, ILLUSTRATION_MODEL } from "../../llm/models.ts";
import { illustrationSketchSvg } from "../../illustrations/sketch.ts";
import {
  illustrationImagePrompt,
  rawVisual,
  requestIllustrationExterior,
  requestIllustrationSetting,
  requestIllustrationVisual,
  visualSubjects,
  type IllustrationVisual,
} from "../../illustrations/visual.ts";
import {
  coverDescription,
  illustrationSpots,
  roomIllustration,
  type IllustrationAnswer,
  type IllustrationSpot,
  type RoomIllustration,
} from "../../illustrations/room-illustration.ts";
import { requestButtonPlacement } from "../../illustrations/button-placement.ts";
import * as repo from "../db/repo.ts";
import { guidePng, inkPng, placementJpeg, ILLUSTRATION_H, ILLUSTRATION_W } from "./image.ts";
import { beforeImage, mayStart, recordImage } from "../spend.ts";

/** An illustration is tried this many times in all, across every run that asks. */
export const ILLUSTRATION_MAX_ATTEMPTS = 3;
/** A `pending` claim this old is taken to be a request that died; the next asker draws it. */
export const ILLUSTRATION_CLAIM_STALE_MS = 3 * 60_000;
/** GPT Image 2's quality setting. The spike found medium no better than low, at four times the price. */
export const ILLUSTRATION_QUALITY = "low";
/** The style references, sent after the guide. Bundled with the function — see `vercel.json`. */
export const ILLUSTRATION_REFS_DIR = "assets/illustration-refs";

export type { IllustrationAnswer };

/** Where an illustration's words and pixels come from. The real ones are `liveIllustrationWork`; tests pass fakes. */
export interface IllustrationWork {
  setting(theme: string): Promise<string>;
  visual(p: RoomIllustration): Promise<IllustrationVisual>;
  /** the picture, from the prompt and the guide; the references are the worker's own */
  draw(prompt: string, guide: Buffer): Promise<Buffer>;
  /**
   * The buttons moved onto the things as `picture` shows them
   * (`button-placement.ts`). Absent: the geometry's buttons are kept.
   */
  place?(p: RoomIllustration, spots: IllustrationSpot[], picture: Buffer): Promise<IllustrationSpot[]>;
  /** store the finished image at `path` in the bucket: a PNG unless `contentType` says otherwise */
  upload(path: string, png: Buffer, contentType?: string): Promise<void>;
  /** the public URL of a stored path */
  urlOf(path: string): string;
  /** how many style references `draw` sends, which the prompt has to say */
  references: number;
  /** the cover's words: the place and its way in, from outside */
  scene(description: string): Promise<string>;
  /** the cover's picture, from the prompt alone */
  drawScene(prompt: string, seed: number): Promise<Buffer>;
  /**
   * Whether a picture nobody has drawn may be drawn now: false once the day's
   * budget is spent (`spend.ts`). Absent is yes, which is what tests want.
   */
  mayDraw?(): Promise<boolean>;
}

/** The statements, as `repo.ts` has them; a parameter so tests need no database. */
export type IllustrationStore = Pick<
  typeof repo,
  "getIllustration" | "claimIllustration" | "finishIllustration" | "failIllustration" | "getIllustrationWords" | "saveIllustrationWords"
>;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The key of the setting line a dungeon's illustrations share. */
export const settingKey = (theme: string) => `setting:${sha(ILLUSTRATION_SETTING_SYSTEM + "\n" + illustrationSettingMessage(theme))}`;

/** What an illustration is drawn from, hashed. See the header for why not the prompt. */
export function illustrationKey(p: RoomIllustration, theme: string, references: number): string {
  const { subjects } = visualSubjects(p);
  return sha(
    JSON.stringify({
      style: ILLUSTRATION_STYLE_VERSION,
      model: `${IMAGE_MODELS[ILLUSTRATION_MODEL].guided} ${ILLUSTRATION_QUALITY} ${ILLUSTRATION_W}x${ILLUSTRATION_H}`,
      references,
      setting: settingKey(theme),
      visual: ILLUSTRATION_VISUAL_SYSTEM + "\n" + illustrationVisualMessage(p.roomName, p.roomBase, subjects),
      // The layout half of the prompt, with the fiction uncut standing in for
      // the words: every position, tag and the style text, and nothing Haiku wrote.
      layout: illustrationImagePrompt(p, "marks", "", rawVisual(p), undefined, references),
      guide: illustrationSketchSvg(p, { marks: true }),
    })
  );
}

export async function serveIllustration(
  d: GeneratedDungeon,
  roomId: string,
  entryId: string,
  work: IllustrationWork,
  store: IllustrationStore = repo
): Promise<IllustrationAnswer> {
  const p = roomIllustration(d, roomId, entryId);
  if (!p) return { status: "none" };
  const theme = d.pass.theme;
  const key = illustrationKey(p, theme, work.references);
  // Where the guide put each thing: the buttons until Haiku has seen the picture.
  const geometry = illustrationSpots(p);
  // Set only when this request draws the picture.
  let placed: IllustrationSpot[] | undefined;
  const answer = await serveKeyed(key, ILLUSTRATION_MODEL, p.roomName, work, store, async () => {
    const sKey = settingKey(theme);
    const setting = (await store.getIllustrationWords(sKey)) ?? (await store.saveIllustrationWords(sKey, await work.setting(theme)));
    const visual = await work.visual(p);
    const prompt = illustrationImagePrompt(p, "marks", setting, visual, undefined, work.references);
    const picture = await work.draw(prompt, await guidePng(p, true));
    placed = await placeButtons(p, geometry, picture, work, key);
    return picture;
  });
  if (answer.status !== "ready") return answer;
  if (placed) {
    // After the picture is stored, so a picture that failed to store leaves no buttons behind.
    await store.saveIllustrationWords(spotsKey(key), JSON.stringify(placed)).catch((e) =>
      console.error(`[illustration] saving buttons (${key.slice(0, 12)}) failed`, e)
    );
  }
  return { ...answer, spots: placed ?? (await savedSpots(store, key)) ?? geometry };
}

/** Where an illustration's corrected buttons are kept in `plate_words`. */
export const spotsKey = (key: string) => `spots:${key}`;

/** Haiku's buttons for a fresh picture; undefined, and logged, when it fails. A failure costs the buttons, never the picture. */
async function placeButtons(
  p: RoomIllustration,
  spots: IllustrationSpot[],
  picture: Buffer,
  work: Pick<IllustrationWork, "place">,
  key: string
): Promise<IllustrationSpot[] | undefined> {
  if (!work.place || !spots.some((s) => s.how === "shown")) return undefined;
  try {
    return await work.place(p, spots, picture);
  } catch (e) {
    console.error(`[illustration] placing buttons (${key.slice(0, 12)}) failed: ${(e as Error).message}`);
    return undefined;
  }
}

async function savedSpots(store: IllustrationStore, key: string): Promise<IllustrationSpot[] | undefined> {
  const raw = await store.getIllustrationWords(spotsKey(key));
  if (!raw) return undefined;
  try {
    const spots = JSON.parse(raw);
    return Array.isArray(spots) ? spots : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// THE COVER
// ---------------------------------------------------------------------------

/**
 * The dungeon from outside: the cover on its library card and above its
 * opening. Klein, prompt only, sparse style — the spike's exterior setup.
 *
 * Keyed like an illustration, by what it is drawn from. The key is written onto the
 * dungeon row (`dungeons.cover`) when the dungeon is finished; a dungeon with
 * no key has no cover and never gets one drawn.
 */
export function coverKey(d: GeneratedDungeon): string | undefined {
  const description = coverDescription(d);
  if (!description) return undefined;
  return sha(
    JSON.stringify({
      style: ILLUSTRATION_STYLE_VERSION,
      model: `${IMAGE_MODELS[COVER_MODEL].unguided} ${ILLUSTRATION_W}x${ILLUSTRATION_H}`,
      seed: d.seeds.dungeonSeed,
      scene: ILLUSTRATION_EXTERIOR_SYSTEM + "\n" + description,
      prompt: exteriorIllustrationPrompt({ scene: "" }),
    })
  );
}

export async function serveCover(
  d: GeneratedDungeon,
  key: string,
  work: IllustrationWork,
  store: IllustrationStore = repo
): Promise<IllustrationAnswer> {
  const description = coverDescription(d);
  if (!description) return { status: "none" };
  return serveKeyed(key, COVER_MODEL, `${d.pass.name} (cover)`, work, store, async () => {
    const scene = await work.scene(description);
    return work.drawScene(exteriorIllustrationPrompt({ scene }), d.seeds.dungeonSeed);
  });
}

/**
 * The claim, the draw and the store, for anything kept in `plates`: room
 * illustrations, covers, and creature sprites (`src/server/illustrations/sprites.ts`).
 *
 *   ready    → the URL
 *   pending  → "ask again", unless the claim is stale
 *   missing  → claim it, draw it, store it, return the URL
 *   failed   → claim it again while attempts are left; past that, none
 *
 * Missing or failed on a day whose budget is spent is none, unclaimed.
 */
export async function serveKeyed(
  key: string,
  model: string,
  label: string,
  work: Pick<IllustrationWork, "upload" | "urlOf" | "mayDraw">,
  store: IllustrationStore,
  make: () => Promise<Buffer>,
  /** the model's picture as stored: an illustration's ink by default; a sprite's masks */
  finish: (picture: Buffer) => Promise<Buffer> = inkPng
): Promise<IllustrationAnswer> {
  const row = await store.getIllustration(key);
  if (row?.status === "ready" && row.path) return { status: "ready", url: work.urlOf(row.path) };
  if (row?.status === "pending" && row.ageMs < ILLUSTRATION_CLAIM_STALE_MS) return { status: "pending" };
  if (row?.status === "failed" && row.attempts >= ILLUSTRATION_MAX_ATTEMPTS) return { status: "none" };
  // Before the claim, so a closed day costs the picture none of its attempts.
  if (work.mayDraw && !(await work.mayDraw())) return { status: "none" };

  const mine = await store.claimIllustration(key, model, {
    staleMs: ILLUSTRATION_CLAIM_STALE_MS,
    maxAttempts: ILLUSTRATION_MAX_ATTEMPTS,
  });
  if (!mine) {
    // Somebody else's claim landed between the read and this. Say whatever it is now.
    const now = await store.getIllustration(key);
    if (now?.status === "ready" && now.path) return { status: "ready", url: work.urlOf(now.path) };
    return now?.status === "pending" ? { status: "pending" } : { status: "none" };
  }

  try {
    const picture = await make();
    const path = `${key}.png`;
    await work.upload(path, await finish(picture));
    await store.finishIllustration(key, path);
    return { status: "ready", url: work.urlOf(path) };
  } catch (e) {
    const body = (e as { body?: unknown }).body;
    const why = `${(e as Error).message}${body ? ` ${JSON.stringify(body).slice(0, 400)}` : ""}`;
    console.error(`[illustration] ${label} (${key.slice(0, 12)}) failed: ${why}`);
    await store.failIllustration(key, why);
    return { status: "none" };
  }
}

// ---------------------------------------------------------------------------
// THE REAL THING
// ---------------------------------------------------------------------------

/**
 * The live worker, or undefined when the server is not set up to draw — no
 * `FAL_KEY`, or no service-role key to store with. Then every room simply has
 * no illustration, which is also the off switch.
 */
export function liveIllustrationWork(): IllustrationWork | undefined {
  const falKey = process.env.FAL_KEY;
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!falKey || !supabaseUrl || !serviceKey) return undefined;
  fal.config({ credentials: falKey });

  const dir = resolve(process.cwd(), ILLUSTRATION_REFS_DIR);
  const refFiles = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  // Uploaded to fal once per process, not once per illustration.
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
    setting: async (theme) => (await requestIllustrationSetting(theme)).value,
    visual: async (p) => (await requestIllustrationVisual(p)).value,
    async place(p, spots, picture) {
      const jpeg = (await placementJpeg(picture)).toString("base64");
      return (await requestButtonPlacement(p, spots, jpeg, { width: ILLUSTRATION_W, height: ILLUSTRATION_H })).value;
    },
    mayDraw: mayStart,
    async draw(prompt, guide) {
      await beforeImage();
      const guideUrl = await fal.storage.upload(new Blob([new Uint8Array(guide)], { type: "image/png" }));
      const res = await fal.subscribe(IMAGE_MODELS[ILLUSTRATION_MODEL].guided, {
        input: {
          prompt,
          quality: ILLUSTRATION_QUALITY,
          image_size: { width: ILLUSTRATION_W, height: ILLUSTRATION_H },
          output_format: "png",
          image_urls: [guideUrl, ...(await refs())],
        },
      });
      await recordImage("illustration", ILLUSTRATION_MODEL);
      return fetchImage(res.data);
    },
    scene: async (description) => (await requestIllustrationExterior(description)).value,
    async drawScene(prompt, seed) {
      const endpoint = IMAGE_MODELS[COVER_MODEL].unguided;
      if (!endpoint) throw new Error(`${COVER_MODEL} has no prompt-only endpoint`);
      await beforeImage();
      const res = await fal.subscribe(endpoint, {
        input: { prompt, image_size: { width: ILLUSTRATION_W, height: ILLUSTRATION_H }, seed, output_format: "png" },
      });
      await recordImage("cover", COVER_MODEL);
      return fetchImage(res.data);
    },
    async upload(path, png, contentType = "image/png") {
      const res = await fetch(`${supabaseUrl}/storage/v1/object/plates/${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
          "content-type": contentType,
          // The key changes whenever the picture would, so a file never does.
          "cache-control": "max-age=31536000, immutable",
          "x-upsert": "true",
        },
        body: new Uint8Array(png),
      });
      if (!res.ok) throw new Error(`storing the illustration failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    },
    urlOf: (path) => illustrationUrl(path)!,
  };
}

/** The image a fal endpoint answered with. */
export async function fetchImage(data: unknown): Promise<Buffer> {
  const url = (data as { images?: { url: string }[] }).images?.[0]?.url;
  if (!url) throw new Error(`no image in the response: ${JSON.stringify(data).slice(0, 300)}`);
  const got = await fetch(url);
  if (!got.ok) throw new Error(`fetching the image failed (${got.status})`);
  return Buffer.from(await got.arrayBuffer());
}

/** The public URL of a stored illustration or cover, or undefined when Storage is not configured. */
export function illustrationUrl(path: string): string | undefined {
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  return base ? `${base}/storage/v1/object/public/plates/${path}` : undefined;
}
