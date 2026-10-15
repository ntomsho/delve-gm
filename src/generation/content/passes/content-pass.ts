/**
 * CONTENT PASS  (per chunk)
 * =========================
 *
 * The fourth pass, and the first that writes prose. ONE batch call per chunk
 * (six rooms). In a single call the model names and writes the standing `base`
 * for every room, entity, connector, and creature-group local to those rooms,
 * and the deterministic layer settles counts and stats around it.
 *
 * CONSOLIDATION. A pack of one creature type is ONE entity with a `count` and a
 * single stat block -- five fen-seals are "Fen-seals x5", not five identical
 * bodies. Distinct specimens (an elite, a named person) split off into their own
 * entity. The number appearing is rolled in code from the group's tier, never by
 * the model.
 *
 * KEYWORDS. Everything that gets a base also carries `keywords`: a record of the
 * procgen rolls behind it, keyed by the table each was rolled from. These ride
 * along into the context of any later pass that revisits the entity.
 */

import type { DungeonBlueprintSeed, InhabitantGroup, Tier } from "../blueprint.ts";
import type { MonsterSeed, NpcSeed } from "../../../shared/world/seeds.ts";
import { makeId } from "../../../shared/utils/id.ts";
import { Rng } from "../../../shared/utils/rng.ts";
import {
  addFixture,
  createCreatureFromGroup,
  createCreatureFromSeed,
  promoteDetail,
  PENDING_CONDITION,
} from "../entities-pass.ts";
import type { EntityPassResult } from "../../../shared/world/entities.ts";
import {
  describeGeometry,
  exitPhrase,
  type RoomGeometry,
  type RoomGround,
  type Siting,
} from "../../floorplan/geometry.ts";
import { fixtureCap, fixtureMenu, placeAt, placeFixture } from "../../floorplan/fixtures.ts";
import {
  isFixtureKind,
  isPositionWord,
  POSITION_WORDS,
  type Placement,
  type PositionWord,
} from "../../../shared/world/placement.ts";
import type {
  MobileEntity,
  Omission,
  RoomStock,
  SpecialContent,
  StockedConnector,
  StockedDungeon,
} from "../types.ts";
import { goalItemValue } from "../rewards.ts";
import type { Reward } from "../types.ts";
import { withheldKeyItems } from "./keys-pass.ts";
import { properName } from "../../../shared/world/entities.ts";
import type {
  CreatureStats,
  ICreature,
  IItem,
  IRoom,
  IRoomFeature,
} from "../../../shared/world/entities.ts";

type KW = Record<string, string>;

// ===========================================================================
// PAYLOAD TYPES
// ===========================================================================

export type DepthBand = "threshold" | "shallow" | "middle" | "deep" | "furthest";
export type TensionBand = "calm" | "uneasy" | "dangerous" | "lethal";

/** A room-local feature / item / hazard the model must name and write. */
export interface EntityBrief {
  ref: string;
  kind: "entrance" | "obstacle" | "clue" | "reward" | "hazard";
  entity: "RoomFeature" | "Item" | "Hazard";
  keywords: KW;
  /** resolved context procgen attached, e.g. what a clue points at */
  note?: string;
  hidden?: boolean;
}

export interface DetailBrief {
  text: string;
  keywords: KW;
}

/** Every connector out of a room the room owns -- gated or not. */
export interface ConnectorBrief {
  ref: string;
  /** null on a way out of the dungeon: there is no room on the other side */
  toRef: string | null;
  /**
   * A way through to a room in ANOTHER chunk. Listed so the room knows how many
   * ways out it has, and NOT written here -- see SeamBrief. Never set on a
   * connector this chunk owns.
   */
  seam?: boolean;
  /**
   * What is on the other side, as context only. A connector's NAME must not
   * mention either room -- it is named for what it physically is, and the room
   * it leads to is appended at read time, from whichever side is being read.
   * See CONNECTOR_NAMING. Absent on a way out of the dungeon.
   */
  toIdentity?: string;
  /**
   * The way out of the dungeon. Carries the rolled entrance keyword, which is
   * how the party got in and therefore what the exit physically is.
   */
  surface?: KW;
  gated: boolean;
  /**
   * Concealed, decided by the seeded roll in gateConnectors. The model still
   * writes what it physically is -- that description is what the player reads
   * on finding it -- but a secret way wants writing as the thing you would miss,
   * not as a door.
   */
  hidden: boolean;
  /**
   * Which wall of THIS room it cuts through -- "the east wall, toward the north
   * end". Absent when the dungeon was generated without a block plan.
   *
   * On the connector line rather than gathered into the room's shape line, so
   * the fact sits next to the thing it is about and nothing has to be joined by
   * ref twice.
   */
  wall?: string;
}

/** One consolidated body of rank-and-file, count rolled in code. */
export interface GroupBrief {
  count: number;
  keywords: KW;
}

/** A specimen that stands apart from the mass: an elite or a named person. */
export interface DistinctBrief {
  kind: "elite" | "named";
  /** for a named person, the NpcSeed id */
  member?: string;
  isLeader?: boolean;
  keywords: KW;
}

export interface EncounterBrief {
  ref: string;
  roomRef: string;
  tier: Tier;
  activity: string;
  disposition: string;
  affiliation: string;
  template: string;
  /** the anonymous mass present, if any */
  group?: GroupBrief;
  /** specimens written as their own entity */
  distinct: DistinctBrief[];
}

export interface ContentRoomBrief {
  ref: string;
  role: RoomStock["role"];
  identity: string;
  depth: DepthBand;
  tension: TensionBand;
  isDeadEnd: boolean;
  headline: RoomStock["headline"];
  stacked?: RoomStock["headline"];
  detail?: string;
  keywords: KW;
  entities: EntityBrief[];
  detailCandidates: DetailBrief[];
  connectors: ConnectorBrief[];
  encounters: EncounterBrief[];
  goal?: { reward: string; mission: string };
  gatedExits: string[];
  openExits: string[];
  /**
   * The room as it was DRAWN, in words -- size, proportion, outline, which walls
   * the ways out are in. See `describeGeometry`.
   *
   * This is the accuracy multiplier and the reason the block plan runs before
   * this pass. Without it the model writes to the rolled identity alone and
   * produces "a long banquet hall" for a room the map draws nearly square; the
   * player is then the only one in a position to notice that the prose and the
   * map are describing different rooms.
   *
   * Absent when the dungeon has no block plan, which stays a supported case.
   */
  geometry?: string;
  /**
   * How many drawable things this room may hold, and whether it is a passage —
   * in which case only the starred half of the menu fits. The menu itself is in
   * the instructions, once, rather than repeated under all six rooms.
   */
  fixtures?: { cap: number; corridor: boolean };
}

export interface ContentBorderBrief {
  ref: string;
  identity: string;
  headline: RoomStock["headline"];
  summary: string;
  connectsTo: string[];
}

export interface ContentPassPayload {
  chunk: number;
  dungeonContext: string;
  rooms: ContentRoomBrief[];
  borders: ContentBorderBrief[];
  instructions: string;
  responseSchema: string;
  /**
   * THE CELLS, WHICH NEVER REACH THE MODEL.
   *
   * `renderContentPassPrompt` does not touch this and must not: coordinates are
   * the half of the geometry that stays on this side, and the payload is already
   * the channel between build and apply for everything else apply needs to look
   * up by ref (rolled keywords, encounter briefs). Keyed by room ref.
   *
   * Absent when there is no block plan, in which case nothing is placed and the
   * map falls back to `pointLayout` — a fully playable dungeon with no drawing.
   */
  ground?: Record<string, { geometry: RoomGeometry; ground: RoomGround }>;
}

// ===========================================================================
// RESPONSE TYPES
// ===========================================================================

/** Stat deviations only. HD/HP come from code; the model layers flavour on top. */
export interface StatDeviations {
  damage?: string;
  armorDefense?: number;
  morale?: number;
  modifiers?: CreatureStats["modifiers"];
}

export interface WrittenEntity {
  ref: string;
  name: string;
  base: string;
  /**
   * One of the position words, saying where in the room it sits.
   *
   * Free text is validated against the vocabulary and anything else falls back
   * to the centre. Optional because a dungeon with no drawing has nowhere to put
   * it — and because a dropped position costs a dot, not a room.
   */
  position?: string;
}

export interface PromotedDetail {
  text: string;
  name: string;
  base: string;
  hidden?: boolean;
  position?: string;
}

/**
 * A drawable thing the model chose to furnish the room with.
 *
 * `kind` and `position` are validated against the menu and the position words;
 * an unrecognised value is dropped and never fatal. HOW MANY there are is not
 * here and never will be — that is rolled from the kind, in code.
 */
export interface FixtureResponse {
  kind: string;
  position: string;
  name: string;
  base: string;
}

export interface ConnectorResponse {
  ref: string;
  name: string;
  /** what the connector physically is: door, stair, corridor, drop, etc. */
  form: string;
  /** what blocks it, gated connectors only */
  requirement?: string;
}

export interface GroupResponse {
  name: string;
  base: string;
  activity: string;
  stats?: StatDeviations;
}

export interface DistinctResponse {
  kind: "elite" | "named";
  member?: string;
  name: string;
  base: string;
  isLeader?: boolean;
  activity: string;
  stats?: StatDeviations;
}

export interface EncounterResponse {
  ref: string;
  group?: GroupResponse;
  distinct?: DistinctResponse[];
}

export interface RoomResponse {
  ref: string;
  name: string;
  base: string;
  entities?: WrittenEntity[];
  fixtures?: FixtureResponse[];
  promotions?: PromotedDetail[];
  connectors?: ConnectorResponse[];
  encounters?: EncounterResponse[];
  goal?: {
    entityType: "Item" | "RoomFeature" | "Creature";
    name: string;
    base: string;
    position?: string;
  };
}

export interface ContentPassResponse {
  rooms: RoomResponse[];
}

// ===========================================================================
// KEYWORD SOURCING  (the rolled procgen behind each base, keyed by table)
// ===========================================================================

function monsterKeywords(m: MonsterSeed): KW {
  const r: KW = { Complexity: m.complexity, Silhouette: m.silhouette };
  if (m.animals?.length) r["Reference animals"] = m.animals.join(" + ");
  if (m.humanoidSeed) r[m.humanoidSeed.table] = m.humanoidSeed.result;
  for (const t of m.traitsAndAbilities) r[t.table] = r[t.table] ? `${r[t.table]}; ${t.result}` : t.result;
  for (const f of m.featuresAndMutations) r[f.table] = r[f.table] ? `${r[f.table]}; ${f.result}` : f.result;
  r["Tactic"] = m.tactic;
  if (m.personality) r["Personality"] = m.personality;
  if (m.weaknesses.length) r["Weakness"] = m.weaknesses.join(", ");
  return r;
}

function npcKeywords(n: NpcSeed): KW {
  const r: KW = {
    [n.origin.kind]: n.origin.result,
    Asset: n.asset,
    Liability: n.liability,
    Method: n.method,
    Appearance: n.appearance,
    Personality: n.personality,
    Goal: n.goal,
  };
  for (const f of n.flavor) r[f.table] = r[f.table] ? `${r[f.table]}; ${f.result}` : f.result;
  return r;
}

const TREASURE_TABLE: Record<string, string> = {
  coins: "Coin",
  item: "Treasure Item",
  "item-with-trait": "Treasure Item",
  ingredients: "Magical Ingredient",
  // The row names the thing and the content is what it DOES, because that is
  // all `POTIONS` holds -- so the pass sees `Potion: Ghost-speech` and writes a
  // flask, not a ghost.
  potion: "Potion",
};

/**
 * What the writing pass is told about one reward entity.
 *
 * An equipment reward already knows what it is -- it came out of the catalog
 * with a name, a price and its facts -- so the keyword is that name and the
 * pass writes THIS coil of rope rather than choosing a thing. Treasure hands
 * over its rolled content. A key hands over the fact it has to answer, which is
 * the one case where the pass is being asked to invent the object.
 */
function rewardKeywords(rw: Reward, itemName: string): KW {
  if (rw.kind === "equipment") return { Equipment: itemName };
  if (rw.kind === "treasure") return { [TREASURE_TABLE[rw.row] ?? "Treasure"]: rw.content };
  return { Key: rw.answers };
}

function hazardKeywords(s: SpecialContent): KW {
  if (s.hazard) return { Hazard: s.hazard };
  const r: KW = {};
  if (s.trapTrigger) r["Trap Trigger"] = s.trapTrigger;
  if (s.trapEffect) r["Trap Effect"] = s.trapEffect;
  return r;
}

function obstacleKeywords(s: SpecialContent): KW {
  const r: KW = {};
  if (s.subject) r["Obstacle"] = s.subject;
  if (s.behaviour) r[s.behaviourSource === "mr-trick" ? "Trick" : "Cairn Feature"] = s.behaviour;
  return r;
}

function roomKeywords(r: RoomStock): KW {
  const kw: KW = { Room: r.identity };
  if (r.detail) kw["Room Detail"] = r.detail;
  return kw;
}

function baseMonsterOf(g: InhabitantGroup): MonsterSeed | undefined {
  return g.kind === "monsters" ? g.monster : undefined;
}

// ===========================================================================
// DESCRIBE HELPERS
// ===========================================================================

function describeMonster(m: MonsterSeed): string {
  const bits: string[] = [`${m.complexity} ${m.silhouette}`];
  if (m.silhouette === "beastlike" && m.animals?.length) bits.push(`drawn from ${m.animals.join(" and ")}`);
  else if (m.humanoidSeed) bits.push(`${m.humanoidSeed.table.toLowerCase()}: ${m.humanoidSeed.result}`);
  for (const ta of m.traitsAndAbilities) bits.push(`${ta.table.toLowerCase()}: ${ta.result}`);
  for (const fm of m.featuresAndMutations) bits.push(`${fm.table.toLowerCase()}: ${fm.result}`);
  bits.push(`tactic: ${m.tactic}`);
  if (m.personality) bits.push(`personality: ${m.personality}`);
  if (m.weaknesses.length) bits.push(`weakness: ${m.weaknesses.join(", ")}`);
  return bits.join("; ");
}

function describeNpc(n: NpcSeed): string {
  const parts = [
    `${n.isLeader ? "[LEADER] " : ""}${n.name} (${n.presentingGender}) [${n.id}]`,
    `${n.origin.kind}: ${n.origin.result}`,
    `asset: ${n.asset}`,
    `liability: ${n.liability}`,
    `method: ${n.method}`,
    `appearance: ${n.appearance}`,
    `personality: ${n.personality}`,
    `goal: ${n.goal}`,
  ];
  if (n.flavor.length) parts.push(n.flavor.map((f) => `${f.table}: ${f.result}`).join("; "));
  return parts.join("; ");
}

function describeGroup(g: InhabitantGroup): string {
  if (g.kind === "monsters") {
    const L = [`MONSTER GROUP, tier ${g.tier}`, `  base: ${describeMonster(g.monster)}`];
    if (g.biggerSpecimen) L.push(`  elite specimen: ${describeMonster(g.biggerSpecimen)}`);
    return L.join("\n");
  }
  const L = [`PEOPLE GROUP, tier ${g.tier}`, `  faction: ${g.faction}`, `  traits: ${g.traits.join("; ")}`];
  if (g.undefinedUnderlings) L.push(`  plus an undefined mass of underlings`);
  for (const n of g.npcs) L.push(`  - ${describeNpc(n)}`);
  return L.join("\n");
}

function describeLooseSeed(m: MobileEntity): string {
  if (m.monster) return `LOOSE MONSTER\n  ${describeMonster(m.monster)}`;
  if (m.npc) return `LOOSE PERSON\n  ${describeNpc(m.npc)}`;
  return m.notes ?? "unspecified creature";
}

function depthBand(depth: number, maxDepth: number): DepthBand {
  if (depth === 0) return "threshold";
  if (!maxDepth) return "shallow";
  const n = depth / maxDepth;
  if (n >= 0.99) return "furthest";
  if (n > 0.66) return "deep";
  if (n > 0.33) return "middle";
  return "shallow";
}

function tensionBand(danger: number): TensionBand {
  if (danger >= 0.75) return "lethal";
  if (danger >= 0.5) return "dangerous";
  if (danger >= 0.25) return "uneasy";
  return "calm";
}

/** Number appearing, rolled in code from the group's tier. Detachments are thinner. */
function numberAppearing(tier: Tier, isBase: boolean, rng: Rng): number {
  let n = tier === "Solo" ? 1 : tier === "Band" ? rng.range(2, 5) : rng.range(6, 12);
  if (!isBase && n > 2) n = Math.max(2, Math.floor(n / 2));
  return n;
}

// ===========================================================================
// BUILD
// ===========================================================================

export function buildContentPassPayload(
  sd: StockedDungeon,
  bp: DungeonBlueprintSeed,
  ep: EntityPassResult,
  chunk: number,
  dungeonContext: string,
  /**
   * The drawn rooms, by graph index. Optional throughout: a dungeon with no
   * block plan generates exactly as it did before, without geometry in the
   * prompt and without fixtures in the response.
   */
  site?: Siting
): ContentPassPayload {
  const rng = new Rng((sd.seed ?? 0) + 131 * (chunk + 1));
  const roomById = new Map(sd.rooms.map((r) => [r.roomId, r]));
  const mobById = new Map(sd.mobiles.map((m) => [m.id, m]));
  const ref = (r: RoomStock) => `room_${r.index}`;

  const itemById = new Map(ep.items.map((i) => [i.id, i]));
  const itemIds = new Set(ep.items.map((i) => i.id));
  const rewardById = new Map<string, Reward>();
  for (const r of sd.rooms) for (const w of r.rewards) rewardById.set(w.id, w);
  const withheld = withheldKeyItems(sd, ep);
  const hazardIds = new Set(ep.hazards.map((h) => h.id));
  const featureById = new Map(ep.features.map((f) => [f.id, f]));

  const groupById = new Map<string, InhabitantGroup>();
  for (const g of [...bp.inhabitants, ...sd.wandererGroups]) groupById.set(g.id, g);

  const inChunk = sd.rooms.filter((r) => r.chunk === chunk);
  const inChunkIds = new Set(inChunk.map((r) => r.roomId));

  const linksOf = (roomId: string) =>
    sd.connectors
      .filter((c) => c.a === roomId || c.b === roomId)
      .map((c) => ({ conn: c, other: roomById.get(c.a === roomId ? c.b : c.a)! }));

  /**
   * A connector is written by the pass that can see BOTH rooms it joins.
   *
   * That is this one only when both endpoints are in this chunk -- and then the
   * lower graph index owns it, so it is written once rather than by each of its
   * two rooms.
   *
   * A connector leaving the chunk is a SEAM and is not written here. Every chunk
   * payload is built before any of them is applied, so at this moment the room on
   * the far side has no name and no base: whatever this chunk wrote would be
   * written blind, and then silently overwritten by the other chunk writing it
   * equally blind from its own side. Seams go to `buildSeamsPassPayload`, which
   * runs after every chunk has landed and has both rooms in front of it.
   */
  const ownsConnector = (c: StockedConnector, r: RoomStock): boolean => {
    const mine = c.a === r.roomId || c.b === r.roomId;
    if (!mine) return false;
    if (!inChunkIds.has(c.a) || !inChunkIds.has(c.b)) return false;
    const owner = roomById.get(c.a)!.index <= roomById.get(c.b)!.index ? c.a : c.b;
    return r.roomId === owner;
  };

  // A connector is looked up by its own id when the geometry is asked which
  // wall it is in. The surface exit is not on the graph and so has no entry;
  // it is matched by its null far side instead, per `GeometryExit`.
  const wallOf = (roomIndex: number, connectorId: string | null): string | undefined => {
    const g = site?.geometry[roomIndex];
    const exit = g?.exits.find((x) => x.connectorId === connectorId);
    return exit ? exitPhrase(exit) : undefined;
  };

  const rooms: ContentRoomBrief[] = inChunk.map((r) => {
    const links = linksOf(r.roomId);
    const geom = site?.geometry[r.index];

    // --- room-local entities ---
    const entities: EntityBrief[] = [];
    for (const b of ep.bindings) {
      if (b.roomId !== r.roomId) continue;
      if (b.element === "creature" || b.element === "connector" || b.element === "detail") continue;
      // A PLACED KEY IS LEFT NAMELESS HERE, the way a seam is left formless.
      // Its lock is usually in another chunk and has not been written at the
      // moment this payload is built, so anything written now could only invent
      // one. `keys-pass.ts` writes it afterwards with both in front of
      // it. The key still gets a position -- see `placeWithheld` in the applier.
      if (withheld.has(b.entityId)) continue;
      const entity = itemIds.has(b.entityId) ? "Item" : hazardIds.has(b.entityId) ? "Hazard" : "RoomFeature";

      let keywords: KW = {};
      let note: string | undefined;
      switch (b.element) {
        case "entrance":
          keywords = r.entranceFeature ? { Entrance: r.entranceFeature } : {};
          break;
        case "clue":
          if (r.clue) {
            keywords = { Clue: r.clue.keyword };
            const t = r.clue.targetRoomId ? roomById.get(r.clue.targetRoomId) : undefined;
            note = `points at ${r.clue.about}` + (t ? ` (${ref(t)})` : "");
          }
          break;
        case "obstacle":
          if (r.special) keywords = obstacleKeywords(r.special);
          break;
        case "hazard":
          if (r.special) keywords = hazardKeywords(r.special);
          break;
        case "reward": {
          // Keys never reach here — `withheld` dropped them above, and the keys
          // pass writes them once their lock exists. What is left is equipment,
          // which arrived from the catalog already knowing what it is, and
          // treasure, which hands over its rolled content.
          const rw = b.rewardId ? rewardById.get(b.rewardId) : undefined;
          if (rw) keywords = rewardKeywords(rw, itemById.get(b.entityId)?.name ?? "");
          break;
        }
      }
      entities.push({ ref: b.entityId, kind: b.element, entity, keywords, note, hidden: featureById.get(b.entityId)?.isHidden });
    }

    // --- detail candidates ---
    const detailCandidates: DetailBrief[] = ep.detailCandidates
      .filter((d) => d.roomId === r.roomId)
      .map((d) => ({ text: d.text, keywords: { "Room Detail": d.text } }));

    // --- ALL connectors this room owns ---
    const connectors: ConnectorBrief[] = links
      .filter((l) => ownsConnector(l.conn, r))
      .slice()
      .map((l) => ({
        ref: l.conn.id,
        toRef: ref(l.other),
        toIdentity: l.other.identity,
        gated: l.conn.gated,
        hidden: l.conn.hidden,
        wall: wallOf(r.index, l.conn.id),
      }));

    // --- and the ways out of the chunk, as context only ---
    // The room has to know how many ways out it has, or it writes itself as
    // having fewer and the writing pass starts inventing replacements. It just
    // does not get to write these ones.
    for (const l of links) {
      if (inChunkIds.has(l.other.roomId)) continue;
      connectors.push({
        ref: l.conn.id,
        toRef: ref(l.other),
        toIdentity: l.other.identity,
        gated: l.conn.gated,
        hidden: l.conn.hidden,
        seam: true,
        // A seam is not written here, but the room still stands in front of it
        // and the prose has to be able to say which way it faces.
        wall: wallOf(r.index, l.conn.id),
      });
    }

    // The way out of the dungeon belongs to the entrance room. It is not in
    // `sd.connectors` -- the topology pass only knows about ways between rooms
    // -- so it is picked up from the emitted entities, where it exists with a
    // null far end.
    if (r.roomId === sd.entranceRoomId) {
      const surface = ep.connectors.find(
        (c) => c.endpointB === null && c.endpointA === r.roomId
      );
      if (surface) {
        connectors.push({
          ref: surface.id,
          toRef: null,
          surface: r.entranceFeature ? { Entrance: r.entranceFeature } : {},
          gated: false,
          hidden: false,
          // Null, because the way out is minted by the entities pass and is not
          // on `graph.edges` — the geometry knows it only by its missing far end.
          wall: wallOf(r.index, null),
        });
      }
    }

    // --- encounters (consolidated) ---
    const encounters: EncounterBrief[] = r.occupants.map((mid) => {
      const m = mobById.get(mid)!;
      const group = m.groupId ? groupById.get(m.groupId) : undefined;
      const tier = m.tier ?? group?.tier ?? "Band";
      const template = group ? describeGroup(group) : describeLooseSeed(m);

      const baseSeed = group ? baseMonsterOf(group) : m.monster;
      const massKw: KW = baseSeed
        ? monsterKeywords(baseSeed)
        : m.npc
        ? npcKeywords(m.npc)
        : {};

      const distinct: DistinctBrief[] = [];
      // People groups: named members are individuals -> each its own entity.
      if (group && group.kind === "people") {
        for (const n of group.npcs) distinct.push({ kind: "named", member: n.id, isLeader: n.isLeader, keywords: npcKeywords(n) });
      }
      // Monsters: the base mobile of a group with a bigger specimen fields its elite.
      const eliteHere = !!group && group.kind === "monsters" && !!group.biggerSpecimen && !!m.isBase;
      if (eliteHere) distinct.push({ kind: "elite", isLeader: true, keywords: monsterKeywords((group as any).biggerSpecimen) });

      // The anonymous mass: rank-and-file monsters, or undefined underlings.
      let mass: GroupBrief | undefined;
      const hasMass =
        !group /* loose seed */ ||
        group.kind === "monsters" ||
        (group.kind === "people" && group.undefinedUnderlings);
      if (hasMass) mass = { count: numberAppearing(tier, m.isBase ?? false, rng), keywords: massKw };

      return {
        ref: m.id,
        roomRef: ref(r),
        tier,
        activity: m.activity ?? "unspecified",
        disposition: m.disposition ?? "hostile",
        affiliation:
          m.groupIndex !== undefined ? `${m.isBase ? "base of" : "detachment from"} group ${m.groupIndex + 1}` : "unaffiliated",
        template,
        group: mass,
        distinct,
      };
    });

    return {
      ref: ref(r),
      role: r.role,
      identity: r.identity,
      depth: depthBand(r.depth, sd.maxDepth),
      tension: tensionBand(r.danger),
      isDeadEnd: r.isDeadEnd,
      headline: r.headline,
      stacked: r.stacked,
      detail: r.detail,
      keywords: roomKeywords(r),
      entities,
      detailCandidates,
      connectors,
      encounters,
      goal: r.roomId === ep.pendingGoal.roomId ? { reward: ep.pendingGoal.reward, mission: ep.pendingGoal.mission } : undefined,
      gatedExits: links.filter((l) => l.conn.gated).map((l) => ref(l.other)),
      openExits: links.filter((l) => !l.conn.gated).map((l) => ref(l.other)),
      geometry: geom ? describeGeometry(geom) : undefined,
      fixtures: geom ? { cap: fixtureCap(geom), corridor: geom.corridor } : undefined,
    };
  });

  // --- borders ---
  const borderIds = new Set<string>();
  for (const r of inChunk) for (const l of linksOf(r.roomId)) if (!inChunkIds.has(l.other.roomId)) borderIds.add(l.other.roomId);
  const borders: ContentBorderBrief[] = [...borderIds].map((id) => {
    const b = roomById.get(id)!;
    const parts: string[] = [];
    if (b.occupants.length) parts.push(`holds ${b.occupants.length} creature group(s)`);
    if (b.special) parts.push(b.special.kind === "hazard" ? "hazardous" : "has an obstacle");
    if (b.role === "goal") parts.push("the objective is here");
    if (b.role === "entrance") parts.push("the way in");
    return {
      ref: ref(b),
      identity: b.identity,
      headline: b.headline,
      summary: parts.length ? parts.join("; ") : "quiet",
      connectsTo: linksOf(b.roomId).filter((l) => inChunkIds.has(l.other.roomId)).map((l) => ref(l.other)),
    };
  });

  // Only the rooms this chunk writes. A border room's cells are of no use here
  // — apply never touches it — and carrying them would put the whole dungeon's
  // grid in every one of N payloads.
  let ground: ContentPassPayload["ground"];
  if (site) {
    ground = {};
    for (const r of inChunk) {
      ground[ref(r)] = { geometry: site.geometry[r.index], ground: site.ground[r.index] };
    }
  }

  return {
    chunk,
    dungeonContext,
    rooms,
    borders,
    instructions: CONTENT_PASS_INSTRUCTIONS,
    responseSchema: CONTENT_PASS_SCHEMA,
    ground,
  };
}

// ===========================================================================
// RENDER
// ===========================================================================

const kwLine = (kw: KW) =>
  Object.entries(kw).map(([t, v]) => `${t}=${v}`).join("  |  ") || "--";

export function renderContentPassPrompt(p: ContentPassPayload): string {
  const L: string[] = [];
  L.push(p.instructions, "");
  L.push("=== DUNGEON FICTION (shared context) ===", p.dungeonContext, "");
  L.push(`=== ROOMS TO WRITE (${p.rooms.length}) ===`, "");

  for (const r of p.rooms) {
    L.push(`--- ${r.ref} ---`);
    L.push(`identity: ${r.identity}`);
    if (r.role !== "normal") L.push(`role: ${r.role}`);
    L.push(`depth: ${r.depth}   tension: ${r.tension}${r.isDeadEnd ? "   dead end" : ""}`);
    L.push(`headline: ${r.headline}${r.stacked ? ` + ${r.stacked}` : ""}`);
    L.push(`room keywords: ${kwLine(r.keywords)}`);
    // AS DRAWN. Placed directly under the identity, because the two are read
    // together: the identity says what the place was built as and this says
    // what it came out as, and where they disagree the drawing is the fact.
    if (r.geometry) L.push(`as drawn: ${r.geometry}`);

    for (const e of r.entities) {
      L.push(`entity [${e.ref}] ${e.kind} (${e.entity})${e.hidden ? " HIDDEN" : ""}: ${kwLine(e.keywords)}` + (e.note ? ` -- ${e.note}` : ""));
    }
    for (const d of r.detailCandidates) {
      L.push(`promotable detail [${kwLine(d.keywords)}] -- make it an entity only if a player would act on it`);
    }
    for (const c of r.connectors) {
      const where = c.wall ? ` in ${c.wall}` : "";
      if (c.surface) {
        L.push(
          `connector [${c.ref}] OUT OF THE DUNGEON${where} -- the way the party came in and the ` +
            `only way back to daylight; realise it from [${kwLine(c.surface)}] and say what ` +
            `it physically is. Name it as a thing, not as an exit.`
        );
        continue;
      }
      if (c.seam) {
        L.push(
          `way out [${c.ref}]${where} to ${c.toRef} (${c.toIdentity})${c.gated ? " GATED" : ""}` +
            ` -- WRITTEN ELSEWHERE. It leaves this region, so it is written by a later ` +
            `pass that can see both rooms. Count it among this room's ways out; do not ` +
            `name it, describe it, or return it.`
        );
        continue;
      }
      const flags = `${c.gated ? " GATED" : ""}${c.hidden ? " CONCEALED" : ""}`;
      const asks = [
        c.hidden
          ? "write it as the thing a person would walk past -- a seam, a draught, a panel that rings hollow -- not as a door"
          : "say what it physically is",
        c.gated ? "and what blocks it, from here" : "no barrier",
      ].join("; ");
      // The far side is named so the form can suit it -- a kennel wants a gate,
      // a vault wants a door -- and for no other reason. It must not reach the
      // connector's name; see CONNECTOR_NAMING.
      L.push(`connector [${c.ref}]${where} to ${c.toRef} (${c.toIdentity})${flags} -- ${asks}`);
    }
    for (const en of r.encounters) {
      L.push(`encounter [${en.ref}] ${en.tier}, ${en.affiliation}, currently ${en.activity}, disposition ${en.disposition}`);
      if (en.group) L.push(`    mass: ${en.group.count} x rank-and-file -> ONE consolidated entity, one stat block  [${kwLine(en.group.keywords)}]`);
      for (const d of en.distinct) {
        L.push(`    distinct ${d.kind}${d.member ? ` [${d.member}]` : ""}${d.isLeader ? " (leader)" : ""} -> its own entity  [${kwLine(d.keywords)}]`);
      }
      for (const line of en.template.split("\n")) L.push(`      ${line}`);
    }
    if (r.goal) {
      L.push(`GOAL HERE: reward "${r.goal.reward}" + mission "${r.goal.mission}".`);
      L.push(`  ${GOAL_INSTRUCTION}`);
    }
    if (r.gatedExits.length) L.push(`gated exits: ${r.gatedExits.join(", ")}`);
    if (r.openExits.length) L.push(`open exits: ${r.openExits.join(", ")}`);
    if (r.fixtures) {
      L.push(
        `fixtures: up to ${r.fixtures.cap}, or none` +
          (r.fixtures.corridor ? " -- A PASSAGE: starred kinds only" : "")
      );
    }
    L.push("");
  }

  if (p.borders.length) {
    L.push(`=== BORDER ROOMS -- context only, do NOT write ===`, "");
    for (const b of p.borders) L.push(`${b.ref}: ${b.identity} (${b.headline}) -- ${b.summary}; connects to ${b.connectsTo.join(", ")}`);
    L.push("");
  }

  L.push("=== RESPONSE FORMAT ===", p.responseSchema);
  return L.join("\n");
}

// ===========================================================================
// INSTRUCTIONS + SCHEMA
// ===========================================================================

/**
 * A connector is read from both ends, and it is one entity with one name.
 *
 * Name it "Corridor to the Kennel" and the player standing IN the Kennel reads
 * "Corridor to the Kennel" on the way out — pointing at where they already are.
 * A game master asked to route "go back to the Laboratory" then has two exits both
 * claiming to lead to the Kennel and picks by coin toss. So the name carries the
 * nature of the crossing and nothing else, and `renderRoom` appends the room on
 * the far side, correct from whichever end is being read.
 */
export const CONNECTOR_NAMING = `Its NAME is what the thing physically is and
  NOTHING else -- "Iron door", "Low archway", "Spiral stair", "Flooded crawl",
  "Rope bridge". Name NEITHER room it joins: no "to the", no "from the", no room
  name, no direction. One connector is walked both ways and read from both ends,
  so a name that points is wrong from one of them. Where it leads is appended
  when it is read, and is not yours to write.`;

/**
 * A stair has a top and a bottom, and one entity read from both ends has no
 * "up" of its own.
 *
 * So the form says which ROOM is the upper one, by name. That is the one phrasing
 * that survives being read from either side, and without it the same flight of
 * steps is written as descending from both of its rooms -- which is what a player
 * walking back the way they came finds out.
 *
 * Both rooms are named by whoever is writing: a chunk writes only the connectors
 * whose two rooms it is naming in the same response, and the seams pass is handed
 * the names the chunks settled.
 */
export const CONNECTOR_HEIGHT = `Where it changes level -- a stair, a ladder, a
  shaft, a ramp, a hole in the floor, a drop -- the FORM must say which of the two
  rooms is above and which below, BY NAME: "a stair, the Counting Room at its head
  and the Sump at its foot". Not "leads down", which is true from only one end.`;

const GOAL_INSTRUCTION =
  "Create exactly one entity that embodies the objective. Read the fiction and " +
  "decide what type it needs to be -- an Item, a RoomFeature, or a Creature -- so " +
  "that a party acting on it plausibly satisfies the mission. Then name and write it.";

const CONTENT_PASS_INSTRUCTIONS = `You are writing one region of a dungeon: six rooms and everything in them.

WHAT YOU ARE GIVEN
Every room, entity, connector, and creature has already been decided by procgen.
Counts and hit dice are already rolled. Your job is to realise it in prose and
settle the few things procgen leaves to you -- not to choose what is there. Each
line lists the rolled keywords behind it as table=value; those are seeds to
realise, not text to echo.

PER ROOM
- name + base: the room's standing description. base is IMMUTABLE -- only what is
  true of the place itself, not what a party is doing in it, nothing that changes
  when its contents change.
- Each listed entity's name + base, written the same way: fixed identity, concrete
  to this fiction.
- Each connector: name + what it physically IS -- a door, a stair, a corridor, a
  crawl, a short drop, a collapsed arch, whatever separates the two rooms, even if
  mundane. ${CONNECTOR_NAMING}
  For a GATED connector also write what blocks it, seen from this room; do not
  invent the key.
  ${CONNECTOR_HEIGHT}
- Promotable details: a detail is always part of the room's description. Make it
  its own entity ONLY if a player would act on it. Most stay as description.
- Fixtures: up to the number the room gives, off the one menu. See FIXTURES.

THE ROOM AS DRAWN
Each room has already been drawn on the map. "as drawn" gives you its real size
in feet, its proportions, whether its outline is square-cornered or broken up,
and how many ways out are in each wall; each connector says which wall it is in.

WRITE TO THE DRAWING, NOT TO THE IDENTITY. The rolled identity says what the
place was built as; the drawing says what it came out as, and where the two
disagree the drawing wins. A room rolled "Banquet hall" and drawn twenty feet
square is not a long hall -- it is what became of one, or a service room off one,
or a hall the collapse took most of. Say so. A player looking at the map and
reading your prose must not be looking at two different rooms.

Two hard rules about direction:
- Compass only. North, south, east and west are on the map and are safe. "Left",
  "right", "ahead", "behind" depend on which way the party is facing and you do
  not know that; a party that walks back through will read them as lies.
- Do not invent an exit, a window, or a level change that is not listed. The ways
  out are exactly the connectors given.

And two about the ways out, both of them because base is IMMUTABLE and there is
no later pass that can correct it:
- DO NOT COUNT THEM IN THE ROOM'S BASE. "Four ways out: east, south, and two to
  the west" stops being true the first time one is opened, barred, collapsed or
  found, and the description cannot be rewritten to catch up -- so the number goes
  on being read aloud to the player long after it is wrong. The map draws the ways
  out and the game lists them fresh every turn. Describe the room; let the
  counting be done by something that is allowed to change its mind.
- A CONCEALED way is NOT part of the room's description. Write what it physically
  is on the connector itself -- that is the text the player reads on FINDING it --
  and keep it out of the room's base entirely, not even as a hint or a draught. A
  room whose standing description mentions the crack in the west wall has no
  secret door in it, because that description is read out on arrival. Where a
  concealed way is meant to be findable, procgen lists a clue as its own entity.

Feet are given so the prose can be concrete. Round them, compare them to
something, or ignore them -- but do not contradict them.

FIXTURES -- WHAT IS STANDING IN THE ROOM
The menu, once. Starred kinds also fit in a passage; the rest need a chamber.

  ${fixtureMenu()}

Each room says how many it may hold. Choose up to that many, or NONE AT ALL --
an empty room is a real room, and a dungeon of uniformly furnished ones reads as
a catalogue. Pick what the fiction has already earned: a barracks has bunks, a
shrine has an altar, a collapsed gallery has rubble.

Each fixture gets a "kind" from the menu, a "position", a name and a base, and is
written exactly like any other feature -- a thing in this dungeon, not a generic
one. Positions, and nothing else: ${POSITION_WORDS.join(", ")}.

A fixture is furniture, never a way somewhere. "stair" on the menu means steps
INSIDE the room -- up to a dais, down into water -- that arrive nowhere else. If
you want a way between two rooms, it is one of the connectors and it is already
listed. See A WAY THROUGH IS NEVER A FEATURE.

DO NOT say how many there are. "Pillars" is your decision; six pillars is not --
the count is rolled, and the map will draw whatever it rolled. Name them in a way
that survives either number, and write the base about what they ARE rather than
about how many.

Anything already listed as an entity may ALSO take a "position", from the same
words, saying where in the room it sits. That is what puts the chest, the clue
and the hazard on the map alongside the furniture.

NAMING A ROOM
The name comes from whatever DOMINATES the room, not from the identity it was
rolled from. The rolled identity says what the place was built as; the name says
what a party walking in would call it. A kennel whose stalls stand empty, with an
iron bridge over a chasm running through the middle of it, is not the Kennel --
the bridge and the chasm are what anyone would remember it by, and what they will
say when they mean "back to the room with the bridge". So read the room's
entities and its detail, work out what the biggest thing in there actually is,
and name it for that. Short, concrete, and sayable out loud.

EVERYTHING IS THERE FOR A REASON
Before you write a room or a feature, know why it is in THIS dungeon. Usually the
answer is ordinary and needs no room on the page -- a barracks in a fort, a sump
at the bottom of a mine. But anything that does NOT obviously belong is the first
thing a party will notice and ask about, and the fiction has to be able to answer.
A theatre inside a prison must have a story behind it: who built it, for whom, and
what became of it. Put that answer in the base, as a clause, not a lecture. An
incongruity with a reason behind it is the best thing in a dungeon; one without is
a mistake the player can see from the doorway.

A WAY THROUGH IS NEVER A FEATURE
If something you are about to write reads as a way to somewhere else -- a stair,
a shaft, a hole in the wall, a rent in the floor, a tunnel, a door -- it is a
CONNECTOR, not a RoomFeature and not a promoted detail. Spend the idea on one of
the connectors this room already has: each is listed with the room it leads to,
so pick the one whose far side suits it and write it as that connector's name
and form. The rooms are joined the way they are joined; you are describing those
joins, not adding to them.

A player will try to walk through anything that looks like a passage. Written as
a feature it leads nowhere, and they find that out by trying.

The ONE exception is the connector marked OUT OF THE DUNGEON, which is a real
way through to no room at all. It is already in your list. Do not invent others.

CREATURES -- CONSOLIDATE
The count is already rolled. A mass of one creature type is ONE entity with a
single stat block; do NOT split it into individuals. "5 x rank-and-file" is one
entity you name in the plural ("Fen-seals") and write once. Only a specimen
marked "distinct" -- an elite, a named person -- becomes its own entity alongside
the mass. Write the group's shared base once (the mass); write each distinct
specimen its own base. Give the mass and each distinct one a one-line current
activity fitting the encounter. Stats: you are given the hit-dice spine; return
only DEVIATIONS the keywords imply (a heavier die for claws, armour, a morale or
ability shift). Leave stats out for an average body.

BEASTS -- WHAT THE REFERENCE ANIMALS ARE FOR
A beastlike monster is listed with one reference animal or two. That was decided
by the roll, not left to you: one means one, two means both. They are the starting
point for a body, NOT the description of it. Take the general shape and bearing
from them -- how it stands, how it moves, how much of the room it takes up -- and
then write SPECIFIC borrowed parts: the shape of the snout, what it has instead of
ears, the horn or the antler, the set of the eyes, the feet, the hide.

What you must not do is name the animal and stop. "Badger-like", "part badger,
part Pteranodon", "resembles a heron" -- that is the reference showing through
where a creature should be. Name an animal only when the naming does real work
("the flat spade-shaped digging claws of a badger" both names it and tells you
something); otherwise the player should be able to picture the thing without ever
learning what it was built out of.

THE GOAL
One room is marked GOAL. ${GOAL_INSTRUCTION}

HARD RULES
1. Every listed entity, encounter, and connector must appear exactly once -- except
   a way out marked WRITTEN ELSEWHERE, which you must NOT return. That one leaves
   this region and is written by a pass that can see the room on the other side.
   Do not add a creature, hazard, or connector that was not listed.
2. Keywords are seeds, not labels. Realise them into the place; do not gloss.
3. Do not contradict the fiction. Material, history, and the state of the ruin are
   settled.
4. Depth and tension are tone, never content. A calm room holding a lethal thing
   still holds it.
5. A clue must point at what it is said to point at, written as something noticed.

MAKE THEM DISTINCT
These rooms are read in sequence. Give each one something the others lack. If two
would read the same, change one.`;

const CONTENT_PASS_SCHEMA = `Return JSON only, no prose outside it:

{
  "rooms": [
    {
      "ref": "<room ref, exactly as given>",
      "name": "<short room name>",
      "base": "<the room's standing description>",
      "entities": [ { "ref": "<entity ref>", "name": "<name>", "base": "<identity>", "position": "<one of the position words>" } ],
      "fixtures": [ { "kind": "<one from THIS room's menu>", "position": "<one of the position words>", "name": "<name>", "base": "<identity>" } ],
      "promotions": [ { "text": "<detail text as given>", "name": "<name>", "base": "<identity>", "hidden": false, "position": "<one of the position words>" } ],
      "connectors": [ { "ref": "<connector ref>", "name": "<what it is, naming neither room>", "form": "<what it physically is>", "requirement": "<gated only: what blocks it>" } ],
      "encounters": [
        {
          "ref": "<encounter ref>",
          "group": { "name": "<plural name>", "base": "<shared identity>", "activity": "<one line>", "stats": { "damage": "1d8" } },
          "distinct": [
            { "kind": "elite|named", "member": "<named: person id>", "name": "<name>", "base": "<identity>", "isLeader": false, "activity": "<one line>", "stats": { "armorDefense": 14 } }
          ]
        }
      ],
      "goal": { "entityType": "Item|RoomFeature|Creature", "name": "<name>", "base": "<identity>", "position": "<one of the position words>" }
    }
  ]
}

Include each key only when the room has it; "group" only when a mass is listed;
"distinct" only for specimens marked distinct; omit "goal" except in the GOAL
room. Leave "stats" out for an average creature.

"fixtures" and every "position" are optional and are omitted entirely for a room
with no "as drawn" line. NEVER put a count, a dimension, or a coordinate in any
of them: "kind" and "position" are words off the lists and nothing else.`;

// ===========================================================================
// COMPLETENESS
// ===========================================================================

/**
 * EVERYTHING THIS CHUNK WAS ASKED ABOUT AND DID NOT WRITE.
 *
 * A response answering five of six connectors is valid JSON against a valid
 * schema. Zod checks shape, and nothing about the shape says how many connectors
 * there should be -- so the omission passes, the chunk applies, and the gap
 * surfaces only when `validateWritten` sweeps at the end, by which point the pass
 * is over and the one retry has gone unspent. That is how a live run finished
 * with three of ~90 written things unwritten, one of them a connector between two
 * rooms in the same chunk, which no seam could explain.
 *
 * This turns an omission into exactly the zod-shaped failure the retry already
 * knows how to take. It lives here rather than in the schema because only the
 * PAYLOAD knows what was asked for, and the schema never sees the payload.
 *
 * WHAT IS DELIBERATELY NOT CHECKED, all for one reason -- the model chose, so
 * there is nothing it can have left out: fixtures, promoted details, and the
 * seam connectors carried as context, which HARD RULE 1 tells it not to return.
 */
export function contentPassOmissions(
  payload: ContentPassPayload,
  res: ContentPassResponse
): Omission[] {
  const out: Omission[] = [];
  const roomByRef = new Map((res.rooms ?? []).map((r) => [r.ref, r]));

  const absent = (want: readonly string[], got: readonly string[]): string[] => {
    const have = new Set(got);
    return want.filter((ref) => !have.has(ref));
  };

  for (const brief of payload.rooms) {
    const rr = roomByRef.get(brief.ref);
    if (!rr) {
      out.push({
        path: `rooms.${brief.ref}`,
        message: `room ${brief.ref} was listed and is missing from the response entirely`,
      });
      continue;
    }
    const at = `rooms.${brief.ref}`;

    for (const ref of absent(
      brief.entities.map((e) => e.ref),
      (rr.entities ?? []).map((e) => e.ref)
    )) {
      out.push({
        path: `${at}.entities`,
        message: `entity ${ref} was listed and is not in the response; every listed entity must be written exactly once`,
      });
    }

    for (const ref of absent(
      brief.connectors.filter((c) => !c.seam).map((c) => c.ref),
      (rr.connectors ?? []).map((c) => c.ref)
    )) {
      out.push({
        path: `${at}.connectors`,
        message: `connector ${ref} was listed and is not in the response; a way out with no form is one the game cannot describe when a player walks up to it`,
      });
    }

    if (brief.goal && !rr.goal) {
      out.push({
        path: `${at}.goal`,
        message: `this room is the GOAL room and no "goal" was written for it`,
      });
    }

    const written = new Map((rr.encounters ?? []).map((e) => [e.ref, e]));
    for (const en of brief.encounters) {
      const er = written.get(en.ref);
      if (!er) {
        out.push({
          path: `${at}.encounters`,
          message: `encounter ${en.ref} was listed and is not in the response`,
        });
        continue;
      }
      // The mass and the specimens become separate entities, so each is
      // separately omittable: a response can carry the encounter, write the rank
      // and file, and quietly drop the named leader standing in front of them.
      if (en.group && !er.group) {
        out.push({
          path: `${at}.encounters.${en.ref}.group`,
          message: `encounter ${en.ref} lists a group of ${en.group.count} and the response wrote no "group" for it`,
        });
      }
      for (const d of en.distinct) {
        // Matched on kind AND member, which is the same join `applyContentPass`
        // makes to find a specimen's keywords. A specimen returned under a
        // member id that was not asked for loses its rolls as surely as one that
        // never came back at all, so both are worth the retry.
        const found = (er.distinct ?? []).some((x) => x.kind === d.kind && x.member === d.member);
        if (found) continue;
        out.push({
          path: `${at}.encounters.${en.ref}.distinct`,
          message:
            `encounter ${en.ref} lists a distinct ${d.kind}` +
            (d.member ? ` (member ${d.member})` : "") +
            ` and the response has no entry matching it`,
        });
      }
    }
  }

  return out;
}

// ===========================================================================
// APPLY
// ===========================================================================

export interface ContentApplyResult {
  goalEntity?: IRoom | IRoomFeature | IItem | ICreature;
  createdCreatures: ICreature[];
}

/** Every entity carries the procgen rolls behind it, keyed by source table. */

/**
 * EVERY NAME IN THE RESPONSE, CAPITALISED, IN ONE PLACE.
 *
 * A dozen sites below lift `name` off the response and onto an entity — rooms,
 * written entities, fixtures, promotions, connectors, groups, distinct
 * specimens, the goal — and normalising at each of them means the thirteenth
 * one, whenever it is written, ships lower-case names again. This is the
 * chokepoint instead: past here, no name in `res` is unnormalised.
 *
 * Keyed on the field NAME, which is safe because every `name` in
 * `ContentPassResponse` is a thing the player reads. What is deliberately not
 * touched: `kind` and `form` and `position`, which are vocabulary the code
 * matches on and would break if their case moved.
 *
 * On a copy. The raw response is what the journal recorded and what a replay
 * reads back; rewriting it underneath them would make the record disagree with
 * the call it is a record of.
 */
function withProperNames(res: ContentPassResponse): ContentPassResponse {
  const copy = structuredClone(res);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (k === "name" && typeof v === "string") rec[k] = properName(v);
      else walk(v);
    }
  };
  walk(copy);
  return copy;
}

export function applyContentPass(
  raw: ContentPassResponse,
  payload: ContentPassPayload,
  ep: EntityPassResult,
  bp: DungeonBlueprintSeed,
  sd: StockedDungeon,
  rng: Rng
): ContentApplyResult {
  const res = withProperNames(raw);
  const roomById = new Map(ep.rooms.map((r) => [r.id, r]));
  const roomByRef = new Map(sd.rooms.map((r) => [`room_${r.index}`, r.roomId]));
  const mobById = new Map(sd.mobiles.map((m) => [m.id, m]));
  const groupById = new Map<string, InhabitantGroup>();
  for (const g of [...bp.inhabitants, ...sd.wandererGroups]) groupById.set(g.id, g);

  const featureById = new Map(ep.features.map((f) => [f.id, f]));
  const itemById = new Map(ep.items.map((i) => [i.id, i]));
  const hazardById = new Map(ep.hazards.map((h) => [h.id, h]));
  const connectorById = new Map(ep.connectors.map((c) => [c.id, c]));
  const detailByText = new Map(ep.detailCandidates.map((d) => [`${d.roomId}:${d.text}`, d]));

  // index the payload so apply can pull rolled keywords + counts by ref
  const briefByRoom = new Map(payload.rooms.map((r) => [r.ref, r]));
  const entityKw = new Map<string, KW>();
  const encounterBrief = new Map<string, EncounterBrief>();
  for (const r of payload.rooms) {
    for (const e of r.entities) entityKw.set(e.ref, e.keywords);
    for (const en of r.encounters) encounterBrief.set(en.ref, en);
  }

  const withheld = withheldKeyItems(sd, ep);
  const created: ICreature[] = [];
  /**
   * Which mobile each created creature came from.
   *
   * The roster this pass writes REPLACES the placeholder creatures the entities
   * pass emitted, with new ids — so the `mobileId` bindings written back there
   * point at entities that no longer exist the moment a chunk lands. Anything
   * downstream that has to get from a stocking-level mobile to the creature
   * standing in the room needs the mapping rebuilt, and this is the only place
   * that knows it. See the binding rewrite at the foot of this function.
   */
  const createdFor: Array<{ mobileId: string; creature: ICreature }> = [];
  let goalEntity: ContentApplyResult["goalEntity"];

  for (const rr of res.rooms) {
    const roomId = roomByRef.get(rr.ref);
    if (!roomId) continue;
    const brief = briefByRoom.get(rr.ref);

    const room = roomById.get(roomId);
    if (room) {
      room.name = rr.name;
      (room as { base?: string }).base = rr.base;
      room.keywords = brief?.keywords ?? {};
    }

    // --- placement -------------------------------------------------------
    //
    // One `taken` set for the whole room, shared by fixtures and stocked
    // things alike, so nothing ends up standing in anything else. Absent
    // ground means the dungeon has no drawing and `place` returns undefined
    // for everything, which every consumer already handles.
    const site = payload.ground?.[rr.ref];
    const taken = new Set<string>();
    const place = (word: string | undefined): Placement | undefined => {
      if (!site) return undefined;
      const w: PositionWord = word !== undefined && isPositionWord(word) ? word : "centre";
      return placeAt(w, site.ground, site.geometry, rng, { taken });
    };

    // entities
    for (const w of rr.entities ?? []) {
      const kw = entityKw.get(w.ref) ?? {};
      const f = featureById.get(w.ref);
      if (f) {
        f.name = w.name;
        (f as { base?: string }).base = w.base;
        f.keywords = kw;
        f.place = place(w.position);
        continue;
      }
      const it = itemById.get(w.ref);
      if (it) {
        // A placed key was withheld from the payload and must stay nameless
        // until the keys pass. Guarded here as well as there, on the rule the
        // seams pass follows: an applier that trusts the payload to have left
        // something out is one prompt edit away from silently overwriting it.
        if (withheld.has(w.ref)) continue;
        it.name = w.name;
        (it as { base?: string }).base = w.base;
        it.keywords = kw;
        // Only an item loose in the room has a position of its own. One inside
        // a chest is wherever the chest is, and giving it a second answer is
        // how the map ends up drawing the contents next to the container.
        if (it.parentId === roomId) it.place = place(w.position);
        continue;
      }
      const hz = hazardById.get(w.ref);
      if (hz) {
        hz.name = w.name;
        hz.keywords = kw;
        const seed = ep.registry.hazards[hz.blueprintId];
        if (seed) seed.base = w.base;
      }
    }

    // WITHHELD KEYS, POSITIONED BY CODE.
    //
    // A placed key is kept out of this pass so the keys pass can name it with
    // its lock in front of it — but WHERE it lies is not something the keys pass
    // can settle, because `taken` and the room's ground live here and are spent
    // by the time it runs. So the position is rolled from the same seeded stream
    // that placed everything else in this room, which keeps the key on the map
    // beside the treasure instead of quietly missing from the drawing.
    //
    // A carried key gets none, on the standing rule that an item inside
    // something is wherever that something is.
    for (const it of ep.items) {
      if (!withheld.has(it.id) || it.parentId !== roomId) continue;
      it.place = place(rng.pick(POSITION_WORDS));
    }

    // fixtures -- the model furnishing a room whose footprint code drew
    for (const fx of (rr.fixtures ?? []).slice(0, site ? fixtureCap(site.geometry) : 0)) {
      // Unrecognised kind: dropped, and the entity with it. A position that
      // does not parse falls back to the centre, because the thing being in
      // the room is the decision and where it stands is the detail.
      if (!isFixtureKind(fx.kind)) continue;
      const word = isPositionWord(fx.position) ? fx.position : "centre";
      const placed = placeFixture({ kind: fx.kind, position: word }, site!.ground, site!.geometry, rng, { taken });
      if (!placed) continue;
      const f = addFixture(roomId, ep);
      f.name = fx.name;
      (f as { base?: string }).base = fx.base;
      f.keywords = { Fixture: fx.kind };
      f.place = placed;
    }

    // promoted details
    for (const pr of rr.promotions ?? []) {
      const cand = detailByText.get(`${roomId}:${pr.text}`);
      if (!cand) continue;
      const f = promoteDetail(cand, ep);
      f.name = pr.name;
      (f as { base?: string }).base = pr.base;
      f.keywords = { "Room Detail": pr.text };
      if (pr.hidden) f.isHidden = true;
      f.place = place(pr.position);
    }

    // connectors -- physical form for all, requirement for gated
    for (const cr of rr.connectors ?? []) {
      const conn = connectorById.get(cr.ref);
      if (!conn) continue;
      // A seam was listed as context and asked for back. Dropped rather than
      // applied: it was written without the far room, and the seams pass is
      // about to write it with both.
      if (brief?.connectors.find((c) => c.ref === cr.ref)?.seam) continue;
      conn.name = cr.name;
      (conn as { base?: string }).base = cr.form;
      conn.keywords = {};
      if (cr.requirement) conn.conditional = cr.requirement || PENDING_CONDITION;
    }

    // goal
    if (rr.goal && roomId === ep.pendingGoal.roomId) {
      goalEntity = createGoalEntity(rr.goal, roomId, sd, rng, ep);
      // The keys pass mints the objective's keyable properties and needs to know
      // which of the entities in this room IS the objective. Nothing else can
      // tell afterwards — see `EntityPassResult.goalEntityId`.
      ep.goalEntityId = goalEntity.id;
      if (goalEntity.type === "Creature") created.push(goalEntity as ICreature);
      // The one thing the whole run is for belongs on the map like anything
      // else. A goal creature does not get a footprint — creatures move, and
      // nothing tracks where they are standing.
      if (goalEntity.type === "Item" || goalEntity.type === "RoomFeature") {
        goalEntity.place = place(rr.goal.position);
      }
    }

    // encounters
    for (const er of rr.encounters ?? []) {
      const m = mobById.get(er.ref);
      if (!m) continue;
      const en = encounterBrief.get(er.ref);
      const group = m.groupId ? groupById.get(m.groupId) : undefined;

      // the consolidated mass -> one creature entity carrying a count
      if (er.group && en?.group) {
        const c = group
          ? createCreatureFromGroup(group, roomId, sd.level, rng, { name: er.group.name })
          : createCreatureFromSeed((m.monster ?? m.npc)!, roomId, sd.level, m.monster?.complexity ?? "simple", ep.registry, rng, { name: er.group.name });
        c.count = en.group.count;
        c.activity = er.group.activity;
        c.keywords = en.group.keywords;
        if (er.group.stats) mergeStats(c.stats, er.group.stats);
        // A group's base is written exactly ONCE. Inhabitant groups already
        // have theirs from the Dungeon Pass, so this guard is what stops a
        // chunk overwriting the dungeon's own fiction; the live path here is
        // wanderer groups, which are minted per-mobile during stocking and so
        // only ever appear in the one chunk that holds them.
        if (group) {
          const tpl = (ep.registry.groups[group.id] ??= { id: group.id });
          tpl.base ??= er.group.base;
          tpl.name ??= er.group.name;
        } else (c as { base?: string }).base = er.group.base;
        created.push(c);
        createdFor.push({ mobileId: er.ref, creature: c });
      }

      // distinct specimens -> their own entity each
      for (const d of er.distinct ?? []) {
        const c = mintDistinct(d, m, group, roomId, sd.level, rng, ep);
        c.count = 1;
        c.activity = d.activity;
        const dkw = en?.distinct.find((x) => x.kind === d.kind && x.member === d.member)?.keywords ?? {};
        c.keywords = dkw;
        if (d.stats) mergeStats(c.stats, d.stats);
        created.push(c);
        createdFor.push({ mobileId: er.ref, creature: c });
      }
    }
  }

  // placeholder anchors in written rooms are replaced by the real roster
  const writtenRoomIds = new Set(res.rooms.map((rr) => roomByRef.get(rr.ref)).filter((x): x is string => !!x));
  ep.creatures = ep.creatures.filter((c) => !writtenRoomIds.has(c.roomId));
  ep.creatures.push(...created);

  // AND THE BINDINGS WITH THEM. A creature binding carries the `mobileId` that
  // is the only way back from a stocking-level mobile — which a challenge names,
  // and a carried reward names — to the entity a player actually meets. Dropping
  // the placeholders without rewriting these left every such binding pointing at
  // a creature that had just been thrown away, and the keys pass could not find
  // a single creature it was meant to write a key for.
  //
  // One mobile can become several entities here: a consolidated group AND the
  // distinct specimens standing beside it. All of them are bound, because all of
  // them are the thing the challenge is about.
  const rebound = new Set(createdFor.map((c) => c.mobileId));
  ep.bindings = ep.bindings.filter(
    (b) => !(b.element === "creature" && b.mobileId !== undefined && rebound.has(b.mobileId))
  );
  for (const { mobileId, creature } of createdFor) {
    ep.bindings.push({
      entityId: creature.id,
      roomId: creature.roomId,
      element: "creature",
      keywords: creature.activity ? [creature.activity] : [],
      mobileId,
    });
  }

  return { goalEntity, createdCreatures: created };
}

function mintDistinct(
  d: DistinctResponse,
  m: MobileEntity,
  group: InhabitantGroup | undefined,
  roomId: string,
  level: number,
  rng: Rng,
  ep: EntityPassResult
): ICreature {
  // Elite: its own template from the bigger specimen, so it is a distinct type
  // with its own base and correct (higher) hit dice -- not the group base.
  if (d.kind === "elite" && group && group.kind === "monsters" && group.biggerSpecimen) {
    const c = createCreatureFromSeed(group.biggerSpecimen, roomId, level, group.biggerSpecimen.complexity, ep.registry, rng, {
      name: d.name,
      isLeader: d.isLeader,
      affiliationGroupId: group.id,
    });
    ep.registry.creatures[c.narrative.blueprintId].base = d.base;
    return c;
  }
  // Named person from a people group.
  if (d.kind === "named" && group && group.kind === "people") {
    const c = createCreatureFromGroup(group, roomId, level, rng, { member: d.member, isLeader: d.isLeader, name: d.name });
    (c as { base?: string }).base = d.base; // per-person identity
    return c;
  }
  // Fallback: a loose distinct seed on the mobile.
  const c = createCreatureFromSeed((m.monster ?? m.npc)!, roomId, level, m.monster?.complexity ?? "simple", ep.registry, rng, { name: d.name, isLeader: d.isLeader });
  ep.registry.creatures[c.narrative.blueprintId].base = d.base;
  return c;
}

function mergeStats(spine: CreatureStats, dev: StatDeviations): void {
  if (dev.damage) spine.damage = dev.damage;
  if (dev.armorDefense !== undefined) spine.armorDefense = dev.armorDefense;
  if (dev.morale !== undefined) spine.morale = dev.morale;
  if (dev.modifiers) spine.modifiers = { ...spine.modifiers, ...dev.modifiers };
}

function createGoalEntity(
  goal: NonNullable<RoomResponse["goal"]>,
  roomId: string,
  sd: StockedDungeon,
  rng: Rng,
  ep: EntityPassResult
): IRoom | IRoomFeature | IItem | ICreature {
  const kw: KW = { Reward: ep.pendingGoal.reward, Mission: ep.pendingGoal.mission };
  if (goal.entityType === "Item") {
    // The thing the whole run is about, priced ABOVE every other single reward
    // in this dungeon rather than out of its pot. Not a band and not a grade: a
    // relative number, so the objective cannot be out-earned by a strongbox in
    // a side room whatever the pot happened to roll.
    const it: IItem = {
      id: makeId(),
      name: goal.name,
      type: "Item",
      base: goal.base,
      parentId: roomId,
      slots: 1,
      value: goalItemValue(sd.rooms.flatMap((r) => r.rewards), rng),
    };
    it.keywords = kw;
    ep.items.push(it);
    return it;
  }
  if (goal.entityType === "Creature") {
    const seed: MonsterSeed = {
      complexity: "major",
      silhouette: "humanoid",
      traitsAndAbilities: [],
      featuresAndMutations: [],
      tactic: "",
      weaknesses: [],
      personality: "",
    };
    const c = createCreatureFromSeed(seed, roomId, sd.level, "major", ep.registry, rng, { name: goal.name });
    ep.registry.creatures[c.narrative.blueprintId].base = goal.base;
    c.keywords = kw;
    // not pushed to ep.creatures here -- apply adds it to `created`.
    return c;
  }
  const f: IRoomFeature = { id: makeId(), name: goal.name, type: "RoomFeature", base: goal.base, roomId };
  f.keywords = kw;
  ep.features.push(f);
  return f;
}
