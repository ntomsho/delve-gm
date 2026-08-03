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
  /** describing a room the player has just walked into */
  | "room-entry"
  /** the runtime referee: triage, roll confirmation, resolution */
  | "turn-loop";

export const MODELS: Record<Task, string> = {
  "dungeon-pass": "claude-sonnet-5",
  "content-pass": "claude-sonnet-5",
  "room-entry": "claude-sonnet-5",
  "turn-loop": "claude-sonnet-5",
};

/** Per-task output ceiling. Generation passes write a lot; turns write a little. */
export const MAX_TOKENS: Record<Task, number> = {
  "dungeon-pass": 4096,
  "content-pass": 16384,
  "room-entry": 4096,
  "turn-loop": 4096,
};

export function modelFor(task: Task): string {
  return MODELS[task];
}
