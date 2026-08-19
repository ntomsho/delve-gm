/**
 * REWARDS
 * =======
 *
 * What a dungeon GIVES you, and what it pays for answering what it asks.
 *
 * Two families and no third:
 *
 *   KEY       answers one challenge
 *   GENERAL   50/50 equipment / treasure
 *
 * `leverage` and `boon` did not survive the cut. Boons are consumables and
 * belong in equipment; leverage -- "defensible chokepoint", "safe place to
 * rest" -- describes a room, and the content pass can write that without
 * spending a reward slot on it.
 *
 * WHAT REPLACED GRADE. The old system set an item's worth from a `ParcelGrade`
 * and nothing else, so a dungeon's total take was whatever its grades happened
 * to roll -- three significant parcels was 3,600-36,000cp against a Knave
 * starting purse of 60-360. Money is now a CONSERVED POT, partitioned across
 * the placed treasure before anything reaches the LLM. Which table a treasure
 * parcel draws on is decided by the share it drew, not the other way round,
 * which is what makes grade unnecessary rather than merely unused.
 *
 * Level does not move money. It never should have.
 *
 * KEYS ARE OUTSIDE THE POT. A key is equipment, not wealth, and its band sits
 * well under treasure money so that selling one never beats using it.
 */

import {
  Rng,
  MAGICAL_INGREDIENTS,
  POTIONS,
  TREASURE_ITEMS,
  TREASURE_TRAITS,
  VALUABLE_MATERIALS,
  rollTable,
  type Rolled,
  type Size,
} from "./dungeon-blueprint.ts";
import {
  DUNGEONEERING_GEAR,
  GENERAL_GEAR_1,
  GENERAL_GEAR_2,
  SPELLS,
  WEAPONS,
  rollArmorTable,
  rollHelmetShieldTable,
  type GearRow,
} from "./knave-tables.ts";
import { STANDARD_EQUIPMENT, type EquipmentKey } from "./equipment.ts";
import type { Challenge } from "./dungeon-challenges.ts";
import { isGoalChallenge } from "./dungeon-challenges.ts";
import type {
  MobileEntity,
  RoomStock,
  StockedConnector,
} from "./dungeon-rooms-loop.ts";

// ---------------------------------------------------------------------------
// THE DIALS
// ---------------------------------------------------------------------------
// Named rather than inlined because the placed/reserved ratio is explicitly a
// dial: the ORDER at `placeRewards` is settled, the weights inside it are not,
// and they get tuned once a dungeon's worth of them can be looked at.

/** Chance a reward-guaranteed location takes a key instead of loot. */
const KEY_SHARE = 0.25;

/** Of the loot that does fall out, how much is equipment rather than treasure. */
const EQUIPMENT_SHARE = 0.5;

/** Chance a reward in a room with a hostile creature is carried by it. */
const CARRIED_SHARE = 0.6;

/** How many of the goal room's keyable properties get a placed key, beyond its location. */
const GOAL_PROPERTY_KEYS: readonly [number, number] = [1, 3];

/** The referee's ad-hoc allowance, held out of the partition. See §7.1. */
const ALLOWANCE_SHARE = 0.1;

/**
 * What a key is worth when it is not a catalog item. Deliberately small: a key
 * is the answer to a question, and a player who sells it has thrown away the
 * only thing it was for.
 */
const KEY_VALUE_BAND: readonly [number, number] = [5, 60];

/**
 * The goal, when the content pass makes it an item, is priced ABOVE every other
 * single reward in the dungeon rather than out of the pot. It is the thing the
 * whole run was about; a strongbox in a side room outvaluing it would be the
 * dungeon disagreeing with itself.
 */
const GOAL_VALUE_MULTIPLIER: readonly [number, number] = [2, 4];

/** Copper below which a treasure share is loose coin rather than an object. */
const COIN_CEILING = 60;
/** Copper above which a treasure object is fine enough to carry a trait. */
const TRAIT_FLOOR = 250;

// ---------------------------------------------------------------------------
// CONTENT TABLES
// ---------------------------------------------------------------------------

/** What coin is found IN. Money in a dungeon is always in something. */
const COIN_VESSELS: readonly string[] = [
  "Loose coin",
  "Coin purse",
  "Small strongbox",
  "Buried cache",
  "Pouch of trade bars",
  "Tithe box",
];

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

/** The six equipment rows of §3.1, all drawn from tables already in the repo. */
export type EquipmentRow =
  | "weapon"
  | "protection"
  | "spellbook"
  | "dungeoneering"
  | "general"
  | "potion";

/** The four treasure rows of §3.2. Which one fires is decided by the share drawn. */
export type TreasureRow = "coins" | "item" | "item-with-trait" | "ingredients";

/**
 * One object an equipment reward hands over. A row can hand over several -- two
 * to four pieces of general gear is one reward, not four.
 */
export type EquipmentDraw =
  /** a catalog entry: name, slots, facts and price all come from STANDARD_EQUIPMENT */
  | { kind: "catalog"; key: EquipmentKey; amount?: string; value: number }
  /** a spellbook, which is the entry plus the one spell it holds */
  | { kind: "spellbook"; spell: string; effect: string; value: number }
  /** a rolled thing with no catalog entry -- today, a potion */
  | { kind: "rolled"; content: Rolled; value: number };

/** Where a placed reward actually sits. */
export interface RewardHolder {
  kind: "room" | "mobile";
  /** a `RoomStock.roomId` or a `MobileEntity.id` */
  id: string;
}

interface RewardCommon {
  /** derived from placement order; stable for a seed, never `makeId()` */
  id: string;
  /** the room it is found in, whoever is holding it */
  roomId: string;
  holder: RewardHolder;
  /** this location was owed a reward: a dead end, an obstacle room, or hostile ground */
  guaranteed: boolean;
}

export type Reward = RewardCommon &
  (
    | {
        kind: "key";
        /** the one challenge this answers */
        challengeId: string;
        /** what the key must answer. The keys pass turns this into an object. */
        answers: Rolled;
        value: number;
      }
    | { kind: "equipment"; row: EquipmentRow; draws: EquipmentDraw[] }
    | { kind: "treasure"; row: TreasureRow; content: Rolled; value: number }
  );

/**
 * The dungeon's wealth, and what was held out of it.
 *
 * `placed` is the whole of what went into treasure and is exactly
 * `total - allowance`. Nothing else draws on the pot: equipment is priced from
 * the catalog, keys have their own small band, and the goal is priced against
 * the placed rewards rather than out of the money.
 */
export interface Pot {
  total: number;
  allowance: number;
  placed: number;
}

/**
 * A challenge with no placed key, held for a draw in play.
 *
 * PURE GENERATION DATA. No prose -- a reserve entry is written only when it is
 * drawn, so its form can match what the player is doing at the moment they get
 * it: information from an NPC mid-conversation, an object in the cabinet they
 * are searching.
 */
export interface ReserveEntry {
  challengeId: string;
  /** how a draw would reach the player */
  kind: "information" | "object";
  /** the mechanical fact, verbatim from the challenge */
  fact: Rolled;
}

export interface RewardPlacement {
  pot: Pot;
  reserve: ReserveEntry[];
  stats: { general: number; keys: number; reserved: number };
}

export interface PlacementInput {
  /** mutated: each room's `rewards` array is filled */
  rooms: RoomStock[];
  connectors: StockedConnector[];
  mobiles: MobileEntity[];
  entranceRoomId: string;
  goalRoomId: string;
  size: Size;
  challenges: Challenge[];
  maxDepth: number;
  rng: Rng;
}

// ---------------------------------------------------------------------------
// THE POT
// ---------------------------------------------------------------------------

/**
 * Size, and nothing else. A bigger dungeon holds more; a deeper one does not
 * hold richer, which is the whole correction — a level 8 run and a level 1 run
 * through the same floorplan find the same money.
 */
export function rollPot(size: Size, rng: Rng): number {
  return size * rng.range(250, 400);
}

/**
 * Split `total` into `n` shares that sum to EXACTLY `total`.
 *
 * Rounded to something a price could be written as, except the last share,
 * which absorbs whatever the rounding left over. Exactness is the point: the
 * conserved pot is the invariant the whole scheme rests on, and "roughly the
 * pot" is not an invariant.
 */
export function partition(total: number, n: number, rng: Rng): number[] {
  if (n <= 0) return [];
  if (n === 1) return [total];

  const w = Array.from({ length: n }, () => 0.5 + rng.next());
  const sum = w.reduce((a, b) => a + b, 0);

  const out: number[] = [];
  let spent = 0;
  for (let i = 0; i < n - 1; i++) {
    const v = Math.max(5, Math.round((total * w[i]) / sum / 5) * 5);
    out.push(v);
    spent += v;
  }
  out.push(total - spent);

  // Rounding up n-1 times can leave the last share short or negative. Take it
  // back off the biggest, which is the share that can most afford it.
  while (out[n - 1] < 5) {
    let big = 0;
    for (let i = 0; i < n - 1; i++) if (out[i] > out[big]) big = i;
    if (out[big] <= 5) break;
    out[big] -= 5;
    out[n - 1] += 5;
  }
  return out;
}

// ---------------------------------------------------------------------------
// WHAT A REWARD IS
// ---------------------------------------------------------------------------

const gearValue = (row: GearRow): number =>
  row.value ?? STANDARD_EQUIPMENT[row.key].value;

const catalogDraw = (row: GearRow): EquipmentDraw => ({
  kind: "catalog",
  key: row.key,
  ...(row.amount !== undefined ? { amount: row.amount } : {}),
  value: gearValue(row),
});

const keyDraw = (key: EquipmentKey): EquipmentDraw => ({
  kind: "catalog",
  key,
  value: STANDARD_EQUIPMENT[key].value,
});

/**
 * One equipment reward.
 *
 * The armor and helmet/shield rows go through the same house-ruled d20 tables
 * character creation rolls on, spellbook payout and all, so a suit of
 * brigandine found in a dungeon and one rolled at creation are the same object
 * at the same price. There is one equipment table and this is a second reader
 * of it, not a second table.
 */
export function rollEquipment(rng: Rng): { row: EquipmentRow; draws: EquipmentDraw[] } {
  const row = pickEquipmentRow(rng);
  return { row, draws: drawsFor(row, rng) };
}

/**
 * A row whose table is still empty draws nothing, so it is not offered. The six
 * stubs in `dungeon-blueprint.ts` are the reason this check exists; `POTIONS`
 * is filled now and the row is offered, so the guard is dead for this row and
 * stays for the next one.
 */
function pickEquipmentRow(rng: Rng): EquipmentRow {
  const rows: EquipmentRow[] = ["weapon", "protection", "spellbook", "dungeoneering", "general"];
  if (POTIONS.length) rows.push("potion");
  return rng.pick(rows);
}

function drawsFor(row: EquipmentRow, rng: Rng): EquipmentDraw[] {
  switch (row) {
    case "weapon":
      return [keyDraw(rng.pick(WEAPONS))];

    case "protection": {
      const draws: EquipmentDraw[] = [];
      if (rng.coin()) {
        const r = rollArmorTable(rng.d(20));
        if (r.armor) draws.push(keyDraw(r.armor));
        for (let i = 0; i < r.spellbooks; i++) draws.push(spellbookDraw(rng));
      } else {
        const r = rollHelmetShieldTable(rng.d(20));
        if (r.helmet) draws.push(keyDraw("helmet"));
        if (r.shield) draws.push(keyDraw("shield"));
        for (let i = 0; i < r.spellbooks; i++) draws.push(spellbookDraw(rng));
      }
      // Both tables have a band that pays out nothing at all; a reward that
      // came up empty is a reward that was never there.
      return draws.length ? draws : [spellbookDraw(rng)];
    }

    case "spellbook":
      return [spellbookDraw(rng)];

    case "dungeoneering":
      return rng
        .pickN(DUNGEONEERING_GEAR, rng.range(1, 3))
        .map(catalogDraw);

    case "general": {
      const pool = [...GENERAL_GEAR_1, ...GENERAL_GEAR_2];
      return rng.pickN(pool, rng.range(2, 4)).map(catalogDraw);
    }

    case "potion": {
      const content = rollTable(POTIONS, rng);
      // THE ROW NAMES THE THING, because a rolled draw has no catalog entry to
      // take a name from and `POTIONS` holds what the potion DOES, not what it
      // is -- "Ghost-speech", "Antlers", "Control Rat". The fallback is
      // unreachable while POTIONS is filled; kept honest rather than asserted.
      return content
        ? [{ kind: "rolled", content: `Potion of ${content}`, value: rng.range(...KEY_VALUE_BAND) }]
        : [spellbookDraw(rng)];
    }
  }
}

function spellbookDraw(rng: Rng): EquipmentDraw {
  const spell = SPELLS[rng.d(SPELLS.length) - 1];
  return {
    kind: "spellbook",
    spell: spell.name,
    effect: spell.effect,
    value: STANDARD_EQUIPMENT.spellbook.value,
  };
}

/**
 * One treasure reward, for a share already drawn.
 *
 * THE SHARE PICKS THE TABLE. Loose coin is what a small share is; a share big
 * enough to be an object is an object, and one big enough to be a fine object
 * carries a trait. Reading it the other way round -- table first, then a value
 * to match -- is what made money unbounded.
 */
export function rollTreasure(share: number, rng: Rng): { row: TreasureRow; content: Rolled } {
  if (MAGICAL_INGREDIENTS.length && share >= COIN_CEILING && rng.chance(0.2)) {
    const content = rollTable(MAGICAL_INGREDIENTS, rng);
    if (content) return { row: "ingredients", content };
  }

  if (share < COIN_CEILING) {
    return { row: "coins", content: rng.pick(COIN_VESSELS) };
  }

  const item = rollTable(TREASURE_ITEMS, rng) ?? "Treasure";
  if (share < TRAIT_FLOOR) return { row: "item", content: item };

  // TREASURE_TRAITS is filled, so the material fallback is now the unreachable
  // half. It stays because it is the same idea from the other end and costs a
  // line.
  const trait =
    rollTable(TREASURE_TRAITS, rng) ?? rollTable(VALUABLE_MATERIALS, rng);
  return trait
    ? { row: "item-with-trait", content: `${item} (${trait})` }
    : { row: "item", content: item };
}

/**
 * What the goal is worth, when the content pass decides the goal is an item.
 *
 * Priced against the dungeon rather than out of the pot: strictly more than the
 * largest single reward in it, by a factor the seeded stream picks. A dungeon
 * with nothing else worth anything still pays for its objective, which is what
 * the floor is for.
 */
export function goalItemValue(rewards: readonly Reward[], rng: Rng): number {
  let best = 0;
  for (const r of rewards) {
    if (r.kind === "equipment") {
      for (const d of r.draws) best = Math.max(best, d.value);
    } else {
      best = Math.max(best, r.value);
    }
  }
  const floor = Math.max(best, 100);
  const raw = floor * (GOAL_VALUE_MULTIPLIER[0] + rng.next() * (GOAL_VALUE_MULTIPLIER[1] - GOAL_VALUE_MULTIPLIER[0]));
  const v = Math.round(raw / 10) * 10;
  return Math.max(best + 10, v);
}

// ---------------------------------------------------------------------------
// REACHABILITY
// ---------------------------------------------------------------------------

/**
 * Which rooms are still reachable from the entrance with one way removed.
 *
 * A placed key is never behind the thing it opens, and for a blocked way that
 * is not a matter of taste: take the edge out, walk the graph, and the rooms
 * that fall off the far side are the rooms the key may not be in.
 */
export function reachableWithout(
  connectors: readonly StockedConnector[],
  entranceRoomId: string,
  withoutConnectorId: string
): Set<string> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const held = adj.get(a);
    if (held) held.push(b);
    else adj.set(a, [b]);
  };
  for (const c of connectors) {
    if (c.id === withoutConnectorId) continue;
    link(c.a, c.b);
    link(c.b, c.a);
  }

  const seen = new Set<string>([entranceRoomId]);
  const q = [entranceRoomId];
  for (let i = 0; i < q.length; i++) {
    for (const n of adj.get(q[i]) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      q.push(n);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// PLACEMENT
// ---------------------------------------------------------------------------

/**
 * The general budget: how many rewards are simply THERE, whether or not the
 * dungeon asked anything for them. Unchanged from the old parcel budget, and
 * still conserved -- a location that came up empty hands its share elsewhere
 * rather than losing it.
 */
export function generalBudget(roomCount: number): number {
  return Math.max(3, Math.round(0.55 * roomCount));
}

/**
 * Place every reward, in the order the spec fixes:
 *
 *   1. General rewards, into the reward-guaranteed locations, each of which
 *      rolls loot or key. The budget spills into a weighted draw over the rest
 *      of the dungeon if the guaranteed set runs out first.
 *   2. Goal keys -- where the objective is, plus one to three of the goal
 *      room's keyable properties.
 *   3. Any dead end or obstacle room that came out of step 1 with nothing.
 *   4. Everything else is reserve.
 *
 * Mutates `rooms[].rewards`. Returns the pot and the reserve, which belong to
 * the dungeon rather than to any room.
 */
export function placeRewards(input: PlacementInput): RewardPlacement {
  const { rooms, connectors, mobiles, entranceRoomId, goalRoomId, size, challenges, maxDepth, rng } =
    input;

  for (const r of rooms) r.rewards = [];

  const total = rollPot(size, rng);
  const distributable = total - Math.round(total * ALLOWANCE_SHARE);

  let counter = 0;
  const nextId = (): string => `rw:${counter++}`;
  const treasure: Reward[] = [];
  const keyed = new Set<string>();
  const byId = new Map<string, RoomStock>();
  for (const r of rooms) byId.set(r.roomId, r);

  const challengeById = new Map<string, Challenge>();
  for (const c of challenges) challengeById.set(c.id, c);

  // --- who is holding it ---------------------------------------------------
  // A reward in a room with something hostile in it is usually ON the hostile
  // thing. That is where a player expects to find it, and it is what makes
  // killing the thing pay rather than merely clear the way.
  const hostilesIn = (roomId: string): MobileEntity[] =>
    mobiles.filter(
      (m) => m.locationRoomId === roomId && m.disposition === "hostile" && !m.minion
    );

  const holderFor = (room: RoomStock): RewardHolder => {
    const hostile = hostilesIn(room.roomId);
    if (hostile.length && rng.chance(CARRIED_SHARE)) {
      return { kind: "mobile", id: rng.pick(hostile).id };
    }
    return { kind: "room", id: room.roomId };
  };

  // --- the three ways to give -----------------------------------------------
  const giveEquipment = (room: RoomStock, guaranteed: boolean): void => {
    const { row, draws } = rollEquipment(rng);
    room.rewards.push({
      id: nextId(),
      roomId: room.roomId,
      holder: holderFor(room),
      guaranteed,
      kind: "equipment",
      row,
      draws,
    });
  };

  /** Value and content are filled once every share is known -- see the partition below. */
  const giveTreasure = (room: RoomStock, guaranteed: boolean): void => {
    const rw: Reward = {
      id: nextId(),
      roomId: room.roomId,
      holder: holderFor(room),
      guaranteed,
      kind: "treasure",
      row: "coins",
      content: "",
      value: 0,
    };
    room.rewards.push(rw);
    treasure.push(rw);
  };

  const giveKey = (room: RoomStock, challenge: Challenge, guaranteed: boolean): void => {
    keyed.add(challenge.id);
    room.rewards.push({
      id: nextId(),
      roomId: room.roomId,
      holder: holderFor(room),
      guaranteed,
      kind: "key",
      challengeId: challenge.id,
      answers: challenge.property,
      value: rng.range(...KEY_VALUE_BAND),
    });
  };

  /**
   * A challenge for a key that is going to sit in `room`.
   *
   * Weighted toward the same region, because a key and its lock in the same
   * stretch of the dungeon is a puzzle and one at opposite ends is a fetch. The
   * blocked-way check is not a weight: a key behind its own door is refused
   * outright.
   */
  const pickChallenge = (room: RoomStock): Challenge | undefined => {
    const pool = challenges.filter((c) => {
      if (keyed.has(c.id)) return false;
      if (isGoalChallenge(c)) return false; // step 2 owns these
      if (c.kind !== "blocked-way") return true;
      return reachableWithout(connectors, entranceRoomId, c.targetId).has(room.roomId);
    });
    if (!pool.length) return undefined;

    const weights = pool.map((c) => (byId.get(c.roomId)?.chunk === room.chunk ? 3 : 1));
    const sum = weights.reduce((a, b) => a + b, 0);
    let x = rng.next() * sum;
    for (let i = 0; i < pool.length; i++) {
      x -= weights[i];
      if (x <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  };

  // --- 1. general rewards ---------------------------------------------------
  const eligible = rooms.filter((r) => r.role !== "entrance");

  const isGuaranteed = (r: RoomStock): boolean =>
    r.isDeadEnd ||
    (r.special?.kind === "obstacle" && (r.headline === "special" || r.stacked === "special")) ||
    hostilesIn(r.roomId).length > 0;

  const guaranteedRooms = eligible.filter(isGuaranteed);
  const budget = generalBudget(rooms.length);
  let generals = 0;
  let keys = 0;

  for (const room of guaranteedRooms) {
    if (generals >= budget) break;
    const challenge = rng.chance(KEY_SHARE) ? pickChallenge(room) : undefined;
    if (challenge) {
      giveKey(room, challenge, true);
      keys++;
    } else {
      if (rng.chance(EQUIPMENT_SHARE)) giveEquipment(room, true);
      else giveTreasure(room, true);
      generals++;
    }
  }

  // The budget is conserved. If the guaranteed set could not absorb it, the
  // remainder goes by the same weighted draw the old contested pool used --
  // danger, deepened by depth.
  const pool = eligible.filter((r) => !r.rewards.length);
  const weights = pool.map((r) => {
    const depthNorm = maxDepth ? r.depth / maxDepth : 0;
    return Math.max(0.02, r.danger * (0.5 + 0.5 * depthNorm));
  });
  while (generals < budget && pool.length) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0) break;
    let x = rng.next() * sum;
    let i = 0;
    for (; i < pool.length; i++) {
      x -= weights[i];
      if (x <= 0) break;
    }
    if (i >= pool.length) i = pool.length - 1;
    if (rng.chance(EQUIPMENT_SHARE)) giveEquipment(pool[i], false);
    else giveTreasure(pool[i], false);
    generals++;
    pool.splice(i, 1);
    weights.splice(i, 1);
  }

  // --- 2. goal keys ---------------------------------------------------------
  // The goal's location, plus one to three of the goal room's own keyable
  // properties. The goal ENTITY's properties cannot be reached from here --
  // its form is the content pass's call -- and the keys pass mints those.
  const goalRoom = byId.get(goalRoomId);
  if (goalRoom) {
    const goalChallenges = challenges.filter((c) => c.kind === "goal-location");
    const roomChallenges = challenges.filter(
      (c) => c.roomId === goalRoomId && !isGoalChallenge(c) && !keyed.has(c.id)
    );
    const want = rng.range(...GOAL_PROPERTY_KEYS);
    for (const c of [...goalChallenges, ...roomChallenges.slice(0, want)]) {
      // A goal key goes somewhere the player can already stand.
      const host = rng.pick(eligible.filter((r) => r.roomId !== goalRoomId)) ?? goalRoom;
      giveKey(host, c, false);
      keys++;
    }
  }

  // --- 3. the leftovers of the hard guarantee -------------------------------
  for (const room of eligible) {
    if (room.rewards.length) continue;
    const owed =
      room.isDeadEnd ||
      (room.special?.kind === "obstacle" &&
        (room.headline === "special" || room.stacked === "special"));
    if (!owed) continue;
    const challenge = pickChallenge(room);
    if (!challenge) continue;
    giveKey(room, challenge, true);
    keys++;
  }

  // --- the partition --------------------------------------------------------
  // Every treasure parcel now exists, so the money can be split across them.
  // The pot is conserved and the sum is exact.
  //
  // A dungeon whose loot rolls came up all equipment would have nowhere to put
  // the money at all, so the last general becomes treasure rather than the pot
  // quietly evaporating.
  if (!treasure.length) {
    const host = eligible.find((r) => r.rewards.some((w) => w.kind === "equipment"));
    if (host) {
      const at = host.rewards.findIndex((w) => w.kind === "equipment");
      const old = host.rewards[at];
      const rw: Reward = {
        id: old.id,
        roomId: old.roomId,
        holder: old.holder,
        guaranteed: old.guaranteed,
        kind: "treasure",
        row: "coins",
        content: "",
        value: 0,
      };
      host.rewards[at] = rw;
      treasure.push(rw);
    }
  }

  const shares = partition(distributable, treasure.length, rng);
  treasure.forEach((rw, i) => {
    if (rw.kind !== "treasure") return; // narrowing only; the array holds treasure
    rw.value = shares[i];
    const rolled = rollTreasure(shares[i], rng);
    rw.row = rolled.row;
    rw.content = rolled.content;
  });
  const placed = shares.reduce((a, b) => a + b, 0);
  // A dungeon with nowhere at all to put money -- no eligible room, so no
  // parcel -- keeps the whole pot as allowance rather than losing it. The
  // conserved-sum invariant holds either way, which is the point of stating it
  // as `total - allowance` rather than as a fraction.
  const allowance = total - placed;

  // --- 4. the reserve -------------------------------------------------------
  // Everything a placed key did not answer, plus the goal's challenges, which
  // are the one exception: they get a placed key AND stay drawable.
  const reserve: ReserveEntry[] = [];
  for (const c of challenges) {
    if (keyed.has(c.id) && !isGoalChallenge(c)) continue;
    reserve.push({ challengeId: c.id, kind: reserveKind(c, rng), fact: c.property });
  }

  return {
    pot: { total, allowance, placed },
    reserve,
    stats: { general: generals, keys, reserved: reserve.length },
  };
}

/**
 * Whether a drawn key arrives as something told or something found.
 *
 * A weakness, a liability, a stretch of map: those are facts, and a fact
 * arrives as information. A blocked way, a hazard, a puzzle can be answered
 * either way -- a written combination or the crowbar that makes it moot -- so
 * the stream picks, once, at generation, rather than the referee picking
 * differently every time it looks.
 */
function reserveKind(c: Challenge, rng: Rng): "information" | "object" {
  switch (c.kind) {
    case "blocked-way":
    case "hazard":
    case "obstacle":
      return rng.coin() ? "object" : "information";
    default:
      return "information";
  }
}
