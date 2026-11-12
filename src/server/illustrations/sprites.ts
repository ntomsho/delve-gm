/**
 * CREATURE SPRITES — drawing one, once
 * ====================================
 *
 * What `GET /api/runs/:id/sprites/:key` does once the route has checked the run
 * may see the creature. The same shape as a room's picture (`serve.ts`): an
 * `assets` row for `(artRoot, "sprite", spriteId)`, where the sprite id is
 * `spriteKeyOf` — one per kind of creature in a dungeon, shared by every run
 * and every copy of it.
 *
 *   ready    → the URL, and the size word
 *   pending  → "ask again"
 *   missing  → claim it; Haiku's look and size; draw; cut out
 *              (`sprite-image.ts`); store, with the look and size on the row
 *   failed   → claim it again while attempts are left; past that, none
 *   redraw   → drawn again on purpose (`src/dev/redraw.ts`)
 *
 * Two paid calls the first time: the look, then the image. About 20 s.
 *
 * Node only.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { fal } from "@fal-ai/client";
import { spriteImagePrompt } from "../../illustrations/sprite-prompt.ts";
import type { EntityPassResult } from "../../shared/world/entities.ts";
import { IMAGE_MODELS, SPRITE_MODEL } from "../../llm/models.ts";
import { FIGURE_SIZE_FT, type FigureSize } from "../../illustrations/figures.ts";
import { requestSpriteLook, spriteSubject, type SpriteAnswer, type SpriteLook, type SpriteSubject } from "../../illustrations/sprites.ts";
import * as repo from "../db/repo.ts";
import { fetchImage, liveIllustrationWork, serveAsset, type IllustrationStore, type IllustrationWork } from "./serve.ts";
import { cutOut, spriteMasksPng } from "./sprite-image.ts";
import { beforeImage, recordImage } from "../spend.ts";

export type { SpriteAnswer };

/** GPT Image 2's quality for sprites: low, as for illustrations. */
export const SPRITE_QUALITY = "low";
/** The drawing's size: portrait, room for a whole figure. */
export const SPRITE_DRAW = { width: 1024, height: 1536 } as const;
/** The style references, sent with every sprite. Bundled with the function — see `vercel.json`. */
export const SPRITE_REFS_DIR = "assets/sprite-refs";

/** Where a sprite's words and pixels come from. The real ones are `liveSpriteWork`; tests pass fakes. */
export interface SpriteWork extends Pick<IllustrationWork, "upload" | "urlOf" | "mayDraw"> {
  look(s: SpriteSubject, theme: string): Promise<SpriteLook>;
  /**
   * the figure on white, from the prompt; the references are the worker's own.
   * `task` is what the spend ledger calls it: a character portrait is drawn
   * by this worker too (`portraits.ts`).
   */
  draw(prompt: string, task?: "sprite" | "portrait"): Promise<Buffer>;
  /** how many style references `draw` sends, which the prompt has to say */
  references: number;
}

/** A drawn sprite's size word, from what was kept with it; medium when it says nothing usable. */
export function spriteSize(meta: Record<string, unknown>): FigureSize {
  const size = meta.size;
  return typeof size === "string" && size in FIGURE_SIZE_FT ? (size as FigureSize) : "medium";
}

export async function serveSprite(
  dungeon: { artRoot: string; theme: string },
  entities: EntityPassResult,
  spriteId: string,
  work: SpriteWork,
  store: IllustrationStore = repo
): Promise<SpriteAnswer> {
  const subject = spriteSubject(entities, spriteId);
  if (!subject) return { status: "none" };
  const answer = await serveAsset(
    { artRoot: dungeon.artRoot, kind: "sprite", subject: spriteId },
    SPRITE_MODEL,
    `${subject.name} (sprite)`,
    work,
    store,
    async () => {
      const look: SpriteLook = await work.look(subject, dungeon.theme);
      const picture = await work.draw(spriteImagePrompt(look.look, work.references));
      return { picture, meta: { look: look.look, size: look.size } };
    },
    async (picture) => spriteMasksPng(await cutOut(picture))
  );
  if (answer.status !== "ready") return answer;
  return { status: "ready", url: answer.url, size: spriteSize(answer.meta) };
}

/**
 * The live worker, or undefined when the server is not set up to draw — the
 * same off switch as illustrations (`liveIllustrationWork`), whose upload it shares.
 */
export function liveSpriteWork(): SpriteWork | undefined {
  const illustrations = liveIllustrationWork();
  if (!illustrations) return undefined;
  const dir = resolve(process.cwd(), SPRITE_REFS_DIR);
  const refFiles = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  // Uploaded to fal once per process, not once per sprite.
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
    upload: illustrations.upload,
    urlOf: illustrations.urlOf,
    mayDraw: illustrations.mayDraw,
    look: async (s, theme) => (await requestSpriteLook(s, theme)).value,
    async draw(prompt, task = "sprite") {
      await beforeImage();
      const res = await fal.subscribe(IMAGE_MODELS[SPRITE_MODEL].guided, {
        input: {
          prompt,
          quality: SPRITE_QUALITY,
          image_size: SPRITE_DRAW,
          output_format: "png",
          image_urls: await refs(),
        },
      });
      await recordImage(task, SPRITE_MODEL);
      const png = await fetchImage(res.data);
      // A moderated answer is a black square, not an error.
      if ((await sharp(png).greyscale().stats()).channels[0].mean < 5) throw new Error("blank image");
      return png;
    },
  };
}
