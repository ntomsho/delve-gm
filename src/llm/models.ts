/**
 * MODEL REGISTRY
 * ==============
 *
 * The ONLY file in the repo permitted to contain a model string. Enforced by
 * `models.test.ts`, which greps everything else.
 *
 * Keyed by task so any one call can be repointed without touching the others.
 * Everything starts on one cheap fast model; expect the split to grow as the
 * passes turn out to have different appetites.
 */

export type Task =
  /** one call, up front: theme, history, goal, and the inhabitant bases */
  | "dungeon-pass"
  /** one call per chunk: rooms and everything in them */
  | "content-pass"
  /** one call at the end: the ways between chunks, once both their rooms exist */
  | "seams-pass"
  /** one call after that: the keys, once both they and their locks are written */
  | "keys-pass"
  /** one call at the end of a run: what each accomplishment was worth */
  | "tally-pass"
  /** describing a room the player has just walked into */
  | "room-entry"
  /** the runtime game master: triage, roll confirmation, resolution */
  | "turn-loop"
  /**
   * a room illustration's words: the room's fiction cut down to what an illustrator
   * would draw — its shell, and a short look for each thing in the frame
   */
  | "illustration-visual"
  /**
   * a creature sprite's words: what the figure looks like, and a size word
   * the code turns into feet
   */
  | "sprite-look";

/**
 * Everything is on Haiku 4.5 while the pipeline is being built: it is the
 * cheapest current model ($1 / $5 per million tokens in / out, against Sonnet
 * 5's $3 / $15), and prompt iteration means running the same seed many times.
 *
 * Two limits it carries that the larger models do not — neither binds today,
 * but both would if this stayed past the prototype:
 *   - 200K context, not 1M. A chunk prompt is a few thousand tokens, so there
 *     is a lot of headroom, but a very large dungeon would eventually crowd it.
 *   - 64K max output, not 128K. Above MAX_TOKENS below, so it does not bind.
 *
 * Haiku 4.5 also predates adaptive thinking and the effort parameter — it takes
 * the older `budget_tokens` form and errors on `effort`. Nothing here uses
 * either, but that is the thing to check before turning them on.
 *
 * Expect this to stop being one model. The obvious first split is the Dungeon
 * Pass: it runs once, sets the fiction every other call is written against, and
 * costs a rounding error next to N content-pass calls — so it is the cheapest
 * place to buy quality. That is what this registry being task-keyed is for.
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
 * Per-task output ceiling. Generation passes write a lot; turns write a little.
 * The content pass writes six rooms and everything in them in one response,
 * which is why it gets four times the others.
 */
export const MAX_TOKENS: Record<Task, number> = {
  "dungeon-pass": 4096,
  "content-pass": 16384,
  // A handful of connectors, two sentences each — a chunk boundary contributes
  // about two, so even a large dungeon is under a dozen.
  "seams-pass": 4096,
  // Four or five objects at size 5, two sentences each, plus a short list of
  // the objective's properties. Sized like the seams pass for the same reason.
  "keys-pass": 4096,
  // One line per accomplishment, and a long run has thirty of them.
  "tally-pass": 4096,
  "room-entry": 4096,
  "turn-loop": 4096,
  // A sentence for the room and a short phrase per thing in the picture.
  "illustration-visual": 1024,
  // Thirty-odd words and one size word.
  "sprite-look": 512,
};

export function modelFor(task: Task): string {
  return MODELS[task];
}

// ---------------------------------------------------------------------------
// IMAGE MODELS
// ---------------------------------------------------------------------------

/**
 * The image models under trial for room illustrations, as fal endpoint ids. Same rule
 * as the text models: no endpoint string anywhere else in the repo.
 *
 * Each has two endpoints because an illustration is drawn either FROM the guide image
 * (`guided`: an edit or control endpoint that takes it) or from the prompt
 * alone (`unguided`: plain text-to-image — exteriors, and the no-guide
 * control). FLUX.1 [pro] Canny only exists guided: it is a structure lock and
 * there is nothing for it to lock to without one.
 *
 * Settings that are not a model choice — quality, size, steps — live with the
 * caller, so trying GPT Image 2 at two qualities is one endpoint used twice.
 */
export type ImageModel = "gpt-image-2" | "flux-2-klein-4b" | "flux-2-pro" | "flux-1-pro-canny";

export const IMAGE_MODELS: Record<ImageModel, { guided: string; unguided?: string }> = {
  "gpt-image-2": { guided: "openai/gpt-image-2/edit", unguided: "openai/gpt-image-2" },
  // 4B rather than 9B: Apache 2.0, where the 9B is non-commercial.
  "flux-2-klein-4b": { guided: "fal-ai/flux-2/klein/4b/edit", unguided: "fal-ai/flux-2/klein/4b" },
  "flux-2-pro": { guided: "fal-ai/flux-2-pro/edit", unguided: "fal-ai/flux-2-pro" },
  "flux-1-pro-canny": { guided: "fal-ai/flux-pro/v1/canny" },
};

/**
 * What draws a room illustration in the game: GPT Image 2 at low quality, from the
 * marked guide and the style references. Of the models tried, it followed the
 * prompt and the guide most closely, and medium quality was no better. Part of every illustration's key, so changing it redraws from then on.
 */
export const ILLUSTRATION_MODEL: ImageModel = "gpt-image-2";

/**
 * What draws a dungeon's cover, its exterior: FLUX.2 [klein] 4B from the
 * prompt alone. The spike found it best on exteriors, and its text-to-image
 * endpoint takes no references.
 */
export const COVER_MODEL: ImageModel = "flux-2-klein-4b";

/**
 * What draws a creature sprite: GPT Image 2 at low quality, against the sprite
 * style references. Klein
 * blanked body horror to a black square even with its safety checker off.
 * Part of every sprite's key, so changing it redraws from then on.
 */
export const SPRITE_MODEL: ImageModel = "gpt-image-2";
