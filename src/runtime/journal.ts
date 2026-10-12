/**
 * THE JOURNAL
 * ===========
 *
 * Everything that happened in a run, written down as it happens, to a file per
 * run. Not the scrollback the player reads and not the transcript the referee
 * is shown — both of those are shaped for somebody. This is shaped for nobody,
 * and that is the point: it is what you read afterwards when a turn went wrong
 * and you need to know whether the fault was the prompt, the model, the dice,
 * or the applier.
 *
 * It records, in order:
 *
 *   the seed and the sheet          what this run was
 *   every generation call           prompt and response, per pass and per chunk
 *   the whole generated dungeon     the baseline every later diff applies to
 *   every referee call              what it was sent, what it said, what it cost
 *   every player input              verbatim
 *   every roll                      the player's own, and each of the referee's
 *   every commit                    proposed, then applied or refused, with why
 *   every stage change              and the step behind it
 *
 * The dungeon plus the commits is a complete history: the generated world is
 * the baseline and the diffs are the deltas, so any moment in the run can be
 * reconstructed from the file. That is why entities are not snapshotted per
 * turn — it would be megabytes to say what a dozen diffs already say.
 *
 * NO SINK, NO COST. The default journal is nothing at all: `log` returns on the
 * first line and the 302 tests that do not want a journal do not get one. A
 * sink is chosen by whoever owns the run — the app, the CLI, the live check.
 *
 * IT MUST NEVER BREAK A TURN. A journal that throws would take the game down
 * with it over a file handle, so every write is wrapped and a failing sink is
 * reported once and then ignored.
 *
 * ONE JOURNAL PER RUN. This was a module singleton until Phase 9 — one `sink`,
 * one sequence counter, one set of steps already written — which is invisible
 * in a browser tab, where there is one run, and wrong everywhere else. A server
 * process holds several runs at once, and a singleton would interleave them
 * into one numbered stream and hand every run whichever sink attached last. So
 * a journal is an object now, made per run and carried alongside the store.
 */

import type { GeneratedDungeon } from "./generate.ts";
import type { Message, SystemBlock, ToolUse, Usage } from "./llm/client.ts";
import type { Commit, Diff, WorldEvent } from "./diffs/types.ts";
import type { RolledOutcome } from "./turn.ts";
import type { DiceOutcome } from "./dice.ts";
import type { Stage, Step } from "./types.ts";
import type { PlayerCharacter } from "../engine/index.ts";
import type { RollRequestParsed, ValidationIssue } from "./llm/schemas.ts";

// ---------------------------------------------------------------------------
// EVENTS
// ---------------------------------------------------------------------------

export type JournalEvent =
  /** what this run is: the seed, the sheet, and which model answers what */
  | {
      kind: "run";
      runId: string;
      seed: number;
      size: number;
      /** the dungeon's danger, not the character's — chosen at run setup */
      level: number;
      offline: boolean;
      models: Record<string, string>;
      character: PlayerCharacter;
    }
  /**
   * A generation call, in full. Kept because the dungeon is written exactly
   * once and cannot be re-examined later by playing differently — if a room
   * reads badly, this is the only record of what was asked for.
   */
  | {
      kind: "generation";
      pass: "dungeon-pass" | "content-pass" | "seams-pass" | "keys-pass" | "tally-pass";
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
      pass: "dungeon-pass" | "content-pass" | "seams-pass" | "keys-pass" | "tally-pass";
      chunk?: number;
      attempt: number;
      willRetry: boolean;
      message: string;
      issues: ValidationIssue[];
      /** the tool input as it arrived, truncated */
      raw?: string;
    }
  /** the finished world, and the baseline every diff below applies to */
  | { kind: "dungeon"; dungeon: GeneratedDungeon }
  /**
   * The standing instructions for a step. Written once per step per run rather
   * than on every call: it is thousands of words of identical prose, and
   * repeating it would make the file 90% playbook.
   */
  | { kind: "system"; step: Step; blocks: SystemBlock[] }
  /** what the referee was sent this call, minus the system blocks above */
  | { kind: "prompt"; step: Step; messages: Message[] }
  /** what it said — including the working-out outside the post */
  | {
      kind: "response";
      step: Step;
      round: number;
      text: string;
      toolUses: ToolUse[];
      usage: Usage;
      ms: number;
    }
  | { kind: "player"; text: string }
  | { kind: "narration"; text: string; arrival: boolean; roomId?: string }
  /** what the turn did to the character, as one line — see `effects.ts` */
  | { kind: "effects"; text: string }
  /** the creature rolls that hurt them, shown to the player — see `foeRolls` */
  | { kind: "foe"; text: string }
  /** the player's own roll, thrown by the interface */
  | { kind: "roll"; source: "player"; outcome: RolledOutcome; draws: number }
  /** the referee's batch, thrown by the dice tool */
  | {
      kind: "roll";
      source: "referee";
      requested: RollRequestParsed[];
      outcomes: DiceOutcome[];
      draws: number;
    }
  /** proposed, then what the applier made of it */
  | {
      kind: "commit";
      commit: Commit;
      ok: boolean;
      /** why it was refused; present only when ok is false */
      reasons?: string[];
      /** consequences the applier performed that the referee did not state */
      events?: WorldEvent[];
      /** a retry: the same turn, asked again with the reasons in front of it */
      retry?: boolean;
    }
  | { kind: "stage"; from?: Stage; to: Stage; step: Step }
  | { kind: "turn"; turn: number; action: string; outcome: string; diffs: number }
  | { kind: "error"; where: string; message: string };

/** An event as it is written: in order, and stamped. */
export type JournalRecord = JournalEvent & { seq: number; at: string };

export interface Sink {
  write(record: JournalRecord): void;
}

// ---------------------------------------------------------------------------
// THE JOURNAL
// ---------------------------------------------------------------------------

export interface Journal {
  log(event: JournalEvent): void;
  /** the standing instructions for a step, written the first time it is used */
  logSystem(step: Step, blocks: SystemBlock[]): void;
}

/**
 * A journal for one run.
 *
 * With no sink it is the no-op every test gets: `log` returns on the first
 * line, nothing is allocated, nothing is stamped.
 *
 * `startSeq` IS WHAT MAKES A RUN SURVIVE BEING PUT DOWN. In a browser one
 * journal sees a whole run and counting from zero is right. On a server there
 * is no continuous anything: a session is built per request, plays one turn,
 * and dies — so a journal that always started at zero would number the second
 * turn's events 1, 2, 3 again, on top of the first turn's. Against a table keyed
 * `(run_id, seq)` that is a collision, and the failure would be the quiet kind:
 * every write here is wrapped, per IT MUST NEVER BREAK A TURN, so the turn would
 * succeed and the journalling would simply stop. Whoever builds the session
 * passes the last sequence already stored.
 */
export function createJournal(sink?: Sink, startSeq = 0): Journal {
  let seq = startSeq;
  let broken = false;

  /**
   * Steps whose playbook has already been written. Tracked on the journal
   * rather than at the call site because "have I already written this" is a
   * property of the journal, not of the referee — and it is per run, because
   * two runs each want their own copy of the instructions they were played
   * under.
   */
  const written = new Set<Step>();

  function log(event: JournalEvent): void {
    if (!sink || broken) return;
    try {
      sink.write({ ...event, seq: ++seq, at: new Date().toISOString() });
    } catch (e) {
      // Once. A sink that is going to fail will fail on every event, and a
      // console full of the same message is how a real error gets missed.
      broken = true;
      console.warn("[journal] writing failed; journalling is off for this run:", e);
    }
  }

  return {
    log,
    logSystem(step, blocks) {
      if (!sink || written.has(step)) return;
      written.add(step);
      log({ kind: "system", step, blocks });
    },
  };
}

/**
 * The journal for a run that is not being journalled — shared, so the default
 * costs one reference rather than an object per turn machine.
 */
export const NO_JOURNAL: Journal = createJournal();

/** A name for this run's directory: sortable, and says which seed it was. */
export function runId(seed: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${stamp}-seed${seed}`;
}

/**
 * The diffs a commit proposed, in one line each, as `entity path = value`.
 * Shared by the transcript and by anything else that has to show a change
 * without printing a wall of JSON.
 */
export function describeDiff(d: Diff): string {
  const value =
    typeof d.value === "string"
      ? d.value.length > 120
        ? `${d.value.slice(0, 117).replace(/\s*\n\s*/g, " ")}…`
        : d.value.replace(/\s*\n\s*/g, " ")
      : JSON.stringify(d.value);
  return `${d.entityId} · ${d.path} = ${value}`;
}
