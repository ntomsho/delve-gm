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
 * the turn machine and its tests never need a renderer. That is why the import
 * below is `zustand/vanilla` and not `zustand`: the package's own entry point
 * re-exports `zustand/react`, so importing it pulled React into the import
 * graph of every module that touches game state — the turn machine and the
 * referee included. `src/ui/shared/use-game.ts` holds the one binding that does.
 *
 * ONE STORE PER RUN. There was a module-level `useGame` here until Phase 9, and
 * a singleton is the right shape for exactly one situation: a browser tab, with
 * one run in it. A process serving several runs at once would have them
 * overwrite each other's entities, stage, and — worst, because it is silent —
 * each other's `rngDraws`. So the store is made by a factory now, and whoever
 * owns a run holds its store.
 */

import { createStore, type StateCreator, type StoreApi } from "zustand/vanilla";
import type { GeneratedDungeon } from "../../generation/generate.ts";
import type { PendingRequest, RolledOutcome, RollSpec, Stage, Step } from "../../shared/types/turn.ts";
import type { Commit, World, WorldEvent } from "../../shared/types/commit.ts";
import type { Effect, FoeRoll } from "../mechanics/effects.ts";
import { applyCommit } from "../diffs/apply.ts";
import { CountingRng } from "../../shared/utils/rng.ts";
import {
  challengeStateOf,
  newChallengeState,
  noteAction,
  noteArrival,
  noteDamage,
  type ChallengeState,
} from "../mechanics/challenges.ts";
import { purse } from "../../rules/knave/character-creation.ts";
import type { EntityPassResult } from "../../generation/content/entities-pass.ts";
import type { PlayerCharacter } from "../../rules/knave/character.ts";
import type { RunTally } from "../tally/tally-pass.ts";
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

/**
 * One message in the exchange for the action currently in progress.
 *
 * `roll` is the player's side of it without being something they said. It is
 * there so the dice are not reachable through a single line of one prompt —
 * see `assemble.ts`, where losing exactly that line lost a won roll.
 */
export interface TranscriptEntry {
  role: "player" | "referee" | "roll";
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
  kind: "opening" | "arrival" | "referee" | "player" | "roll" | "effects" | "foe";
  text: string;
  /** arrivals only: which room, so the heading can name it */
  roomId?: string;
  /**
   * Arrivals only: the connector they came in by, so the room's plate can be
   * drawn from that side. Absent on arrivals logged before it was kept.
   */
  via?: string;
  /**
   * The player's rolls only: the dice themselves, so the screen can draw them
   * rather than parse `text`. Absent on rolls logged before it existed, which
   * fall back to the line of text.
   */
  outcome?: RolledOutcome;
  /**
   * `effects` only: what the turn did to the character — hit points, items
   * damaged, destroyed, lost or gained. `text` carries the same as one line.
   */
  effects?: Effect[];
  /** `foe` only: the creature rolls that hurt them this turn — see `foeRolls` */
  foe?: FoeRoll[];
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
  /** input billed as a cache write (1.25×) and a cache read (0.1×) — see `Usage` */
  cacheWriteTokens: number;
  cacheReadTokens: number;
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
  /**
   * The connector they came in by — set by the applier when a walk crosses one.
   * The room card puts it at the top, apart from the rest: "the way you came" is
   * the first thing anyone wants from a room they have just walked into.
   */
  arrivedVia?: string;
  /**
   * The room the player has actually READ about, which lags `currentRoomId` for
   * as long as the arrival is being written.
   *
   * A move applies its diffs and then the room-entry pass runs, and for those
   * few seconds the player is standing somewhere they have been told nothing
   * about. Showing them its contents in the panel is the interface getting ahead
   * of the narration — they read the inventory of a room before its first
   * sentence. So the panel follows this, and this is advanced once, by the turn
   * machine, when the room entry has finished and its prose is on the page.
   */
  shownRoomId?: string;
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
  /**
   * What play has added to the story of the dungeon, oldest first — written by a
   * commit's `fictionNote` and read back into every later call.
   *
   * Kept beside `dungeonContext` rather than folded into it. The generated
   * fiction is an artifact of generation and stays as it was written; this is the
   * run's own accumulation, it belongs to the save rather than to the dungeon,
   * and two runs down the same dungeon should not inherit each other's history.
   */
  fiction: string[];
  /** Play-time randomness. `draws` is what makes a reload resume mid-stream. */
  runSeed: number;
  rngDraws: number;
  /** entities as they now stand — diverges from the generated copy as play goes on */
  entities: EntityPassResult;
  pendingRoll?: RollSpec;
  /**
   * The ask the turn machine has out, or the one that failed — what `retry`
   * repeats. Part of the run because the machine that has to repeat it is not
   * the machine that made it; see `PendingRequest`.
   *
   * Absent on a run that is not mid-ask, and on every run saved before this
   * existed, which is why `retry` treats it as a reason to do nothing rather
   * than as an invariant.
   */
  pending?: PendingRequest;
  /** the exchange for the action in progress; capped when assembling prompts */
  transcript: TranscriptEntry[];
  /** the scrollback the player reads. Display only — never sent to the referee. */
  log: LogEntry[];
  turnRecords: TurnRecord[];
  callLog: CallLogEntry[];
  /**
   * What this run has made of the dungeon's challenges: what it has been given
   * out of the reserve, what it has been told, what it has put on the map, and
   * the ledger the end-of-run tally reads.
   *
   * FIRST-CLASS RUN STATE rather than journal entries, because the journal
   * defaults to no sink — a run played without one would tally to nothing. It
   * is optional only so a run saved before it existed reloads; see
   * `challengeStateOf`.
   */
  challengeState?: ChallengeState;
  /**
   * What the run was worth, once it has ended alive.
   *
   * Absent while the run is in progress, absent forever on a death — a run that
   * ends in death does not tally, though its ledger is still written — and
   * absent for the few seconds between the ending and the call coming back.
   */
  tally?: RunTally;
  /**
   * The ids the character walked in carrying, and the copper they walked in
   * with. Written once, at the start, and never touched again.
   *
   * THIS IS THE ONLY THING THAT MAKES LOOT KNOWABLE. What they came back with is
   * the inventory at the end minus the inventory at the start, and the end is
   * the only half of that the run would otherwise still have — everything is
   * mutated in place, so by the time anyone wants to ask, the question is
   * unanswerable. Two small arrays written at turn zero, against a whole second
   * copy of the sheet if it were remembered any later.
   *
   * Optional so a run saved before they existed still reloads; `lootOf` says
   * what it falls back to.
   */
  startedWith?: string[];
  startingPurse?: number;
}

export function newRun(dungeon: GeneratedDungeon, pc: PlayerCharacter): RunState {
  const entrance = dungeon.stocked.entranceRoomId;
  return {
    dungeonId: dungeon.id,
    pc,
    currentRoomId: entrance,
    // They came down the way out. It is true, and it puts the door home at the
    // top of the panel from the first room onward, which is where a player
    // deciding whether to press on wants to find it.
    arrivedVia: dungeon.entities.connectors.find(
      (c) => c.endpointB === null && c.endpointA === entrance
    )?.id,
    stage: "room_entry",
    step: "room-entry",
    turnCount: 0,
    goalMet: false,
    fiction: [],
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
    // The 10% held out of the pot at generation, which play spends as coin
    // grants. Nothing else in the run is allowed to invent money.
    challengeState: newChallengeState(dungeon.stocked.pot?.allowance ?? 0),
    // What they went down with, so that what they came back with can be told
    // from it. See `startedWith`.
    startedWith: pc.inventory.map((i) => i.id),
    startingPurse: purse(pc),
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
  /** Remember the ask in flight, or `undefined` once it has landed. */
  setPending(pending: PendingRequest | undefined): void;
  /**
   * The panel and the map marker catch up with the page. Called by the turn
   * machine when a room entry finishes — see `shownRoomId`, and `enterRoom` in
   * turn.ts, which is the only caller. A room entry that never finishes leaves
   * the interface showing the room the player last read about, which is the
   * honest answer while the game is in `error`.
   */
  showRoom(roomId: string): void;
  pushTranscript(entry: TranscriptEntry): void;
  pushLog(entry: Omit<LogEntry, "turn">): void;
  recordTurn(record: Omit<TurnRecord, "turn">): void;
  /** What the run was worth. Written once, when it has ended alive. */
  setTally(tally: RunTally): void;
  logCall(entry: CallLogEntry): void;
  reset(): void;
}

/**
 * The world a commit acts on.
 *
 * Takes the DUNGEON as well as the run, because what the dungeon asks is
 * generation data and belongs to the dungeon — the run holds only what it has
 * made of it. Two runs down the same dungeon face the same challenges and share
 * no ledger.
 */
function worldOf(run: RunState, dungeon: GeneratedDungeon | undefined): World {
  return {
    entities: run.entities,
    pc: run.pc,
    currentRoomId: run.currentRoomId,
    ...(run.arrivedVia !== undefined ? { arrivedVia: run.arrivedVia } : {}),
    goalMet: run.goalMet,
    // A run saved before this field existed reloads without it.
    fiction: run.fiction ?? [],
    challenges: dungeon?.stocked.challenges ?? [],
    reserve: dungeon?.stocked.reserve ?? [],
    challengeState: challengeStateOf(run.challengeState, dungeon?.stocked.pot?.allowance ?? 0),
    turn: run.turnCount,
    runSeed: run.runSeed,
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

/**
 * A store, as everything that is not React sees it: `getState`, `setState`,
 * `subscribe`. The turn machine and the referee take one of these and declare
 * it structurally, so neither of them imports zustand at all.
 */
export type GameStoreApi = StoreApi<GameStore>;

export function createGameStore(): GameStoreApi {
  return createStore<GameStore>(init);
}

const init: StateCreator<GameStore> = (set, get) => ({
  dungeon: undefined,
  run: undefined,
  lastEvents: [],

  start(dungeon, pc) {
    const run = newRun(dungeon, pc);
    // The entrance is walked into like anywhere else, and nothing else will
    // ever mark it: `noteArrival` fires on a change of room, and the first room
    // is not a change.
    if (run.challengeState) {
      noteArrival(run.challengeState, dungeon.stocked.challenges ?? [], run.currentRoomId, 0);
    }
    set({ dungeon, run, lastEvents: [] });
  },

  commit(commit) {
    const run = get().run;
    if (!run) return { ok: false, reasons: ["no run in progress"] };

    const result = applyCommit(worldOf(run, get().dungeon), commit);
    if (!result.ok || !result.world) {
      return { ok: false, reasons: result.rejected.map((r) => `${r.diff.path}: ${r.reason}`) };
    }

    const died = result.events.some((e) => e.kind === "player-died");

    // WHAT IT COST THEM, against whatever was in the room. The end-of-run tally
    // rates risk, and hit points lost is the only hard evidence of it that a
    // turn produces without being asked.
    noteDamage(
      result.world.challengeState,
      result.world.challenges,
      run.currentRoomId,
      run.turnCount,
      run.pc.hp.current - result.world.pc.hp.current
    );

    // MEETING A THING IS WALKING IN ON IT, whatever happens next. That is what
    // `metTurn` means, and it is the earlier of the two timestamps the tally
    // compares to work out whether a creature was got past rather than fled.
    if (result.world.currentRoomId !== run.currentRoomId) {
      noteArrival(
        result.world.challengeState,
        result.world.challenges,
        result.world.currentRoomId,
        run.turnCount
      );
    }
    set({
      lastEvents: result.events,
      run: {
        ...run,
        entities: result.world.entities,
        pc: result.world.pc,
        currentRoomId: result.world.currentRoomId,
        arrivedVia: result.world.arrivedVia,
        goalMet: result.world.goalMet,
        fiction: result.world.fiction,
        challengeState: result.world.challengeState,
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

  setPending(pending) {
    const run = get().run;
    if (!run) return;
    if (pending) {
      set({ run: { ...run, pending } });
      return;
    }
    // Dropped rather than set to `undefined`, so a cleared request does not
    // travel to Postgres and back as a null nobody meant to store.
    const next = { ...run };
    delete next.pending;
    set({ run: next });
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

  showRoom(roomId) {
    const run = get().run;
    if (run) set({ run: { ...run, shownRoomId: roomId } });
  },

  recordTurn(record) {
    const run = get().run;
    if (!run) return;
    const turn = run.turnCount + 1;

    // THE LEDGER, WRITTEN BY CODE. The turn already worked out what the action
    // was aimed at — `record.target` is step 1's answer — so when that target is
    // something a challenge is about, the attempt is appended without anyone
    // being asked whether it counted. It never enters a prompt, so it costs
    // nothing per turn and can afford to hold everything.
    const cs = challengeStateOf(run.challengeState, get().dungeon?.stocked.pot?.allowance ?? 0);
    if (record.target) {
      noteAction(cs, get().dungeon?.stocked.challenges ?? [], run.entities, [record.target], {
        turn,
        action: record.action,
        ...(record.roll ? { roll: record.roll } : {}),
      });
    }

    set({
      run: {
        ...run,
        turnCount: turn,
        turnRecords: [...run.turnRecords, { ...record, turn }],
        challengeState: cs,
        // A completed turn closes the exchange that produced it.
        transcript: [],
      },
    });
  },

  setTally(tally) {
    const run = get().run;
    if (run) set({ run: { ...run, tally } });
  },

  logCall(entry) {
    const run = get().run;
    if (run) set({ run: { ...run, callLog: [...run.callLog, entry] } });
  },

  reset() {
    set({ dungeon: undefined, run: undefined, lastEvents: [] });
  },
});

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
