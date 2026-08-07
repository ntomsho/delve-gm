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

import {
  Rng,
  makeId,
  type DungeonBlueprintSeed,
  type InhabitantGroup,
  type MonsterSeed,
  type NpcSeed,
  type Tier,
} from "./dungeon-blueprint.ts";
import {
  createCreatureFromGroup,
  createCreatureFromSeed,
  promoteDetail,
  PENDING_CONDITION,
  type EntityPassResult,
} from "./dungeon-entities-pass.ts";
import type {
  MobileEntity,
  RewardParcel,
  RoomStock,
  SpecialContent,
  StockedConnector,
  StockedDungeon,
} from "./dungeon-rooms-loop.ts";
import type {
  CreatureStats,
  ICreature,
  IItem,
  IRoom,
  IRoomFeature,
} from "./dungeon-entities.ts";

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
}

export interface PromotedDetail {
  text: string;
  name: string;
  base: string;
  hidden?: boolean;
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
  promotions?: PromotedDetail[];
  connectors?: ConnectorResponse[];
  encounters?: EncounterResponse[];
  goal?: { entityType: "Item" | "RoomFeature" | "Creature"; name: string; base: string };
}

export interface ContentPassResponse {
  rooms: RoomResponse[];
}

// ===========================================================================
// KEYWORD SOURCING  (the rolled procgen behind each base, keyed by table)
// ===========================================================================

function monsterKeywords(m: MonsterSeed): KW {
  const r: KW = { Complexity: m.complexity, Silhouette: m.silhouette };
  if (m.animals?.length) r["Animals"] = m.animals.join(" / ");
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

const PARCEL_TABLE: Record<string, string> = {
  material: "Valuable Material",
  knowledge: "Knowledge",
  leverage: "Leverage",
  boon: "Boon",
  relic: "Relic",
};

function itemKeywords(p: RewardParcel): KW {
  return { [PARCEL_TABLE[p.type] ?? "Reward"]: p.content };
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
  dungeonContext: string
): ContentPassPayload {
  const rng = new Rng((sd.seed ?? 0) + 131 * (chunk + 1));
  const roomById = new Map(sd.rooms.map((r) => [r.roomId, r]));
  const mobById = new Map(sd.mobiles.map((m) => [m.id, m]));
  const ref = (r: RoomStock) => `room_${r.index}`;

  const itemIds = new Set(ep.items.map((i) => i.id));
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

  // One owner per connector: the in-chunk endpoint, or the lower graph index
  // when both are in the chunk. Applies to ALL connectors now, not just gated.
  const ownsConnector = (c: StockedConnector, r: RoomStock): boolean => {
    const mine = c.a === r.roomId || c.b === r.roomId;
    if (!mine) return false;
    const aIn = inChunkIds.has(c.a);
    const bIn = inChunkIds.has(c.b);
    if (aIn && bIn) {
      const owner = roomById.get(c.a)!.index <= roomById.get(c.b)!.index ? c.a : c.b;
      return r.roomId === owner;
    }
    return true;
  };

  const rooms: ContentRoomBrief[] = inChunk.map((r) => {
    const links = linksOf(r.roomId);

    // --- room-local entities ---
    const entities: EntityBrief[] = [];
    for (const b of ep.bindings) {
      if (b.roomId !== r.roomId) continue;
      if (b.element === "creature" || b.element === "connector" || b.element === "detail") continue;
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
        case "reward":
          if (r.reward) keywords = itemKeywords(r.reward);
          break;
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
      }));

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

  return { chunk, dungeonContext, rooms, borders, instructions: CONTENT_PASS_INSTRUCTIONS, responseSchema: CONTENT_PASS_SCHEMA };
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

    for (const e of r.entities) {
      L.push(`entity [${e.ref}] ${e.kind} (${e.entity})${e.hidden ? " HIDDEN" : ""}: ${kwLine(e.keywords)}` + (e.note ? ` -- ${e.note}` : ""));
    }
    for (const d of r.detailCandidates) {
      L.push(`promotable detail [${kwLine(d.keywords)}] -- make it an entity only if a player would act on it`);
    }
    for (const c of r.connectors) {
      if (c.surface) {
        L.push(
          `connector [${c.ref}] OUT OF THE DUNGEON -- the way the party came in and the ` +
            `only way back to daylight; realise it from [${kwLine(c.surface)}] and say what ` +
            `it physically is. Name it as a thing, not as an exit.`
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
      L.push(`connector [${c.ref}] to ${c.toRef} (${c.toIdentity})${flags} -- ${asks}`);
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
 * A referee asked to route "go back to the Laboratory" then has two exits both
 * claiming to lead to the Kennel and picks by coin toss. So the name carries the
 * nature of the crossing and nothing else, and `renderRoom` appends the room on
 * the far side, correct from whichever end is being read.
 */
const CONNECTOR_NAMING = `Its NAME is what the thing physically is and
  NOTHING else -- "Iron door", "Low archway", "Spiral stair", "Flooded crawl",
  "Rope bridge". Name NEITHER room it joins: no "to the", no "from the", no room
  name, no direction. One connector is walked both ways and read from both ends,
  so a name that points is wrong from one of them. Where it leads is appended
  when it is read, and is not yours to write.`;

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
- Promotable details: a detail is always part of the room's description. Make it
  its own entity ONLY if a player would act on it. Most stay as description.

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

THE GOAL
One room is marked GOAL. ${GOAL_INSTRUCTION}

HARD RULES
1. Every listed entity, connector, and encounter must appear exactly once. Do not
   add a creature, hazard, or connector that was not listed.
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
      "entities": [ { "ref": "<entity ref>", "name": "<name>", "base": "<identity>" } ],
      "promotions": [ { "text": "<detail text as given>", "name": "<name>", "base": "<identity>", "hidden": false } ],
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
      "goal": { "entityType": "Item|RoomFeature|Creature", "name": "<name>", "base": "<identity>" }
    }
  ]
}

Include each key only when the room has it; "group" only when a mass is listed;
"distinct" only for specimens marked distinct; omit "goal" except in the GOAL
room. Leave "stats" out for an average creature.`;

// ===========================================================================
// APPLY
// ===========================================================================

export interface ContentApplyResult {
  goalEntity?: IRoom | IRoomFeature | IItem | ICreature;
  createdCreatures: ICreature[];
}

/** Every entity carries the procgen rolls behind it, keyed by source table. */

export function applyContentPass(
  res: ContentPassResponse,
  payload: ContentPassPayload,
  ep: EntityPassResult,
  bp: DungeonBlueprintSeed,
  sd: StockedDungeon,
  rng: Rng
): ContentApplyResult {
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

  const created: ICreature[] = [];
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

    // entities
    for (const w of rr.entities ?? []) {
      const kw = entityKw.get(w.ref) ?? {};
      const f = featureById.get(w.ref);
      if (f) { f.name = w.name; (f as { base?: string }).base = w.base; f.keywords = kw; continue; }
      const it = itemById.get(w.ref);
      if (it) { it.name = w.name; (it as { base?: string }).base = w.base; it.keywords = kw; continue; }
      const hz = hazardById.get(w.ref);
      if (hz) {
        hz.name = w.name;
        hz.keywords = kw;
        const seed = ep.registry.hazards[hz.blueprintId];
        if (seed) seed.base = w.base;
      }
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
    }

    // connectors -- physical form for all, requirement for gated
    for (const cr of rr.connectors ?? []) {
      const conn = connectorById.get(cr.ref);
      if (!conn) continue;
      conn.name = cr.name;
      (conn as { base?: string }).base = cr.form;
      conn.keywords = {};
      if (cr.requirement) conn.conditional = cr.requirement || PENDING_CONDITION;
    }

    // goal
    if (rr.goal && roomId === ep.pendingGoal.roomId) {
      goalEntity = createGoalEntity(rr.goal, roomId, sd, rng, ep);
      if (goalEntity.type === "Creature") created.push(goalEntity as ICreature);
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
      }
    }
  }

  // placeholder anchors in written rooms are replaced by the real roster
  const writtenRoomIds = new Set(res.rooms.map((rr) => roomByRef.get(rr.ref)).filter((x): x is string => !!x));
  ep.creatures = ep.creatures.filter((c) => !writtenRoomIds.has(c.roomId));
  ep.creatures.push(...created);

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
    const it: IItem = { id: makeId(), name: goal.name, type: "Item", base: goal.base, parentId: roomId, slots: 1 };
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
