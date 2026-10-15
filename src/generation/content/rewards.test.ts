/**
 * PHASE 17 R1 -- generation, pure, headless.
 *
 * The whole of the challenge enumeration, the taxonomy, the pot and its
 * partition, placement, and the reserve, asserted with no LLM anywhere near it.
 * That is the point of doing R1 first: everything here is arithmetic and graph
 * walking, and it either holds for every seed or it does not hold.
 */

import { describe, expect, it } from "vitest";
import { generateBlueprintSeed, type Size } from "./blueprint.ts";
import {
  MAGICAL_INGREDIENTS,
  MISC_ITEMS,
  POTIONS,
  TOOL_ITEMS,
  TREASURE_TRAITS,
  WORN_ITEMS,
  rollTable,
} from "../../rules/maze-rats/tables.ts";
import { Rng } from "../../shared/utils/rng.ts";
import { enumerateChallenges, isGoalChallenge } from "./challenges.ts";
import type { Challenge } from "../../shared/world/challenges.ts";
import { generateBlueprint } from "../floorplan/graph.ts";
import { partition, reachableWithout } from "./rewards.ts";
import type { Reward } from "./types.ts";
import { runEntitiesPass } from "./entities-pass.ts";
import { stockDungeon } from "./stock.ts";
import type { StockedDungeon } from "./types.ts";

function stockFor(seed: number, size: Size): StockedDungeon {
  const bp = generateBlueprintSeed(size, seed);
  const { dungeon } = generateBlueprint(String(seed), { chunks: size }, true);
  return stockDungeon(dungeon, bp, { level: 1, seed: seed + 7919 });
}

/** A spread wide enough that a rule holding across it is a rule, not a seed. */
const SEEDS = [1005, 4242, 77, 90210, 31337];
const CASES: Array<[number, Size]> = SEEDS.flatMap(
  (seed): Array<[number, Size]> => [
    [seed, 2],
    [seed, 4],
  ]
);

const rewardsOf = (sd: StockedDungeon): Reward[] => sd.rooms.flatMap((r) => r.rewards);
const keysOf = (sd: StockedDungeon): Reward[] => rewardsOf(sd).filter((r) => r.kind === "key");

// ===========================================================================
// THE ENUMERATION
// ===========================================================================

describe("challenges", () => {
  it.each(CASES)("seed %i size %i enumerates its challenges", (seed, size) => {
    const sd = stockFor(seed, size);
    expect(sd.challenges.length).toBeGreaterThan(0);

    const roomIds = new Set(sd.rooms.map((r) => r.roomId));
    const mobileIds = new Set(sd.mobiles.map((m) => m.id));
    const connectorIds = new Set(sd.connectors.map((c) => c.id));

    for (const c of sd.challenges) {
      expect(roomIds, `${c.id} sits in a real room`).toContain(c.roomId);
      // A challenge with no property is a challenge nothing could answer.
      expect(c.property.length, `${c.id} names the fact it keys`).toBeGreaterThan(0);

      if (c.target === "mobile") expect(mobileIds).toContain(c.targetId);
      if (c.target === "connector") expect(connectorIds).toContain(c.targetId);
      if (c.target === "room") expect(roomIds).toContain(c.targetId);
    }
  });

  it.each(CASES)("seed %i size %i gives every challenge a distinct id", (seed, size) => {
    const ids = stockFor(seed, size).challenges.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("counts one challenge per keyable property, not one per entity", () => {
    const sd = stockFor(4242, 4);
    const byMobile = new Map<string, Challenge[]>();
    for (const c of sd.challenges) {
      if (c.target !== "mobile") continue;
      const held = byMobile.get(c.targetId);
      if (held) held.push(c);
      else byMobile.set(c.targetId, [c]);
    }

    // A creature with two rolled weaknesses is two challenges, and each of them
    // carries its own weakness rather than the pair.
    for (const [mobileId, cs] of byMobile) {
      const m = sd.mobiles.find((x) => x.id === mobileId)!;
      const weaknesses = cs.filter((c) => c.kind === "creature-weakness");
      expect(weaknesses).toHaveLength(m.monster?.weaknesses.length ?? 0);
      for (const c of weaknesses) expect(m.monster!.weaknesses).toContain(c.property);
    }
  });

  it("keys a way twice when it is both blocked and concealed", () => {
    const sd = stockFor(90210, 4);
    for (const c of sd.connectors) {
      const found = sd.challenges.filter((ch) => ch.targetId === c.id).map((ch) => ch.kind);
      expect(found.includes("blocked-way")).toBe(c.gated);
      expect(found.includes("concealed-way")).toBe(c.hidden);
    }
  });

  it("enumerates the same list called on its own as called inside stocking", () => {
    // R2's keys pass and R3's ledger both call this outside `stockDungeon`, so
    // it has to be a pure reading of the stocked dungeon rather than a step in
    // building one.
    const sd = stockFor(31337, 4);
    expect(enumerateChallenges(sd)).toEqual(sd.challenges);
  });

  it("does not enumerate the goal entity's properties, which do not exist yet", () => {
    for (const [seed, size] of CASES) {
      const sd = stockFor(seed, size);
      expect(sd.challenges.filter((c) => c.kind === "goal-property")).toHaveLength(0);
      expect(sd.challenges.filter((c) => c.kind === "goal-location")).toHaveLength(1);
    }
  });
});

// ===========================================================================
// THE POT
// ===========================================================================

describe("the pot", () => {
  it.each(CASES)("seed %i size %i places exactly the pot less its allowance", (seed, size) => {
    const sd = stockFor(seed, size);
    const placed = rewardsOf(sd)
      .filter((r) => r.kind === "treasure")
      .reduce((n, r) => n + (r.kind === "treasure" ? r.value : 0), 0);

    expect(placed).toBe(sd.pot.placed);
    expect(sd.pot.placed + sd.pot.allowance).toBe(sd.pot.total);
  });

  it("scales with size and not with level", () => {
    const small = stockFor(1005, 2).pot.total;
    const large = stockFor(1005, 5).pot.total;
    expect(large).toBeGreaterThan(small);

    const bp = generateBlueprintSeed(3, 4242);
    const { dungeon } = generateBlueprint("4242", { chunks: 3 }, true);
    const l1 = stockDungeon(dungeon, bp, { level: 1, seed: 999 });
    const l8 = stockDungeon(dungeon, bp, { level: 8, seed: 999 });
    expect(l8.pot.total).toBe(l1.pot.total);
  });

  it("keeps a dungeon's whole take within sight of a starting purse", () => {
    // The defect this phase exists to fix: grade alone set value, so three
    // significant parcels was 3,600-36,000cp against a purse of 60-360.
    for (const [seed, size] of CASES) {
      const sd = stockFor(seed, size);
      expect(sd.pot.total).toBeLessThanOrEqual(size * 400);
    }
  });

  it("partitions exactly, whatever the rounding does", () => {
    const rng = new Rng(7);
    for (const total of [1250, 1801, 47, 2000]) {
      for (const n of [1, 2, 3, 7, 19]) {
        const shares = partition(total, n, rng);
        expect(shares).toHaveLength(n);
        expect(shares.reduce((a, b) => a + b, 0), `${total}/${n}`).toBe(total);
      }
    }
  });

  it("keeps keys and equipment out of the pot", () => {
    const sd = stockFor(31337, 4);
    // Nothing but treasure draws on it, which is what lets `placed` be an
    // equality rather than a bound.
    const treasure = rewardsOf(sd).filter((r) => r.kind === "treasure");
    expect(treasure.length).toBeGreaterThan(0);
    for (const k of keysOf(sd)) {
      if (k.kind !== "key") continue;
      expect(k.value).toBeLessThan(100);
    }
  });
});

// ===========================================================================
// PLACEMENT
// ===========================================================================

describe("placement", () => {
  it.each(CASES)("seed %i size %i never puts a key behind its own lock", (seed, size) => {
    const sd = stockFor(seed, size);
    const byId = new Map(sd.challenges.map((c) => [c.id, c]));

    for (const rw of keysOf(sd)) {
      if (rw.kind !== "key") continue;
      const c = byId.get(rw.challengeId);
      expect(c, `${rw.id} answers a real challenge`).toBeDefined();
      if (c!.kind !== "blocked-way") continue;

      const reachable = reachableWithout(sd.connectors, sd.entranceRoomId, c!.targetId);
      expect(
        reachable.has(rw.roomId),
        `${rw.id} is behind ${c!.targetId}, the very way it opens`
      ).toBe(true);
    }
  });

  it.each(CASES)("seed %i size %i answers each challenge with at most one placed key", (seed, size) => {
    const ids = keysOf(stockFor(seed, size)).map((r) => (r.kind === "key" ? r.challengeId : ""));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(CASES)("seed %i size %i places every reward somewhere real", (seed, size) => {
    const sd = stockFor(seed, size);
    const roomIds = new Set(sd.rooms.map((r) => r.roomId));
    const mobileIds = new Set(sd.mobiles.map((m) => m.id));

    for (const r of sd.rooms) {
      for (const rw of r.rewards) {
        expect(rw.roomId).toBe(r.roomId);
        expect(roomIds).toContain(rw.roomId);
        if (rw.holder.kind === "room") expect(rw.holder.id).toBe(r.roomId);
        else expect(mobileIds).toContain(rw.holder.id);
      }
    }
  });

  it("puts a carried reward on a creature that is actually in the room", () => {
    for (const [seed, size] of CASES) {
      const sd = stockFor(seed, size);
      for (const rw of rewardsOf(sd)) {
        if (rw.holder.kind !== "mobile") continue;
        const m = sd.mobiles.find((x) => x.id === rw.holder.id)!;
        expect(m.locationRoomId).toBe(rw.roomId);
        expect(m.disposition).toBe("hostile");
      }
    }
  });

  it("puts nothing in the entrance", () => {
    for (const [seed, size] of CASES) {
      const sd = stockFor(seed, size);
      const entrance = sd.rooms.find((r) => r.roomId === sd.entranceRoomId)!;
      expect(entrance.rewards).toHaveLength(0);
    }
  });

  it("allows more than one reward in a room and more than one on an entity", () => {
    // No cap is the rule, not an accident, so this asserts the rule is not
    // being quietly enforced somewhere. Stacking is uncommon, not forbidden.
    const rooms = SEEDS.flatMap((s) => stockFor(s, 5).rooms);
    expect(rooms.some((r) => r.rewards.length > 1)).toBe(true);
  });
});

// ===========================================================================
// THE RESERVE
// ===========================================================================

describe("the reserve", () => {
  it.each(CASES)("seed %i size %i holds every challenge no placed key answered", (seed, size) => {
    const sd = stockFor(seed, size);
    const keyed = new Set(keysOf(sd).map((r) => (r.kind === "key" ? r.challengeId : "")));
    const reserved = new Set(sd.reserve.map((e) => e.challengeId));

    for (const c of sd.challenges) {
      if (isGoalChallenge(c)) {
        // The one exception: a goal challenge gets a placed key AND stays
        // drawable, so it can be found a second way.
        expect(reserved, `${c.id} is a goal challenge`).toContain(c.id);
        continue;
      }
      expect(keyed.has(c.id) !== reserved.has(c.id), `${c.id} is keyed xor reserved`).toBe(true);
    }
  });

  it.each(CASES)("seed %i size %i carries the fact and no prose", (seed, size) => {
    const sd = stockFor(seed, size);
    const byId = new Map(sd.challenges.map((c) => [c.id, c]));
    for (const e of sd.reserve) {
      expect(byId.get(e.challengeId)?.property).toBe(e.fact);
      expect(["information", "object"]).toContain(e.kind);
      expect(Object.keys(e).sort()).toEqual(["challengeId", "fact", "kind"]);
    }
  });

  it("shrinks the placed set to something a single pass can write", () => {
    // The keys pass covers the PLACED keys only -- roughly a handful at size 5
    // rather than the thirty-odd the enumeration turns up.
    const sd = stockFor(4242, 5);
    expect(sd.challenges.length).toBeGreaterThan(15);
    expect(keysOf(sd).length).toBeLessThan(sd.challenges.length / 2);
  });
});

// ===========================================================================
// DETERMINISM
// ===========================================================================

/**
 * Entity ids are deliberately unseeded -- `makeId` uses `crypto.randomUUID` and
 * says so -- and a challenge id is built from the id of the thing it is about,
 * so it inherits that. Same-seed comparison strips anything holding or naming
 * an id and compares what is left, exactly as `architecture.test.ts` does.
 */
const ID_KEY = /^id$|Id$|Ids$/;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !ID_KEY.test(k))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    );
  }
  return value;
}

describe("determinism", () => {
  it.each(CASES)("seed %i size %i gives the same pool twice", (seed, size) => {
    const a = stockFor(seed, size);
    const b = stockFor(seed, size);
    expect(canonical(a.challenges)).toEqual(canonical(b.challenges));
    expect(canonical(a.reserve)).toEqual(canonical(b.reserve));
    expect(a.pot).toEqual(b.pot);
    expect(canonical(rewardsOf(a))).toEqual(canonical(b.rooms.flatMap((r) => r.rewards)));
  });

  it("derives a challenge id from the thing it is about", () => {
    // Not `makeId()`. A challenge is a property OF something, so its id is
    // built from that something's id and the property's position on it -- which
    // is what lets a reward that names a challenge and a ledger that names one
    // still agree after a save and a reload of the same dungeon.
    for (const c of stockFor(1005, 3).challenges) {
      expect(c.id.startsWith(`ch:${c.kind}:${c.targetId}`)).toBe(true);
    }
  });

  it("gives a reward an id that does not move between runs of a seed", () => {
    const a = rewardsOf(stockFor(4242, 4)).map((r) => r.id);
    const b = rewardsOf(stockFor(4242, 4)).map((r) => r.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});

// ===========================================================================
// THE SIX TABLES THAT WERE EMPTY
// ===========================================================================

describe("the reward tables", () => {
  it("is filled, and every entry is a Maze Rats row", () => {
    for (const [name, t] of [
      ["MISC_ITEMS", MISC_ITEMS],
      ["WORN_ITEMS", WORN_ITEMS],
      ["TOOL_ITEMS", TOOL_ITEMS],
      ["TREASURE_TRAITS", TREASURE_TRAITS],
      ["MAGICAL_INGREDIENTS", MAGICAL_INGREDIENTS],
      ["POTIONS", POTIONS],
    ] as const) {
      // 36 is a Maze Rats table, and all six of these are full ones. The two
      // plant tables they cascade into are checked below.
      expect(t.length, name).toBe(36);
      expect(new Set(t).size, `${name} has a duplicate`).toBe(t.length);
      for (const e of t) expect(e.trim(), `${name} has a blank`).not.toBe("");
    }
  });

  it("resolves every cascade token it carries", () => {
    // The tables are the only readers of `Item`, `Valuable Material`, `Element`,
    // `Effect`, `Mutation`, `Spell` and `Book`, so an unregistered key would
    // show up nowhere else. An unresolved token comes back with its braces
    // stripped or its own name inline -- both are visible here.
    const tables = [TREASURE_TRAITS, MAGICAL_INGREDIENTS, POTIONS];
    const raw = new Set(tables.flatMap((t) => t));
    const tokens = [...raw].flatMap((e) => [...e.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]));
    expect(tokens.length).toBeGreaterThan(0);

    for (const t of tables) {
      for (let i = 0; i < 2000; i++) {
        const drawn = rollTable(t, new Rng(i))!;
        expect(drawn).not.toMatch(/[{}]/);
      }
    }
  });

  it("leaves an unfilled table's token inline rather than throwing", () => {
    // No table is a stub today, so the mechanism is asserted directly rather
    // than through whichever one happened to be empty. It is what keeps the
    // next stub a dull word in the prose instead of a crash.
    expect(rollTable([], new Rng(1))).toBeUndefined();
    expect(rollTable(["Only entry"], new Rng(1))).toBe("Only entry");

    // Both plant tables are filled, so both resolve rather than going inline.
    const drawn = new Set<string>();
    for (let i = 0; i < 20000; i++) drawn.add(rollTable(MAGICAL_INGREDIENTS, new Rng(i))!);
    expect(drawn).not.toContain("Edible Plant");
    expect(drawn).not.toContain("Poisonous Plant");
    expect(drawn).toContain("Wood sorrel");
    expect(drawn).toContain("Wolfsbane");
  });

  it("draws potions as treasure, never as equipment", () => {
    // It was an equipment row while POTIONS was a stub and then while it was
    // filled; it is a treasure row now, so it is priced from the pot like
    // everything else the dungeon puts a number on.
    const rewards = SEEDS.flatMap((s) => rewardsOf(stockFor(s, 5)));
    const equipment = rewards.flatMap((r) => (r.kind === "equipment" ? [r.row] : []));
    const treasure = rewards.flatMap((r) => (r.kind === "treasure" ? [r.row] : []));

    expect(equipment.length).toBeGreaterThan(0);
    expect(equipment).not.toContain("potion");
    expect(treasure).toContain("potion");
  });

  it("names the potion by what it does, and leaves the flask to the writing pass", () => {
    // `POTIONS` holds effects — the row is the noun. A content string that had
    // already said "Potion" would reach the pass as `Potion: Potion of Flight`.
    const potions = SEEDS.flatMap((s) =>
      rewardsOf(stockFor(s, 5)).filter((r) => r.kind === "treasure" && r.row === "potion")
    );
    expect(potions.length).toBeGreaterThan(0);
    for (const p of potions) {
      if (p.kind !== "treasure") continue;
      expect(p.content).not.toMatch(/potion/i);
      expect(p.content.length).toBeGreaterThan(0);
    }
  });

  it("pays a potion out of the pot rather than out of the key band", () => {
    // The old row priced itself at KEY_VALUE_BAND, 5-60cp, which is what a key
    // is worth and not what a flask of flight is worth. A share is a share.
    const potions = SEEDS.flatMap((s) =>
      rewardsOf(stockFor(s, 5)).filter((r) => r.kind === "treasure" && r.row === "potion")
    );
    for (const p of potions) {
      if (p.kind !== "treasure") continue;
      // Every object-bearing treasure row clears the coin ceiling by
      // construction; below it a share is loose coin instead.
      expect(p.value).toBeGreaterThanOrEqual(60);
    }
  });
});

// ===========================================================================
// WHAT THE REST OF THE PIPELINE SEES
// ===========================================================================

describe("the entities pass", () => {
  it.each(CASES)("seed %i size %i emits one item per reward draw", (seed, size) => {
    const bp = generateBlueprintSeed(size, seed);
    const { dungeon } = generateBlueprint(String(seed), { chunks: size }, true);
    const sd = stockDungeon(dungeon, bp, { level: 1, seed: seed + 7919 });
    const ep = runEntitiesPass(sd, bp, new Rng(sd.seed));

    const want = rewardsOf(sd).reduce(
      (n, r) => n + (r.kind === "equipment" ? r.draws.length : 1),
      0
    );
    const bindings = ep.bindings.filter((b) => b.element === "reward");
    expect(bindings).toHaveLength(want);

    const itemIds = new Set(ep.items.map((i) => i.id));
    for (const b of bindings) {
      // Every reward is an ITEM now. The old split -- loot as an item,
      // knowledge and leverage as features of the room -- went with the parcel
      // types that produced it.
      expect(itemIds, `${b.entityId} is an item`).toContain(b.entityId);
      expect(b.rewardId, "a reward binding names its reward").toBeDefined();
    }
  });

  it("parents a carried reward to the creature carrying it", () => {
    const seed = 4242;
    const bp = generateBlueprintSeed(5, seed);
    const { dungeon } = generateBlueprint(String(seed), { chunks: 5 }, true);
    const sd = stockDungeon(dungeon, bp, { level: 1, seed: seed + 7919 });
    const ep = runEntitiesPass(sd, bp, new Rng(sd.seed));

    const creatureOf = new Map(
      ep.bindings.filter((b) => b.mobileId).map((b) => [b.mobileId!, b.entityId])
    );
    const itemById = new Map(ep.items.map((i) => [i.id, i]));
    const rewardById = new Map(rewardsOf(sd).map((r) => [r.id, r]));

    let carried = 0;
    for (const b of ep.bindings) {
      if (b.element !== "reward" || !b.rewardId) continue;
      const rw = rewardById.get(b.rewardId)!;
      if (rw.holder.kind !== "mobile") continue;
      carried++;
      expect(itemById.get(b.entityId)!.parentId).toBe(creatureOf.get(rw.holder.id));
    }
    expect(carried, "this dungeon has carried rewards to check").toBeGreaterThan(0);
  });

  it("marks the obstacle so the runtime can recognise one", () => {
    const seed = 90210;
    const bp = generateBlueprintSeed(5, seed);
    const { dungeon } = generateBlueprint(String(seed), { chunks: 5 }, true);
    const sd = stockDungeon(dungeon, bp, { level: 1, seed: seed + 7919 });
    const ep = runEntitiesPass(sd, bp, new Rng(sd.seed));

    const obstacles = ep.bindings.filter((b) => b.element === "obstacle");
    expect(obstacles.length).toBeGreaterThan(0);
    const byId = new Map(ep.features.map((f) => [f.id, f]));
    for (const b of obstacles) expect(byId.get(b.entityId)?.isObstacle).toBe(true);
    // Nothing else claims to be one.
    const marked = ep.features.filter((f) => f.isObstacle).length;
    expect(marked).toBe(obstacles.length);
  });

  it("gives an equipment reward the catalog's price, not the pot's", () => {
    const seed = 1005;
    const bp = generateBlueprintSeed(5, seed);
    const { dungeon } = generateBlueprint(String(seed), { chunks: 5 }, true);
    const sd = stockDungeon(dungeon, bp, { level: 1, seed: seed + 7919 });
    const ep = runEntitiesPass(sd, bp, new Rng(sd.seed));

    const itemById = new Map(ep.items.map((i) => [i.id, i]));
    const rewardById = new Map(rewardsOf(sd).map((r) => [r.id, r]));
    let checked = 0;
    for (const b of ep.bindings) {
      if (b.element !== "reward" || !b.rewardId) continue;
      const rw = rewardById.get(b.rewardId)!;
      if (rw.kind !== "equipment") continue;
      const item = itemById.get(b.entityId)!;
      // A catalog draw arrives named and priced; only its prose is missing.
      expect(item.name.length).toBeGreaterThan(0);
      expect(rw.draws.map((d) => d.value)).toContain(item.value);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("carries a treasure reward's share onto the item, potions included", () => {
    // The other half of the rule above. A treasure item is worth the share its
    // parcel drew from the pot and nothing decides that twice — which is what
    // "a potion is priced from the treasure budget" actually means once the
    // reward has become a thing in a room.
    const seed = 1005;
    const bp = generateBlueprintSeed(5, seed);
    const { dungeon } = generateBlueprint(String(seed), { chunks: 5 }, true);
    const sd = stockDungeon(dungeon, bp, { level: 1, seed: seed + 7919 });
    const ep = runEntitiesPass(sd, bp, new Rng(sd.seed));

    const itemById = new Map(ep.items.map((i) => [i.id, i]));
    const rewardById = new Map(rewardsOf(sd).map((r) => [r.id, r]));
    let potions = 0;
    let checked = 0;
    for (const b of ep.bindings) {
      if (b.element !== "reward" || !b.rewardId) continue;
      const rw = rewardById.get(b.rewardId)!;
      if (rw.kind !== "treasure") continue;
      expect(itemById.get(b.entityId)!.value).toBe(rw.value);
      if (rw.row === "potion") potions++;
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(potions).toBeGreaterThan(0);
  });
});
