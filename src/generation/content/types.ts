import type { Challenge, ReserveEntry } from "../../shared/world/challenges.ts";
import type { EquipmentKey } from "../../rules/knave/equipment.ts";
import type { InhabitantGroup, Size, Tier } from "./blueprint.ts";
import type { MonsterSeed, NpcSeed } from "../../shared/world/seeds.ts";
import type { Rolled } from "../../shared/utils/rng.ts";
import type { SizeClass } from "../floorplan/room-size.ts";
/**
 * THE STOCKED DUNGEON, AS DATA
 *
 * What stocking decides before any prose is written: each room's role and
 * contents, the creatures that move between rooms, the ways between them, and
 * the rewards placed or held back. `stock.ts` builds it, `challenges.ts` and
 * `rewards.ts` read and fill it, and the writing passes turn it into entities.
 * The shapes live here, apart from all three, so none of them has to import
 * another just for a type.
 */

/**
 * The equipment rows of a general reward, all drawn from tables already in the repo.
 * Potions are treasure, not equipment, so every row here prices itself from the catalog.
 */
export type EquipmentRow =
  | "weapon"
  | "protection"
  | "spellbook"
  | "dungeoneering"
  | "general";

/**
 * The treasure rows of a general reward (ARCHITECTURE §8.2). Which one fires is decided by the share drawn --
 * every one of them is worth exactly that share, whatever it turns out to be.
 */
export type TreasureRow = "coins" | "item" | "item-with-trait" | "ingredients" | "potion";

/**
 * One object an equipment reward hands over. A row can hand over several -- two
 * to four pieces of general gear is one reward, not four.
 *
 * EVERY DRAW HAS A CATALOG PRICE BEHIND IT. There was a third variant -- a
 * rolled thing with no entry, which was only ever a potion -- and it went with
 * the row: an equipment reward that had to invent its own number was the one
 * place this family drew a price out of nowhere.
 */
export type EquipmentDraw =
  /** a catalog entry: name, slots, facts and price all come from STANDARD_EQUIPMENT */
  | { kind: "catalog"; key: EquipmentKey; amount?: string; value: number }
  /** a spellbook, which is the entry plus the one spell it holds */
  | { kind: "spellbook"; spell: string; effect: string; value: number };

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

export type Headline = "creature" | "special" | "quiet" | "none";

export type RoomRole = "entrance" | "goal" | "normal";

export type Disposition = "hostile" | "neutral" | "friendly";

export interface SpecialContent {
  kind: "hazard" | "obstacle";
  /** hazard: an environmental hazard, or a trap (trigger + effect) */
  hazard?: Rolled;
  trapTrigger?: Rolled;
  trapEffect?: Rolled;
  /** obstacle: Cairn Special + (Cairn Feature | MR Trick) */
  subject?: Rolled;
  behaviour?: Rolled;
  behaviourSource?: "cairn-feature" | "mr-trick";
}

export interface ClueContent {
  keyword: Rolled;
  /** what this clue is actually about -- resolved after all placement */
  targetRoomId?: string;
  targetMobileId?: string;
  about: string;
}

/**
 * What the composition pass must create to embody the dungeon goal. We do not
 * pick the entity TYPE here -- the goal may be a creature, an object, a person,
 * a feature of the room, or something stranger, and only the fiction settled in
 * the Dungeon Pass can say which. The room is fixed; the form is not.
 */
export interface GoalDirective {
  reward: Rolled;
  mission: Rolled;
  instruction: string;
}

export interface MobileEntity {
  id: string;
  kind: "group-member" | "wanderer-monster" | "wanderer-npc";
  /**
   * Id of the group this creature belongs to. Inhabitant groups come from the
   * dungeon pass; wanderer groups are created here during stocking and held in
   * StockedDungeon.wandererGroups. Either way the creature's rolled identity
   * lives on a group at dungeon level, never on the creature itself.
   */
  groupId?: string;
  name: string;
  locationRoomId: string;
  /** index into blueprint.inhabitants, when affiliated */
  groupIndex?: number;
  isBase?: boolean;
  tier?: Tier;
  activity?: Rolled;
  disposition?: Disposition;
  monster?: MonsterSeed;
  npc?: NpcSeed;
  /**
   * Nameless rank and file attached to an inhabitant group. Minions share their
   * parent's tier and are always simple complexity -- for people minions, treat
   * them as simple wherever complexity is needed.
   */
  minion?: "young" | "thrall" | "ecology" | "hirelings";
  notes?: string;
}

export interface RoomStock {
  /** stable entity id carried through from the graph */
  roomId: string;
  /** graph index, for adjacency work and human-readable reports */
  index: number;
  /** the graph's chunk -- purely a batching unit, never a content input */
  chunk: number;
  role: RoomRole;
  headline: Headline;
  /** true when load-bearing placement claimed this room */
  claimed: boolean;
  /** a claimed room that also stacked a second headline */
  stacked?: Headline;

  /**
   * This room is a passage rather than a place: it rolled `identity` on the
   * Dungeon Corridors table and the floorplan draws it as whatever shape the
   * connection needed rather than as a chamber with an area band.
   *
   * A corridor is an ordinary room in every other respect -- it keeps its
   * headline and its contents, occupancy and travel and fog work on it
   * unchanged. It costs roughly 17% of the content rooms at every size, which
   * is the point rather than the price: a dungeon of nothing but stocked rooms
   * reads as beads on a string, and corridors are the pacing.
   */
  isCorridor: boolean;

  /**
   * How big the room came out once the layout drew it, read off its floor area.
   *
   * This arrives from OUTSIDE stocking, via the `layout` hook, and it arrives
   * before `identity` is rolled -- which is the whole reason the hook exists. A
   * room's size is decided by where its neighbours ended up and how much ground
   * they left it, and no roll can know that in advance. So the geometry settles
   * first and the size then constrains what the room may be: a four-cell closet
   * does not get to be a banquet hall. See `sizeAllows`.
   *
   * Undefined when no layout ran, in which case identity rolls unconstrained.
   */
  sizeClass?: SizeClass;

  identity: Rolled;
  detail?: Rolled;
  entranceFeature?: Rolled;

  depth: number;
  degree: number;
  isDeadEnd: boolean;

  danger: number;
  special?: SpecialContent;
  clue?: ClueContent;
  /**
   * Everything placed here, whoever ends up holding it. An array because there
   * is deliberately NO CAP per room or per entity -- more than one reward in a
   * room is fine, and sometimes you stumble on an awesome find.
   */
  rewards: Reward[];

  /** mobile entity ids currently located here */
  occupants: string[];

  /** present on exactly one room */
  goalDirective?: GoalDirective;
}

export interface StockedConnector {
  id: string;
  a: string;
  b: string;
  /**
   * A connection is either freely usable or it is not. Whatever stands in the
   * way -- locked, blocked, concealed, flooded, too dangerous -- is one idea,
   * not three, so we only mark THAT a connector is gated. What it actually
   * demands falls out of the LLM pass, which can see both rooms it joins, and
   * lands in `requirement` -> the entity's `conditional` field.
   */
  gated: boolean;
  /**
   * Concealed: the player does not know this way exists until they find it.
   * Rolled here rather than decided by the writing pass — see gateConnectors.
   * Independent of `gated`; a way can be hidden, blocked, or both.
   */
  hidden: boolean;
  /** filled by the composition pass; becomes IRoomConnector.conditional */
  requirement?: string;
}

export interface StockedDungeon {
  seed: number;
  size: Size;
  level: number;
  entranceRoomId: string;
  goalRoomId: string;
  maxDepth: number;
  rooms: RoomStock[];
  mobiles: MobileEntity[];
  /**
   * Groups created for wandering encounters. Same shape as inhabitants, but
   * rolled during stocking rather than during dungeon generation, so they are
   * not part of the dungeon's resident population.
   */
  wandererGroups: InhabitantGroup[];
  connectors: StockedConnector[];
  /** per-dungeon share of creature encounters tied to the roster */
  cohesion: number;
  quota: Record<Headline, number>;
  /**
   * Every keyable property in the dungeon, enumerated. Keys answer these,
   * accomplishments resolve them, and XP prices them -- see dungeon-challenges.
   */
  challenges: Challenge[];
  /**
   * The challenges no placed key answers, held for a draw in play. Pure data:
   * a reserve entry is written only when it is drawn.
   */
  reserve: ReserveEntry[];
  /** the dungeon's money, conserved */
  pot: Pot;
  rewardBudget: { general: number; keys: number; reserved: number };
}

/**
 * One thing the payload asked for that the response did not answer.
 *
 * Structurally a `ValidationIssue` (src/llm/validation.ts) without being
 * one: the engine does not import from the runtime. The guard that keeps the
 * two shapes together lives on the runtime side, beside the other three.
 */
export interface Omission {
  path: string;
  message: string;
}
