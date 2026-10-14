/**
 * THE POINT OF PHASE 9, AS A TEST
 * ===============================
 *
 * Everything else about the session refactor is invisible: the same game, the
 * same turns, the same journal. What changed is that the store and the journal
 * stopped being module singletons, and the only way to see that is to run two
 * runs at once and check that neither can reach the other.
 *
 * That is not a hypothetical. A server process holds a session per request in
 * flight, and under a singleton the second player's dungeon would land in the
 * first player's store, their events would interleave into one numbered
 * stream, and — quietly, which is the bad part — they would share a draw count
 * on the dice.
 *
 * Free: the offline fixture for the dungeon, the stub game master for the turns.
 */

import { describe, expect, it } from "vitest";
import { createGameSession, describeFailure } from "./session.ts";
import { ResponseFormatError } from "../../llm/json.ts";
import { generateOffline, testCharacter } from "../../fixtures/offline.ts";
import { stubGameMaster } from "../../fixtures/stub-game-master.ts";
import type { JournalRecord } from "../../journal/journal.ts";

/** A session that costs nothing: fixture dungeon, fixture game master. */
function offlineSession(events?: JournalRecord[]) {
  return createGameSession({
    offline: true,
    gameMaster: () => stubGameMaster,
    generate: async ({ seed, size }) => generateOffline(seed, size),
    ...(events ? { sink: () => ({ write: (r: JournalRecord) => events.push(r) }) } : {}),
  });
}

const begin = (s: ReturnType<typeof offlineSession>, seed: number) =>
  s.begin({ seed, size: 1, level: 1, character: testCharacter() });

describe("two sessions in one process", () => {
  it("keep their own world, their own dice, and their own journal", async () => {
    const aEvents: JournalRecord[] = [];
    const bEvents: JournalRecord[] = [];
    const a = offlineSession(aEvents);
    const b = offlineSession(bEvents);

    // Started together, on different seeds, so a singleton anywhere below would
    // have the second overwrite the first.
    await Promise.all([begin(a, 1005), begin(b, 4242)]);

    const runA = () => a.store.getState().run!;
    const runB = () => b.store.getState().run!;

    expect(runA().dungeonId).not.toBe(runB().dungeonId);
    // The seed each store is holding, which is the thing a shared store would
    // get wrong. (The fixture's prose does not vary by seed, so its names are
    // no evidence either way.)
    expect(a.store.getState().dungeon!.seeds.dungeonSeed).toBe(1005);
    expect(b.store.getState().dungeon!.seeds.dungeonSeed).toBe(4242);

    // Turns interleaved. Only A climbs, so only A's stream is drawn from.
    await Promise.all([a.submit("I climb the far wall"), b.submit("I search the floor")]);
    await a.roll();

    expect(runA().rngDraws).toBeGreaterThan(0);
    expect(runB().rngDraws).toBe(0);
    expect(runA().log.some((l) => l.kind === "roll")).toBe(true);
    expect(runB().log.some((l) => l.kind === "roll")).toBe(false);

    // Each journal is numbered from one and holds only its own run.
    expect(aEvents.map((r) => r.seq)).toEqual(aEvents.map((_, i) => i + 1));
    expect(bEvents.map((r) => r.seq)).toEqual(bEvents.map((_, i) => i + 1));

    const runIds = (rs: JournalRecord[]) =>
      rs.filter((r) => r.kind === "run").map((r) => (r as { seed: number }).seed);
    expect(runIds(aEvents)).toEqual([1005]);
    expect(runIds(bEvents)).toEqual([4242]);

    expect(bEvents.some((r) => r.kind === "roll")).toBe(false);
    expect(aEvents.filter((r) => r.kind === "player")).toHaveLength(1);
    expect(bEvents.filter((r) => r.kind === "player")).toHaveLength(1);
  });
});

describe("a session", () => {
  it("writes the run and the dungeon before anything is played", async () => {
    const events: JournalRecord[] = [];
    await begin(offlineSession(events), 1005);

    // In that order: what the run is, then the world every later diff is a
    // delta from. A journal missing the baseline cannot be replayed.
    expect(events[0].kind).toBe("run");
    expect(events.findIndex((r) => r.kind === "dungeon")).toBe(1);
  });

  it("ignores a second begin", async () => {
    const session = offlineSession();
    await begin(session, 1005);

    const before = session.store.getState().dungeon;
    // React's development double-mount, and a handler retried. Generating over
    // the top of a run in progress is worse than doing nothing.
    await begin(session, 4242);

    expect(session.store.getState().dungeon).toBe(before);
  });

  it("picks up a run that already exists", async () => {
    const first = offlineSession();
    await begin(first, 1005);
    await first.submit("I search the floor");

    const saved = {
      dungeon: first.store.getState().dungeon!,
      run: first.store.getState().run!,
    };

    const second = offlineSession();
    second.restore(saved, "an-id-from-somewhere-else");
    expect(second.runId).toBe("an-id-from-somewhere-else");
    expect(second.store.getState().run!.turnCount).toBe(saved.run.turnCount);

    // And it plays on from there rather than starting over.
    await second.submit("I search the floor");
    expect(second.store.getState().run!.log.length).toBeGreaterThan(saved.run.log.length);
  });
});

// ---------------------------------------------------------------------------

/**
 * CODING-PLAN §6.7. "Could not build a dungeon: response did not match the
 * expected shape" was the whole of what a failed generation said, on the screen
 * and in the journal, while the error itself was carrying the field-by-field
 * complaints the entire time.
 */
describe("describeFailure", () => {
  it("puts the validation complaints into the sentence", () => {
    const text = describeFailure(
      new ResponseFormatError("response did not match the expected shape", [
        { path: "rooms.0.name", message: "Required" },
        { path: "rooms.2.base", message: "Expected string" },
      ])
    );

    expect(text).toContain("rooms.0.name: Required");
    expect(text).toContain("rooms.2.base: Expected string");
  });

  it("says how many more there are rather than printing all of them", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ path: `r.${i}`, message: "Required" }));
    const text = describeFailure(new ResponseFormatError("bad", many));

    expect(text).toContain("and 6 more");
    expect(text).not.toContain("r.8");
  });

  it("leaves an ordinary error alone", () => {
    expect(describeFailure(new Error("the network is out"))).toBe("the network is out");
    expect(describeFailure("a string somebody threw")).toBe("a string somebody threw");
  });
});
