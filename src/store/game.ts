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
  /** Play-time randomness. `draws` is what makes a reload resume mid-stream. */
  runSeed: number;
  rngDraws: number;
  /** entities as they now stand — diverges from the generated copy as play goes on */
  entities: EntityPassResult;
  pendingRoll?: RollSpec;
  /** the exchange for the action in progress; capped when assembling prompts */
  transcript: TranscriptEntry[];
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
    runSeed: dungeon.seeds.runSeed,
    rngDraws: 0,
    // The run mutates entities; the generated copy stays pristine so a restart
    // does not need regenerating.
    entities: structuredClone(dungeon.entities),
    transcript: [],
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
  recordTurn(record: Omit<TurnRecord, "turn">): void;
  logCall(entry: CallLogEntry): void;
  reset(): void;
}

function worldOf(run: RunState): World {
  return { entities: run.entities, pc: run.pc, currentRoomId: run.currentRoomId };
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
        // Death outranks whatever the referee thought came next. It is derived
        // from hit points, so it cannot be talked out of.
        stage: died ? "dead" : commit.nextStage,
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
