import { beforeEach, describe, expect, it } from "vitest";
import {
  characterKey, dungeonKey, memoryStore, runKey, type KeyValueStore,
} from "./persist.ts";
import { createGameStore, listSaves, loadGame, newRun, saveDungeon, saveRun } from "./game.ts";
/** This file's own store — see the note atop `store/game.ts`. */
const useGame = createGameStore();

import { shownRoom } from "./selectors.ts";
import { CountingRng } from "../runtime/rng.ts";
import { die } from "../engine/index.ts";
import { PLAYER_ID } from "../runtime/diffs/types.ts";
import type { GeneratedDungeon } from "../runtime/generate.ts";
import type { EntityPassResult, PlayerCharacter } from "../engine/index.ts";

// ===========================================================================
// STORAGE
// ===========================================================================

describe("key/value storage", () => {
  let store: KeyValueStore;
  beforeEach(() => { store = memoryStore(); });

  it("round-trips a value", async () => {
    await store.set("a", { n: 1, nested: { deep: [1, 2, 3] } });
    expect(await store.get("a")).toEqual({ n: 1, nested: { deep: [1, 2, 3] } });
  });

  it("returns undefined for a key that was never set", async () => {
    expect(await store.get("missing")).toBeUndefined();
  });

  it("isolates stored values from later mutation of the original", async () => {
    // IndexedDB behaves this way; memory must too, or a test passes for the
    // wrong reason and a real save behaves differently.
    const value = { hp: 6 };
    await store.set("pc", value);
    value.hp = 1;
    expect(await store.get<{ hp: number }>("pc")).toEqual({ hp: 6 });
  });

  it("isolates the returned value from the stored one", async () => {
    await store.set("pc", { hp: 6 });
    const got = await store.get<{ hp: number }>("pc");
    got!.hp = 99;
    expect(await store.get<{ hp: number }>("pc")).toEqual({ hp: 6 });
  });

  it("lists keys by prefix, which is how saves and characters stay apart", async () => {
    await store.set(dungeonKey("d1"), {});
    await store.set(runKey("d1"), {});
    await store.set(runKey("d2"), {});
    await store.set(characterKey("c1"), {});

    expect((await store.keys("run:")).sort()).toEqual(["run:d1", "run:d2"]);
    expect(await store.keys("character:")).toEqual(["character:c1"]);
    expect(await store.keys()).toHaveLength(4);
  });

  it("deletes and clears", async () => {
    await store.set("a", 1);
    await store.delete("a");
    expect(await store.get("a")).toBeUndefined();
    await store.set("b", 2);
    await store.clear();
    expect(await store.keys()).toEqual([]);
  });
});

// ===========================================================================
// THE RUN RNG
// ===========================================================================

describe("the run rng", () => {
  it("counts every draw", () => {
    const rng = new CountingRng(1005);
    for (let i = 0; i < 7; i++) die(rng, 20);
    expect(rng.draws).toBe(7);
  });

  it("resumes exactly where a save left off", () => {
    const live = new CountingRng(1005);
    const first = Array.from({ length: 10 }, () => die(live, 20));
    const savedDraws = live.draws;
    const next = Array.from({ length: 10 }, () => die(live, 20));

    const resumed = CountingRng.resume(1005, savedDraws);
    expect(Array.from({ length: 10 }, () => die(resumed, 20))).toEqual(next);
    // And it did not replay what already happened.
    expect(first).not.toEqual(next);
  });

  it("keeps play separate from generation", () => {
    const a = new CountingRng(1005);
    const b = new CountingRng(1005 ^ 0x5f3759df);
    expect(die(a, 20)).not.toBe(die(b, 20));
  });
});

// ===========================================================================
// A MINIMAL SAVED GAME
// ===========================================================================

const ROOM = "room-1";

function pc(): PlayerCharacter {
  return {
    id: "pc-1", name: "Wren", level: 1,
    hp: { current: 6, max: 6 },
    abilities: { str: 2, dex: 1, con: 2, int: 1, wis: 1, cha: 1 },
    traits: {
      physique: "Wiry", face: "Bony", skin: "Ashen", hair: "Cropped", clothing: "Patched",
      virtue: "Cautious", vice: "Greedy", speech: "Blunt", background: "Burglar",
      misfortunes: "Exiled", alignment: "Neutrality",
    },
    inventory: [], equipped: {}, conditions: [],
  };
}

function entities(): EntityPassResult {
  return {
    registry: { creatures: {}, hazards: {}, groups: {} },
    rooms: [{ id: ROOM, name: "Antechamber", type: "Room", base: "a cold room" }],
    connectors: [], creatures: [], features: [], items: [], hazards: [], effects: [],
    bindings: [], detailCandidates: [],
    pendingGoal: { roomId: ROOM, reward: "", mission: "", instruction: "" },
  };
}

function dungeon(): GeneratedDungeon {
  return {
    id: "dungeon-test",
    seeds: { dungeonSeed: 1005, graphSeed: "1005", blueprintSeed: 1005, stockSeed: 8924, layoutSeed: 105734, runSeed: 42 },
    size: 1, level: 1,
    dungeonContext: "THE DUNGEON: Test",
    pass: {
      name: "Test", theme: "t", history: "h",
      goal: { summary: "s", spec: "sp" }, openingProse: "o", groups: [],
    },
    blueprint: {} as never,
    graph: {} as never,
    stocked: { entranceRoomId: ROOM, goalRoomId: ROOM } as never,
    entities: entities(),
    blockplan: null,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

describe("save and load", () => {
  it("round-trips a game through storage", async () => {
    const store = memoryStore();
    const d = dungeon();
    const run = newRun(d, pc());
    run.turnCount = 3;

    await saveDungeon(store, d);
    await saveRun(store, run);

    const loaded = await loadGame(store, d.id);
    expect(loaded?.run.turnCount).toBe(3);
    expect(loaded?.dungeon.pass.name).toBe("Test");
  });

  it("returns undefined when only half a game is stored", async () => {
    const store = memoryStore();
    await saveDungeon(store, dungeon());
    expect(await loadGame(store, "dungeon-test")).toBeUndefined();
  });

  it("lists saved runs by dungeon id", async () => {
    const store = memoryStore();
    await saveRun(store, newRun(dungeon(), pc()));
    expect(await listSaves(store)).toEqual(["dungeon-test"]);
  });

  it("gives the run its own copy of the entities", () => {
    const d = dungeon();
    const run = newRun(d, pc());
    run.entities.rooms[0].name = "Changed";
    // The generated dungeon stays pristine, so a restart needs no regeneration.
    expect(d.entities.rooms[0].name).toBe("Antechamber");
  });

  it("starts at the entrance, on the room-entry step", () => {
    const run = newRun(dungeon(), pc());
    expect(run.currentRoomId).toBe(ROOM);
    expect(run.stage).toBe("room_entry");
    expect(run.turnCount).toBe(0);
    // Nothing has been read yet, so there is nothing honest to put in the panel.
    expect(run.shownRoomId).toBeUndefined();
  });
});

// ===========================================================================
// WHAT THE PANEL IS SHOWING
// ===========================================================================

describe("the room the player has read", () => {
  beforeEach(() => { useGame.getState().reset(); });

  it("shows nothing until a room entry has finished", () => {
    useGame.getState().start(dungeon(), pc());
    // The player is standing in the entrance and has been told nothing about it.
    expect(useGame.getState().run!.shownRoomId).toBeUndefined();
    expect(shownRoom(useGame.getState().run!)).toBeUndefined();

    // Prose that is not an arrival does not move it.
    useGame.getState().pushLog({ kind: "referee", text: "You heave at the door." });
    expect(shownRoom(useGame.getState().run!)).toBeUndefined();

    useGame.getState().showRoom(ROOM);
    expect(shownRoom(useGame.getState().run!)).toBe(ROOM);
  });

  it("falls back to where they stand for a run saved before it existed", () => {
    useGame.getState().start(dungeon(), pc());
    useGame.getState().setStage("awaiting_action", "1-target");
    const run = useGame.getState().run!;
    expect(run.shownRoomId).toBeUndefined();
    expect(shownRoom(run)).toBe(run.currentRoomId);
  });
});

// ===========================================================================
// THE STORE
// ===========================================================================

describe("the game store", () => {
  beforeEach(() => { useGame.getState().reset(); });

  it("refuses a commit with no run in progress", () => {
    expect(useGame.getState().commit({ timeSpent: "instant", nextStage: "awaiting_action", nextStep: "1-target", diffs: [] }).ok)
      .toBe(false);
  });

  it("applies a commit and advances stage and step", () => {
    useGame.getState().start(dungeon(), pc());
    const r = useGame.getState().commit({
      nextStage: "awaiting_action",
      timeSpent: "instant",
      nextStep: "1-target",
      diffs: [{ entityId: ROOM, path: "composed", value: "A cold, bare room." }],
    });
    expect(r.ok).toBe(true);
    const run = useGame.getState().run!;
    expect(run.stage).toBe("awaiting_action");
    expect(run.entities.rooms[0].composed).toBe("A cold, bare room.");
  });

  it("changes nothing when a commit is refused, and says why", () => {
    useGame.getState().start(dungeon(), pc());
    const r = useGame.getState().commit({
      nextStage: "awaiting_action",
      timeSpent: "instant",
      nextStep: "1-target",
      diffs: [{ entityId: ROOM, path: "base", value: "rewritten" }],
    });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("base");
    expect(useGame.getState().run!.entities.rooms[0].base).toBe("a cold room");
  });

  it("death overrides whatever stage the referee asked for", () => {
    useGame.getState().start(dungeon(), pc());
    const r = useGame.getState().commit({
      // The referee wants to carry on; hit points say otherwise.
      nextStage: "awaiting_action",
      timeSpent: "instant",
      nextStep: "1-target",
      diffs: [{ entityId: PLAYER_ID, path: "hp.current", value: 0 }],
    });
    expect(r.ok).toBe(true);
    expect(useGame.getState().run!.stage).toBe("dead");
  });

  it("holds a pending roll only while one is offered", () => {
    useGame.getState().start(dungeon(), pc());
    const spec = {
      kind: "save" as const, ability: "dex" as const, bonus: 1, edge: "none" as const,
      description: "Vault the pillar", dc: 16,
    };
    useGame.getState().commit({ timeSpent: "instant", nextStage: "roll_offered", nextStep: "4-confirm-roll", rollRequest: spec, diffs: [] });
    expect(useGame.getState().run!.pendingRoll).toEqual(spec);

    useGame.getState().commit({ timeSpent: "instant", nextStage: "awaiting_action", nextStep: "1-target", diffs: [] });
    expect(useGame.getState().run!.pendingRoll).toBeUndefined();
  });

  it("closes the exchange when a turn is recorded", () => {
    useGame.getState().start(dungeon(), pc());
    useGame.getState().pushTranscript({ role: "player", text: "I search the desk" });
    useGame.getState().pushTranscript({ role: "referee", text: "Which desk?" });
    expect(useGame.getState().run!.transcript).toHaveLength(2);

    useGame.getState().recordTurn({ action: "search the desk", outcome: "found a key", diffsApplied: 2 });
    const run = useGame.getState().run!;
    expect(run.turnCount).toBe(1);
    expect(run.turnRecords[0].turn).toBe(1);
    expect(run.transcript).toEqual([]);
  });

  it("resumes the dice stream across a save and reload", () => {
    useGame.getState().start(dungeon(), pc());
    const rng = useGame.getState().rng();
    const rolled = Array.from({ length: 5 }, () => die(rng, 20));
    useGame.getState().syncRng(rng);
    expect(useGame.getState().run!.rngDraws).toBe(5);

    // A reload rebuilds from the persisted seed and draw count.
    const saved = useGame.getState().run!;
    useGame.getState().reset();
    useGame.getState().start(dungeon(), pc());
    useGame.setState({ run: { ...useGame.getState().run!, rngDraws: saved.rngDraws } });

    const resumed = useGame.getState().rng();
    const next = Array.from({ length: 5 }, () => die(resumed, 20));
    expect(next).not.toEqual(rolled);

    // …and it matches what the unbroken stream would have produced.
    const unbroken = new CountingRng(saved.runSeed);
    for (let i = 0; i < 5; i++) die(unbroken, 20);
    expect(Array.from({ length: 5 }, () => die(unbroken, 20))).toEqual(next);
  });
});
