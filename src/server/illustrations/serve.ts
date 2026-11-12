/**
 * ROOM ILLUSTRATIONS AND COVERS — drawing one, once
 * =================================================
 *
 * What `GET /api/runs/:id/illustrations/:roomId` and `/cover` do once the route
 * has checked the run (ARCHITECTURE §10.3). Every picture is an `assets` row
 * found by what it shows — `(artRoot, kind, subject)` — never by its prompt:
 *
 *   ready    → the URL
 *   pending  → "ask again", unless the claim is stale
 *   missing  → claim it, draw it, store it, return the URL
 *   failed   → claim it again while attempts are left; past that, none
 *   redraw   → marked by `npm run redraw`: claim it and draw it again; the old
 *              picture stays until the new one is stored, and stays for good
 *              if the redraw fails
 *
 * NOTHING IS REDRAWN BECAUSE THE CODE CHANGED. A prompt, guide or style edit
 * affects pictures not drawn yet; redrawing old ones is a decision someone
 * makes with `src/dev/redraw.ts`.
 *
 * A ROOM HAS ONE PICTURE, drawn from `illustrationDoor`. Four paid calls the
 * first time — the setting line (once per theme, then kept in `plate_words`),
 * the room's words, the image, and Haiku moving the buttons onto what the
 * image shows — about 30 s, well inside `maxDuration`. The placed buttons and
 * the door are kept on the row (`meta`), so they always belong to the picture
 * stored there. A picture whose placement failed gets the geometry's buttons.
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
import { exteriorIllustrationPrompt, illustrationSettingMessage } from "../../illustrations/prompt.ts";
import { ILLUSTRATION_SETTING_SYSTEM } from "../../prompts/loader.ts";
import type { GeneratedDungeon } from "../../generation/generate.ts";
import { COVER_MODEL, IMAGE_MODELS, ILLUSTRATION_MODEL } from "../../llm/models.ts";
import {
  illustrationImagePrompt,
  requestIllustrationExterior,
  requestIllustrationSetting,
  requestIllustrationVisual,
  type IllustrationVisual,
} from "../../illustrations/visual.ts";
import {
  coverDescription,
  illustrationDoor,
  illustrationSpots,
  roomIllustration,
  type IllustrationAnswer,
  type IllustrationSpot,
  type RoomIllustration,
} from "../../illustrations/room-illustration.ts";
import { requestButtonPlacement } from "../../illustrations/button-placement.ts";
import * as repo from "../db/repo.ts";
import type { AssetRef, AssetRow } from "../db/repo.ts";
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
  "getAsset" | "claimAsset" | "finishAsset" | "failAsset" | "getIllustrationWords" | "saveIllustrationWords"
>;

/** A dungeon as pictures need it: whose art it uses, and the world as generated. */
export interface ArtDungeon {
  artRoot: string;
  doc: GeneratedDungeon;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The key of the setting line a dungeon's illustrations share. */
export const settingKey = (theme: string) => `setting:${sha(ILLUSTRATION_SETTING_SYSTEM + "\n" + illustrationSettingMessage(theme))}`;

/** What a room's `assets.meta` holds: the door it was drawn from, its name, and Haiku's buttons when placement worked. */
export type RoomMeta = {
  entryId: string;
  title: string;
  spots?: IllustrationSpot[];
};

export async function serveIllustration(
  dungeon: ArtDungeon,
  roomId: string,
  work: IllustrationWork,
  store: IllustrationStore = repo
): Promise<IllustrationAnswer> {
  const d = dungeon.doc;
  const door = illustrationDoor(d, roomId);
  const p = door ? roomIllustration(d, roomId, door) : undefined;
  if (!p) return { status: "none" };
  const ref: AssetRef = { artRoot: dungeon.artRoot, kind: "room", subject: roomId };
  const answer = await serveAsset(ref, ILLUSTRATION_MODEL, p.roomName, work, store, async () => {
    const theme = d.pass.theme;
    const sKey = settingKey(theme);
    const setting = (await store.getIllustrationWords(sKey)) ?? (await store.saveIllustrationWords(sKey, await work.setting(theme)));
    const visual = await work.visual(p);
    const prompt = illustrationImagePrompt(p, "marks", setting, visual, undefined, work.references);
    const picture = await work.draw(prompt, await guidePng(p, true));
    const spots = await placeButtons(p, illustrationSpots(p), picture, work);
    const meta: RoomMeta = { entryId: p.entryId, title: p.roomName, ...(spots ? { spots } : {}) };
    return { picture, meta };
  });
  if (answer.status !== "ready") return answer;
  return { status: "ready", url: answer.url, spots: roomSpots(d, roomId, answer.meta as Partial<RoomMeta>) };
}

/**
 * A drawn room's buttons: Haiku's, kept with the picture, or else the
 * geometry's from the door the picture was drawn from — which is the door on
 * its row, not today's `illustrationDoor`, should that rule ever change.
 */
function roomSpots(d: GeneratedDungeon, roomId: string, meta: Partial<RoomMeta>): IllustrationSpot[] {
  if (Array.isArray(meta.spots)) return meta.spots;
  const door = meta.entryId ?? illustrationDoor(d, roomId);
  const p = door ? roomIllustration(d, roomId, door) : undefined;
  return p ? illustrationSpots(p) : [];
}

/** Haiku's buttons for a fresh picture; undefined, and logged, when it fails. A failure costs the buttons, never the picture. */
async function placeButtons(
  p: RoomIllustration,
  spots: IllustrationSpot[],
  picture: Buffer,
  work: Pick<IllustrationWork, "place">
): Promise<IllustrationSpot[] | undefined> {
  if (!work.place || !spots.some((s) => s.how === "shown")) return undefined;
  try {
    return await work.place(p, spots, picture);
  } catch (e) {
    console.error(`[illustration] placing buttons (${p.roomName}) failed: ${(e as Error).message}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// THE COVER
// ---------------------------------------------------------------------------

/**
 * The dungeon from outside: the cover on its library card and above its
 * opening. Klein, prompt only, sparse style — the spike's exterior setup.
 * None for a dungeon with no way in from the surface.
 */
export async function serveCover(
  dungeon: ArtDungeon,
  work: IllustrationWork,
  store: IllustrationStore = repo
): Promise<IllustrationAnswer> {
  const d = dungeon.doc;
  const description = coverDescription(d);
  if (!description) return { status: "none" };
  const ref: AssetRef = { artRoot: dungeon.artRoot, kind: "cover", subject: "" };
  const answer = await serveAsset(ref, COVER_MODEL, `${d.pass.name} (cover)`, work, store, async () => {
    const scene = await work.scene(description);
    return { picture: await work.drawScene(exteriorIllustrationPrompt({ scene }), d.seeds.dungeonSeed), meta: {} };
  });
  return answer.status === "ready" ? { status: "ready", url: answer.url } : answer;
}

/** A picture's answer before its kind adds what it needs: the URL and what was kept with it. */
export type AssetAnswer =
  | { status: "ready"; url: string; meta: Record<string, unknown> }
  | { status: "pending" }
  | { status: "none" };

/**
 * Where a drawing is stored. A new file every time it is drawn, because the
 * bucket serves files as immutable: a redraw under the old name would go on
 * showing the old picture from every cache that had it.
 */
export function assetPath(ref: AssetRef, at: number = Date.now()): string {
  return `${ref.kind}/${ref.artRoot}/${sha(ref.subject).slice(0, 16)}-${at.toString(36)}.png`;
}

/**
 * The claim, the draw and the store, for every picture in `assets`: rooms,
 * covers and creature sprites (`src/server/illustrations/sprites.ts`). See the
 * header for the states.
 *
 * A day whose budget is spent draws nothing: a missing picture is none, and a
 * picture marked for a redraw goes on showing the old one.
 */
export async function serveAsset(
  ref: AssetRef,
  model: string,
  label: string,
  work: Pick<IllustrationWork, "upload" | "urlOf" | "mayDraw">,
  store: IllustrationStore,
  make: () => Promise<{ picture: Buffer; meta: Record<string, unknown> }>,
  /** the model's picture as stored: an illustration's ink by default; a sprite's masks */
  finish: (picture: Buffer) => Promise<Buffer> = inkPng
): Promise<AssetAnswer> {
  const shown = (r: AssetRow): AssetAnswer => ({ status: "ready", url: work.urlOf(r.path!), meta: r.meta });
  const row = await store.getAsset(ref);
  if (row?.status === "ready" && row.path) return shown(row);
  if (row?.status === "pending" && row.ageMs < ILLUSTRATION_CLAIM_STALE_MS) return { status: "pending" };
  if (row?.status === "failed" && row.attempts >= ILLUSTRATION_MAX_ATTEMPTS) return { status: "none" };
  // Before the claim, so a closed day costs the picture none of its attempts.
  if (work.mayDraw && !(await work.mayDraw())) return row?.path ? shown(row) : { status: "none" };

  const mine = await store.claimAsset(ref, model, {
    staleMs: ILLUSTRATION_CLAIM_STALE_MS,
    maxAttempts: ILLUSTRATION_MAX_ATTEMPTS,
  });
  if (!mine) {
    // Somebody else's claim landed between the read and this. Say whatever it is now.
    const now = await store.getAsset(ref);
    if (now?.status === "pending") return { status: "pending" };
    return now?.path ? shown(now) : { status: "none" };
  }

  try {
    const { picture, meta } = await make();
    const path = assetPath(ref);
    await work.upload(path, await finish(picture));
    await store.finishAsset(ref, path, meta);
    return { status: "ready", url: work.urlOf(path), meta };
  } catch (e) {
    const body = (e as { body?: unknown }).body;
    const why = `${(e as Error).message}${body ? ` ${JSON.stringify(body).slice(0, 400)}` : ""}`;
    console.error(`[illustration] ${label} failed: ${why}`);
    await store.failAsset(ref, why);
    // A redraw that failed leaves the old picture showing.
    return row?.path ? shown(row) : { status: "none" };
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
          // Every drawing gets a new path (`assetPath`), so a file never changes.
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
