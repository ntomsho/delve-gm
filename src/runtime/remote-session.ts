/**
 * A RUN, PLAYED THROUGH THE SERVER
 * ================================
 *
 * The same four verbs as `GameSession`, and the same store underneath — but
 * nothing here decides anything. The turn machine, the referee, the applier and
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
 */

import { createGameStore, type RunState } from "../store/game.ts";
import type { GeneratedDungeon, GenerationProgress } from "./generate.ts";
import type { PlayableSession, RunRequest } from "./session.ts";

export interface RemoteOptions {
  /** where the API lives. Same origin in dev, because Vite proxies `/api`. */
  baseUrl?: string;
  onProgress?: (p: GenerationProgress) => void;
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

  let runId: string | undefined;
  let version = 0;
  let begun = false;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
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
    store.setState({ run: reply.state, lastEvents: [] });
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
        const res = await fetch(`${base}/api/runs/${runId}`);
        if (res.ok) {
          const { run } = (await res.json()) as { run: { state: RunState; version: number } };
          land({ state: run.state, version: run.version });
          return;
        }
      }
      throw e;
    }
  }

  return {
    store,

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

      const created = await call<{
        run: { id: string; state: RunState; version: number };
        dungeon: GeneratedDungeon;
      }>("POST", "/api/runs", { dungeonId: made.dungeonId, character });

      runId = created.run.id;
      version = created.run.version;
      store.setState({ dungeon: created.dungeon, run: created.run.state, lastEvents: [] });

      await act("enter");
    },

    enterRoom: () => act("enter"),
    submit: (text: string) => act("turn", { text }),
    roll: () => act("roll"),
    retry: () => act("retry"),
  };
}
