/**
 * CHARACTER PORTRAITS — drawing one, or taking the player's own
 * =============================================================
 *
 * What `POST /api/portraits` and `POST /api/portraits/upload` do once the route
 * has checked the day's allowance (`allowance.ts`).
 *
 * DRAWN: claim one of today's drawings (a `pending` row in `portraits`); draw
 * one adventurer on white with the sprite worker, against the sprite
 * references, from a prompt written straight from the sheet
 * (`portraitImagePrompt`); threshold it to ink on transparent like an
 * illustration (`inkPng`); cut the head and shoulders out of it for the
 * thumbnail; store both; mark the row ready. A failure marks it failed, and a
 * failed drawing does not count against the day.
 *
 * UPLOADED: the player's own picture, shown as it is rather than thresholded,
 * which would ruin a photograph. sharp reads it (so anything that is not an
 * image is refused), turns it upright, strips its metadata and writes it
 * again as WebP, at most `UPLOAD_MAX_PX` on a side. The thumbnail is a square
 * crop where sharp's attention strategy finds the most going on, which on a
 * picture of a person is usually the face.
 *
 * NOT CACHED BY CONTENT, unlike illustrations and sprites: a portrait is one
 * account's, and drawing again is the point of the button. Each is stored
 * under its own id.
 *
 * Node only: sharp is native.
 */

import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { PlayerCharacter, Portrait } from "../../rules/knave/character.ts";
import { portraitImagePrompt } from "../../illustrations/portrait-prompt.ts";
import * as repo from "../db/repo.ts";
import { inkPng } from "./image.ts";
import type { SpriteWork } from "./sprites.ts";

/** The thumbnail's side, in pixels: about twice the largest it is shown. */
export const PORTRAIT_THUMB_PX = 256;
/** The largest upload taken, in bytes. Under Vercel's 4.5 MB request limit. */
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
/** An upload's longest side, as stored. */
export const UPLOAD_MAX_PX = 1024;
/** What an upload may be. */
export const UPLOAD_FORMATS = ["jpeg", "png", "webp"] as const;

/**
 * The head and shoulders of a standing figure, as a share of its height: the
 * square's side, and how far above the top of the figure it starts. A standing
 * adult is about seven and a half heads tall, so the top 30% is the head and
 * the shoulders with a little chest.
 */
const HEAD_SIDE = 0.3;
const HEAD_MARGIN = 0.03;
/** The band read for where the head is across: the top of the figure, about one head deep. */
const HEAD_BAND = 0.12;

/** What draws and stores a portrait: the sprite worker, which shares the illustrations' bucket. */
export type PortraitWork = Pick<SpriteWork, "draw" | "references" | "upload" | "urlOf" | "mayDraw">;

/** The statements, as `repo.ts` has them; a parameter so tests need no database. */
export type PortraitStore = Pick<typeof repo, "claimPortrait" | "finishPortrait" | "failPortrait" | "insertUploadedPortrait">;

/** Why a portrait was not made, in words the player can read. */
export class PortraitRefused extends Error {
  readonly status: 400 | 413 | 429 | 502;
  constructor(message: string, status: 400 | 413 | 429 | 502) {
    super(message);
    this.status = status;
  }
}

const pathsOf = (id: string, ext: string) => ({ path: `portraits/${id}.${ext}`, thumbPath: `portraits/${id}-thumb.${ext}` });

/**
 * The square around the head of a figure drawn as ink on transparent: down
 * from the top of the ink, centred across on the ink in the top band.
 *
 * Read off the drawing rather than asked for, because the image model puts the
 * figure wherever it likes on the page. A weapon held above the head moves the
 * top of the ink up, and the crop with it; the band's centre still finds the
 * figure across.
 */
export async function headAndShoulders(ink: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(ink).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const at = (x: number, y: number) => data[(y * w + x) * channels + channels - 1] > 0;

  let y0 = -1;
  let y1 = -1;
  for (let y = 0; y < h && y0 < 0; y++) for (let x = 0; x < w; x++) if (at(x, y)) { y0 = y; break; }
  for (let y = h - 1; y >= 0 && y1 < 0; y--) for (let x = 0; x < w; x++) if (at(x, y)) { y1 = y; break; }
  if (y0 < 0) throw new Error("no figure in the drawing");

  const tall = y1 - y0 + 1;
  let sum = 0;
  let n = 0;
  for (let y = y0; y < Math.min(h, y0 + Math.ceil(tall * HEAD_BAND)); y++) {
    for (let x = 0; x < w; x++) if (at(x, y)) { sum += x; n++; }
  }
  const cx = sum / n;
  const side = Math.max(1, Math.round(tall * HEAD_SIDE));
  const left = Math.round(cx - side / 2);
  const top = Math.round(y0 - tall * HEAD_MARGIN);

  // Padded by a side all round, so a square hanging off the page is paper rather than an error.
  const padded = await sharp(ink)
    .extend({ top: side, bottom: side, left: side, right: side, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp(padded)
    .extract({ left: left + side, top: top + side, width: side, height: side })
    .resize(PORTRAIT_THUMB_PX, PORTRAIT_THUMB_PX)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Draw a portrait of `pc` for `owner`, who may have `limit` drawings a day
 * (`null`: no limit). The route has already said no to a spent allowance; the
 * claim here is what holds the line if two requests race it.
 */
export async function drawPortrait(
  pc: PlayerCharacter,
  owner: string,
  limit: number | null,
  work: PortraitWork,
  store: PortraitStore = repo,
  id: string = randomUUID()
): Promise<Portrait> {
  if (!(await store.claimPortrait(id, owner, limit))) {
    throw new PortraitRefused("That is all the portraits for today. More at midnight UTC, or upload your own.", 429);
  }
  try {
    const picture = await work.draw(portraitImagePrompt(pc, work.references), "portrait");
    const ink = await inkPng(picture);
    const thumb = await headAndShoulders(ink);
    const { path, thumbPath } = pathsOf(id, "png");
    await Promise.all([work.upload(path, ink), work.upload(thumbPath, thumb)]);
    await store.finishPortrait(id, path, thumbPath);
    return { id, url: work.urlOf(path), thumbUrl: work.urlOf(thumbPath), source: "drawn" };
  } catch (e) {
    const body = (e as { body?: unknown }).body;
    const why = `${(e as Error).message}${body ? ` ${JSON.stringify(body).slice(0, 400)}` : ""}`;
    console.error(`[portrait] ${id.slice(0, 8)} failed: ${why}`);
    await store.failPortrait(id, why);
    throw new PortraitRefused("The drawing did not come out. It did not count against today; try again.", 502);
  }
}

/** Store the player's own picture as a portrait. Costs nothing and counts against nothing. */
export async function uploadPortrait(
  bytes: Buffer,
  owner: string,
  work: Pick<PortraitWork, "upload" | "urlOf">,
  store: PortraitStore = repo,
  id: string = randomUUID()
): Promise<Portrait> {
  if (bytes.length > UPLOAD_MAX_BYTES) {
    throw new PortraitRefused(`That picture is over ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`, 413);
  }
  const format = await sharp(bytes)
    .metadata()
    .then((m) => m.format)
    .catch(() => undefined);
  if (!format || !(UPLOAD_FORMATS as readonly string[]).includes(format)) {
    throw new PortraitRefused("That is not a picture this can take: a JPEG, PNG or WebP, please.", 400);
  }
  // `rotate()` with no angle turns the picture the way its EXIF says, before
  // the metadata goes. sharp writes none unless asked.
  const [full, thumb] = await Promise.all([
    sharp(bytes).rotate().resize(UPLOAD_MAX_PX, UPLOAD_MAX_PX, { fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer(),
    sharp(bytes)
      .rotate()
      .resize(PORTRAIT_THUMB_PX, PORTRAIT_THUMB_PX, { fit: "cover", position: sharp.strategy.attention })
      .webp({ quality: 85 })
      .toBuffer(),
  ]);
  const { path, thumbPath } = pathsOf(id, "webp");
  await Promise.all([work.upload(path, full, "image/webp"), work.upload(thumbPath, thumb, "image/webp")]);
  await store.insertUploadedPortrait(id, owner, path, thumbPath);
  return { id, url: work.urlOf(path), thumbUrl: work.urlOf(thumbPath), source: "uploaded" };
}

/**
 * The portrait a saved sheet may carry: the one in the database under that id
 * and this owner, with its URLs as the server makes them. A sheet naming a
 * portrait that is not the owner's, or not finished, is saved without one.
 * The client never asserts a picture any more than a rule.
 */
export async function portraitFor(
  claimed: Portrait | undefined,
  owner: string,
  urlOf: (path: string) => string | undefined,
  get: typeof repo.getPortrait = repo.getPortrait
): Promise<Portrait | undefined> {
  if (!claimed?.id) return undefined;
  const row = await get(claimed.id, owner);
  if (!row || row.status !== "ready" || !row.path || !row.thumbPath) return undefined;
  const url = urlOf(row.path);
  const thumbUrl = urlOf(row.thumbPath);
  if (!url || !thumbUrl) return undefined;
  return { id: row.id, url, thumbUrl, source: row.source };
}
