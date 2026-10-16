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
 *
 * THE PASS IN FOUR FILES, in the order a chunk goes through them:
 *
 *   build.ts     what the model is told about each room (this file)
 *   prompt.ts    that payload rendered into the call, with the instructions
 *   response.ts  the shape of the answer, and what it left out
 *   apply.ts     the answer turned into entities
 */

import type { DungeonBlueprintSeed, InhabitantGroup, Tier } from "../../blueprint.ts";
import type { MonsterSeed, NpcSeed } from "../../../../shared/world/seeds.ts";
import { Rng } from "../../../../shared/utils/rng.ts";
import type { EntityPassResult } from "../../../../shared/world/entities.ts";
import {
  describeGeometry,
  exitPhrase,
  type RoomGeometry,
  type RoomGround,
  type Siting,
} from "../../../floorplan/geometry.ts";
import { fixtureCap } from "../../../floorplan/fixtures.ts";
import type {
  MobileEntity,
  Reward,
  RoomStock,
  SpecialContent,
  StockedConnector,
  StockedDungeon,
} from "../../types.ts";
import { withheldKeyItems } from "../keys-pass.ts";
import { CONTENT_PASS_INSTRUCTIONS, CONTENT_PASS_SCHEMA } from "./prompt.ts";

export type KW = Record<string, string>;

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
