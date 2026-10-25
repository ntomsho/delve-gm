/**
 * Every model the app uses, and what each costs.
 *
 * This is the only file allowed to contain a model name. The "model strings"
 * test in `src/architecture.test.ts` searches every other file and fails if
 * it finds one.
 *
 * Text models are chosen per task, so one kind of call can be moved to a
 * different model without affecting the others. Today every task uses the
 * same cheap, fast model.
 */

export type Task =
  /** one call, first: the dungeon's theme, history, goal and inhabitant groups */
  | "dungeon-pass"
  /** one call per chunk: rooms and everything in them */
  | "content-pass"
  /** one call after the content passes: the connections between chunks, once the rooms on both sides exist */
  | "seams-pass"
  /** one call after that: the keys, once the things they answer have been written */
  | "keys-pass"
  /** one call at the end of a run: how much XP each accomplishment is worth */
  | "tally-pass"
  /** describing a room the player has just walked into */
  | "room-entry"
  /** the game master during play: reading the action, confirming a roll, resolving it */
  | "turn-loop"
  /**
   * the text for a room illustration: the room's description cut down to what
   * an illustrator would draw (the room itself, and a short description of
   * each thing in the picture)
   */
  | "illustration-visual"
  /**
   * the text for a creature sprite: what the creature looks like, and a size
   * word that code converts to a height in feet
   */
  | "sprite-look";

/**
 * Which model each task uses. All tasks use Haiku 4.5 while the game is in
 * development: it is the cheapest current model ($1 / $5 per million input /
 * output tokens, against Sonnet 5's $3 / $15), and working on prompts means
 * running the same seed many times.
 *
 * Haiku 4.5 has two limits the larger models don't. Neither matters today:
 *   - a 200K-token context, not 1M. A chunk's prompt is a few thousand
 *     tokens, so there is plenty of room, though a very large dungeon could
 *     eventually fill it.
 *   - 64K maximum output tokens, not 128K. That is above every `MAX_TOKENS`
 *     value below.
 *
 * Haiku 4.5 is also older than adaptive thinking and the `effort` parameter:
 * it only accepts the older `budget_tokens` form and rejects `effort`. Nothing
 * here uses either, but check this before turning them on.
 *
 * The first task worth moving to a better model is probably the dungeon pass.
 * It runs once, sets the background every other call builds on, and costs
 * very little next to the many content-pass calls.
 */
export const MODELS: Record<Task, string> = {
  "dungeon-pass": "claude-haiku-4-5",
  "content-pass": "claude-haiku-4-5",
  "seams-pass": "claude-haiku-4-5",
  "keys-pass": "claude-haiku-4-5",
  "tally-pass": "claude-haiku-4-5",
  "room-entry": "claude-haiku-4-5",
  "turn-loop": "claude-haiku-4-5",
  "illustration-visual": "claude-haiku-4-5",
  "sprite-look": "claude-haiku-4-5",
};

/**
 * The maximum output tokens for each task. The content pass gets four times
 * the others because it writes six rooms and everything in them in one
 * response.
 */
export const MAX_TOKENS: Record<Task, number> = {
  "dungeon-pass": 4096,
  "content-pass": 16384,
  // A few connections, two sentences each. Each boundary between chunks has
  // about two, so even a large dungeon has fewer than a dozen.
  "seams-pass": 4096,
  // Four or five objects at size 5, two sentences each, plus a short list of
  // the goal's properties. A small output, like the seams pass.
  "keys-pass": 4096,
  // One line per accomplishment; a long run has about thirty.
  "tally-pass": 4096,
  "room-entry": 4096,
  "turn-loop": 4096,
  // A sentence for the room and a short phrase for each thing in the picture.
  "illustration-visual": 1024,
  // About thirty words, plus one size word.
  "sprite-look": 512,
};

export function modelFor(task: Task): string {
  return MODELS[task];
}

// ---------------------------------------------------------------------------
// PRICES
// ---------------------------------------------------------------------------

/**
 * The price per million tokens, in US dollars, for each model in `MODELS`.
 * Kept next to the model names so changing a model and its price is one edit.
 * `cost.test.ts` fails if a model in `MODELS` has no price here.
 *
 * Cache writes are the 5-minute kind, which cost 1.25× the input price; cache
 * reads cost 0.1×.
 */
export interface TextPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const TEXT_PRICES: Record<string, TextPrice> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

// ---------------------------------------------------------------------------
// IMAGE MODELS
// ---------------------------------------------------------------------------

/**
 * The image models that have been tried, as fal endpoint ids. As with text
 * models, no endpoint id may appear anywhere else in the repo.
 *
 * Each model has up to two endpoints. `guided` draws from a guide image (an
 * edit or control endpoint); `unguided` draws from the prompt alone (plain
 * text-to-image, used for exteriors and for comparing against no guide).
 * FLUX.1 [pro] Canny only has a guided endpoint: it follows the edges of the
 * guide image, so it can't work without one.
 *
 * Settings that aren't a choice of model (quality, size, steps) are set by
 * the caller, so trying GPT Image 2 at two qualities uses the same endpoint
 * twice.
 */
export type ImageModel = "gpt-image-2" | "flux-2-klein-4b" | "flux-2-pro" | "flux-1-pro-canny";

export const IMAGE_MODELS: Record<ImageModel, { guided: string; unguided?: string }> = {
  "gpt-image-2": { guided: "openai/gpt-image-2/edit", unguided: "openai/gpt-image-2" },
  // The 4B model rather than the 9B, because 4B is Apache 2.0 and 9B is licensed for non-commercial use only.
  "flux-2-klein-4b": { guided: "fal-ai/flux-2/klein/4b/edit", unguided: "fal-ai/flux-2/klein/4b" },
  "flux-2-pro": { guided: "fal-ai/flux-2-pro/edit", unguided: "fal-ai/flux-2-pro" },
  "flux-1-pro-canny": { guided: "fal-ai/flux-pro/v1/canny" },
};

/**
 * The model that draws room illustrations: GPT Image 2 at low quality, from
 * the marked-up guide image and the style reference images. Of the models
 * tried, it followed the prompt and the guide most closely, and medium
 * quality was no better. The model is part of every illustration's cache
 * key, so changing it means new illustrations are drawn from then on.
 */
export const ILLUSTRATION_MODEL: ImageModel = "gpt-image-2";

/**
 * The model that draws a dungeon's cover (its exterior): FLUX.2 [klein] 4B,
 * from the prompt alone. Testing found it best at exteriors. Its
 * text-to-image endpoint takes no reference images.
 */
export const COVER_MODEL: ImageModel = "flux-2-klein-4b";

/**
 * The model that draws creature sprites: GPT Image 2 at low quality, with the
 * sprite style reference images. FLUX.2 [klein] wasn't usable here: it
 * turned body horror into a black square even with its safety checker off.
 * The model is part of every sprite's cache key, so changing it means new
 * sprites are drawn from then on.
 */
export const SPRITE_MODEL: ImageModel = "gpt-image-2";

/**
 * The cost of one image in US dollars, at the size and quality this app uses.
 * From fal's model pages, read on 2026-10-16:
 *
 *   - GPT Image 2 at low quality is $0.018 for 1024x1536 with one input
 *     image. An illustration sends the guide and four reference images, and a
 *     sprite sends more, and fal says more input costs more. So $0.03 is an
 *     estimate until fal's usage page shows the real cost.
 *   - FLUX.2 [klein] 4B is $0.005 per megapixel, and a cover is 1536x1024
 *     (1.57 megapixels).
 *   - FLUX.2 [pro] and FLUX.1 [pro] Canny are only used by experiment scripts, which
 *     record no costs. Their $0.05 is a placeholder so every model has a
 *     price; look up the real price before the game uses either.
 */
export const IMAGE_PRICES: Record<ImageModel, number> = {
  "gpt-image-2": 0.03,
  "flux-2-klein-4b": 0.008,
  "flux-2-pro": 0.05,
  "flux-1-pro-canny": 0.05,
};
