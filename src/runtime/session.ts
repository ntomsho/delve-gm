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
import { createModelReferee } from "./referee.ts";
import { createTurnMachine, type Referee, type TurnMachine } from "./turn.ts";
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

export interface GameSession {
  /** what the interface subscribes to, and what a handler serialises */
  readonly store: GameStoreApi;
  /** undefined until `begin` or `resume` — it is derived from the seed */
  readonly runId: string | undefined;

  /** Generate a dungeon, start the run, and describe the first room. */
  begin(request: RunRequest): Promise<void>;
  /**
   * Pick up a run that already exists, from a save or from a database row.
   *
   * Pass the run id it was journalled under to keep writing the same file.
   * Without one it gets a fresh id, because `runId` is stamped with the time
   * and there is nothing in a save to recover the original from.
   */
  resume(saved: SavedGame, runId?: string): void;

  enterRoom(): Promise<void>;
  submit(text: string): Promise<void>;
  roll(): Promise<void>;
  retry(): Promise<void>;
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
    journal = createJournal(opts.sink?.(runId));
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
        journal!.log({
          kind: "error",
          where: "session:generate",
          message: e instanceof Error ? e.message : String(e),
        });
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

    resume(saved, existingId) {
      begun = true;
      wire(existingId ?? runId(saved.dungeon.seeds.dungeonSeed));
      store.setState({ dungeon: saved.dungeon, run: saved.run, lastEvents: [] });
    },

    async enterRoom() {
      await turn()?.enterRoom();
    },
    async submit(text) {
      await turn()?.submit(text);
    },
    async roll() {
      await turn()?.roll();
    },
    async retry() {
      await turn()?.retry();
    },
  };
}
