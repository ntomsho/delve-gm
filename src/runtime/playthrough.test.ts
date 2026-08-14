/**
 * Drive a whole generated dungeon through a run's worth of commits, then save
 * it, reload it, and check it is still coherent.
 *
 * The unit tests prove each dispatch row in isolation against a hand-built
 * world of two rooms. This proves the same machinery holds against a world the
 * generator actually produced — thirty-odd rooms, consolidated creature groups,
 * gated connectors, items nested inside features — and that what comes back off
 * disk is what went in.
 */

import { describe, expect, it } from "vitest";
import { generateOffline, testCharacter } from "./__fixtures__/offline.ts";
import { applyCommit } from "./diffs/apply.ts";
import { PLAYER_ID, type Commit, type Diff, type World } from "./diffs/types.ts";
import { roomIndex } from "./occupancy.ts";
import { CountingRng } from "./rng.ts";
import { createGameStore, loadGame, saveDungeon, saveRun } from "../store/game.ts";
/** This file's own store — see the note atop `store/game.ts`. */
const useGame = createGameStore();

import { memoryStore } from "../store/persist.ts";
import { attackRoll, resolveBase, saveRoll, type ICreature } from "../engine/index.ts";
import { validateWritten } from "./generate.ts";

const SEED = 1005;

const turn = (...diffs: Diff[]): Commit => ({
  nextStage: "awaiting_action",
  nextStep: "1-target",
  diffs,
});

describe("a run through a generated dungeon", () => {
  it("applies a full turn's worth of commits and stays coherent", () => {
    const dungeon = generateOffline(SEED, 2);
    expect(validateWritten(dungeon)).toEqual([]);

    useGame.getState().reset();
    useGame.getState().start(dungeon, testCharacter());

    const state = () => useGame.getState().run!;
    const entities = () => state().entities;
    const commits: Commit[] = [];

    // --- arriving: describe the entrance and everything in it -------------
    const entrance = dungeon.stocked.entranceRoomId;
    const here = roomIndex(entities()).get(entrance) ?? [];
    commits.push(
      turn(
        { entityId: entrance, path: "state", value: "cold, and lit from somewhere above" },
        { entityId: entrance, path: "composed", value: "A cold room, lit from above." },
        ...here.flatMap((e) => [
          { entityId: e.id, path: "state", value: "as it was left" },
          { entityId: e.id, path: "composed", value: `${e.name}, undisturbed.` },
        ])
      )
    );

    // --- picking things up -------------------------------------------------
    const loose = entities().items.filter((i) => i.parentId === entrance).slice(0, 2);
    for (const item of loose) {
      commits.push(turn({ entityId: item.id, path: "parentId", value: PLAYER_ID }));
    }

    // --- establishing something that was never written down ----------------
    // Create and take it up in ONE commit: a ref lives for the commit that
    // minted it, because that is the only window in which the referee cannot
    // yet know the real id.
    commits.push(
      turn(
        {
          entityId: entrance,
          path: "children[]",
          value: { type: "Item", name: "guttering torch", base: "a pitch-soaked brand", ref: "torch" },
        },
        { entityId: "torch", path: "parentId", value: PLAYER_ID }
      )
    );

    // --- opening a gated way through ---------------------------------------
    const gated = entities().connectors.find((c) => c.conditional !== undefined);
    if (gated) {
      commits.push(
        turn(
          { entityId: gated.id, path: "conditional", value: null },
          { entityId: gated.id, path: "state", value: "the bar lies on the floor" }
        )
      );
    }

    // --- a fight, with real dice -------------------------------------------
    const rng = new CountingRng(dungeon.seeds.runSeed);
    const creature = entities().creatures[0] as ICreature;
    expect(creature).toBeDefined();

    for (let round = 0; round < 3; round++) {
      const attack = attackRoll(rng, { bonus: 2, targetDefense: 11, damage: "1d8" });
      if (attack.success && attack.damage) {
        const current = entities().creatures.find((c) => c.id === creature.id);
        if (!current) break;
        commits.push(
          turn(
            { entityId: creature.id, path: "stats.hp", value: current.stats.hp - attack.damage.total },
            { entityId: creature.id, path: "state", value: "bleeding, still upright" }
          )
        );
      }
      // The creature answers.
      const back = saveRoll(rng, 1, 16);
      if (!back.success) {
        commits.push(turn({ entityId: PLAYER_ID, path: "hp.current", value: 5 }));
      }
    }

    // --- consequences ------------------------------------------------------
    commits.push(
      turn(
        { entityId: PLAYER_ID, path: "conditions[]", value: "bleeding" },
        { entityId: PLAYER_ID, path: "conditions[]", value: "winded" }
      ),
      turn({ entityId: PLAYER_ID, path: "conditions[0]", value: null })
    );

    // --- searching: hidden things become findable, one at a time -----------
    for (const hidden of entities().features.filter((f) => f.isHidden).slice(0, 3)) {
      commits.push(
        turn(
          { entityId: hidden.id, path: "isHidden", value: false },
          { entityId: hidden.id, path: "state", value: "prised open" },
          { entityId: hidden.id, path: "composed", value: `${hidden.name}, now plain to see.` }
        )
      );
    }

    // --- wear on what is carried -------------------------------------------
    for (const carried of state().pc.inventory.filter((i) => (i.currentQuality ?? 0) > 1).slice(0, 2)) {
      commits.push(turn({ entityId: carried.id, path: "currentQuality", value: (carried.currentQuality ?? 1) - 1 }));
    }

    // --- describing somewhere new ------------------------------------------
    const elsewhere = entities().rooms.find((r) => r.id !== entrance)!;
    const there = (roomIndex(entities()).get(elsewhere.id) ?? []).slice(0, 4);
    commits.push(
      turn(
        { entityId: elsewhere.id, path: "state", value: "the air is warmer here" },
        { entityId: elsewhere.id, path: "composed", value: `${elsewhere.name}. Warmer.` },
        ...there.flatMap((e) => [
          { entityId: e.id, path: "state", value: "untouched" },
          { entityId: e.id, path: "composed", value: `${e.name}.` },
        ])
      )
    );

    // --- creatures get on with their business ------------------------------
    for (const c of entities().creatures.slice(0, 3)) {
      commits.push(turn({ entityId: c.id, path: "activity", value: "watching the door" }));
    }

    // --- moving on ---------------------------------------------------------
    const wanderer = entities().creatures[0];
    if (wanderer) {
      commits.push(turn({ entityId: wanderer.id, path: "roomId", value: elsewhere.id }));
    }

    // --- and on: a real run reaches every room, one entry pass each --------
    const everywhere = roomIndex(entities());
    for (const room of entities().rooms) {
      if (room.id === entrance || room.id === elsewhere.id) continue;
      const contents = everywhere.get(room.id) ?? [];
      commits.push(
        turn(
          { entityId: room.id, path: "state", value: "as the player found it" },
          { entityId: room.id, path: "composed", value: `${room.name}.` },
          ...contents.flatMap((e) => [
            { entityId: e.id, path: "state", value: "as the player found it" },
            { entityId: e.id, path: "composed", value: `${e.name}.` },
          ])
        )
      );
    }

    // --- run them all ------------------------------------------------------
    let applied = 0;
    for (const c of commits) {
      const r = useGame.getState().commit(c);
      expect(r.reasons).toEqual([]);
      expect(r.ok).toBe(true);
      applied += c.diffs.length;
      useGame.getState().recordTurn({ action: "…", outcome: "…", diffsApplied: c.diffs.length });
    }
    useGame.getState().syncRng(rng);

    expect(commits.length).toBeGreaterThanOrEqual(10);
    expect(applied).toBeGreaterThanOrEqual(30);
    expect(state().turnCount).toBe(commits.length);

    // --- the world is still self-consistent --------------------------------
    const e = entities();
    const ids = new Set([
      ...e.rooms.map((r) => r.id), ...e.creatures.map((c) => c.id),
      ...e.features.map((f) => f.id), ...e.items.map((i) => i.id),
      ...state().pc.inventory.map((i) => i.id),
    ]);

    for (const c of e.creatures) {
      expect(e.rooms.some((r) => r.id === c.roomId), `${c.name} stands nowhere`).toBe(true);
      expect(resolveBase(c, e.registry), `${c.name} has no base`).toBeTruthy();
    }
    for (const i of e.items) {
      expect(ids.has(i.parentId), `${i.name} is held by nothing`).toBe(true);
    }
    for (const i of state().pc.inventory) {
      expect(i.parentId).toBe(state().pc.id);
      // Carried items must not also be lying on the floor.
      expect(e.items.some((x) => x.id === i.id)).toBe(false);
    }
    // Every room in the index is a real room, and nothing is indexed twice.
    const index = roomIndex(e);
    for (const [roomId, contents] of index) {
      expect(e.rooms.some((r) => r.id === roomId)).toBe(true);
      expect(new Set(contents.map((x) => x.id)).size).toBe(contents.length);
    }
  });

  it("survives a save and reload", async () => {
    const store = memoryStore();
    const dungeon = generateOffline(SEED, 1);

    useGame.getState().reset();
    useGame.getState().start(dungeon, testCharacter());
    const room = dungeon.stocked.entranceRoomId;

    useGame.getState().commit(
      turn(
        { entityId: room, path: "state", value: "ransacked" },
        { entityId: PLAYER_ID, path: "conditions[]", value: "hungry" },
        { entityId: PLAYER_ID, path: "hp.current", value: 4 }
      )
    );
    useGame.getState().recordTurn({ action: "ransack", outcome: "found nothing", diffsApplied: 3 });

    const before = useGame.getState().run!;
    await saveDungeon(store, dungeon);
    await saveRun(store, before);

    useGame.getState().reset();
    const loaded = await loadGame(store, dungeon.id);
    expect(loaded).toBeDefined();

    const run = loaded!.run;
    expect(run.turnCount).toBe(1);
    expect(run.pc.hp.current).toBe(4);
    expect(run.pc.conditions).toEqual(["hungry"]);
    expect(run.entities.rooms.find((r) => r.id === room)!.state).toBe("ransacked");
    // needUpdate must survive the round trip, or the room silently never gets
    // re-described after a reload.
    expect(run.entities.rooms.find((r) => r.id === room)!.needUpdate).toBe(true);

    // The reloaded run keeps applying commits.
    useGame.setState({ dungeon: loaded!.dungeon, run });
    expect(useGame.getState().commit(turn({ entityId: room, path: "composed", value: "Turned over." })).ok).toBe(true);
  });

  it("leaves the generated dungeon untouched by the run", () => {
    const dungeon = generateOffline(SEED, 1);
    const room = dungeon.stocked.entranceRoomId;

    useGame.getState().reset();
    useGame.getState().start(dungeon, testCharacter());
    useGame.getState().commit(turn({ entityId: room, path: "state", value: "changed" }));

    // A restart must not need regenerating, so the write-once copy stays clean.
    expect(dungeon.entities.rooms.find((r) => r.id === room)!.state).toBeUndefined();
  });

  it("refuses a batch that is bad anywhere, leaving a long run intact", () => {
    const dungeon = generateOffline(SEED, 1);
    const world: World = {
      entities: structuredClone(dungeon.entities),
      pc: testCharacter(),
      currentRoomId: dungeon.stocked.entranceRoomId,
      goalMet: false,
      fiction: [],
    };
    const room = dungeon.stocked.entranceRoomId;

    const good: Diff[] = Array.from({ length: 20 }, (_, i) => ({
      entityId: room, path: "state", value: `pass ${i}`,
    }));
    const r = applyCommit(world, turn(...good, { entityId: room, path: "name", value: "Renamed" }));

    expect(r.ok).toBe(false);
    expect(r.applied).toEqual([]);
    expect(world.entities.rooms.find((x) => x.id === room)!.state).toBeUndefined();
  });
});
