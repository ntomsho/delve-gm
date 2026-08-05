import { beforeEach, describe, expect, it } from "vitest";
import { applyCommit } from "./apply.ts";
import { PLAYER_ID, type Commit, type Diff, type World } from "./types.ts";
import { normalizePath } from "./paths.ts";
import { roomIndex } from "../occupancy.ts";
import type {
  EntityPassResult,
  ICreature,
  IItem,
  IRoom,
  IRoomConnector,
  IRoomFeature,
  PlayerCharacter,
} from "../../engine/index.ts";

// ===========================================================================
// A SMALL WORLD
// ===========================================================================
// Two rooms joined by a barred door. A ghoul in the far room. The player
// carries a sword, a halberd, a shield and a gambeson, and there is a chest in
// the near room with a dagger inside it.

const ROOM_A = "room-a";
const ROOM_B = "room-b";

function item(id: string, over: Partial<IItem> = {}): IItem {
  return { id, name: id, type: "Item", base: `a ${id}`, parentId: ROOM_A, slots: 1, ...over };
}

function makeWorld(): World {
  const rooms: IRoom[] = [
    { id: ROOM_A, name: "Antechamber", type: "Room", base: "a cold antechamber" },
    { id: ROOM_B, name: "Cell", type: "Room", base: "a bare cell" },
  ];

  const connectors: IRoomConnector[] = [
    {
      id: "door", name: "Barred door", type: "RoomConnector", base: "a plank door",
      endpointA: ROOM_A, endpointB: ROOM_B, conditional: "barred from the far side",
    },
  ];

  const ghoul: ICreature = {
    id: "ghoul", name: "Ghoul", type: "Creature", base: "a lean grey thing",
    roomId: ROOM_B,
    stats: { hitDice: 2, hp: 8, modifiers: {} },
    narrative: { blueprintId: "tpl-ghoul" },
  };

  const chest: IRoomFeature = {
    id: "chest", name: "Iron chest", type: "RoomFeature", base: "a banded iron chest", roomId: ROOM_A,
  };
  const flagstone: IRoomFeature = {
    id: "flagstone", name: "Loose flagstone", type: "RoomFeature",
    base: "a flagstone worn smoother than its neighbours", roomId: ROOM_A, isHidden: true,
  };

  const entities = {
    registry: { creatures: { "tpl-ghoul": { id: "tpl-ghoul", seed: {} as never, base: "a lean grey thing" } }, hazards: {}, groups: {} },
    rooms,
    connectors,
    creatures: [ghoul],
    features: [chest, flagstone],
    items: [item("dagger", { parentId: "chest", weapon: { damage: "1d6", hands: 1 }, quality: 3, currentQuality: 3 })],
    hazards: [],
    effects: [],
    bindings: [],
    detailCandidates: [],
    pendingGoal: { roomId: ROOM_B, reward: "", mission: "", instruction: "" },
  } satisfies EntityPassResult;

  const pc: PlayerCharacter = {
    id: "pc-1",
    name: "Wren",
    level: 1,
    hp: { current: 6, max: 6 },
    abilities: { str: 2, dex: 1, con: 2, int: 1, wis: 1, cha: 1 },
    traits: {
      physique: "Wiry", face: "Bony", skin: "Ashen", hair: "Cropped", clothing: "Patched",
      virtue: "Cautious", vice: "Greedy", speech: "Blunt", background: "Burglar",
      misfortunes: "Exiled", alignment: "Neutrality",
    },
    inventory: [
      item("sword", { parentId: "pc-1", weapon: { damage: "1d8", hands: 1 }, quality: 3, currentQuality: 3 }),
      item("halberd", { parentId: "pc-1", weapon: { damage: "1d10", hands: 2 }, slots: 3, quality: 2, currentQuality: 2 }),
      item("shield", { parentId: "pc-1", armor: { armorType: "shield", defense: 1 }, quality: 1, currentQuality: 1 }),
      item("gambeson", { parentId: "pc-1", armor: { armorType: "body", defense: 12 }, quality: 3, currentQuality: 3 }),
    ],
    equipped: {},
    conditions: [],
  };

  return { entities, pc, currentRoomId: ROOM_A };
}

let world: World;
beforeEach(() => { world = makeWorld(); });

const commit = (...diffs: Diff[]): Commit => ({
  nextStage: "awaiting_action",
  nextStep: "1-target",
  diffs,
});

/** Apply and assert success, returning the new world. */
function ok(c: Commit): World {
  const r = applyCommit(world, c);
  expect(r.rejected.map((x) => x.reason)).toEqual([]);
  expect(r.ok).toBe(true);
  return r.world!;
}

// ===========================================================================
// WHAT MAY NOT BE WRITTEN
// ===========================================================================

describe("the read-only surface", () => {
  it.each([
    ["base", "base"],
    ["name", "name"],
    ["id", "id"],
    ["type", "type"],
    ["keywords", "keywords"],
    ["hit dice", "stats.hitDice"],
    ["modifiers", "stats.modifiers"],
    ["the blueprint", "narrative.blueprintId"],
  ])("refuses a write to %s", (_label, path) => {
    const r = applyCommit(world, commit({ entityId: "ghoul", path, value: "anything" }));
    expect(r.ok).toBe(false);
    expect(r.rejected[0].reason).toMatch(/no writable path/);
  });

  it("refuses the player's fixed sheet", () => {
    for (const path of ["abilities.str", "level", "hp.max", "traits.virtue"]) {
      const r = applyCommit(world, commit({ entityId: PLAYER_ID, path, value: 3 }));
      expect(r.ok, path).toBe(false);
    }
  });

  it("refuses an unknown path and says what it would accept", () => {
    const r = applyCommit(world, commit({ entityId: "door", path: "colour", value: "red" }));
    expect(r.ok).toBe(false);
    expect(r.rejected[0].reason).toContain("conditional");
  });

  it("refuses an id that does not exist", () => {
    const r = applyCommit(world, commit({ entityId: "no-such-thing", path: "state", value: "x" }));
    expect(r.rejected[0].reason).toMatch(/no entity with id/);
  });

  it("normalises indices so one rule covers every index", () => {
    expect(normalizePath("conditions[12]")).toBe("conditions[#]");
    expect(normalizePath("conditions[]")).toBe("conditions[]");
  });
});

// ===========================================================================
// ATOMICITY
// ===========================================================================

describe("atomicity", () => {
  it("one bad diff in a batch applies none of them", () => {
    const r = applyCommit(
      world,
      commit(
        { entityId: "ghoul", path: "state", value: "wounded" },
        { entityId: "door", path: "conditional", value: null },
        { entityId: "ghoul", path: "base", value: "rewritten" }, // refused
      )
    );
    expect(r.ok).toBe(false);
    expect(r.applied).toEqual([]);
    expect(r.world).toBeUndefined();
    // The original is untouched.
    expect(world.entities.creatures[0].state).toBeUndefined();
    expect(world.entities.connectors[0].conditional).toBe("barred from the far side");
  });

  it("collects every reason, so one retry can fix them all", () => {
    const r = applyCommit(
      world,
      commit(
        { entityId: "ghoul", path: "base", value: "x" },
        { entityId: "nope", path: "state", value: "y" },
      )
    );
    expect(r.rejected).toHaveLength(2);
  });

  it("a clarifying turn carrying diffs changes nothing", () => {
    const r = applyCommit(world, {
      nextStage: "clarifying",
      nextStep: "1-target",
      diffs: [{ entityId: "ghoul", path: "state", value: "wounded" }],
    });
    expect(r.ok).toBe(false);
    expect(r.rejected[0].reason).toMatch(/must not change the world/);
  });

  it("a rejected turn carrying diffs changes nothing", () => {
    const r = applyCommit(world, {
      nextStage: "rejected",
      nextStep: "1-target",
      diffs: [{ entityId: PLAYER_ID, path: "hp.current", value: 1 }],
    });
    expect(r.ok).toBe(false);
  });
});

// ===========================================================================
// PROSE
// ===========================================================================

describe("state and composed", () => {
  it("a state write marks it stale and keeps the old description", () => {
    const before = ok(commit({ entityId: "chest", path: "composed", value: "A banded chest, lid shut." }));
    world = before;
    const after = ok(commit({ entityId: "chest", path: "state", value: "lid splintered open" }));
    const chest = after.entities.features.find((f) => f.id === "chest")!;
    expect(chest.needUpdate).toBe(true);
    expect(chest.composed).toBe("A banded chest, lid shut.");
  });

  it("a composed write clears the flag", () => {
    const w = ok(
      commit(
        { entityId: "chest", path: "state", value: "open" },
        { entityId: "chest", path: "composed", value: "The chest stands open." },
      )
    );
    expect(w.entities.features.find((f) => f.id === "chest")!.needUpdate).toBe(false);
  });
});

// ===========================================================================
// THE DISPATCH TABLE
// ===========================================================================

describe("dropping — inventory[i] = null", () => {
  it("clears the slot, compacts, and leaves the item on the floor", () => {
    const w = ok(commit({ entityId: PLAYER_ID, path: "inventory[1]", value: null }));
    expect(w.pc.inventory.map((i) => i.id)).toEqual(["sword", "shield", "gambeson"]);
    const dropped = w.entities.items.find((i) => i.id === "halberd")!;
    expect(dropped.parentId).toBe(ROOM_A);
  });

  it("also clears an equipment slot pointing at it", () => {
    world = ok(commit({ entityId: PLAYER_ID, path: "equipped.weapon", value: "sword" }));
    const w = ok(commit({ entityId: PLAYER_ID, path: "inventory[0]", value: null }));
    expect(w.pc.equipped.weapon).toBeUndefined();
  });

  it("drops where the player is standing, not where the item was minted", () => {
    world.currentRoomId = ROOM_B;
    const w = ok(commit({ entityId: PLAYER_ID, path: "inventory[0]", value: null }));
    expect(w.entities.items.find((i) => i.id === "sword")!.parentId).toBe(ROOM_B);
  });

  it("refuses a non-null value and an out-of-range index", () => {
    expect(applyCommit(world, commit({ entityId: PLAYER_ID, path: "inventory[0]", value: "x" })).ok).toBe(false);
    expect(applyCommit(world, commit({ entityId: PLAYER_ID, path: "inventory[9]", value: null })).ok).toBe(false);
  });
});

describe("equipping — routed through the resolving form, not written", () => {
  it("taking up a two-hander puts the shield away by itself", () => {
    world = ok(commit({ entityId: PLAYER_ID, path: "equipped.shield", value: "shield" }));
    const r = applyCommit(world, commit({ entityId: PLAYER_ID, path: "equipped.weapon", value: "halberd" }));

    expect(r.ok).toBe(true);
    expect(r.world!.pc.equipped.weapon).toBe("halberd");
    expect(r.world!.pc.equipped.shield).toBeUndefined();
    // Reported, so the narration can say where the shield went.
    expect(r.events.some((e) => e.kind === "unequipped")).toBe(true);
  });

  it("and the same the other way round", () => {
    world = ok(commit({ entityId: PLAYER_ID, path: "equipped.weapon", value: "halberd" }));
    const r = applyCommit(world, commit({ entityId: PLAYER_ID, path: "equipped.shield", value: "shield" }));

    expect(r.ok).toBe(true);
    expect(r.world!.pc.equipped.shield).toBe("shield");
    expect(r.world!.pc.equipped.weapon).toBeUndefined();
  });

  it("leaves a one-handed weapon alone beside a shield", () => {
    world = ok(commit({ entityId: PLAYER_ID, path: "equipped.shield", value: "shield" }));
    const w = ok(commit({ entityId: PLAYER_ID, path: "equipped.weapon", value: "sword" }));
    expect(w.pc.equipped.shield).toBe("shield");
    expect(w.pc.equipped.weapon).toBe("sword");
  });

  it("displaces nothing when the equip itself is refused", () => {
    world = ok(commit({ entityId: PLAYER_ID, path: "equipped.shield", value: "shield" }));
    // "dagger" is not carried, so this fails — and must not have quietly
    // dropped the shield on its way to failing.
    const r = applyCommit(world, commit({ entityId: PLAYER_ID, path: "equipped.weapon", value: "dagger" }));
    expect(r.ok).toBe(false);
    expect(world.pc.equipped.shield).toBe("shield");
  });

  it("refuses the wrong kind of thing for a slot", () => {
    const r = applyCommit(world, commit({ entityId: PLAYER_ID, path: "equipped.armor", value: "shield" }));
    expect(r.ok).toBe(false);
    expect(r.rejected[0].reason).toMatch(/body armor/);
  });

  it("refuses something not carried", () => {
    const r = applyCommit(world, commit({ entityId: PLAYER_ID, path: "equipped.weapon", value: "dagger" }));
    expect(r.ok).toBe(false);
  });

  it("null empties the slot", () => {
    world = ok(commit({ entityId: PLAYER_ID, path: "equipped.weapon", value: "sword" }));
    const w = ok(commit({ entityId: PLAYER_ID, path: "equipped.weapon", value: null }));
    expect(w.pc.equipped.weapon).toBeUndefined();
  });

  it("lets a later diff resolve a conflict an earlier one created", () => {
    // The whole reason the batch runs against a draft rather than being
    // pre-validated against the starting state.
    world = ok(commit({ entityId: PLAYER_ID, path: "equipped.shield", value: "shield" }));
    const w = ok(
      commit(
        { entityId: PLAYER_ID, path: "equipped.shield", value: null },
        { entityId: PLAYER_ID, path: "equipped.weapon", value: "halberd" },
      )
    );
    expect(w.pc.equipped.weapon).toBe("halberd");
    expect(w.pc.equipped.shield).toBeUndefined();
  });
});

describe("picking up — parentId", () => {
  it("moves a world item into the inventory", () => {
    const w = ok(commit({ entityId: "dagger", path: "parentId", value: PLAYER_ID }));
    expect(w.pc.inventory.map((i) => i.id)).toContain("dagger");
    expect(w.entities.items.find((i) => i.id === "dagger")).toBeUndefined();
  });

  it("accepts an over-capacity pickup and flags it rather than refusing", () => {
    // Capacity is CON defense = 12. Load up past it.
    for (let i = 0; i < 12; i++) world.entities.items.push(item(`rock-${i}`));
    const r = applyCommit(
      world,
      commit(...Array.from({ length: 12 }, (_, i) => ({ entityId: `rock-${i}`, path: "parentId", value: PLAYER_ID })))
    );
    expect(r.ok).toBe(true);
    expect(r.events.some((e) => e.kind === "overburdened")).toBe(true);
  });

  it("moves an item back out into a room", () => {
    const w = ok(commit({ entityId: "sword", path: "parentId", value: ROOM_B }));
    expect(w.pc.inventory.map((i) => i.id)).not.toContain("sword");
    expect(w.entities.items.find((i) => i.id === "sword")!.parentId).toBe(ROOM_B);
  });

  it("null removes it from the world", () => {
    const w = ok(commit({ entityId: "dagger", path: "parentId", value: null }));
    expect(w.entities.items.find((i) => i.id === "dagger")).toBeUndefined();
  });

  it("refuses a holder that does not exist", () => {
    expect(applyCommit(world, commit({ entityId: "dagger", path: "parentId", value: "nowhere" })).ok).toBe(false);
  });
});

describe("quality", () => {
  it("destroys at zero and clears the slot it filled", () => {
    world = ok(commit({ entityId: PLAYER_ID, path: "equipped.shield", value: "shield" }));
    const r = applyCommit(world, commit({ entityId: "shield", path: "currentQuality", value: 0 }));
    expect(r.ok).toBe(true);
    expect(r.world!.pc.inventory.map((i) => i.id)).not.toContain("shield");
    expect(r.world!.pc.equipped.shield).toBeUndefined();
    expect(r.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["item-destroyed", "unequipped"]));
  });

  it("clamps to the item's original quality", () => {
    const w = ok(commit({ entityId: "sword", path: "currentQuality", value: 99 }));
    expect(w.pc.inventory.find((i) => i.id === "sword")!.currentQuality).toBe(3);
  });

  it("clamps a negative to zero, which destroys it", () => {
    const r = applyCommit(world, commit({ entityId: "sword", path: "currentQuality", value: -4 }));
    expect(r.world!.pc.inventory.find((i) => i.id === "sword")).toBeUndefined();
  });
});

describe("creatures", () => {
  it("dies at zero hp and drops what it carried where it stood", () => {
    world.entities.items.push(item("keyring", { parentId: "ghoul" }));
    const r = applyCommit(world, commit({ entityId: "ghoul", path: "stats.hp", value: 0 }));
    expect(r.ok).toBe(true);
    expect(r.world!.entities.creatures).toHaveLength(0);
    expect(r.world!.entities.items.find((i) => i.id === "keyring")!.parentId).toBe(ROOM_B);
    expect(r.events.some((e) => e.kind === "creature-slain")).toBe(true);
  });

  it("dies on overkill too, and the negative is not floored away", () => {
    const r = applyCommit(world, commit({ entityId: "ghoul", path: "stats.hp", value: -12 }));
    expect(r.world!.entities.creatures).toHaveLength(0);
  });

  it("clamps healing to its maximum", () => {
    const w = ok(commit({ entityId: "ghoul", path: "stats.hp", value: 999 }));
    expect(w.entities.creatures[0].stats.hp).toBe(8); // hitDice 2 x 4
  });

  it("a count of zero wipes the group out", () => {
    world.entities.creatures[0].count = 5;
    const r = applyCommit(world, commit({ entityId: "ghoul", path: "count", value: 0 }));
    expect(r.world!.entities.creatures).toHaveLength(0);
  });

  it("moving keeps the derived index consistent, with nothing else to update", () => {
    const w = ok(commit({ entityId: "ghoul", path: "roomId", value: ROOM_A }));
    const index = roomIndex(w.entities);
    expect(index.get(ROOM_A)!.map((e) => e.id)).toContain("ghoul");
    expect(index.get(ROOM_B)!.map((e) => e.id)).not.toContain("ghoul");
  });

  it("refuses a move to something that is not a room", () => {
    expect(applyCommit(world, commit({ entityId: "ghoul", path: "roomId", value: "chest" })).ok).toBe(false);
  });
});

describe("the player", () => {
  it("reports death at or below zero, and does not floor the overkill", () => {
    const r = applyCommit(world, commit({ entityId: PLAYER_ID, path: "hp.current", value: -3 }));
    expect(r.world!.pc.hp.current).toBe(-3);
    expect(r.events.some((e) => e.kind === "player-died")).toBe(true);
  });

  it("treats exactly zero as death", () => {
    const r = applyCommit(world, commit({ entityId: PLAYER_ID, path: "hp.current", value: 0 }));
    expect(r.events.some((e) => e.kind === "player-died")).toBe(true);
  });

  it("clamps healing to maximum", () => {
    const w = ok(commit({ entityId: PLAYER_ID, path: "hp.current", value: 40 }));
    expect(w.pc.hp.current).toBe(6);
  });

  it("adds and clears conditions", () => {
    world = ok(commit(
      { entityId: PLAYER_ID, path: "conditions[]", value: "poisoned" },
      { entityId: PLAYER_ID, path: "conditions[]", value: "leg wound" },
    ));
    expect(world.pc.conditions).toEqual(["poisoned", "leg wound"]);
    const w = ok(commit({ entityId: PLAYER_ID, path: "conditions[0]", value: null }));
    expect(w.pc.conditions).toEqual(["leg wound"]);
  });
});

describe("connectors, features, hazards", () => {
  it("null opens a way through by deleting the field, not storing a null", () => {
    const w = ok(commit({ entityId: "door", path: "conditional", value: null }));
    expect("conditional" in w.entities.connectors[0]).toBe(false);
  });

  it("sets a new barrier", () => {
    const w = ok(commit({ entityId: "door", path: "conditional", value: "wedged shut" }));
    expect(w.entities.connectors[0].conditional).toBe("wedged shut");
  });

  it("reveals a hidden feature", () => {
    const w = ok(commit({ entityId: "flagstone", path: "isHidden", value: false }));
    expect(w.entities.features.find((f) => f.id === "flagstone")!.isHidden).toBe(false);
  });

  it("refuses a non-boolean for isHidden", () => {
    expect(applyCommit(world, commit({ entityId: "flagstone", path: "isHidden", value: "yes" })).ok).toBe(false);
  });

  it("can conceal anything, not just features", () => {
    // A door behind a tapestry, a coin under a flagstone, something waiting in
    // the dark — concealment is a property of being unnoticed, not of a type.
    for (const id of ["door", "ghoul", "dagger", "chest"]) {
      const r = applyCommit(world, commit({ entityId: id, path: "isHidden", value: true }));
      expect(r.ok, id).toBe(true);
    }
  });

  it("will not conceal a room", () => {
    // The map reads a written description as "the player has been here", which
    // only holds while rooms cannot be hidden.
    const r = applyCommit(world, commit({ entityId: ROOM_A, path: "isHidden", value: true }));
    expect(r.ok).toBe(false);
    expect(r.rejected[0].reason).toMatch(/no writable path/);
  });
});

// ===========================================================================
// CREATION
// ===========================================================================

describe("children[] — newly established things", () => {
  it("creates an item on the thing that holds it", () => {
    const r = applyCommit(
      world,
      commit({
        entityId: "ghoul",
        path: "children[]",
        value: { type: "Item", name: "iron keyring", base: "a ring of iron keys" },
      })
    );
    expect(r.ok).toBe(true);
    const created = r.world!.entities.items.find((i) => i.name === "iron keyring")!;
    expect(created.parentId).toBe("ghoul");
    expect(r.events.some((e) => e.kind === "entity-created")).toBe(true);
  });

  it("puts a created feature in the room its holder is in", () => {
    const w = ok(commit({
      entityId: "ghoul",
      path: "children[]",
      value: { type: "RoomFeature", name: "scratched tally", base: "marks gouged into the wall" },
    }));
    expect(w.entities.features.find((f) => f.name === "scratched tally")!.roomId).toBe(ROOM_B);
  });

  it("a ref lets a later diff in the same commit address it", () => {
    const w = ok(
      commit(
        {
          entityId: "ghoul",
          path: "children[]",
          value: { type: "Item", name: "iron keyring", base: "a ring of keys", ref: "keys" },
        },
        { entityId: "keys", path: "parentId", value: PLAYER_ID },
      )
    );
    expect(w.pc.inventory.map((i) => i.name)).toContain("iron keyring");
  });

  it("creating into the player's hands works", () => {
    const w = ok(commit({
      entityId: PLAYER_ID,
      path: "children[]",
      value: { type: "Item", name: "torn map", base: "a scrap of vellum" },
    }));
    expect(w.pc.inventory.map((i) => i.name)).toContain("torn map");
  });

  it("refuses a half-formed spec", () => {
    for (const value of [{ type: "Item", name: "x" }, { type: "Item", base: "y" }, {}, null]) {
      expect(applyCommit(world, commit({ entityId: ROOM_A, path: "children[]", value })).ok).toBe(false);
    }
  });

  it("refuses creating a creature, which needs a stat block generation owns", () => {
    const r = applyCommit(
      world,
      commit({ entityId: ROOM_A, path: "children[]", value: { type: "Creature", name: "rat", base: "a rat" } })
    );
    expect(r.ok).toBe(false);
    expect(r.rejected[0].reason).toMatch(/only Item and RoomFeature/);
  });
});
