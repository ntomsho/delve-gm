import { beforeEach, describe, expect, it } from "vitest";
import { applyCommit } from "./apply.ts";
import { PLAYER_ID, type Commit, type Diff, type World } from "./types.ts";
import { normalizePath } from "./paths.ts";
import { roomIndex } from "../occupancy.ts";
import { isBook } from "../../engine/index.ts";
import type {
  EntityPassResult,
  ICreature,
  AnyItem,
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
// the near room with a dagger and a herbal inside it.

const ROOM_A = "room-a";
const ROOM_B = "room-b";
/** On the map, reachable from neither — the far side of a move that isn't one. */
const ROOM_C = "room-c";

function item(id: string, over: Partial<AnyItem> = {}): AnyItem {
  return { id, name: id, type: "Item", base: `a ${id}`, parentId: ROOM_A, slots: 1, value: 0, ...over } as AnyItem;
}

function makeWorld(): World {
  const rooms: IRoom[] = [
    { id: ROOM_A, name: "Antechamber", type: "Room", base: "a cold antechamber" },
    { id: ROOM_B, name: "Cell", type: "Room", base: "a bare cell" },
    { id: ROOM_C, name: "Sacristy", type: "Room", base: "a room off the map" },
  ];

  // A and B are joined twice — a barred door and an open arch — because a move
  // is refused only when EVERY way across is shut, and one of each is what says
  // so. C is joined to nothing.
  const connectors: IRoomConnector[] = [
    {
      id: "door", name: "Barred door", type: "RoomConnector", base: "a plank door",
      endpointA: ROOM_A, endpointB: ROOM_B, conditional: "barred from the far side",
    },
    {
      id: "arch", name: "Low arch", type: "RoomConnector", base: "a low arch",
      endpointA: ROOM_A, endpointB: ROOM_B,
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
    items: [
      item("dagger", { parentId: "chest", itemKind: "weapon", weapon: { damage: "1d6", hands: 1 }, quality: 3, currentQuality: 3 }),
      item("herbal", { parentId: "chest", itemKind: "book", book: { subject: "Herbs", uses: 3 } }),
    ],
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
      item("sword", { parentId: "pc-1", itemKind: "weapon", weapon: { damage: "1d8", hands: 1 }, quality: 3, currentQuality: 3 }),
      item("halberd", { parentId: "pc-1", itemKind: "weapon", weapon: { damage: "1d10", hands: 2 }, slots: 3, quality: 2, currentQuality: 2 }),
      item("shield", { parentId: "pc-1", itemKind: "armor", armor: { armorType: "shield", defense: 1 }, quality: 1, currentQuality: 1 }),
      item("gambeson", { parentId: "pc-1", itemKind: "armor", armor: { armorType: "body", defense: 12 }, quality: 3, currentQuality: 3 }),
    ],
    equipped: {},
    conditions: [],
  };

  return { entities, pc, currentRoomId: ROOM_A, goalMet: false, fiction: [] };
}

let world: World;
beforeEach(() => { world = makeWorld(); });

const commit = (...diffs: Diff[]): Commit => ({
  nextStage: "awaiting_action",
  nextStep: "1-target",
  timeSpent: "instant",
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
      timeSpent: "instant",
      nextStep: "1-target",
      diffs: [{ entityId: "ghoul", path: "state", value: "wounded" }],
    });
    expect(r.ok).toBe(false);
    expect(r.rejected[0].reason).toMatch(/must not change the world/);
  });

  it("a rejected turn carrying diffs changes nothing", () => {
    const r = applyCommit(world, {
      nextStage: "rejected",
      timeSpent: "instant",
      nextStep: "1-target",
      diffs: [{ entityId: PLAYER_ID, path: "hp.current", value: 1 }],
    });
    expect(r.ok).toBe(false);
  });

  // The fiction is part of the world for this purpose: a turn that turned the
  // action away established nothing, least of all about the dungeon.
  it("a rejected turn cannot write the fiction either", () => {
    const r = applyCommit(world, {
      nextStage: "rejected",
      timeSpent: "instant",
      nextStep: "1-target",
      diffs: [],
      fictionNote: "The gaol was built over a mine.",
    });
    expect(r.ok).toBe(false);
    expect(r.rejected[0].reason).toMatch(/adding to its fiction/);
  });
});

// ===========================================================================
// THE DUNGEON'S OWN STORY
// ===========================================================================

describe("fictionNote", () => {
  const note = (fictionNote: string): Commit => ({
    nextStage: "awaiting_action",
    timeSpent: "instant",
    nextStep: "1-target",
    diffs: [],
    fictionNote,
  });

  it("appends, oldest first", () => {
    world = ok(note("The gaol was built over a mine."));
    world = ok(note("The mine flooded in the winter of the collapse."));
    expect(world.fiction).toEqual([
      "The gaol was built over a mine.",
      "The mine flooded in the winter of the collapse.",
    ]);
  });

  // A refused commit is written again, and a referee restating the same fact on
  // the retry should not leave it on the list twice.
  it("does not stack the same fact twice", () => {
    world = ok(note("The gaol was built over a mine."));
    world = ok(note("  The gaol was built over a mine.  "));
    expect(world.fiction).toHaveLength(1);
  });

  it("goes down with a batch that is refused for anything else", () => {
    const r = applyCommit(world, {
      ...note("The gaol was built over a mine."),
      diffs: [{ entityId: "ghoul", path: "base", value: "rewritten" }],
    });
    expect(r.ok).toBe(false);
    expect(world.fiction).toEqual([]);
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

  it("refuses an out-of-range index, and says how to put something IN", () => {
    const r = applyCommit(world, commit({ entityId: PLAYER_ID, path: "inventory[9]", value: null }));
    expect(r.ok).toBe(false);
    // "nothing carried at index 9" is true and useless. A refusal the referee
    // cannot act on turns a retry into the same mistake twice — 8a A2.
    expect(r.rejected[0].reason).toContain("inventory[]");
    expect(r.rejected[0].reason).toContain("parentId");
  });
});

// ===========================================================================
// PICKING UP — inventory[…] = an item. 8a A2.
// ===========================================================================

/**
 * The referee reached for this three times in one playtest to say "they now
 * have this", and was refused three times. It is the path that most obviously
 * names where a thing ended up, and stating a destination value is what the
 * envelope asks for — so the vocabulary was inviting the mistake it refused.
 */
describe("picking up — inventory[…] = an item", () => {
  it("takes an item that already exists in the world, by id", () => {
    const w = ok(commit({ entityId: PLAYER_ID, path: "inventory[]", value: "dagger" }));

    expect(w.pc.inventory.map((i) => i.id)).toEqual(["sword", "halberd", "shield", "gambeson", "dagger"]);
    expect(w.pc.inventory.at(-1)!.parentId).toBe("pc-1");
    // Out of the chest it was in, and out of the world's list — carried once,
    // not in two places at once.
    expect(w.entities.items.some((i) => i.id === "dagger")).toBe(false);
  });

  it("mints a whole new entity, the way the search finds did", () => {
    const w = ok(
      commit({
        entityId: PLAYER_ID,
        path: "inventory[7]",
        value: { type: "Item", name: "Iron key", base: "a cold iron key, its bit worn round" },
      })
    );

    const key = w.pc.inventory.find((i) => i.name === "Iron key")!;
    expect(key).toBeDefined();
    expect(key.id).not.toBe("");
    expect(key.parentId).toBe("pc-1");
  });

  // The exact refusal from the run: seven items carried, written to index 8.
  // An index past the end is not a reason to lose the turn — the inventory is
  // compacted, so a pickup appends however it was addressed.
  it("ignores the stated index and appends", () => {
    const w = ok(commit({ entityId: PLAYER_ID, path: "inventory[8]", value: "dagger" }));
    expect(w.pc.inventory.at(-1)!.id).toBe("dagger");
    expect(w.pc.inventory).toHaveLength(5);
  });

  it("is the same operation as parentId to the player, whichever is written", () => {
    const viaIndex = ok(commit({ entityId: PLAYER_ID, path: "inventory[]", value: "dagger" }));
    world = makeWorld();
    const viaParent = ok(commit({ entityId: "dagger", path: "parentId", value: PLAYER_ID }));

    expect(viaIndex.pc.inventory.map((i) => i.id)).toEqual(viaParent.pc.inventory.map((i) => i.id));
    expect(viaIndex.entities.items.map((i) => i.id)).toEqual(viaParent.entities.items.map((i) => i.id));
  });

  it("reports overburdening rather than refusing the pickup", () => {
    // The fiction has already committed to it by the time the diff lands.
    const r = applyCommit(
      world,
      commit({
        entityId: PLAYER_ID,
        path: "inventory[]",
        value: { type: "Item", name: "Anvil", base: "a blacksmith's anvil", slots: 40 },
      })
    );

    expect(r.ok).toBe(true);
    expect(r.events.some((e) => e.kind === "overburdened")).toBe(true);
  });

  it("refuses an id that is not an item, and names what it is", () => {
    const r = applyCommit(world, commit({ entityId: PLAYER_ID, path: "inventory[]", value: "chest" }));
    expect(r.ok).toBe(false);
    expect(r.rejected[0].reason).toContain("RoomFeature");
  });

  it("refuses an id that resolves to nothing at all", () => {
    expect(
      applyCommit(world, commit({ entityId: PLAYER_ID, path: "inventory[0]", value: "no-such-thing" })).ok
    ).toBe(false);
  });

  it("does not take the same item twice", () => {
    const w = ok(
      commit(
        { entityId: PLAYER_ID, path: "inventory[]", value: "dagger" },
        { entityId: PLAYER_ID, path: "inventory[]", value: "dagger" }
      )
    );
    expect(w.pc.inventory.filter((i) => i.id === "dagger")).toHaveLength(1);
  });
});

// ===========================================================================
// A CARRIED THING CANNOT BE DISCOVERED. 8a A3.
// ===========================================================================

/**
 * The lantern. Told to reveal something found in the stables and told never to
 * invent an id, the referee reached for the player's own lantern and described
 * it lying in the straw. Every path it wrote was writable, so the commit was
 * accepted and the player's belongings became scenery in a room across the
 * dungeon. `isHidden` on a carried item is the one part of that which cannot
 * mean anything else.
 */
describe("revealing — isHidden on something the player is holding", () => {
  it("refuses it, and says the found thing is a different thing", () => {
    const r = applyCommit(world, commit({ entityId: "sword", path: "isHidden", value: false }));

    expect(r.ok).toBe(false);
    expect(r.rejected[0].reason).toContain("children[]");
    expect(r.rejected[0].reason).toContain("inventory");
  });

  // The commit as it actually arrived, at seq 454: prose and a reveal
  // together. Atomicity is what makes the guard worth having — refusing the
  // reveal takes the invented description down with it.
  it("takes the invented prose down with it", () => {
    const r = applyCommit(
      world,
      commit(
        { entityId: "sword", path: "state", value: "half-buried in old straw" },
        { entityId: "sword", path: "composed", value: "A sword lies half-buried in the straw." },
        { entityId: "sword", path: "isHidden", value: false }
      )
    );

    expect(r.ok).toBe(false);
    expect(world.pc.inventory.find((i) => i.id === "sword")!.composed).toBeUndefined();
  });

  it("still lets a loose item in the world be revealed", () => {
    const w = ok(commit({ entityId: "dagger", path: "isHidden", value: false }));
    expect(w.entities.items.find((i) => i.id === "dagger")!.isHidden).not.toBe(true);
  });

  it("still lets a carried item be described, worn down, and put back", () => {
    const w = ok(
      commit(
        { entityId: "sword", path: "state", value: "notched along the edge" },
        { entityId: "sword", path: "currentQuality", value: 2 }
      )
    );
    expect(w.pc.inventory.find((i) => i.id === "sword")!.currentQuality).toBe(2);
  });

  // Putting something down is not concealing it, and the two must not be
  // confused: `parentId` to the current room is the documented drop.
  it("still lets a carried item be dropped into the room", () => {
    const w = ok(commit({ entityId: "sword", path: "parentId", value: ROOM_A }));
    expect(w.pc.inventory.some((i) => i.id === "sword")).toBe(false);
    expect(w.entities.items.find((i) => i.id === "sword")!.parentId).toBe(ROOM_A);
  });

  it("refuses concealing a carried thing too — the sheet shows it either way", () => {
    expect(applyCommit(world, commit({ entityId: "sword", path: "isHidden", value: true })).ok).toBe(false);
  });
});

// ===========================================================================
// PICKING UP SOMETHING CONCEALED. 8a A8 — the regression A3 introduced.
// ===========================================================================

/**
 * The ledger. Found on the library shelves, and taking it is the obvious pair:
 * `parentId` to the player, `isHidden` to false. The guard above read the
 * DRAFT, so by the time the reveal was checked the pickup beside it had already
 * put the ledger in the inventory — and it refused a commit for a state it had
 * itself just produced. Atomicity took the pickup down too, and the retry read
 * "it is in their inventory" as "nothing left to do" and committed nothing at
 * all. Three turns to pick up one book.
 *
 * The guard asks about the state the turn STARTED in, which is what "they were
 * already holding it" ever meant.
 */
describe("picking up something concealed — 8a A8", () => {
  /** A hidden thing standing in the room, on the chest. */
  beforeEach(() => {
    world.entities.items.push(item("ledger", { parentId: "chest", isHidden: true }));
  });

  it("takes it and reveals it in one commit", () => {
    const w = ok(
      commit(
        { entityId: "ledger", path: "parentId", value: PLAYER_ID },
        { entityId: "ledger", path: "isHidden", value: false }
      )
    );

    const held = w.pc.inventory.find((i) => i.id === "ledger");
    expect(held).toBeDefined();
    expect(held!.isHidden).not.toBe(true);
  });

  // The referee writes the pair in whichever order it thinks of them, and a
  // guard that only tolerates one of the two orders is the same bug wearing a
  // different hat.
  it("in either order", () => {
    const w = ok(
      commit(
        { entityId: "ledger", path: "isHidden", value: false },
        { entityId: "ledger", path: "parentId", value: PLAYER_ID }
      )
    );
    expect(w.pc.inventory.find((i) => i.id === "ledger")!.isHidden).not.toBe(true);
  });

  // A3's case, restated against the fixture this block adds, so the two live
  // side by side: what the turn FOUND may be revealed, what it walked in
  // carrying may not.
  it("still refuses a reveal of something carried before the turn began", () => {
    const r = applyCommit(
      world,
      commit(
        { entityId: "ledger", path: "parentId", value: PLAYER_ID },
        { entityId: "sword", path: "isHidden", value: false }
      )
    );
    expect(r.ok).toBe(false);
    expect(r.rejected[0].reason).toContain("when this turn began");
  });

  // A2's second half: a refusal that does not name the way through is what
  // sent the R2 retry off in the first place.
  it("names the pickup as the way through when it does refuse", () => {
    const r = applyCommit(world, commit({ entityId: "sword", path: "isHidden", value: false }));
    expect(r.rejected[0].reason).toContain("parentId");
    expect(r.rejected[0].reason).toContain("same commit");
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

  it("moves between rooms, and takes the drop point with them", () => {
    const w = ok(commit({ entityId: PLAYER_ID, path: "roomId", value: ROOM_B }));
    expect(w.currentRoomId).toBe(ROOM_B);
    expect(world.currentRoomId).toBe(ROOM_A); // the original is untouched

    // Where the player stands is where dropped things land, so the two must
    // move together or a drop lands a room behind.
    world = w;
    const after = ok(commit(
      { entityId: "dagger", path: "parentId", value: PLAYER_ID },
      { entityId: PLAYER_ID, path: "inventory[4]", value: null },
    ));
    expect(after.entities.items.find((i) => i.id === "dagger")!.parentId).toBe(ROOM_B);
  });

  it("refuses a move to something that is not a room", () => {
    for (const target of ["ghoul", "chest", "nowhere"]) {
      const r = applyCommit(world, commit({ entityId: PLAYER_ID, path: "roomId", value: target }));
      expect(r.ok).toBe(false);
      expect(r.world).toBeUndefined();
    }
  });

  // The player walks. A referee that picked the wrong exit used to put them
  // somewhere no corridor reaches, silently, and the arrival pass then described
  // that room as though they had walked into it.
  it("refuses a move to a room nothing connects to", () => {
    const r = applyCommit(world, commit({ entityId: PLAYER_ID, path: "roomId", value: ROOM_C }));
    expect(r.ok).toBe(false);
    expect(r.rejected[0]!.reason).toMatch(/no way leads/);
  });

  // A barred way is not an error — it is a thing to be standing in front of.
  it("stops them where they are when every way across is blocked", () => {
    world.entities.connectors = world.entities.connectors.filter((c) => c.id !== "arch");
    const r = applyCommit(world, commit({ entityId: PLAYER_ID, path: "roomId", value: ROOM_B }));
    expect(r.ok).toBe(true);
    expect(r.world!.currentRoomId).toBe(ROOM_A);
    expect(r.events.find((e) => e.kind === "movement-stopped")!.detail).toMatch(
      /barred from the far side/
    );
  });

  // Unbar the door and walk through it is one commit. The check reads the world
  // as the earlier diffs left it, so the batch has to hold together on its own
  // terms rather than against the state it started from.
  it("allows a move through a way the same commit opens", () => {
    world.entities.connectors = world.entities.connectors.filter((c) => c.id !== "arch");
    const w = ok(commit(
      { entityId: "door", path: "conditional", value: null },
      { entityId: PLAYER_ID, path: "roomId", value: ROOM_B },
    ));
    expect(w.currentRoomId).toBe(ROOM_B);
  });

  it("allows a move to the room they are already in", () => {
    const w = ok(commit({ entityId: PLAYER_ID, path: "roomId", value: ROOM_A }));
    expect(w.currentRoomId).toBe(ROOM_A);
  });

  // Which way they came in by is the applier's to know: it is the thing that
  // routed the walk, and a room can have more than one way into it.
  it("records the way they came in by", () => {
    const w = ok(commit({ entityId: PLAYER_ID, path: "roomId", value: ROOM_B }));
    // The open arch, not the barred door.
    expect(w.arrivedVia).toBe("arch");
  });

  it("records the last way crossed when a walk ends short", () => {
    world.entities.connectors = world.entities.connectors.filter((c) => c.id !== "arch");
    const r = applyCommit(world, commit({ entityId: PLAYER_ID, path: "roomId", value: ROOM_B }));
    // They never crossed anything, so there is nothing behind them to name.
    expect(r.world!.arrivedVia).toBeUndefined();
  });

  it("leaves it alone when the walk covers no ground", () => {
    world.arrivedVia = "arch";
    const w = ok(commit({ entityId: PLAYER_ID, path: "roomId", value: ROOM_A }));
    expect(w.arrivedVia).toBe("arch");
  });
});

// ===========================================================================
// THE WAY OUT
// ===========================================================================

describe("leaving the dungeon", () => {
  const depart = (over: Partial<Commit> = {}): Commit => ({
    nextStage: "departed",
    nextStep: "5-resolution",
    timeSpent: "instant",
    diffs: [],
    ...over,
  });

  /** A way to the surface from ROOM_A, in whatever condition is asked for. */
  const surface = (over: Partial<IRoomConnector> = {}) =>
    world.entities.connectors.push({
      id: "stair", name: "Worn stair", type: "RoomConnector", base: "steps up to daylight",
      endpointA: ROOM_A, endpointB: null, ...over,
    });

  it("is refused from a room with no way to the surface", () => {
    const r = applyCommit(world, depart());
    expect(r.ok).toBe(false);
    expect(r.rejected[0]!.reason).toMatch(/no way to the surface/);
  });

  it("is refused when the way out is blocked", () => {
    surface({ conditional: "the rubble has not shifted" });
    const r = applyCommit(world, depart());
    expect(r.ok).toBe(false);
    expect(r.rejected[0]!.reason).toMatch(/the rubble has not shifted/);
  });

  // Clear the rubble and climb out is one commit — the check runs after the
  // diffs, so the batch has to hold together on its own terms.
  it("is allowed through a way the same commit opens", () => {
    surface({ conditional: "the rubble has not shifted" });
    const r = applyCommit(
      world,
      depart({ diffs: [{ entityId: "stair", path: "conditional", value: null }] })
    );
    expect(r.ok).toBe(true);
  });

  it("is allowed when the room has an open way out", () => {
    surface();
    expect(applyCommit(world, depart()).ok).toBe(true);
  });

  /** An ordinary turn that reports the objective done. Not itself an ending. */
  const achieve = (): Commit => ({
    nextStage: "awaiting_action",
    timeSpent: "instant",
    nextStep: "1-target",
    diffs: [],
    goalMet: true,
  });

  // The goal LATCHES: the applier is the one place that can be sure a referee
  // which stops mentioning it has not taken the win back.
  it("latches the goal, and never unlatches it", () => {
    world = ok(achieve());
    expect(world.goalMet).toBe(true);

    // A later commit that says nothing about it leaves it standing.
    expect(ok(commit({ entityId: PLAYER_ID, path: "hp.current", value: 5 })).goalMet).toBe(true);
  });

  it("reports the goal as an event the turn it is met, and only then", () => {
    const first = applyCommit(world, achieve());
    expect(first.events.some((e) => e.kind === "goal-met")).toBe(true);

    const again = applyCommit(first.world!, achieve());
    expect(again.events.some((e) => e.kind === "goal-met")).toBe(false);
  });

  // A way out is a terminus, not an edge: a route that took it would end the
  // run on the way to somewhere else.
  it("is never used as a step in a walk", () => {
    surface();
    const r = applyCommit(world, commit({ entityId: PLAYER_ID, path: "roomId", value: ROOM_C }));
    expect(r.ok).toBe(false);
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
    const created = r.world!.entities.items.find((i) => i.name === "Iron keyring")!;
    expect(created.parentId).toBe("ghoul");
    expect(r.events.some((e) => e.kind === "entity-created")).toBe(true);
  });

  // 8f. The name arrives in whatever register the sentence around it was in,
  // and it is going to be set beside "Iron chest" in the room card. Capitalised
  // at the mint, first letter only — see `properName`.
  it("capitalises the name it was handed", () => {
    const w = ok(commit({
      entityId: "ghoul",
      path: "children[]",
      value: { type: "Item", name: "unmarked ledger of the warden", base: "a thin ledger" },
    }));
    expect(w.entities.items.map((i) => i.name)).toContain("Unmarked ledger of the warden");
  });

  it("puts a created feature in the room its holder is in", () => {
    const w = ok(commit({
      entityId: "ghoul",
      path: "children[]",
      value: { type: "RoomFeature", name: "scratched tally", base: "marks gouged into the wall" },
    }));
    expect(w.entities.features.find((f) => f.name === "Scratched tally")!.roomId).toBe(ROOM_B);
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
    expect(w.pc.inventory.map((i) => i.name)).toContain("Iron keyring");
  });

  it("creating into the player's hands works", () => {
    const w = ok(commit({
      entityId: PLAYER_ID,
      path: "children[]",
      value: { type: "Item", name: "torn map", base: "a scrap of vellum" },
    }));
    expect(w.pc.inventory.map((i) => i.name)).toContain("Torn map");
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

// ---------------------------------------------------------------------------
// BOOKS
// ---------------------------------------------------------------------------

describe("consulting a book", () => {
  const book = (w: World) => {
    const it = w.entities.items.find((i) => i.id === "herbal")!;
    return isBook(it) ? it.book : undefined;
  };

  it("records a reading", () => {
    expect(book(ok(commit({ entityId: "herbal", path: "book.uses", value: 4 })))?.uses).toBe(4);
  });

  // One reading at a time and none un-read: the count is what `consultRoll`
  // just handed back, and any other number is the referee inventing one.
  it("only ever counts up, and only ever by one", () => {
    expect(book(ok(commit({ entityId: "herbal", path: "book.uses", value: 9 })))?.uses).toBe(4);
    expect(book(ok(commit({ entityId: "herbal", path: "book.uses", value: 1 })))?.uses).toBe(3);
  });

  it("reads a book out without destroying it", () => {
    const w = ok(
      commit(
        { entityId: "herbal", path: "book.uses", value: 4 },
        { entityId: "herbal", path: "book.exhausted", value: true }
      )
    );
    expect(book(w)?.exhausted).toBe(true);
    expect(w.entities.items.some((i) => i.id === "herbal")).toBe(true);
  });

  it("says so, so the narration can acknowledge it", () => {
    const r = applyCommit(makeWorld(), commit({ entityId: "herbal", path: "book.exhausted", value: true }));
    expect(r.events.some((e) => e.kind === "book-exhausted")).toBe(true);
  });

  // A latch: a book that has given up everything does not get it back.
  it("never un-exhausts a book", () => {
    const spent = ok(commit({ entityId: "herbal", path: "book.exhausted", value: true }));
    const r = applyCommit(spent, commit({ entityId: "herbal", path: "book.exhausted", value: false }));
    expect(r.ok).toBe(true);
    expect(
      r.world!.entities.items.find((i) => i.id === "herbal") as { book?: { exhausted?: boolean } }
    ).toMatchObject({ book: { exhausted: true } });
  });

  it("refuses to count consultations of something that is not a book", () => {
    const r = applyCommit(makeWorld(), commit({ entityId: "sword", path: "book.uses", value: 1 }));
    expect(r.ok).toBe(false);
    expect(r.rejected[0].reason).toMatch(/not a book/);
  });
});

// ===========================================================================
// CREATURES THAT WALK THEMSELVES ACROSS THE DUNGEON
// ===========================================================================
//
// A longer corridor than `makeWorld` has, because the whole point of `approach`
// is the rooms in between. The ghoul starts in ROOM_B, at the far end:
//
//   room-a — room-b — far-1 — far-2         and room-c is joined to nothing
//
// `timeSpent` is what buys a step, so it is stated on every commit here rather
// than left to the helper's "instant".

const FAR_1 = "far-1";
const FAR_2 = "far-2";

/** The corridor extended, with the ghoul stood at the far end of it. */
function longWorld(): World {
  const w = makeWorld();
  w.entities.rooms.push(
    { id: FAR_1, name: "Passage", type: "Room", base: "a passage" },
    { id: FAR_2, name: "Crypt", type: "Room", base: "a crypt" }
  );
  w.entities.connectors.push(
    { id: "b-f1", name: "A gap", type: "RoomConnector", base: "a gap", endpointA: ROOM_B, endpointB: FAR_1 },
    { id: "f1-f2", name: "A stair", type: "RoomConnector", base: "a stair", endpointA: FAR_1, endpointB: FAR_2 }
  );
  w.entities.creatures[0].roomId = FAR_2;
  return w;
}

const walks = (...diffs: Diff[]): Commit => ({ ...commit(...diffs), timeSpent: "short" });
const where = (w: World) => w.entities.creatures[0].roomId;
const heading = (w: World) => w.entities.creatures[0].approach;

describe("approach", () => {
  it("a creature three rooms off arrives in three turns", () => {
    let w = longWorld();
    const r = applyCommit(w, walks({ entityId: "ghoul", path: "approach", value: ROOM_A }));
    expect(r.rejected).toEqual([]);
    w = r.world!;

    // The write sets the destination and the sweep spends one room of it, so
    // the turn it was told to come is already a turn of walking.
    expect(where(w)).toBe(FAR_1);
    expect(heading(w)).toBe(ROOM_A);

    w = applyCommit(w, walks()).world!;
    expect(where(w)).toBe(ROOM_B);

    w = applyCommit(w, walks()).world!;
    expect(where(w)).toBe(ROOM_A);
  });

  it("clears the destination the moment it arrives, and then stays put", () => {
    let w = longWorld();
    for (let i = 0; i < 3; i++) {
      w = applyCommit(w, i === 0 ? walks({ entityId: "ghoul", path: "approach", value: ROOM_A }) : walks()).world!;
    }
    expect(where(w)).toBe(ROOM_A);
    expect(heading(w)).toBeUndefined();

    // Two more turns of nothing in particular, and it has not wandered off.
    w = applyCommit(w, walks()).world!;
    expect(where(w)).toBe(ROOM_A);
  });

  // The whole reason `roomId` and `approach` are different writes: this is the
  // relational-key rule in BUILD-PLAN §4.3, and one assignment is all of it.
  it("leaves the old room's occupancy and joins the new one", () => {
    const w = applyCommit(longWorld(), walks({ entityId: "ghoul", path: "approach", value: ROOM_A })).world!;
    const index = roomIndex(w.entities);
    expect(index.get(FAR_1)!.map((e) => e.id)).toContain("ghoul");
    expect(index.get(FAR_2)?.map((e) => e.id) ?? []).not.toContain("ghoul");
  });

  // Refused rather than dropped. A write that vanishes is a creature the
  // referee believes is on its way and that never arrives.
  it("refuses a destination with no route to it", () => {
    const r = applyCommit(longWorld(), walks({ entityId: "ghoul", path: "approach", value: ROOM_C }));
    expect(r.ok).toBe(false);
    expect(r.rejected[0].reason).toMatch(/no way leads/);
  });

  it("refuses a destination that is not a room", () => {
    expect(applyCommit(longWorld(), walks({ entityId: "ghoul", path: "approach", value: "chest" })).ok).toBe(false);
  });

  it("nobody moves on an instant turn", () => {
    let w = applyCommit(longWorld(), walks({ entityId: "ghoul", path: "approach", value: ROOM_A })).world!;
    expect(where(w)).toBe(FAR_1);

    // A glance, a word, a question back — the world does not get a turn for it.
    w = applyCommit(w, commit()).world!;
    expect(where(w)).toBe(FAR_1);
    expect(heading(w)).toBe(ROOM_A);
  });

  it("naming the room it is already in is satisfied, not refused", () => {
    const r = applyCommit(longWorld(), walks({ entityId: "ghoul", path: "approach", value: FAR_2 }));
    expect(r.ok).toBe(true);
    expect(where(r.world!)).toBe(FAR_2);
    expect(heading(r.world!)).toBeUndefined();
  });

  // Put somewhere outright and whatever it was walking toward is settled.
  it("a direct roomId write cancels the walk", () => {
    let w = applyCommit(longWorld(), walks({ entityId: "ghoul", path: "approach", value: ROOM_A })).world!;
    w = applyCommit(w, walks({ entityId: "ghoul", path: "roomId", value: FAR_2 })).world!;
    expect(where(w)).toBe(FAR_2);
    expect(heading(w)).toBeUndefined();
  });
});

// ===========================================================================
// HOW MUCH IS LEFT
// ===========================================================================

describe("amount", () => {
  const rations = (over: Partial<AnyItem> = {}) =>
    item("rations", { parentId: "pc-1", amount: "2 days", ...over });

  /** The world with the rations in the player's pack. */
  function fed(over: Partial<AnyItem> = {}): World {
    const w = makeWorld();
    w.pc.inventory.push(rations(over));
    return w;
  }

  const carried = (w: World) => w.pc.inventory.find((i) => i.id === "rations");

  it("writes what is left down", () => {
    const r = applyCommit(fed(), commit({ entityId: "rations", path: "amount", value: "1 day" }));
    expect(r.ok).toBe(true);
    expect(carried(r.world!)!.amount).toBe("1 day");
  });

  // `setPurse` made this call for money first — "a purse of nothing is no row
  // at all" — and this is that decision generalised to everything measured.
  it("a stated zero uses the thing up", () => {
    const r = applyCommit(fed(), commit({ entityId: "rations", path: "amount", value: "0 days" }));
    expect(r.ok).toBe(true);
    expect(carried(r.world!)).toBeUndefined();
    expect(r.events.some((e) => e.kind === "item-destroyed")).toBe(true);
  });

  // The failure the player could not recover from: an item deleted by a turn
  // of phrase. An amount with no number in it is not an amount of nothing.
  it("an amount with no number in it survives", () => {
    const r = applyCommit(fed(), commit({ entityId: "rations", path: "amount", value: "a handful" }));
    expect(r.ok).toBe(true);
    expect(carried(r.world!)!.amount).toBe("a handful");
  });

  it("and neither 'no days left' nor '10 days' is zero", () => {
    for (const [value, gone] of [["no days left", false], ["10 days", false]] as const) {
      const r = applyCommit(fed(), commit({ entityId: "rations", path: "amount", value }));
      expect(carried(r.world!) === undefined, value).toBe(gone);
    }
  });

  it("an erase out of an equipped slot says the slot emptied", () => {
    const w = fed({ itemKind: "weapon", weapon: { damage: "1d4", hands: 1 } });
    w.pc.equipped.weapon = "rations";
    const r = applyCommit(w, commit({ entityId: "rations", path: "amount", value: "0" }));
    expect(r.ok).toBe(true);
    expect(r.events.some((e) => e.kind === "unequipped")).toBe(true);
    expect(r.world!.pc.equipped.weapon).toBeUndefined();
  });
});
