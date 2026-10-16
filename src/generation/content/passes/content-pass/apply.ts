/**
 * THE CONTENT PASS, APPLIED: a chunk's written answer turned into entities, with
 * counts and stats settled in code around it. Runs serially in chunk order even
 * when generation is parallel (CLAUDE.md).
 */

import type { DungeonBlueprintSeed, InhabitantGroup } from "../../blueprint.ts";
import type { MonsterSeed } from "../../../../shared/world/seeds.ts";
import { makeId } from "../../../../shared/utils/id.ts";
import { Rng } from "../../../../shared/utils/rng.ts";
import {
  addFixture,
  createCreatureFromGroup,
  createCreatureFromSeed,
  promoteDetail,
  PENDING_CONDITION,
} from "../../entities-pass.ts";
import type { EntityPassResult } from "../../../../shared/world/entities.ts";
import { fixtureCap, placeAt, placeFixture } from "../../../floorplan/fixtures.ts";
import {
  isFixtureKind,
  isPositionWord,
  POSITION_WORDS,
  type Placement,
  type PositionWord,
} from "../../../../shared/world/placement.ts";
import type { MobileEntity, StockedDungeon } from "../../types.ts";
import { goalItemValue } from "../../rewards.ts";
import { withheldKeyItems } from "../keys-pass.ts";
import { properName } from "../../../../shared/world/entities.ts";
import type {
  CreatureStats,
  ICreature,
  IItem,
  IRoom,
  IRoomFeature,
} from "../../../../shared/world/entities.ts";
import type { ContentPassPayload, EncounterBrief, KW } from "./build.ts";
import type {
  ContentPassResponse,
  DistinctResponse,
  RoomResponse,
  StatDeviations,
} from "./response.ts";

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
