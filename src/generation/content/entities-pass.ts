/**
 * ENTITIES PASS
 * =============
 *
 * Third pass. Takes the stocked dungeon (what is in each room) and emits one
 * entity per separable thing, so each can be updated independently in play.
 *
 * This pass is DETERMINISTIC and writes no prose. Every entity comes out with
 * its references resolved and its `base`/`state`/`composed` empty -- those are
 * the LLM's job in the next pass. What this guarantees is that the set of
 * entities, their types, and their wiring are settled before any text exists.
 *
 * Emission rules (what becomes its own entity, and what does not):
 *
 *   RoomStock            -> IRoom
 *   StockedConnector     -> IRoomConnector
 *   MobileEntity         -> ICreature
 *   special: hazard/trap -> IHazard + a HazardSeed template
 *   special: obstacle    -> IRoomFeature
 *   entranceFeature      -> IRoomFeature
 *   clue                 -> IRoomFeature            (see OPEN #4)
 *   reward parcel        -> IItem or IRoomFeature   (see OPEN #4)
 *   detail               -> ALWAYS part of the room's description, and only
 *                           SOMETIMES its own entity. We cannot tell from a
 *                           keyword whether "Chains" is scenery or something a
 *                           player will pull on, so the detail ships as a
 *                           promotion candidate and the writing pass decides.
 *                           Promote via promoteDetail().
 *   goalDirective        -> NOT emitted; its type is the LLM's call (OPEN #3)
 *
 * IMobileEffect is never emitted here. Nothing in stocking produces one; they
 * arise in play (a fire started, a gas released). Some rolled hazards read as
 * mobile -- "Toxic fumes", "Flooding" -- but a hazard is the *source* and the
 * effect is what it produces once active, so converting at generation time
 * would collapse two different things.
 */

import type {
  MobileEntity,
  RoomStock,
  StockedDungeon,
} from "./stock.ts";
import type { EquipmentDraw, Reward } from "./rewards.ts";
import type {
  Complexity,
  DungeonBlueprintSeed,
  InhabitantGroup,
  MonsterSeed,
  NpcSeed,
  Tier,
} from "./blueprint.ts";
import { Rng, TIER_COMPLEXITY, makeId } from "./blueprint.ts";
import { mintItem, mintSpellbook } from "../../rules/knave/equipment.ts";
import type {
  CreatureStats,
  CreatureTemplate,
  HazardSeed,
  ICreature,
  IHazard,
  IItem,
  IMobileEffect,
  IRoom,
  IRoomConnector,
  IRoomFeature,
  TemplateRegistry,
} from "../../shared/world/entities.ts";
import { maxHp } from "../../shared/world/entities.ts";

// ---------------------------------------------------------------------------
// OUTPUT
// ---------------------------------------------------------------------------

/** Ties an emitted entity back to the stocked element it came from, so the
 *  Rooms Pass `elements` manifestations can be matched to entities by ref. */
export interface ElementBinding {
  entityId: string;
  roomId: string;
  /** matches the element ref the Rooms Pass payload used */
  element:
    | "entrance"
    | "hazard"
    | "obstacle"
    | "clue"
    | "reward"
    | "creature"
    | "connector"
    | "detail";
  /** the rolled keyword(s) behind it, for the writing pass */
  keywords: string[];
  /**
   * Reward bindings only: which `Reward` this entity came out of.
   *
   * One reward can emit several entities -- a general-gear row hands over two
   * to four things -- and several rewards can sit in one room, so the room is
   * no longer enough to find the reward an item belongs to. The keys pass reads
   * this to find the challenge a placed key answers.
   */
  rewardId?: string;
  /**
   * Creature bindings only: the `MobileEntity.id` this entity was emitted from.
   *
   * Stocking names creatures by mobile id -- a challenge does, and so does a
   * reward carried by one -- while entities get their own minted ids, and
   * nothing else carries the mapping between them.
   */
  mobileId?: string;
}

export interface DetailCandidate {
  roomId: string;
  /** the rolled detail, e.g. "Chains" */
  text: string;
}

export interface EntityPassResult {
  registry: TemplateRegistry;
  rooms: IRoom[];
  connectors: IRoomConnector[];
  creatures: ICreature[];
  features: IRoomFeature[];
  items: IItem[];
  hazards: IHazard[];
  effects: IMobileEffect[];
  bindings: ElementBinding[];
  /**
   * Room details always appear in the room's description. Some are also things
   * a player will poke at -- chains, a nest, a bas-relief -- and those want to
   * be their own entity so they can change independently. That is a reading of
   * the fiction, not something a keyword settles, so the writing pass decides
   * and calls promoteDetail() for the ones it wants.
   */
  detailCandidates: DetailCandidate[];
  /** the goal room; the writing pass must create one entity of its choosing here */
  pendingGoal: { roomId: string; reward: string; mission: string; instruction: string };
  /**
   * The entity the writing pass made of the objective, once it has run.
   *
   * ABSENT UNTIL THEN, and that is the whole reason it is here rather than
   * derived: `GoalDirective` deliberately does not pick an entity type, so
   * nothing before `applyContentPass` knows whether the objective is an item, a
   * creature, or a feature of the room -- and afterwards there is no way to tell
   * it from the other entities in that room. The keys pass needs it to mint the
   * objective's keyable properties, and the tally needs it to know what
   * "completed" was about.
   */
  goalEntityId?: string;
}

// ---------------------------------------------------------------------------
// STATS
// ---------------------------------------------------------------------------

/**
 * Knave gives a monster's Hit Dice, and HD then fills the six ability bonuses,
 * the attack bonus, and max HP. Nothing upstream produces HD, so it is derived
 * here: the DUNGEON LEVEL is the base and COMPLEXITY modifies it.
 *
 *   major    level +1 to +2   the set piece
 *   complex  level +0 to +1   a peer threat
 *   simple   level -1 to  0   chaff, dangerous in numbers
 *
 * Complexity, NOT tier. Tier says how many creatures the entity represents --
 * one thing, a band, a swarm -- which is orthogonal to how hard each of them
 * hits. Keying HD to tier made a Solo's thralls as tough as the Solo, and gave
 * every lone wanderer boss-tier dice just for being alone. Group members get
 * their complexity from their tier (a Band IS complex); minions and
 * unaffiliated creatures carry their own.
 *
 * A group's leader sits one die above its rank and file, which is what
 * `isLeader` is for -- see the note on leaders in emitCreature().
 *
 * Clamped to 1..10 because Knave ability bonuses top out at +10 and a monster's
 * bonuses default to its HD; past that the derived defenses stop making sense.
 */
const COMPLEXITY_HD_OFFSET: Record<Complexity, readonly [number, number]> = {
  major: [1, 2],
  complex: [0, 1],
  simple: [-1, 0],
};

export function hitDiceFor(
  complexity: Complexity,
  level: number,
  rng: Rng,
  isLeader = false
): number {
  const [lo, hi] = COMPLEXITY_HD_OFFSET[complexity];
  const hd = level + rng.range(lo, hi) + (isLeader ? 1 : 0);
  // FLOORED AT 0, NOT 1. HD 0 is the fodder band -- +0 to everything, defense
  // 10, half a hit die -- and it is what a level 0 dungeon is mostly made of.
  return Math.max(0, Math.min(10, hd));
}

function statsFor(
  complexity: Complexity,
  level: number,
  rng: Rng,
  isLeader = false
): CreatureStats {
  const hd = hitDiceFor(complexity, level, rng, isLeader);
  // Through `maxHp` rather than `hd * 4`, so the half-hit-die band at HD 0 is
  // stated once. The two spellings agreed until 0 became reachable.
  const stats: CreatureStats = { hitDice: hd, hp: 0, modifiers: {} };
  return { ...stats, hp: maxHp(stats) };
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

const kw = (...r: Array<string | undefined>): string[] =>
  r.filter((x): x is string => !!x);

/**
 * WHAT A REWARD BECOMES.
 *
 * Every reward is an ITEM now, and the old split -- loot as an item, knowledge
 * and leverage and boons as features of the room -- went with the parcel types
 * that produced them. A key is an object placed to answer a challenge; treasure
 * is a thing you carry off; equipment is one or more catalog entries. None of
 * the three is furniture.
 *
 * An equipment reward can be several items: two to four pieces of general gear
 * is ONE reward and four entities, because a player picks them up one at a time.
 */
function rewardItems(
  rw: Reward,
  parentId: string,
  rng: Rng
): Array<{ item: IItem; keywords: string[] }> {
  switch (rw.kind) {
    case "equipment":
      return rw.draws.map((d) => ({ item: equipmentItem(d, parentId, rng), keywords: [] }));

    case "treasure":
      return [
        {
          // The value arrived with the reward: it is the share this parcel drew
          // from the conserved pot, settled before the content pass ever ran.
          item: { id: makeId(), name: "", type: "Item", parentId, slots: 1, value: rw.value },
          keywords: kw(rw.content),
        },
      ];

    case "key":
      return [
        {
          item: { id: makeId(), name: "", type: "Item", parentId, slots: 1, value: rw.value },
          keywords: kw(rw.answers),
        },
      ];
  }
}

/**
 * One catalog draw, as a carried thing. Name, slots, facts and price all come
 * from the table, and there is no longer any other kind.
 *
 * THERE WAS A THIRD BRANCH: a rolled draw carrying its own name and nothing
 * else, which was only ever a potion. `rewardKeywords` hands the writing pass
 * `Equipment: <item name>`, so that branch was the one place an equipment reward
 * had a name the catalog had never heard of and a price it invented. Potions are
 * treasure now and take a share of the pot, so every equipment item on this path
 * is a mint of a real entry.
 */
function equipmentItem(d: EquipmentDraw, parentId: string, rng: Rng): IItem {
  if (d.kind === "spellbook") {
    return mintSpellbook({ name: d.spell, effect: d.effect }, parentId);
  }
  return mintItem(d.key, parentId, rng, {
    ...(d.amount !== undefined ? { amount: d.amount } : {}),
    value: d.value,
  });
}

// ---------------------------------------------------------------------------
// CREATURES
// ---------------------------------------------------------------------------

/**
 * Every creature's prose identity has to resolve to a dungeon-level template.
 * Three cases fall out of how stocking builds mobiles:
 *
 *  1. Group base / outpost -- shares the group's rolled seed, so it points
 *     straight at the group id and stores nothing of its own.
 *  2. Minions (young / thrall / ecology / hirelings) -- attached to an
 *     inhabitant group but rolled their OWN seed, so they need their own
 *     template. Affiliation is kept separately on `affiliationGroupId`.
 *  3. Wanderers -- their own group, created during stocking rather than during
 *     dungeon generation. Structurally identical to case 1: point at the group.
 *
 * NOTE ON LEADERS: nothing at this stage is marked as a leader. A people group
 * is placed as a collective encounter and the writing pass decides which named
 * NPCs are present, so the leader does not exist as its own mobile yet. When it
 * creates one, statsFor(..., isLeader = true) is the die it should get.
 */
/**
 * Create one creature from a group. This is the single path by which creatures
 * come into being, used both by this pass and by the writing pass at runtime.
 *
 * A creature room's stocking produces ONE mobile, which stands for the whole
 * encounter rather than for one body. How many creatures actually populate that
 * room is a reading of the fiction -- three militia at a checkpoint, a dozen
 * rats, one ogre -- so the writing pass calls this as many times as the scene
 * wants, and picks a `member` for each so they resolve to different people.
 *
 *   member  absent   the group's base monster, or an unnamed member of a
 *                    people group -- the anonymous rank and file
 *           "elite"  a monster group's biggerSpecimen
 *           <npc id> a specific NpcSeed from a people group
 *
 * `isLeader` adds a die, for the named head of a group.
 * `minion` forces the simple band regardless of what the group is.
 */
export function createCreatureFromGroup(
  group: InhabitantGroup,
  roomId: string,
  level: number,
  rng: Rng,
  opts: {
    member?: string;
    isLeader?: boolean;
    minion?: boolean;
    name?: string;
  } = {}
): ICreature {
  const complexity: Complexity = opts.minion
    ? "simple"
    : TIER_COMPLEXITY[group.tier];
  const c: ICreature = {
    id: makeId(),
    name: opts.name ?? "",
    type: "Creature",
    roomId,
    stats: statsFor(complexity, level, rng, opts.isLeader),
    narrative: { blueprintId: group.id, ...(opts.member ? { member: opts.member } : {}) },
  };
  return c;
}

/**
 * Create a creature that belongs to no group -- a minion with its own rolled
 * seed, or anything the writing pass invents that needs its own identity. The
 * seed is registered as a dungeon-level template so repeat instances stay
 * consistent, per the rule that prose identity never lives on the creature.
 */
export function createCreatureFromSeed(
  seed: MonsterSeed | NpcSeed,
  roomId: string,
  level: number,
  complexity: Complexity,
  registry: TemplateRegistry,
  rng: Rng,
  opts: { affiliationGroupId?: string; isLeader?: boolean; name?: string } = {}
): ICreature {
  const tpl: CreatureTemplate = { id: makeId(), seed };
  registry.creatures[tpl.id] = tpl;
  const c: ICreature = {
    id: makeId(),
    name: opts.name ?? "",
    type: "Creature",
    roomId,
    stats: statsFor(complexity, level, rng, opts.isLeader),
    narrative: { blueprintId: tpl.id },
  };
  if (opts.affiliationGroupId) c.affiliationGroupId = opts.affiliationGroupId;
  return c;
}

function emitCreature(
  m: MobileEntity,
  groups: Map<string, InhabitantGroup>,
  level: number,
  registry: TemplateRegistry,
  rng: Rng
): ICreature {
  const group = m.groupId ? groups.get(m.groupId) : undefined;
  const tier: Tier = m.tier ?? group?.tier ?? "Band";
  // Minions are always simple, whatever their parent is -- that is the whole
  // point of the category, and it is what keeps a Solo's thralls (or a people
  // group's hirelings, which carry no seed at all) from coming out as tough as
  // the thing they serve. Everything else uses its own rolled complexity, or
  // failing that what its tier implies.
  const complexity: Complexity = m.minion
    ? "simple"
    : m.monster?.complexity ?? TIER_COMPLEXITY[tier];

  // Minions roll their own seed and so need a template; everything else --
  // inhabitants and wanderers alike -- points at the group it came from.
  //
  // Exactly one creature is emitted per mobile: the anchor for the encounter,
  // not a claim about how many bodies are in the room. The writing pass calls
  // createCreatureFromGroup() for however many the scene actually wants.
  if (group && m.minion === undefined) {
    const c = createCreatureFromGroup(group, m.locationRoomId, level, rng, {
      name: m.name,
    });
    // stats were derived from the group's tier; a mobile carrying its own
    // rolled monster overrides that with its own complexity.
    if (m.monster && m.monster.complexity !== TIER_COMPLEXITY[group.tier]) {
      c.stats = statsFor(m.monster.complexity, level, rng);
    }
    return c;
  }

  return createCreatureFromSeed(
    (m.monster ?? m.npc)!,
    m.locationRoomId,
    level,
    complexity,
    registry,
    rng,
    { affiliationGroupId: group?.id, name: m.name }
  );
}

// ---------------------------------------------------------------------------
// PASS
// ---------------------------------------------------------------------------

export function runEntitiesPass(
  sd: StockedDungeon,
  bp: DungeonBlueprintSeed,
  rng: Rng = new Rng(sd.seed)
): EntityPassResult {
  const registry: TemplateRegistry = { creatures: {}, hazards: {}, groups: {} };
  const rooms: IRoom[] = [];
  const connectors: IRoomConnector[] = [];
  const creatures: ICreature[] = [];
  const features: IRoomFeature[] = [];
  const items: IItem[] = [];
  const hazards: IHazard[] = [];
  const effects: IMobileEffect[] = [];
  const bindings: ElementBinding[] = [];
  const detailCandidates: DetailCandidate[] = [];

  const bind = (
    entityId: string,
    roomId: string,
    element: ElementBinding["element"],
    keywords: string[]
  ) => bindings.push({ entityId, roomId, element, keywords });

  // --- rooms and everything parented to them ---
  for (const r of sd.rooms) {
    const room: IRoom = { id: r.roomId, name: "", type: "Room" };

    // The entrance is NOT dressing and is not emitted here. It is the way out
    // of the dungeon, and it becomes a connector below.

    // A detail is always described; whether it is ALSO an entity is the
    // writing pass's call.
    if (r.detail) {
      detailCandidates.push({ roomId: r.roomId, text: r.detail });
    }

    // special: hazard/trap becomes a Hazard entity + template; obstacle a feature
    if (r.special) {
      if (r.special.kind === "hazard") {
        const seed: HazardSeed = {
          id: makeId(),
          effect: (r.special.hazard ?? r.special.trapEffect)!,
          // Environmental hazards have no trigger -- they are simply present.
          trigger: r.special.trapTrigger ?? "",
        };
        registry.hazards[seed.id] = seed;

        const h: IHazard = {
          id: makeId(),
          name: "",
          type: "Hazard",
          blueprintId: seed.id,
          sprung: false,
          // An environmental hazard is on from the start; a trap waits.
          active: r.special.trapTrigger === undefined,
        };
        hazards.push(h);
        room.hazardId = h.id;
        bind(h.id, r.roomId, "hazard", kw(r.special.hazard, r.special.trapTrigger, r.special.trapEffect));
      } else {
        const f: IRoomFeature = {
          id: makeId(),
          name: "",
          type: "RoomFeature",
          roomId: r.roomId,
        };
        f.isObstacle = true;
        features.push(f);
        bind(f.id, r.roomId, "obstacle", kw(r.special.subject, r.special.behaviour));
      }
    }

    // clue -- something noticed in the room
    if (r.clue) {
      const f: IRoomFeature = {
        id: makeId(),
        name: "",
        type: "RoomFeature",
        roomId: r.roomId,
      };
      features.push(f);
      bind(f.id, r.roomId, "clue", kw(r.clue.keyword));
    }

    rooms.push(room);
  }

  // --- creatures ---
  // Inhabitants and wanderer groups resolve the same way; the only difference
  // is which pass created them.
  const groups = new Map<string, InhabitantGroup>();
  for (const g of [...bp.inhabitants, ...sd.wandererGroups]) groups.set(g.id, g);

  // Which entity each mobile became. Stocking works in mobile ids -- challenges
  // name one, and so does a reward carried by a creature -- and this is the one
  // place the two numbering systems meet.
  const creatureOf = new Map<string, string>();
  for (const m of sd.mobiles) {
    const c = emitCreature(m, groups, sd.level, registry, rng);
    creatures.push(c);
    creatureOf.set(m.id, c.id);
    bindings.push({ entityId: c.id, roomId: m.locationRoomId, element: "creature", keywords: kw(m.activity), mobileId: m.id });
  }

  // --- rewards ---
  // AFTER the creatures, because a reward can be carried by one and an item
  // needs its holder's entity id to be parented to it. Everything else about a
  // reward was settled during stocking.
  //
  // The binding still names the ROOM, whoever is holding it: that is what the
  // content pass groups by, and a thing in a monster's grip is still a thing
  // found in that room.
  for (const r of sd.rooms) {
    for (const rw of r.rewards) {
      const parentId =
        rw.holder.kind === "mobile" ? creatureOf.get(rw.holder.id) ?? r.roomId : r.roomId;
      for (const { item, keywords } of rewardItems(rw, parentId, rng)) {
        items.push(item);
        bindings.push({ entityId: item.id, roomId: r.roomId, element: "reward", keywords, rewardId: rw.id });
      }
    }
  }

  // --- connectors ---
  for (const c of sd.connectors) {
    const conn: IRoomConnector = {
      id: c.id,
      name: "",
      type: "RoomConnector",
      endpointA: c.a,
      endpointB: c.b,
    };
    // `conditional` absent means freely usable. A gated connector whose
    // requirement text has not been written yet still must not read as open --
    // see OPEN #5.
    if (c.gated) conn.conditional = c.requirement ?? PENDING_CONDITION;
    // Concealment is settled by the seeded roll in gateConnectors, not by the
    // writing pass -- a way through is topology, and the map hangs off it.
    if (c.hidden) conn.isHidden = true;
    connectors.push(conn);
    bind(conn.id, c.a, "connector", []);
  }

  // --- the way out of the dungeon ---
  //
  // The entrance was rolled as a feature of its room -- a collapsed stair, a
  // crack in the cliff -- because until connectors could end at nothing there
  // was no way to say what it actually is: a way THROUGH, and the only one that
  // leads out. It is emitted as a connector with a null far end and the rolled
  // keyword carried across, so the writing pass describes it once, as an exit,
  // rather than twice as a feature and a hole.
  const entranceRoom = sd.rooms.find((r) => r.roomId === sd.entranceRoomId);
  if (entranceRoom) {
    const way: IRoomConnector = {
      id: makeId(),
      name: "",
      type: "RoomConnector",
      endpointA: entranceRoom.roomId,
      endpointB: null,
    };
    connectors.push(way);
    bind(way.id, entranceRoom.roomId, "connector", kw(entranceRoom.entranceFeature));
  }

  const goalRoom = sd.rooms.find((r) => r.goalDirective) as RoomStock;
  return {
    registry,
    rooms,
    connectors,
    creatures,
    features,
    items,
    hazards,
    effects,
    bindings,
    detailCandidates,
    pendingGoal: {
      roomId: goalRoom.roomId,
      reward: goalRoom.goalDirective!.reward,
      mission: goalRoom.goalDirective!.mission,
      instruction: goalRoom.goalDirective!.instruction,
    },
  };
}

/**
 * Turn a detail the writing pass judged interactive into a real entity. The
 * detail stays in the room's description either way -- promoting it does not
 * remove it from the prose, it gives the player something to act on.
 */
export function promoteDetail(
  c: DetailCandidate,
  res: EntityPassResult
): IRoomFeature {
  const f: IRoomFeature = {
    id: makeId(),
    name: "",
    type: "RoomFeature",
    roomId: c.roomId,
  };
  res.features.push(f);
  res.bindings.push({
    entityId: f.id,
    roomId: c.roomId,
    element: "detail",
    keywords: [c.text],
  });
  return f;
}

/**
 * A fixture from the content pass, as a real feature of the room.
 *
 * The mirror of `promoteDetail`, and deliberately the same shape: a thing the
 * writing pass decided to add, minted here so the entity layer stays the one
 * place entities come from. The caller fills in name, base and `place`.
 *
 * There is no binding for it. `ElementBinding` ties an entity back to the
 * STOCKED element it came from, and a fixture came from no roll — it is the
 * model furnishing a room whose footprint code had already drawn. Nothing later
 * looks a fixture up by element, so a binding would be a row that only ever gets
 * filtered out.
 */
export function addFixture(roomId: string, res: EntityPassResult): IRoomFeature {
  const f: IRoomFeature = { id: makeId(), name: "", type: "RoomFeature", roomId };
  res.features.push(f);
  return f;
}

/** Placeholder for a gated connector whose condition text is not yet written. */
export const PENDING_CONDITION = "[gated -- condition not yet written]";

/** Debug dump. */
export function entitySheet(res: EntityPassResult): string {
  const L: string[] = [];
  const n = (a: unknown[]) => a.length;
  L.push("=== ENTITIES PASS ===");
  L.push(
    `rooms ${n(res.rooms)}  connectors ${n(res.connectors)}  creatures ${n(res.creatures)}  ` +
      `features ${n(res.features)}  items ${n(res.items)}  hazards ${n(res.hazards)}  effects ${n(res.effects)}`
  );
  L.push(
    `templates: ${Object.keys(res.registry.creatures).length} creature, ` +
      `${Object.keys(res.registry.hazards).length} hazard`
  );
  L.push("");
  const byRoom = new Map<string, ElementBinding[]>();
  for (const b of res.bindings) {
    if (!byRoom.has(b.roomId)) byRoom.set(b.roomId, []);
    byRoom.get(b.roomId)!.push(b);
  }
  for (const r of res.rooms) {
    L.push(`[room ${r.id.slice(0, 8)}]`);
    for (const b of byRoom.get(r.id) ?? []) {
      L.push(`    ${b.element.padEnd(10)} ${b.keywords.join(", ") || "--"}`);
    }
  }
  L.push("");
  L.push(`DETAIL CANDIDATES (writing pass promotes as it sees fit):`);
  for (const c of res.detailCandidates) {
    L.push(`  room ${c.roomId.slice(0, 8)}  ${c.text}`);
  }
  L.push("");
  L.push(`PENDING GOAL in room ${res.pendingGoal.roomId.slice(0, 8)}:`);
  L.push(`  reward "${res.pendingGoal.reward}" / mission "${res.pendingGoal.mission}"`);
  return L.join("\n");
}
