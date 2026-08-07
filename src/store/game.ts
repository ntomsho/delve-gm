/**
 * GAME STATE
 * ==========
 *
 * The serialisable root, split in two by write frequency.
 *
 *   GeneratedDungeon  large, written once at generation      -> dungeon:<id>
 *   RunState          small, written on every commit         -> run:<id>
 *
 * Keeping them apart means a turn does not re-serialise thirty rooms and
 * everything in them just to record that the player lost two hit points.
 *
 * The store owns no React. Everything below is plain state plus functions, so
 * the turn machine and its tests never need a renderer.
 */

import { create } from "zustand";
import type { GeneratedDungeon } from "../runtime/generate.ts";
import type { RollSpec, Stage, Step } from "../runtime/types.ts";
import type { Commit, World, WorldEvent } from "../runtime/diffs/types.ts";
import { applyCommit } from "../runtime/diffs/apply.ts";
import { CountingRng } from "../runtime/rng.ts";
import type { EntityPassResult, PlayerCharacter } from "../engine/index.ts";
import { dungeonKey, runKey, type KeyValueStore } from "./persist.ts";

// ---------------------------------------------------------------------------
// RECORDS
// ---------------------------------------------------------------------------

/**
 * A completed turn, carried forward as structure rather than prose. The
 * entities' own `state` is the long-term memory; the transcript only has to
 * hold conversational continuity, so what a finished turn owes the next one is
 * a few facts, not its paragraphs.
 */
export interface TurnRecord {
  turn: number;
  action: string;
  target?: string;
  roll?: { kind: string; total: number; success: boolean };
  outcome: string;
  diffsApplied: number;
}

/** One message in the exchange for the action currently in progress. */
export interface TranscriptEntry {
  role: "player" | "referee";
  text: string;
}

/**
 * One line of the scrollback — what the screen shows, and nothing else.
 *
 * Deliberately not the transcript. `transcript` is what the referee is shown
 * and is cleared the moment a turn closes, which is right for a prompt and
 * fatal for a page: the player would watch the last hour of play blank itself
 * every time they finished an action. Keeping them apart lets this one hold the
 * referee's actual prose and survive a reload, while the transcript stays the
 * lean thing BUILD-PLAN §4.4 describes.
 *
 * Never assembled into a prompt.
 */
export interface LogEntry {
  /**
   * `opening` is the briefing — what the player knows walking in, written by the
   * Dungeon Pass. Exactly one, always first, and the only entry in the whole
   * scrollback that no turn produced.
   */
  kind: "opening" | "arrival" | "referee" | "player" | "roll";
  text: string;
  /** arrivals only: which room, so the heading can name it */
  roomId?: string;
  /** the turn it belongs to, for the Phase 7 log viewer */
  turn: number;
}

/** One model call, for the Phase 7 call log and for replay cassettes. */
export interface CallLogEntry {
  at: number;
  step: Step;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// RUN STATE
// ---------------------------------------------------------------------------

export interface RunState {
  dungeonId: string;
  pc: PlayerCharacter;
  currentRoomId: string;
  stage: Stage;
  step: Step;
  /**
   * Elapsed turns. Nothing consumes it yet — light and rations are out of scope
   * for the prototype — but the stocking pass already produces wandering groups
   * that will want a clock, and retrofitting one into a state model with no
   * notion of elapsed time is miserable.
   */
  turnCount: number;
  /**
   * The dungeon's objective is accomplished. A latch, and NOT the end of the
   * run: the player still has to carry it out — see `endingOf`.
   */
  goalMet: boolean;
  /** Play-time randomness. `draws` is what makes a reload resume mid-stream. */
  runSeed: number;
  rngDraws: number;
  /** entities as they now stand — diverges from the generated copy as play goes on */
  entities: EntityPassResult;
  pendingRoll?: RollSpec;
  /** the exchange for the action in progress; capped when assembling prompts */
  transcript: TranscriptEntry[];
  /** the scrollback the player reads. Display only — never sent to the referee. */
  log: LogEntry[];
  turnRecords: TurnRecord[];
  callLog: CallLogEntry[];
}

export function newRun(dungeon: GeneratedDungeon, pc: PlayerCharacter): RunState {
  return {
    dungeonId: dungeon.id,
    pc,
    currentRoomId: dungeon.stocked.entranceRoomId,
    stage: "room_entry",
    step: "room-entry",
    turnCount: 0,
    goalMet: false,
    runSeed: dungeon.seeds.runSeed,
    rngDraws: 0,
    // The run mutates entities; the generated copy stays pristine so a restart
    // does not need regenerating.
    entities: structuredClone(dungeon.entities),
    transcript: [],
    // The briefing, which is the first thing on the page. It was written during
    // generation and belongs to no turn, so nothing in the turn machine would
    // ever push it — and until it was put here it reached the journal file and
    // never the player, who arrived in the first room knowing nothing about
    // where they were or what they had come for.
    log: [{ kind: "opening", text: dungeon.pass.openingProse, turn: 0 }],
    turnRecords: [],
    callLog: [],
  };
}

// ---------------------------------------------------------------------------
// STORE
// ---------------------------------------------------------------------------

export interface GameStore {
  dungeon?: GeneratedDungeon;
  run?: RunState;
  /** last commit's side effects, for narration and the UI to acknowledge */
  lastEvents: WorldEvent[];

  start(dungeon: GeneratedDungeon, pc: PlayerCharacter): void;
  /** Apply a referee commit. Returns false and changes nothing if it was refused. */
  commit(commit: Commit): { ok: boolean; reasons: string[] };
  /** A seeded RNG positioned where the run left off. Persist `draws` after use. */
  rng(): CountingRng;
  syncRng(rng: CountingRng): void;

  setStage(stage: Stage, step: Step): void;
  pushTranscript(entry: TranscriptEntry): void;
  pushLog(entry: Omit<LogEntry, "turn">): void;
  recordTurn(record: Omit<TurnRecord, "turn">): void;
  logCall(entry: CallLogEntry): void;
  reset(): void;
}

function worldOf(run: RunState): World {
  return {
    entities: run.entities,
    pc: run.pc,
    currentRoomId: run.currentRoomId,
    goalMet: run.goalMet,
  };
}

/**
 * WHICH ENDING THIS IS.
 *
 * Two things outrank whatever the referee thought came next, and both for the
 * same reason: they are derived from state the referee does not hold and cannot
 * be talked out of.
 *
 * Death is hit points at zero.
 *
 * A departure is a stage the referee ASKS for — it knows the player walked out,
 * and nothing else — and the store settles what that was worth. Out with the
 * objective done is `goal_met`; out without it is `escaped`. Leaving that to the
 * referee would mean the ending depended on whether it still remembered a thing
 * that might have happened twenty turns ago.
 */
function endingOf(commit: Commit, world: World, died: boolean): Stage {
  if (died) return "dead";
  if (commit.nextStage === "departed") return world.goalMet ? "goal_met" : "escaped";
  return commit.nextStage;
}

export const useGame = create<GameStore>((set, get) => ({
  dungeon: undefined,
  run: undefined,
  lastEvents: [],

  start(dungeon, pc) {
    set({ dungeon, run: newRun(dungeon, pc), lastEvents: [] });
  },

  commit(commit) {
    const run = get().run;
    if (!run) return { ok: false, reasons: ["no run in progress"] };

    const result = applyCommit(worldOf(run), commit);
    if (!result.ok || !result.world) {
      return { ok: false, reasons: result.rejected.map((r) => `${r.diff.path}: ${r.reason}`) };
    }

    const died = result.events.some((e) => e.kind === "player-died");
    set({
      lastEvents: result.events,
      run: {
        ...run,
        entities: result.world.entities,
        pc: result.world.pc,
        currentRoomId: result.world.currentRoomId,
        goalMet: result.world.goalMet,
        stage: endingOf(commit, result.world, died),
        step: commit.nextStep,
        pendingRoll: commit.nextStage === "roll_offered" ? commit.rollRequest : undefined,
      },
    });
    return { ok: true, reasons: [] };
  },

  rng() {
    const run = get().run;
    if (!run) throw new Error("no run in progress");
    return CountingRng.resume(run.runSeed, run.rngDraws);
  },

  syncRng(rng) {
    const run = get().run;
    if (run) set({ run: { ...run, rngDraws: rng.draws } });
  },

  setStage(stage, step) {
    const run = get().run;
    if (run) set({ run: { ...run, stage, step } });
  },

  pushTranscript(entry) {
    const run = get().run;
    if (run) set({ run: { ...run, transcript: [...run.transcript, entry] } });
  },

  pushLog(entry) {
    const run = get().run;
    // Stamped with the turn in progress — `turnCount` is the number of CLOSED
    // turns, so the line the player is reading now belongs to the next one.
    if (run) set({ run: { ...run, log: [...run.log, { ...entry, turn: run.turnCount + 1 }] } });
  },

  recordTurn(record) {
    const run = get().run;
    if (!run) return;
    const turn = run.turnCount + 1;
    set({
      run: {
        ...run,
        turnCount: turn,
        turnRecords: [...run.turnRecords, { ...record, turn }],
        // A completed turn closes the exchange that produced it.
        transcript: [],
      },
    });
  },

  logCall(entry) {
    const run = get().run;
    if (run) set({ run: { ...run, callLog: [...run.callLog, entry] } });
  },

  reset() {
    set({ dungeon: undefined, run: undefined, lastEvents: [] });
  },
}));

// ---------------------------------------------------------------------------
// SAVE / LOAD
// ---------------------------------------------------------------------------

export async function saveRun(store: KeyValueStore, run: RunState): Promise<void> {
  await store.set(runKey(run.dungeonId), run);
}

export async function saveDungeon(store: KeyValueStore, dungeon: GeneratedDungeon): Promise<void> {
  await store.set(dungeonKey(dungeon.id), dungeon);
}

export interface SavedGame {
  dungeon: GeneratedDungeon;
  run: RunState;
}

export async function loadGame(store: KeyValueStore, dungeonId: string): Promise<SavedGame | undefined> {
  const [dungeon, run] = await Promise.all([
    store.get<GeneratedDungeon>(dungeonKey(dungeonId)),
    store.get<RunState>(runKey(dungeonId)),
  ]);
  return dungeon && run ? { dungeon, run } : undefined;
}

/** Dungeon ids with a saved run. */
export async function listSaves(store: KeyValueStore): Promise<string[]> {
  return (await store.keys("run:")).map((k) => k.slice("run:".length));
}
