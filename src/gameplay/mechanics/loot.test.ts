/**
 * WHAT THEY CAME BACK WITH
 * ========================
 *
 * Two claims, and both are about the same thing: the end-of-run screen must not
 * make anything up.
 *
 * The take is a diff against a snapshot taken at turn zero, so a thing they went
 * down with is never reported as treasure and a thing they found always is. The
 * death is read off the run exactly as it was saved, so it survives a reload —
 * which is the whole reason it is derived rather than written at the moment the
 * hit points reached zero.
 */

import { describe, expect, it } from "vitest";
import { COPPER_NAME } from "../../rules/knave/character-creation.ts";
import { type AnyItem } from "../../shared/world/entities.ts";
import { type PlayerCharacter } from "../../rules/knave/character.ts";
import { generateOffline, testCharacter } from "../../fixtures/offline.ts";
import { causeOfDeath, keepsWhatTheyFound, lootOf } from "./loot.ts";
import { newRun, type RunState } from "../state/store.ts";
import type { Stage } from "../../shared/types/turn.ts";

const SEED = 1005;

const dungeon = generateOffline(SEED, 2);

/** The test character, with something already in the purse. */
function aCharacter(extra: AnyItem[] = []): PlayerCharacter {
  const pc = testCharacter();
  pc.inventory = [...pc.inventory, ...extra];
  return pc;
}

/** A run at turn zero, with the snapshot `newRun` takes. */
function aRun(pc: PlayerCharacter = aCharacter()): RunState {
  return newRun(dungeon, pc);
}

const anItem = (over: Partial<AnyItem> & { id: string; name: string }): AnyItem => ({
  type: "Item",
  parentId: "pc-1",
  slots: 1,
  value: 0,
  ...over,
});

const coin = (n: number): AnyItem =>
  anItem({ id: `coin-${n}`, name: COPPER_NAME, amount: `${n} cp`, value: n });

// ---------------------------------------------------------------------------

describe("keeping what you found", () => {
  /*
   * THE RULE, and the only place it is stated twice is `commitTurn`, which
   * enforces it against the database. Walking out alive is what makes the pack
   * yours; whether the objective came too decides which ending it was and
   * nothing else.
   */
  it("is walking out alive, with or without the objective", () => {
    expect(keepsWhatTheyFound("goal_met")).toBe(true);
    expect(keepsWhatTheyFound("escaped")).toBe(true);
  });

  it("is not dying, and not walking away from the run", () => {
    expect(keepsWhatTheyFound("dead")).toBe(false);
    expect(keepsWhatTheyFound("abandoned")).toBe(false);
  });
});

describe("the take", () => {
  it("is nothing at all on a run that has just begun", () => {
    const loot = lootOf(aRun(), dungeon);
    expect(loot.found).toEqual([]);
    expect(loot.coin).toBe(0);
    expect(loot.total).toBe(0);
  });

  // The whole point of the snapshot. Every one of these was in the pack on the
  // way down, and a screen that called the character's own sword treasure would
  // be lying about the one number it exists to report.
  it("never reports what they went down with", () => {
    const run = aRun();
    expect(lootOf(run, dungeon).found).toEqual([]);
    expect(run.startedWith).toContain("test-sword");
  });

  it("reports what was picked up, with its worth", () => {
    const run = aRun();
    run.pc.inventory.push(anItem({ id: "reliquary", name: "Silver reliquary", value: 420 }));
    run.pc.inventory.push(anItem({ id: "comb", name: "Ivory comb", value: 85 }));

    const loot = lootOf(run, dungeon);
    expect(loot.found.map((l) => l.name)).toEqual(["Silver reliquary", "Ivory comb"]);
    expect(loot.total).toBe(505);
  });

  it("carries an amount through, for the things measured rather than counted", () => {
    const run = aRun();
    run.pc.inventory.push(anItem({ id: "oil", name: "Flask of oil", value: 6, amount: "4 flasks" }));
    expect(lootOf(run, dungeon).found[0]?.amount).toBe("4 flasks");
  });

  /*
   * MONEY IS NOT AN OBJECT. The purse is one item whose amount moves, so a diff
   * of ids would either miss a richer purse entirely — the case below — or, for
   * a player who went down broke, report the whole purse as a thing they found.
   */
  it("counts a fuller purse as coin, and never as a line", () => {
    const run = aRun(aCharacter([coin(60)]));

    // Same item, more in it — which is exactly what `setPurse` does.
    run.pc.inventory.find((i) => i.name === COPPER_NAME)!.amount = "172 cp";

    const loot = lootOf(run, dungeon);
    expect(loot.coin).toBe(112);
    expect(loot.found.map((l) => l.name)).not.toContain(COPPER_NAME);
    expect(loot.total).toBe(112);
  });

  it("counts a purse minted in play as coin, for a character who went down broke", () => {
    const run = aRun();
    run.pc.inventory.push(coin(240));

    const loot = lootOf(run, dungeon);
    expect(loot.coin).toBe(240);
    expect(loot.found).toEqual([]);
  });

  // Knave has nothing to spend money on below ground, and a screen about what
  // was GAINED should not report a negative. Whatever went out is not a loss.
  it("never reports coin as negative", () => {
    const run = aRun(aCharacter([coin(300)]));
    run.pc.inventory.find((i) => i.name === COPPER_NAME)!.amount = "40 cp";

    expect(lootOf(run, dungeon).coin).toBe(0);
  });

  /*
   * A RUN SAVED BEFORE THE SNAPSHOT EXISTED still gets an answer, from the one
   * other thing that distinguishes a found item: its id is in the generated
   * dungeon. It misses anything minted during play and is right about everything
   * that was lying in a room, which is a floor under old saves rather than a
   * second implementation.
   */
  it("falls back to the dungeon's own items when there is no snapshot", () => {
    const run = aRun();
    delete run.startedWith;
    delete run.startingPurse;

    const fromDownThere = dungeon.entities.items[0]!;
    run.pc.inventory.push({ ...structuredClone(fromDownThere), parentId: run.pc.id });
    run.pc.inventory.push(anItem({ id: "minted-in-play", name: "A guard's keyring", value: 5 }));

    const loot = lootOf(run, dungeon);
    expect(loot.found.map((l) => l.id)).toEqual([fromDownThere.id]);
  });
});

describe("how it happened", () => {
  const died = (over: Partial<RunState> = {}): RunState => ({
    ...aRun(),
    stage: "dead" as Stage,
    turnCount: 23,
    ...over,
  });

  it("says nothing about a run that did not end in death", () => {
    for (const stage of ["goal_met", "escaped", "abandoned", "awaiting_action"] as Stage[]) {
      expect(causeOfDeath({ ...aRun(), stage }, dungeon)).toBeUndefined();
    }
  });

  it("names the room and the turn", () => {
    const report = causeOfDeath(died(), dungeon)!;
    const room = dungeon.entities.rooms.find((r) => r.id === dungeon.stocked.entranceRoomId)!;
    expect(report.turn).toBe(23);
    expect(report.where).toContain(room.name);
  });

  /*
   * NAMED ONLY WHEN THE GAME ACTUALLY KNOWS. The last turn record carries the
   * target of the roll that was thrown, and a roll thrown at a creature on the
   * turn the hit points reached zero is as close to a killer as anything written
   * down gets.
   */
  it("names what the fatal turn was aimed at, when it was aimed at a creature", () => {
    const run = died();
    const creature = run.entities.creatures[0]!;
    run.currentRoomId = creature.roomId;
    run.turnRecords = [
      { turn: 23, action: "swing at it again", target: creature.id, outcome: "…", diffsApplied: 2 },
    ];

    const report = causeOfDeath(run, dungeon)!;
    expect(report.killer).toContain(creature.name);
    expect(report.lastAction).toBe("swing at it again");
  });

  // A turn that threw no dice — a hazard the referee resolved outright — leaves
  // this absent, and the screen says where they died rather than inventing who.
  it("accuses nobody when the fatal turn had no target", () => {
    const run = died();
    run.turnRecords = [{ turn: 23, action: "step onto the bridge", outcome: "…", diffsApplied: 1 }];
    expect(causeOfDeath(run, dungeon)!.killer).toBeUndefined();
  });

  /*
   * SEPARATE FROM `killer` ON PURPOSE. Nothing in the entity model marks a
   * creature hostile, so what was in the room and what killed them are two
   * different claims and must not be rendered as one.
   */
  it("lists what was standing there without calling any of it the killer", () => {
    const run = died();
    const creature = run.entities.creatures.find((c) => c.count === undefined || c.count > 0)!;
    run.currentRoomId = creature.roomId;

    const report = causeOfDeath(run, dungeon)!;
    expect(report.present.length).toBeGreaterThan(0);
    expect(report.killer).toBeUndefined();
  });

  it("does not list a group that has been wiped out", () => {
    const run = died();
    const creature = run.entities.creatures[0]!;
    run.currentRoomId = creature.roomId;
    creature.count = 0;

    expect(causeOfDeath(run, dungeon)!.present).not.toContain(creature.name);
  });
});
