/**
 * WHAT KIND OF PAGE THIS IS, decided once when the bundle loads.
 *
 * The URL switches (`switches.ts`), and the session they imply: a real run is
 * played by the server, and `?offline` is played in the browser with the
 * fixture dungeon and the stub game master.
 */

import type { PlayableSession } from "../../gameplay/sessions/session.ts";
import type { GenerationProgress } from "../../generation/generate.ts";
import { createRemoteSession } from "../../gameplay/sessions/remote-session.ts";
import { authedFetch } from "../../api-client/auth.ts";
import { randomSeed } from "../../generation/seeds.ts";
import { readSwitches } from "./switches.ts";

export const {
  offline: OFFLINE,
  bypass: BYPASS,
  seed: SEED,
  pinnedSeed: PINNED,
  size: SIZE,
  level: LEVEL,
} = readSwitches(location.search);

/**
 * A run started from the front of the app gets a fresh dungeon unless the URL
 * pinned one. The bypass path keeps its 1005 default, so `?offline=1` on its own
 * returns to the same dungeon every time — which is the whole point of it
 * during interface work.
 */
export const seedForNewRun = () => (PINNED ? SEED : randomSeed());

/**
 * AN OFFLINE RUN'S CODE, loaded only on an offline run.
 *
 * A real run is played by the server, so the browser needs none of the game
 * engine: not the generator, not the game master, not their prompts. Only
 * `?offline` plays in the browser, and it needs the in-process session, the
 * fixture dungeon and the stub game master. Each dynamic import is its own
 * chunk, so a normal visit downloads none of them. `undefined` means this is
 * not an offline run.
 */
export const fixtures = OFFLINE ? await loadFixtures() : undefined;

async function loadFixtures() {
  const [session, offline, stub] = await Promise.all([
    import("../../gameplay/sessions/session.ts"),
    import("../../fixtures/offline.ts"),
    import("../../fixtures/stub-game-master.ts"),
  ]);
  return {
    createGameSession: session.createGameSession,
    generate: offline.generateOffline,
    /**
     * The dev quick-start character. Handing every visitor somebody called
     * Testy with +3 in everything is a different proposition from handing one
     * to a developer with `?offline` in the URL, so it lives with the fixtures.
     */
    character: offline.testCharacter,
    gameMaster: stub.stubGameMaster,
  };
}

/**
 * A session, and which KIND of session, decided here and nowhere else.
 *
 * A real run is played by the server. `?offline` is played in the browser:
 * interface work should not need Postgres running, and a fixture dungeon run
 * by a keyword-table game master costs nothing and answers instantly.
 *
 * Both satisfy `PlayableSession`, so nothing that holds one can tell which it
 * has.
 */
export function makeSession(onProgress: (p: GenerationProgress) => void): PlayableSession {
  return fixtures
    ? fixtures.createGameSession({
        onProgress,
        gameMaster: () => fixtures.gameMaster,
        offline: true,
        generate: async ({ seed, size }) => fixtures.generate(seed, size),
      })
    : createRemoteSession({ onProgress, fetch: authedFetch });
}
