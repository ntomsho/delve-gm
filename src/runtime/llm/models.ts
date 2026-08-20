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
  /** the runtime referee: triage, roll confirmation, resolution */
  | "turn-loop";

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
};

export function modelFor(task: Task): string {
  return MODELS[task];
}
