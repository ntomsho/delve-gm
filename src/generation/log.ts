/**
 * WHAT GENERATION WRITES DOWN
 * ===========================
 *
 * Every model call a pass makes is recorded, in full, because the dungeon is
 * written exactly once and cannot be re-examined later by playing differently.
 *
 * Generation declares the records it writes and the one method it needs to
 * write them. The run's journal (`journal/journal.ts`) accepts these records
 * among its own events and so satisfies `GenerationLog` as it is, which keeps
 * the dependency pointing one way: the journal knows about generation, and
 * generation knows only this.
 */

import type { Usage } from "../llm/client.ts";
import type { ValidationIssue } from "../llm/validation.ts";

/** Every pass that calls a model. The tally runs at the end of play, but it is the same kind of call. */
export type GenerationPass = "dungeon-pass" | "content-pass" | "seams-pass" | "keys-pass" | "tally-pass";

export type GenerationRecord =
  /**
   * A generation call, in full. Kept because the dungeon is written exactly
   * once and cannot be re-examined later by playing differently — if a room
   * reads badly, this is the only record of what was asked for.
   */
  | {
      kind: "generation";
      pass: GenerationPass;
      chunk?: number;
      prompt: string;
      response: unknown;
      usage: Usage;
    }
  /**
   * A generation call that came back unusable.
   *
   * The `generation` event above is written on SUCCESS, which meant a pass that
   * never succeeded left no trace but the message on the exception — and since
   * the chunks run in parallel, not even which one it was. So a failure writes
   * its own event: which pass, which chunk, which attempt, and what was
   * actually objected to.
   *
   * Both attempts are recorded, not just the last. The first failure and the
   * failure after the correction are different evidence: the same complaint
   * twice is a prompt that cannot be satisfied, and two different ones is a
   * model having a bad day.
   */
  | {
      kind: "generation-error";
      pass: GenerationPass;
      chunk?: number;
      attempt: number;
      willRetry: boolean;
      message: string;
      issues: ValidationIssue[];
      /** the tool input as it arrived, truncated */
      raw?: string;
    }
  | { kind: "error"; where: string; message: string };

/** Where a generation writes itself down. */
export interface GenerationLog {
  log(record: GenerationRecord): void;
}

/** Writes nothing: generation without a journal. */
export const NO_LOG: GenerationLog = { log() {} };
