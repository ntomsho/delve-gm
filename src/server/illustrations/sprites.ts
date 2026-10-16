/**
 * CREATURE SPRITES — drawing one, once
 * ====================================
 *
 * What `GET /api/runs/:id/sprites/:key` does once the route has checked the run
 * may see the creature. The same shape as an illustration (`illustrations.ts`):
 *
 *   1. the subject from the run's entities, and its key
 *   2. ready    → the URL, and the size word
 *      pending  → "ask again"
 *      missing  → claim it; Haiku's look and size (kept in `plate_words`);
 *                 draw; cut out (`sprite-image.ts`); store; the URL
 *      failed   → claim it again while attempts are left; past that, none
 *
 * THE KEY IS A HASH OF WHAT THE SPRITE IS DRAWN FROM — the Haiku request, the
 * image prompt's fixed text, the model, the references — and never of Haiku's
 * answer, which differs every call. A generated creature's base never changes,
 * so every run of a dungeon, and every copy of it, finds the same sprite.
 *
 * Two paid calls the first time: the look, then the image. About 20 s.
 *
 * Node only.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { fal } from "@fal-ai/client";
import {
  SPRITE_STYLE_VERSION,
  spriteImagePrompt,
  spriteLookMessage,
} from "../../illustrations/sprite-prompt.ts";
import { SPRITE_LOOK_SYSTEM } from "../../prompts/loader.ts";
import type { EntityPassResult } from "../../shared/world/entities.ts";
import { IMAGE_MODELS, SPRITE_MODEL } from "../../llm/models.ts";
import { requestSpriteLook, spriteSubject, type SpriteAnswer, type SpriteLook, type SpriteSubject } from "../../illustrations/sprites.ts";
import * as repo from "../db/repo.ts";
import { fetchImage, liveIllustrationWork, serveKeyed, type IllustrationStore, type IllustrationWork } from "./serve.ts";
import { cutOut, spriteMasksPng } from "./sprite-image.ts";

export type { SpriteAnswer };

/** GPT Image 2's quality for sprites: low, as for illustrations. */
export const SPRITE_QUALITY = "low";
/** The drawing's size: portrait, room for a whole figure. */
export const SPRITE_DRAW = { width: 1024, height: 1536 } as const;
/** The style references, sent with every sprite. Bundled with the function — see `vercel.json`. */
export const SPRITE_REFS_DIR = "assets/sprite-refs";

/** Where a sprite's words and pixels come from. The real ones are `liveSpriteWork`; tests pass fakes. */
export interface SpriteWork extends Pick<IllustrationWork, "upload" | "urlOf"> {
  look(s: SpriteSubject, theme: string): Promise<SpriteLook>;
  /** the figure on white, from the prompt; the references are the worker's own */
  draw(prompt: string): Promise<Buffer>;
  /** how many style references `draw` sends, which the prompt has to say */
  references: number;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** What a sprite is drawn from, hashed. See the header for why not Haiku's answer. */
export function spriteKey(s: SpriteSubject, theme: string, references: number): string {
  return sha(
    JSON.stringify({
      kind: "sprite",
      style: SPRITE_STYLE_VERSION,
      model: `${IMAGE_MODELS[SPRITE_MODEL].guided} ${SPRITE_QUALITY} ${SPRITE_DRAW.width}x${SPRITE_DRAW.height}`,
      references,
      look: SPRITE_LOOK_SYSTEM + "\n" + spriteLookMessage({ theme, name: s.name, base: s.base, member: s.member }),
      prompt: spriteImagePrompt("", references),
    })
  );
}

/** Where a sprite's look and size are kept, beside the illustrations' words. */
const lookKey = (key: string) => `sprite-look:${key}`;

const parseLook = (text: string | undefined): SpriteLook | undefined => {
  try {
    return text ? (JSON.parse(text) as SpriteLook) : undefined;
  } catch {
    return undefined;
  }
};

export async function serveSprite(
  entities: EntityPassResult,
  theme: string,
  spriteId: string,
  work: SpriteWork,
  store: IllustrationStore = repo
): Promise<SpriteAnswer> {
  const subject = spriteSubject(entities, spriteId);
  if (!subject) return { status: "none" };
  const key = spriteKey(subject, theme, work.references);
  const answer = await serveKeyed(
    key,
    SPRITE_MODEL,
    `${subject.name} (sprite)`,
    work,
    store,
    async () => {
      const kept = parseLook(await store.getIllustrationWords(lookKey(key)));
      const look = kept ?? parseLook(await store.saveIllustrationWords(lookKey(key), JSON.stringify(await work.look(subject, theme))))!;
      return work.draw(spriteImagePrompt(look.look, work.references));
    },
    async (picture) => spriteMasksPng(await cutOut(picture))
  );
  if (answer.status !== "ready") return answer;
  const look = parseLook(await store.getIllustrationWords(lookKey(key)));
  return { status: "ready", url: answer.url, size: look?.size ?? "medium" };
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
    look: async (s, theme) => (await requestSpriteLook(s, theme)).value,
    async draw(prompt) {
      const res = await fal.subscribe(IMAGE_MODELS[SPRITE_MODEL].guided, {
        input: {
          prompt,
          quality: SPRITE_QUALITY,
          image_size: SPRITE_DRAW,
          output_format: "png",
          image_urls: await refs(),
        },
      });
      const png = await fetchImage(res.data);
      // A moderated answer is a black square, not an error.
      if ((await sharp(png).greyscale().stats()).channels[0].mean < 5) throw new Error("blank image");
      return png;
    },
  };
}
