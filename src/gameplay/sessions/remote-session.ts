/**
 * A RUN, PLAYED THROUGH THE SERVER
 * ================================
 *
 * The same four verbs as `GameSession`, and the same store underneath — but
 * nothing here decides anything. The turn machine, the game master, the applier and
 * the dice all live on the server now; this posts what the player did and
 * replaces the store with what came back.
 *
 * WHY THE STORE IS STILL HERE. The interface reads run state through it and has
 * since Phase 3, and none of that has to change because the state now arrives
 * over a wire rather than from a turn machine in the next module. `PlayScreen`
 * cannot tell the difference, which is the point.
 *
 * WHAT THE CLIENT SENDS: what the player typed, and the version it last saw.
 * Nothing else. It does not say which stage it is on — a client that names its
 * own stage can name a flattering one — and it does not compute a commit, throw
 * a die, or decide an outcome. The version is opaque, so a client cannot even
 * choose a favourable one.
 *
 * GENERATION IS THREE REQUESTS, and the regions in the middle are fired
 * together. That is the same parallelism the pipeline always had; it has moved
 * from `Promise.all` over function calls to `Promise.all` over fetches, because
 * no one server invocation may hold more than one model call.
 *
 * WHAT THE SCREEN DOES WHILE IT WAITS
 * -----------------------------------
 * The interface has always been driven by one thing, `run.stage`: it closes the
 * input, names what the game is doing, and runs the sweep under the narration.
 * In process, the turn machine moves the stage on the same tick as the keypress
 * and *then* awaits the model, so the screen reacts instantly.
 *
 * This file did none of that. It posted, awaited, and only touched the store
 * when the answer came back — so for the forty seconds a game master takes, the
 * stage was still `awaiting_action`: no line in the scrollback, no sweep, and an
 * open box that accepted three more actions the server then refused as `busy`.
 * The interface was intact; nothing was telling it anything.
 *
 * So every verb below moves the stage BEFORE its request, to the stage the
 * server is about to confirm, and `land` overwrites the guess with the truth.
 * The guesses are only ever busy stages, which is what makes the guessing safe:
 * the worst case is an input closed a moment early, and a client that guesses a
 * busy stage cannot guess itself a favour. Nothing else is predicted — no
 * commit, no dice, no outcome. See the note on `predict`.
 */

import { createGameStore, type RunState } from "../state/store.ts";
import { acceptsInput, isTerminal, type Stage, type Step } from "../../shared/types/turn.ts";
import type { GeneratedDungeon, GenerationProgress } from "../../generation/generate.ts";
import type { IllustrationAnswer } from "../../illustrations/room-illustration.ts";
import type { PlayableSession, RunRequest } from "./session.ts";
import type { PlayerCharacter } from "../../rules/knave/character.ts";

export interface RemoteOptions {
  /** where the API lives. Same origin in dev, because Vite proxies `/api`. */
  baseUrl?: string;
  onProgress?: (p: GenerationProgress) => void;
  /**
   * How to make a request — `authedFetch` in the app, the global in tests.
   *
   * INJECTED RATHER THAN IMPORTED, so the runtime never depends on the store's
   * auth module and therefore never constructs a Supabase client just by being
   * imported. Attaching the token is `api-client/auth.ts`'s single job and this file
   * stays unaware that there is one.
   */
  fetch?: typeof globalThis.fetch;
}

/** What the server says a run is, every time it answers. */
interface TurnReply {
  state: RunState;
  version: number;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function createRemoteSession(opts: RemoteOptions = {}): PlayableSession {
  const base = (opts.baseUrl ?? "").replace(/\/$/, "");
  const report = opts.onProgress ?? (() => {});
  const store = createGameStore();
  // Read through a getter rather than captured once, so a test that stubs the
  // global after this function runs still gets its stub.
  const http: typeof globalThis.fetch = (...args) => (opts.fetch ?? globalThis.fetch)(...args);

  let runId: string | undefined;
  let version = 0;
  let begun = false;

  /**
   * The request the server never got.
   *
   * A turn can fail in two places and they need different repairs. If the
   * GAME MASTER failed, the server's own machine caught it, landed on `error` with
   * its `pending` recorded, and answered 200 — the run really is in `error` and
   * `POST /retry` will repeat the ask. If the REQUEST failed — the network, a
   * 500, a function that timed out — the server committed nothing and is still
   * sitting on `awaiting_action` with no pending anything, so `POST /retry`
   * would find nothing to repeat and quietly do nothing at all. That one has to
   * be sent again as itself, which is what this holds.
   */
  let unsent: { path: string; body: Record<string, unknown>; stage: Stage; step: Step } | undefined;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await http(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!res.ok) {
      const detail = await res.json().catch(() => ({}) as { error?: string });
      throw new ApiError(res.status, detail.error ?? `${method} ${path} failed (${res.status})`);
    }
    return (await res.json()) as T;
  }

  /**
   * What came back IS the run now.
   *
   * Replaced wholesale rather than merged: the server is the only thing that
   * changes run state, so anything the client still held is by definition older.
   */
  function land(reply: TurnReply): void {
    version = reply.version;
    unsent = undefined;
    store.setState({ run: reply.state, lastEvents: [] });
  }

  /**
   * SHOW THE STAGE THE SERVER IS ABOUT TO CONFIRM.
   *
   * Always a busy one — `room_entry`, `thinking`, `resolving` — because that is
   * the only kind of guess that cannot flatter the player. A busy stage closes
   * the input and asks for nothing; the reply either confirms it or replaces it
   * wholesale a moment later. The client still names no commit, throws no die
   * and decides no outcome, which is the rule Phase 10 was built on.
   *
   * It doubles as the lock on a second submission, exactly as it does in the
   * turn machine: the store is synchronous, so by the time a second keystroke
   * reaches `submit` the stage already refuses it.
   */
  function predict(stage: Stage, step: Step): void {
    store.getState().setStage(stage, step);
  }

  /**
   * The request could not be made. The machine's `fail`, on this side of the
   * wire: the world is left exactly as it was, the run goes to the one stage
   * where the software rather than the game master is talking, and what was being
   * sent is kept so the retry card can send it again.
   *
   * Deliberately does NOT throw. `App` calls these as `void session.submit(…)`,
   * so a rejection here is an unhandled promise and nothing on the screen; the
   * in-process machine has always reported a failed turn by landing on `error`,
   * and this reports it the same way so the two paths behave identically.
   * Generation is the exception and still throws — see `call`, used directly by
   * `begin`, which has a screen of its own for failing.
   */
  function fail(path: string, body: Record<string, unknown>, e: unknown): void {
    console.warn("[remote] the turn could not be sent:", e);
    const r = store.getState().run;
    const stage = r?.stage ?? "thinking";
    const step = r?.step ?? "1-target";
    unsent = { path, body, stage, step };
    store.getState().setStage("error", step);
  }

  /**
   * A turn, and what a rejected one means.
   *
   * A 409 is not an error the player should see. Either the run moved on in
   * another tab (`stale`) or a request for it is already in flight (`busy`), and
   * in both cases the honest thing is to show what is actually true — which the
   * server sends back with the refusal.
   */
  async function act(path: string, body: Record<string, unknown> = {}): Promise<void> {
    if (!runId) return;
    try {
      land(await call<TurnReply>("POST", `/api/runs/${runId}/${path}`, { ...body, version }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Its own try: a re-read that cannot be made is a failed turn like any
        // other, and a throw out of a catch block would be an unhandled
        // rejection — a failure inside a recovery, and invisible.
        try {
          const res = await http(`${base}/api/runs/${runId}`);
          if (res.ok) {
            const { run } = (await res.json()) as { run: { state: RunState; version: number } };
            land({ state: run.state, version: run.version });
            return;
          }
        } catch (resync) {
          fail(path, body, resync);
          return;
        }
      }
      fail(path, body, e);
    }
  }

  /**
   * A character walks into a dungeon that exists — the half of `begin` that is
   * not generation.
   *
   * Extracted because Phase 13a gave it a second caller. A world outlives the
   * run played in it, so going back down one the player already owns is this
   * and nothing else: no structure pass, no regions, no join, no bill.
   */
  async function startRun(dungeonId: string, character: PlayerCharacter): Promise<void> {
    const created = await call<{
      run: { id: string; state: RunState; version: number };
      dungeon: GeneratedDungeon;
    }>("POST", "/api/runs", { dungeonId, character });

    runId = created.run.id;
    version = created.run.version;
    store.setState({ dungeon: created.dungeon, run: created.run.state, lastEvents: [] });

    void cover();
    await act("enter");
  }

  /**
   * Illustrations asked for, by room. The promise is kept, not the answer, so a second
   * ask while the first is still drawing (a re-mount, a second panel) waits on
   * the same request instead of being told "pending" by its own claim.
   */
  const illustrations = new Map<string, Promise<IllustrationAnswer>>();

  /** One ask of an illustration-like route, kept until it is an answer. See `plates`. */
  function askOnce(key: string, path: string): Promise<IllustrationAnswer> {
    let asked = illustrations.get(key);
    if (!asked) {
      asked = (async (): Promise<IllustrationAnswer> => {
        const res = await http(`${base}${path}`);
        // A picture is never worth an error on the page: anything but an answer is none.
        return res.ok ? ((await res.json()) as IllustrationAnswer) : { status: "none" };
      })().catch((): IllustrationAnswer => ({ status: "none" }));
      illustrations.set(key, asked);
      // "Ask again later" is not an answer to keep.
      void asked.then((a) => a.status === "pending" && illustrations.delete(key));
    }
    return asked;
  }

  /**
   * The cover, asked for as soon as there is a run. On a dungeon just written
   * this is the ask that draws it, so it starts now rather than when the
   * opening renders: the picture is then seconds behind the prose, not more.
   */
  function cover(): Promise<IllustrationAnswer> {
    if (!runId) return Promise.resolve({ status: "none" });
    return askOnce("cover", `/api/runs/${runId}/cover`);
  }

  return {
    store,

    illustration(roomId: string): Promise<IllustrationAnswer> {
      if (!runId) return Promise.resolve({ status: "none" });
      return askOnce(`room:${roomId}`, `/api/runs/${runId}/illustrations/${encodeURIComponent(roomId)}`);
    },

    cover,

    async begin({ seed, size, level, character }: RunRequest) {
      // Same guard as the in-process session, for the same reason: React mounts
      // twice in development, and a second `begin` would build a second dungeon.
      if (begun) return;
      begun = true;

      report({ stage: "layout" });
      const made = await call<{ dungeonId: string; chunks: number[] }>("POST", "/api/dungeons", {
        seed,
        size,
        level,
      });

      // In parallel, and progress reported as each lands — which is honest for
      // the first time, because each one really is a region finished rather
      // than a step in a function nobody can see.
      let done = 0;
      report({ stage: "writing", chunksDone: 0, chunksTotal: made.chunks.length });
      await Promise.all(
        made.chunks.map(async (n) => {
          await call("POST", `/api/dungeons/${made.dungeonId}/chunks/${n}`);
          report({ stage: "writing", chunksDone: ++done, chunksTotal: made.chunks.length });
        })
      );

      report({ stage: "joining" });
      await call("POST", `/api/dungeons/${made.dungeonId}/finish`);

      await startRun(made.dungeonId, character);
    },

    /**
     * GO BACK DOWN A WORLD THAT IS ALREADY WRITTEN.
     *
     * One request instead of N+3, and none of them a model call. The dungeon is
     * named rather than rolled, so there is no seed, no size and no level in
     * this — those are facts about the world already, and a client that restated
     * them could state them wrongly.
     *
     * NO PROGRESS REPORTED BEYOND `layout`. The loading screen's stages describe
     * a dungeon being written and nothing is being written; what the player sees
     * is the one beat it takes to create the run, which is honest, and then the
     * room.
     *
     * The same `begun` latch as `begin` and `resume`: a session plays one run,
     * and StrictMode's double mount must not send two people into one hole.
     */
    async beginIn({ dungeonId, character }) {
      if (begun) return;
      begun = true;

      report({ stage: "layout" });
      await startRun(dungeonId, character);
    },

    /**
     * PICK A RUN BACK UP — one fetch, and nothing is rebuilt.
     *
     * The temptation is to replay: take the dungeon and the journal and run them
     * forward to where the player stopped. There is no need. `runs.state` is a
     * whole `RunState` — entities, the sheet, the room, the RNG's draw count, the
     * transcript, and `log`, which is the scrollback the player actually reads —
     * so what the server hands back IS the game. A replay path would be a second
     * reconstruction of a state the server already writes in full on every turn,
     * and a second one is a thing that can disagree with the first.
     *
     * THE STAGE IS THE ONE THING NOT TAKEN AT FACE VALUE. A run whose function
     * timed out or was deployed over mid-turn is stored saying `thinking`, and
     * `thinking` closes the input — so a player resuming one would land in a game
     * that will never ask them for anything again. A busy stage becomes `error`,
     * which is the one stage that offers a way on. Nothing is written and no
     * version is spent: the row still says what it said, and `retry` repeats the
     * ask from the `pending` the run was stored with.
     */
    async resume(id: string) {
      if (begun) return;
      begun = true;

      report({ stage: "layout" });
      const { run, dungeon } = await call<{
        run: { id: string; state: RunState; version: number };
        dungeon: GeneratedDungeon;
      }>("GET", `/api/runs/${id}`);

      runId = run.id;
      version = run.version;
      store.setState({ dungeon, run: run.state, lastEvents: [] });

      const { stage, step } = run.state;
      if (!acceptsInput(stage) && !isTerminal(stage)) store.getState().setStage("error", step);
    },

    /*
     * THE FOUR VERBS, each guarded exactly as the turn machine guards its own.
     *
     * The guards are not security — the server re-checks everything and is the
     * only thing that decides — they are what stops the interface from offering
     * a move the game is not in a position to accept, and they are the reason a
     * player can no longer stack four actions into a wait.
     */

    enterRoom() {
      const r = store.getState().run;
      if (!r || isTerminal(r.stage)) return Promise.resolve();
      predict("room_entry", "room-entry");
      return act("enter");
    },

    /**
     * The player's line goes up the moment they press return, as it does in
     * process — the scrollback is the record of the conversation and their half
     * of it is not in doubt. The reply carries the server's own copy of the log
     * and replaces this one, so it lands once however slow the game master is.
     */
    submit(text: string) {
      const r = store.getState().run;
      if (!r || !acceptsInput(r.stage) || text.trim() === "") return Promise.resolve();

      store.getState().pushLog({ kind: "player", text });
      store.getState().pushTranscript({ role: "player", text });
      predict("thinking", r.step);
      return act("turn", { text });
    },

    /**
     * TWO REQUESTS: THE DICE, THEN WHAT THEY MEANT.
     *
     * The dice are the server's — the run's RNG is seeded and its draw count is
     * state, so a client that rolled would be inventing a number and desyncing
     * the stream. They used to come back in the same request as the game master's
     * prose, so the player watched a spinner for ten seconds over a number the
     * server already had. Now `/roll` throws and saves and returns at once —
     * `rolling` is as brief as it sounds — the die lands in the log and the
     * screen draws it, and `/resolve` is the wait for the words.
     *
     * Only on to `/resolve` if the first landed where it should. Anything else —
     * a failure, which is `error` with the request kept for retry, or a resync
     * to some other state — is the truth now, and resolving over it is not.
     */
    async roll() {
      const r = store.getState().run;
      if (!r || r.stage !== "roll_offered" || !r.pendingRoll) return;
      predict("rolling", "4-confirm-roll");
      await act("roll");
      if (store.getState().run?.stage !== "resolving") return;
      await act("resolve");
    },

    /**
     * Ask again — and which "again" depends on where it broke.
     *
     * A request that never landed is sent again as itself. A game master that failed
     * on the server left its `pending` in the run, so the stage to show is read
     * from that: the same three-way the machine makes in `turn.ts`, off the same
     * field, which is why they cannot drift apart. Neither is available on a run
     * whose error predates this field, and then there is nothing honest to do.
     */
    retry() {
      const r = store.getState().run;
      if (!r || r.stage !== "error") return Promise.resolve();

      if (unsent) {
        const { path, body, stage, step } = unsent;
        predict(stage, step);
        return act(path, body);
      }

      if (!r.pending) return Promise.resolve();
      const { entering, roll, step } = r.pending;
      predict(entering ? "room_entry" : roll ? "resolving" : "thinking", step);
      return act("retry");
    },

    /**
     * Walk away.
     *
     * Goes through `act` like every other verb, so a stale version resyncs and a
     * failure lands on `error` with a retry — abandoning is a write against the
     * run and deserves the same care as one that costs a model call.
     *
     * NO PREDICTED STAGE. Every other verb guesses a BUSY stage while it waits,
     * which is safe because a busy stage asks for nothing. `abandoned` is
     * terminal, and a client that showed the end of a run before the server had
     * agreed to it would be showing the player an ending that might not land.
     * This one is fast and it can wait for the truth.
     */
    abandon() {
      const r = store.getState().run;
      if (!r || isTerminal(r.stage)) return Promise.resolve();
      return act("abandon");
    },
  };
}
