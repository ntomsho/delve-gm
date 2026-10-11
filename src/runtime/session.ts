/**
 * A RUN, AS ONE OBJECT
 * ====================
 *
 * Everything a single run needs to exist: its store, its journal, its referee,
 * its turn machine, and the sequence that gets it from a seed to a player
 * standing in the first room.
 *
 * That sequence used to live inside `App.tsx`, in a function called `begin`,
 * interleaved with `setScreen` and `setProgress` and a ref guarding React's
 * development double-mount. None of it was React's business — attach a journal,
 * write the first line, generate, start the store, describe the room — and all
 * of it is exactly what a server handler has to do when a player asks for a new
 * run. Leaving it in a component meant the only way to play a run was to render
 * one.
 *
 * So it is here, and the component above it does what a component should: shows
 * what the store says and calls these four methods.
 *
 * NOTHING IS SHARED BETWEEN SESSIONS. The store and the journal are made per
 * session, not imported, which is the whole point of the exercise — two
 * sessions in one process are two runs and cannot see each other. See the notes
 * atop `store/game.ts` and `runtime/journal.ts` for what that replaced.
 *
 * No React. Runs under vitest and under `node` — see `dev/cli-play.ts`, which
 * plays a whole run through this with no browser anywhere.
 */

import { createGameStore, type GameStoreApi, type SavedGame } from "../store/game.ts";
import { createJournal, runId, type Journal, type Sink } from "./journal.ts";
import { ResponseFormatError } from "./llm/json.ts";
import { createModelReferee } from "./referee.ts";
import { createTurnMachine, type Referee, type TurnMachine } from "./turn.ts";
import { isTerminal } from "./types.ts";
import { tallyRun } from "./tally.ts";
import { challengeStateOf } from "./challenges.ts";
import { generateDungeon, type GeneratedDungeon, type GenerateOptions } from "./generate.ts";
import { MODELS } from "./llm/models.ts";
import type { PlayerCharacter, Size } from "../engine/index.ts";

/** What a run is: a seed, how big, how dangerous, and who walked in. */
export interface RunRequest {
  seed: number;
  size: Size;
  level: number;
  character: PlayerCharacter;
}

/**
 * A referee, built once the session's store and journal exist.
 *
 * A factory rather than a `Referee` because the real one needs both of those,
 * and they belong to the session. A fixture that needs neither is `() => stub`.
 */
export type RefereeFactory = (deps: { store: GameStoreApi; journal: Journal }) => Referee;

export interface SessionOptions {
  /** defaults to the model referee, which is the only one that plays for real */
  referee?: RefereeFactory;
  /**
   * Where this run writes itself down, chosen once the run id is known — it is
   * derived from the seed, and the seed does not arrive until `begin`. Omitted
   * means the run is not journalled, and costs nothing.
   */
  sink?: (runId: string) => Sink;
  /**
   * How many events this run has already written.
   *
   * Zero for a run that is starting. For one being picked up — a handler that
   * has just loaded a turn's worth of state out of a row — it is the last
   * sequence in storage, so this session's events carry on from there instead
   * of colliding with the last session's. See `createJournal`.
   */
  startSeq?: number;
  /**
   * The generator. Overridden by the offline fixture and by tests; `offline`
   * beside it is what the journal records about the run, and the two are set
   * together because they are one decision.
   */
  generate?: (opts: GenerateOptions) => Promise<GeneratedDungeon>;
  offline?: boolean;
  onProgress?: GenerateOptions["onProgress"];
  signal?: AbortSignal;
  /** how many model calls one turn may take — see ModelRefereeOptions */
  maxRounds?: number;
}

/**
 * A run the interface can play, however it is actually being played.
 *
 * The two implementations are this file — the whole runtime, in process — and
 * `remote-session.ts`, which posts to the server and holds nothing but a store.
 * `App.tsx` takes one of these and cannot tell which it has, so `?offline` and
 * `?stub` still work with no server running while a real run goes over HTTP.
 */
export interface PlayableSession {
  /** what the interface subscribes to */
  readonly store: GameStoreApi;
  /**
   * Where this run wrote itself down, when that is a place a person can go
   * look. The in-process session names a directory under `out/runs`; a run
   * played through the server does not have one, because its journal is in
   * Postgres and the error screen has nothing useful to say about that.
   */
  readonly runId?: string | undefined;
  /** Build a dungeon, start the run, and describe the first room. */
  begin(request: RunRequest): Promise<void>;
  /**
   * Pick a stored run back up and play on from where it stopped.
   *
   * OPTIONAL, AND ABSENT ON A LOCAL RUN. `?offline` and `?stub` never write a
   * run down anywhere, so there is nothing for them to come back to — and an
   * implementation that threw would be a worse answer than a method that
   * visibly is not there. `App` offers the control only where the method is.
   */
  resume?(runId: string): Promise<void>;
  /**
   * Start a run in a world that is already written.
   *
   * OPTIONAL, AND ABSENT ON A LOCAL RUN, for the same reason `resume` is: a
   * stored dungeon is a row in Postgres, and `?offline` has one fixture and no
   * database to name it in. `App` offers the choice only where the method is.
   *
   * IT TAKES A DUNGEON ID AND NOT A `RunRequest`. Size, level and seed are
   * facts about a world that exists, so restating them here would be inviting a
   * client to state them wrongly — and the server would then have to decide
   * which of the two it believed.
   */
  beginIn?(request: { dungeonId: string; character: PlayerCharacter }): Promise<void>;
  enterRoom(): Promise<void>;
  submit(text: string): Promise<void>;
  roll(): Promise<void>;
  retry(): Promise<void>;
  /** End the run without playing it out. No referee, no dice, no world change. */
  abandon(): Promise<void>;
}

export interface GameSession extends PlayableSession {
  /** undefined until `begin` or `restore` — it is derived from the seed */
  readonly runId: string | undefined;
  /**
   * Pick up a run that already exists, from a save or from a database row.
   *
   * Pass the run id it was journalled under to keep writing the same file.
   * Without one it gets a fresh id, because `runId` is stamped with the time
   * and there is nothing in a save to recover the original from.
   *
   * NAMED `restore` AND NOT `resume`, since Phase 12. `PlayableSession.resume`
   * takes a run id and fetches; this takes a state that has already been
   * fetched. Two shapes under one name on an interface a caller holds
   * polymorphically is how the wrong one gets passed.
   */
  restore(saved: SavedGame, runId?: string): void;
}

/**
 * An error, said usefully.
 *
 * "response did not match the expected shape" is what a `ResponseFormatError`
 * says on its own, and on a screen it is worth nothing: it names no pass, no
 * chunk, and no field. The issues are right there on the error, so the first
 * few of them go into the message — enough to tell a prompt problem from a bad
 * roll of the dice without opening anything.
 */
export function describeFailure(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (!(e instanceof ResponseFormatError) || e.issues.length === 0) return message;

  const shown = e.issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`);
  const rest = e.issues.length - shown.length;
  return `${message} — ${shown.join("; ")}${rest > 0 ? `, and ${rest} more` : ""}`;
}

export function createGameSession(opts: SessionOptions = {}): GameSession {
  // Eagerly, so a component can subscribe before there is anything to see.
  // Generation takes a minute and the loading screen is rendered against this.
  const store = createGameStore();
  const generate = opts.generate ?? generateDungeon;

  let id: string | undefined;
  let journal: Journal | undefined;
  let machine: TurnMachine | undefined;
  let begun = false;

  /**
   * The journal, the referee, and the machine, in that order — each needs the
   * one before it. Called by both entry points, because a resumed run is as
   * entitled to a journal as a new one.
   */
  function wire(runId: string): void {
    id = runId;
    journal = createJournal(opts.sink?.(runId), opts.startSeq ?? 0);
    const referee =
      opts.referee?.({ store, journal }) ??
      createModelReferee({
        store,
        journal,
        ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    machine = createTurnMachine(referee, { store, journal });
  }

  /**
   * The machine, or nothing. Every method below is reachable from an interface
   * that could call it before the run exists — a stray keystroke during
   * generation, a resumed page — and doing nothing is the honest answer.
   */
  const turn = (): TurnMachine | undefined => machine;

  /**
   * WHAT THE RUN WAS WORTH, asked once, after it has ended.
   *
   * Every method that can end a run funnels through here, because a run can end
   * on a submit, on a roll, on a retry, or on the arrival pass that follows a
   * move — and a tally hung off only one of them would silently not happen for
   * the others.
   *
   * IT NEVER THROWS INTO THE ENDING. The run is over whether or not the scoring
   * call comes back, and a player looking at "you got out" must not instead be
   * looking at an error because a tally timed out. A failure is journalled and
   * the ledger is kept, so it can be asked for again.
   */
  async function settle(): Promise<void> {
    const state = store.getState();
    const run = state.run;
    const dungeon = state.dungeon;
    if (!run || !dungeon) return;
    if (!isTerminal(run.stage) || run.tally !== undefined) return;

    try {
      const result = await tallyRun({
        challengeState: challengeStateOf(run.challengeState, dungeon.stocked.pot?.allowance ?? 0),
        challenges: dungeon.stocked.challenges ?? [],
        dungeonContext: dungeon.dungeonContext,
        ending: run.stage,
        level: run.pc.level,
        hp: run.pc.hp,
        turns: run.turnCount,
        ...(journal ? { journal } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      // `undefined` is a normal answer: a death does not tally, and neither
      // does a run that accomplished nothing.
      if (result) store.getState().setTally(result.tally);
    } catch (e) {
      journal?.log({ kind: "error", where: "session:tally", message: describeFailure(e) });
    }
  }

  return {
    store,
    get runId() {
      return id;
    },

    async begin({ seed, size, level, character }) {
      // React mounts twice in development. Beyond the interface, a second
      // `begin` would generate a second dungeon over the top of the first —
      // a minute of model calls thrown away, and a store that changed under
      // a run already in progress.
      if (begun) return;
      begun = true;

      wire(runId(seed));

      // The first line of the file, before anything can go wrong: a run that
      // fails during generation is a run worth reading.
      journal!.log({
        kind: "run",
        runId: id!,
        seed,
        size,
        level,
        offline: opts.offline ?? false,
        models: MODELS,
        character,
      });

      // Errors are logged here and rethrown. What to SHOW for one is the
      // caller's — a screen, an HTTP status, a line on a terminal — and this
      // has no way to know which.
      let dungeon: GeneratedDungeon;
      try {
        dungeon = await generate({
          seed,
          size,
          level,
          journal: journal!,
          ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      } catch (e) {
        // `generation-error` above already holds the issues and the raw
        // response for each attempt; this is the run-level "and so it stopped".
        journal!.log({
          kind: "error",
          where: "session:generate",
          message: describeFailure(e),
        });
        // The object, not the string. Whoever is looking at this has devtools
        // open and the journal file out of reach, and everything that makes the
        // failure legible — the zod issues, the response — is on the error.
        console.error("[session] generation failed:", e);
        throw e;
      }

      // The baseline. Every diff in the rest of the journal is a delta from
      // this, which is what makes the file a complete history rather than a
      // highlight reel — any moment in the run can be rebuilt from here plus
      // the commits.
      journal!.log({ kind: "dungeon", dungeon });

      store.getState().start(dungeon, character);
      await turn()!.enterRoom();
    },

    restore(saved, existingId) {
      begun = true;
      wire(existingId ?? runId(saved.dungeon.seeds.dungeonSeed));
      store.setState({ dungeon: saved.dungeon, run: saved.run, lastEvents: [] });
    },

    async enterRoom() {
      await turn()?.enterRoom();
      await settle();
    },
    async submit(text) {
      await turn()?.submit(text);
      await settle();
    },
    async roll() {
      await turn()?.roll();
      await settle();
    },
    async retry() {
      await turn()?.retry();
      await settle();
    },

    /**
     * A local run walks away too.
     *
     * There is no server to tell and no roster to free a character on, so this
     * is the stage and nothing else — but the control exists on the play screen
     * and interface work is done under `?stub`, so a button that did nothing
     * there would be a button nobody could look at.
     *
     * NO TALLY, and no call. Abandoning is not walking out — the character is
     * still standing wherever they were left, and nothing came back up with
     * them. `shouldTally` is where that rule lives; not calling `settle` at all
     * is this path agreeing with it rather than paying for a model call whose
     * answer is already known.
     */
    async abandon() {
      const run = store.getState().run;
      if (!run || isTerminal(run.stage)) return;
      journal?.log({ kind: "stage", from: run.stage, to: "abandoned", step: run.step });
      store.getState().setStage("abandoned", run.step);
    },
  };
}
