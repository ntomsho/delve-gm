/**
 * KEYS PASS  (once, after the seams pass)
 * =======================================
 *
 * The objects that answer the dungeon's questions.
 *
 * WHY IT IS NOT PART OF THE CONTENT PASS. A placed key and the challenge it
 * answers are usually in different chunks, and the content pass is per-chunk and
 * parallel: every chunk payload is built before any of them is applied, so at
 * the moment the chunk holding the key is written, the door it opens has no
 * name, no form, and no lock. A key written there can only be vague -- "a heavy
 * iron key" -- because the thing it fits does not exist yet.
 *
 * This is the same problem the seams pass was built for and it takes the same
 * answer: the chunks skip these (see `withheldKeyItems`) and they arrive here
 * instead, after the serial applies AND after the seams, with both the key and
 * its challenge's finished `base` in front of the model.
 *
 * It does two jobs.
 *
 *   1. WRITES THE PLACED KEYS. Where the challenge is a blocked way it may also
 *      rewrite that connector's `conditional`, so that lock and key name each
 *      other instead of merely coexisting.
 *
 *   2. MINTS THE GOAL ENTITY'S KEYABLE PROPERTIES. The goal's FORM is the
 *      content pass's call -- `GoalDirective` deliberately does not pick an
 *      entity type -- so its keyable properties do not exist until then. This is
 *      the first point at which they do. They are minted as `goal-property`
 *      challenges and go straight to the reserve, to be drawn in play.
 *
 * NO NUMBERS COME BACK FROM THIS PASS. A key's value was settled during
 * placement, out of the pot; the model writes what the thing IS and nothing
 * about what it is worth.
 */

import type { Rolled } from "./dungeon-blueprint.ts";
import { CHALLENGE_LABEL, type Challenge, type ChallengeKind } from "./dungeon-challenges.ts";
import type { Omission } from "./dungeon-content-pass.ts";
import {
  isSurfaceExit,
  properName,
  resolveBase,
  resolveName,
  type IEntity,
  type IRoomConnector,
} from "./dungeon-entities.ts";
import type { EntityPassResult } from "./dungeon-entities-pass.ts";
import type { ReserveEntry } from "./dungeon-rewards.ts";
import type { StockedDungeon } from "./dungeon-rooms-loop.ts";

// ===========================================================================
// WHAT THE CONTENT PASS SKIPS
// ===========================================================================

/**
 * The entity ids of every placed key, which the content pass must leave
 * nameless.
 *
 * Read by `buildContentPassPayload` to keep them out of the entity list, and by
 * `applyContentPass` to refuse a write to one that came back anyway. Both ends,
 * for the same reason the seams pass guards both ends: a payload that omits it
 * and an applier that trusts the payload is one prompt edit away from silently
 * letting the earlier, blinder pass win.
 *
 * Computed from the bindings rather than from the items, because `rewardId` is
 * the only thing that says which item a reward produced.
 */
export function withheldKeyItems(sd: StockedDungeon, ep: EntityPassResult): Set<string> {
  const keyRewards = new Set<string>();
  for (const r of sd.rooms) for (const rw of r.rewards) if (rw.kind === "key") keyRewards.add(rw.id);
  const out = new Set<string>();
  for (const b of ep.bindings) {
    if (b.rewardId !== undefined && keyRewards.has(b.rewardId)) out.add(b.entityId);
  }
  return out;
}

// ===========================================================================
// PAYLOAD
// ===========================================================================

/** The thing a key answers, as the pass that wrote it left it. */
export interface KeyTargetBrief {
  /** what it is called, if the player would ever hear it called anything */
  name: string;
  /** its standing description */
  base: string;
  /** the rolled fact the key has to answer, verbatim */
  fact: Rolled;
  /** which kind of question this is, in words */
  label: string;
  kind: ChallengeKind;
  /** blocked ways only: the lock as it currently reads */
  condition?: string;
}

export interface KeyBrief {
  /** the key item's entity id, which is also its ref in the response */
  ref: string;
  /** the room it is found in */
  roomName: string;
  roomBase: string;
  /** set when the key is carried rather than lying about */
  carriedBy?: string;
  target: KeyTargetBrief;
  /** blocked ways only: the connector whose `conditional` may be rewritten */
  lockRef?: string;
}

/** The objective, once the content pass has decided what it physically is. */
export interface GoalBrief {
  ref: string;
  name: string;
  base: string;
  /** "Item" | "Creature" | "RoomFeature" | "Room" */
  entityType: string;
  mission: string;
}

export interface KeysPassPayload {
  dungeonContext: string;
  keys: KeyBrief[];
  goal?: GoalBrief;
  instructions: string;
  responseSchema: string;
}

/**
 * Every placed key, with its challenge resolved to a written entity.
 *
 * A key whose target cannot be resolved to something with a description is
 * DROPPED FROM THE PAYLOAD rather than sent with an empty target. The model
 * cannot write "the key to <nothing>", and asking it to would get an invented
 * lock -- which is the exact failure this pass exists to prevent. Such a key
 * keeps the nameless placeholder the entities pass gave it; `unwritableKeys`
 * reports them so the gap is visible rather than silent.
 */
export function buildKeysPassPayload(
  sd: StockedDungeon,
  ep: EntityPassResult,
  dungeonContext: string
): KeysPassPayload {
  const challengeById = new Map(sd.challenges.map((c) => [c.id, c]));
  const itemById = new Map(ep.items.map((i) => [i.id, i]));
  const roomById = new Map(ep.rooms.map((r) => [r.id, r]));
  const connectorById = new Map(ep.connectors.map((c) => [c.id, c]));
  const featureById = new Map(ep.features.map((f) => [f.id, f]));
  const hazardById = new Map(ep.hazards.map((h) => [h.id, h]));
  const creatureById = new Map(ep.creatures.map((c) => [c.id, c]));

  // mobile id -> the creature entity it became. Only the bindings carry this.
  const creatureOfMobile = new Map<string, string>();
  for (const b of ep.bindings) if (b.mobileId) creatureOfMobile.set(b.mobileId, b.entityId);

  // room id -> the hazard and obstacle standing in it, for the two challenge
  // kinds whose target is a room rather than a thing with an id of its own.
  const specialInRoom = new Map<string, string>();
  for (const b of ep.bindings) {
    if (b.element === "hazard" || b.element === "obstacle") {
      specialInRoom.set(`${b.roomId}:${b.element}`, b.entityId);
    }
  }

  const itemRewardId = new Map<string, string>();
  for (const b of ep.bindings) if (b.rewardId) itemRewardId.set(b.rewardId, b.entityId);

  const target = (c: Challenge): KeyTargetBrief | undefined => {
    const common = { fact: c.property, label: CHALLENGE_LABEL[c.kind], kind: c.kind };

    switch (c.kind) {
      case "creature-weakness":
      case "creature-ability":
      case "npc-liability":
      case "npc-asset": {
        const id = creatureOfMobile.get(c.targetId);
        const cr = id ? creatureById.get(id) : undefined;
        if (!cr) return undefined;
        const base = resolveBase(cr, ep.registry);
        if (!base) return undefined;
        return { ...common, name: resolveName(cr, ep.registry), base };
      }

      case "blocked-way":
      case "concealed-way": {
        const conn = connectorById.get(c.targetId);
        if (!conn || !conn.base) return undefined;
        return {
          ...common,
          name: conn.name,
          base: conn.base,
          ...(conn.conditional !== undefined ? { condition: conn.conditional } : {}),
        };
      }

      case "hazard": {
        const id = specialInRoom.get(`${c.targetId}:hazard`);
        const hz = id ? hazardById.get(id) : undefined;
        if (!hz) return undefined;
        const base = resolveBase(hz, ep.registry);
        if (!base) return undefined;
        return { ...common, name: hz.name, base };
      }

      case "obstacle": {
        const id = specialInRoom.get(`${c.targetId}:obstacle`);
        const f = id ? featureById.get(id) : undefined;
        if (!f || !f.base) return undefined;
        return { ...common, name: f.name, base: f.base };
      }

      // A region and the goal's location are both answered by a PLACE, and the
      // room is the only entity here guaranteed to have been written.
      case "region":
      case "goal-location": {
        const room = roomById.get(c.roomId);
        if (!room || !room.base) return undefined;
        return { ...common, name: room.name, base: room.base };
      }

      // Minted BY this pass, so there is never one to write a key for on the
      // way in. They go to the reserve and are drawn in play.
      case "goal-property":
        return undefined;
    }
  };

  const keys: KeyBrief[] = [];
  for (const r of sd.rooms) {
    for (const rw of r.rewards) {
      if (rw.kind !== "key") continue;
      const c = challengeById.get(rw.challengeId);
      if (!c) continue;
      const t = target(c);
      if (!t) continue;

      const itemId = itemRewardId.get(rw.id);
      if (!itemId || !itemById.has(itemId)) continue;

      const carrier = rw.holder.kind === "mobile" ? creatureOfMobile.get(rw.holder.id) : undefined;
      const carried = carrier ? creatureById.get(carrier) : undefined;
      const room = roomById.get(r.roomId);

      keys.push({
        ref: itemId,
        roomName: room?.name ?? "",
        roomBase: room?.base ?? "",
        ...(carried ? { carriedBy: resolveName(carried, ep.registry) } : {}),
        target: t,
        ...(c.kind === "blocked-way" ? { lockRef: c.targetId } : {}),
      });
    }
  }

  const goalEntity = findGoalEntity(ep);
  const goalBase = goalEntity ? resolveBase(goalEntity, ep.registry) : undefined;

  const goal: GoalBrief | undefined =
    goalEntity && goalBase
      ? {
          ref: goalEntity.id,
          name: resolveName(goalEntity, ep.registry),
          base: goalBase,
          entityType: goalEntity.type,
          mission: ep.pendingGoal.mission,
        }
      : undefined;

  return {
    dungeonContext,
    keys,
    ...(goal ? { goal } : {}),
    instructions: KEYS_PASS_INSTRUCTIONS,
    responseSchema: KEYS_PASS_SCHEMA,
  };
}

/**
 * The one entity the whole run is for.
 *
 * `goalEntityId` is written by `applyContentPass`, which is the pass that
 * decides what the objective physically is. A dungeon whose goal chunk failed
 * has none, and this pass simply does not ask for its properties.
 */
function findGoalEntity(ep: EntityPassResult): IEntity | undefined {
  if (!ep.goalEntityId) return undefined;
  const pools: IEntity[][] = [ep.items, ep.features, ep.creatures, ep.rooms];
  for (const pool of pools) {
    const found = pool.find((e) => e.id === ep.goalEntityId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Placed keys that no payload could be built for, with the reason.
 *
 * Not an `Omission` -- there is no retry that would fix it, because the gap is
 * in the dungeon rather than in the response. It is reported so `stockSheet` and
 * the journal can show it: a key with a target nobody wrote is a bug upstream,
 * and it should not take a playthrough to notice.
 */
export function unwritableKeys(
  sd: StockedDungeon,
  ep: EntityPassResult,
  payload: KeysPassPayload
): string[] {
  const inPayload = new Set(payload.keys.map((k) => k.ref));
  const itemOfReward = new Map<string, string>();
  for (const b of ep.bindings) if (b.rewardId) itemOfReward.set(b.rewardId, b.entityId);

  const out: string[] = [];
  for (const r of sd.rooms) {
    for (const rw of r.rewards) {
      if (rw.kind !== "key") continue;
      const itemId = itemOfReward.get(rw.id);
      if (itemId !== undefined && inPayload.has(itemId)) continue;
      const c = sd.challenges.find((ch) => ch.id === rw.challengeId);
      out.push(
        `${rw.id} answers ${c ? CHALLENGE_LABEL[c.kind] : "an unknown challenge"} ` +
          `("${rw.answers}") and its target was never written`
      );
    }
  }
  return out;
}

// ===========================================================================
// RESPONSE
// ===========================================================================

export interface KeyResponse {
  ref: string;
  name: string;
  /** what the object is, and how it answers */
  base: string;
  /** blocked ways only: the lock rewritten so it names what opens it */
  lockRequirement?: string;
}

export interface KeysPassResponse {
  keys: KeyResponse[];
  /**
   * The objective's own keyable properties -- what a player would need to LEARN
   * about it, over and above finding it. Each becomes a `goal-property`
   * challenge and a reserve entry.
   */
  goalProperties?: string[];
}

// ===========================================================================
// RENDER
// ===========================================================================

export function renderKeysPassPrompt(p: KeysPassPayload): string {
  const L: string[] = [];
  L.push(p.instructions, "");
  L.push("=== DUNGEON FICTION (shared context) ===", p.dungeonContext, "");

  const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ");

  L.push(`=== KEYS TO WRITE (${p.keys.length}) ===`, "");
  for (const k of p.keys) {
    L.push(`--- ${k.ref} ---`);
    L.push(`found in "${k.roomName}" -- ${oneLine(k.roomBase)}`);
    if (k.carriedBy) L.push(`carried by ${k.carriedBy}, not lying in the open.`);
    L.push(`IT ANSWERS ${k.target.label.toUpperCase()}: "${k.target.name}"`);
    L.push(`  which is: ${oneLine(k.target.base)}`);
    L.push(`  THE FACT IT MUST CARRY, exactly: "${k.target.fact}"`);
    if (k.target.condition) L.push(`  the lock as it currently reads: ${oneLine(k.target.condition)}`);
    if (k.lockRef) {
      L.push(
        `  you may return "lockRequirement" for this one to rewrite that lock so ` +
          `it and the key name each other.`
      );
    }
    L.push("");
  }

  if (p.goal) {
    L.push("=== THE OBJECTIVE ===");
    L.push(`"${p.goal.name}" (${p.goal.entityType}) -- ${oneLine(p.goal.base)}`);
    L.push(`the mission: ${p.goal.mission}`);
    L.push(
      "",
      "Name one to three things a player would have to LEARN about it, beyond",
      "finding it -- what it wants, what it costs, which of the four seals is",
      "the real one, whose name has to be spoken. Each one short, mechanical,",
      "and true of the objective as described above. These are the QUESTIONS,",
      "not the answers: something else in the dungeon will turn out to answer",
      "them, and it is not your job here to say what.",
      ""
    );
  }

  L.push("=== RESPONSE FORMAT ===", p.responseSchema);
  return L.join("\n");
}

// ===========================================================================
// INSTRUCTIONS + SCHEMA
// ===========================================================================

const KEYS_PASS_INSTRUCTIONS = `You are writing the keys of a dungeon that is otherwise finished. Every room,
every way through and every creature below has already been written and
committed to; nothing about them is yours to change.

A KEY IS AN OBJECT THAT ANSWERS A QUESTION THE DUNGEON ASKS. A journal naming
what drives the ghoul back. A steward's ring the door was cut for. A rubbing of
the seal. Half a map. A vial of the acid that eats the fungus. It is a thing a
player picks up and carries, not a feeling and not a hint.

FOR EACH KEY
- name: what the object is called, two to five words. A thing, not a promise:
  "the almoner's daybook", not "the key to the ghoul".
- base: what it IS and what it tells you, in a sentence or two. THE FACT QUOTED
  UNDER IT MUST SURVIVE VERBATIM OR NEARLY SO -- that exact wording is what the
  game later writes onto the thing it is about, and a paraphrase breaks the
  link. Put it in the object's own voice: what the page says, what the ring is
  cut to fit, what the vial is labelled.
- lockRequirement: OFFERED ONLY where the brief says so, and only for a blocked
  way. Rewrite what stands in that way so that it and this key name each other.
  It must still read correctly from both sides, since a player can meet it from
  either.

HARD RULES
1. Return exactly the keys listed, each once, with its ref exactly as given. Do
   not add one and do not leave one out: a key with no name is an object the
   player picks up and is told nothing about.
2. The key must be findable and useful WITHOUT the thing it answers being
   present. A player reads the journal in one room and meets the ghoul in
   another, in either order.
3. Do not say what the key is worth. Do not give it a price, a weight, or a
   number of any kind.
4. Do not describe the room it is in, or the thing it answers. Both are written.
5. Write prose, not notes.`;

const KEYS_PASS_SCHEMA = `Return JSON only, no prose outside it:

{
  "keys": [
    {
      "ref": "<exactly as given>",
      "name": "<what the object is called>",
      "base": "<what it is and what it tells you, carrying the fact verbatim>",
      "lockRequirement": "<only where offered: the lock, rewritten to name this key>"
    }
  ],
  "goalProperties": ["<a thing that must be learned about the objective>"]
}`;

// ===========================================================================
// COMPLETENESS
// ===========================================================================

/**
 * Every key that was listed and did not come back.
 *
 * Bought the same way `seamsPassOmissions` buys it: asked BEFORE the response is
 * accepted, so a gap costs a retry rather than being reported after the call is
 * spent. A key that never comes back is an unnamed object sitting in a room the
 * player is going to search.
 */
export function keysPassOmissions(payload: KeysPassPayload, res: KeysPassResponse): Omission[] {
  const written = new Set((res.keys ?? []).map((k) => k.ref));
  return payload.keys
    .filter((k) => !written.has(k.ref))
    .map((k) => ({
      path: `keys.${k.ref}`,
      message: `key ${k.ref} (in ${k.roomName}, answering "${k.target.fact}") was listed and is not in the response`,
    }));
}

// ===========================================================================
// APPLY
// ===========================================================================

export interface KeysApplyResult {
  written: string[];
  /** listed but not returned -- these keep their nameless placeholder */
  missing: string[];
  /** blocked ways whose condition was rewritten to name its key */
  locksRewritten: string[];
  /** the `goal-property` challenges this pass minted */
  goalProperties: Challenge[];
}

/**
 * Write the keys onto their items, rewrite the locks that asked for it, and mint
 * the goal's properties.
 *
 * MUTATES `sd.challenges` and `sd.reserve`. The goal's keyable properties do not
 * exist before this call and are pure generation data once they do -- a
 * challenge and a reserve entry, no prose, exactly like every challenge the
 * rooms loop enumerated. See `dungeon-rewards.ts` on why the reserve holds facts
 * and not sentences.
 *
 * Anything not listed in the payload is ignored rather than applied, on the same
 * rule the seams pass follows: a key the content pass legitimately owns is not
 * this pass's to overwrite.
 */
export function applyKeysPass(
  res: KeysPassResponse,
  payload: KeysPassPayload,
  sd: StockedDungeon,
  ep: EntityPassResult
): KeysApplyResult {
  const listed = new Map(payload.keys.map((k) => [k.ref, k]));
  const itemById = new Map(ep.items.map((i) => [i.id, i]));
  const connectorById = new Map(ep.connectors.map((c) => [c.id, c]));

  const written: string[] = [];
  const locksRewritten: string[] = [];

  for (const kr of res.keys ?? []) {
    const brief = listed.get(kr.ref);
    if (!brief) continue;
    const item = itemById.get(kr.ref);
    if (!item) continue;

    // A key is named in the room card beside the things the content pass named,
    // so it is capitalised on the same rule. See `properName`.
    item.name = properName(kr.name);
    (item as { base?: string }).base = kr.base;
    // The fact stays on the item as a keyword as well as in its prose. It is
    // what the resolution write copies onto the thing the key is about, and
    // reading it back out of written prose would be guesswork.
    item.keywords = { Key: brief.target.fact, Answers: brief.target.label };
    written.push(kr.ref);

    // The lock, rewritten to name what opens it. Only where the brief offered
    // it, only onto a way that is actually shut, and never onto the way out.
    if (kr.lockRequirement && brief.lockRef) {
      const conn: IRoomConnector | undefined = connectorById.get(brief.lockRef);
      if (conn && !isSurfaceExit(conn) && conn.conditional !== undefined) {
        conn.conditional = kr.lockRequirement;
        locksRewritten.push(brief.lockRef);
      }
    }
  }

  return {
    written,
    missing: [...listed.keys()].filter((ref) => !written.includes(ref)),
    locksRewritten,
    goalProperties: mintGoalProperties(res, payload, sd),
  };
}

/**
 * The objective's keyable properties, as challenges and reserve entries.
 *
 * Ids are DERIVED like every other challenge id -- `ch:goal-property:<entity>:<n>`
 * -- so a save and a reload agree about which one a ledger entry names. Capped at
 * three: the objective is one thing, and a model handed an open list writes six.
 */
function mintGoalProperties(
  res: KeysPassResponse,
  payload: KeysPassPayload,
  sd: StockedDungeon
): Challenge[] {
  if (!payload.goal) return [];

  // Where the player meets it: the goal room, as the enumeration named it. A
  // `goal-property` is about the objective, and the objective is standing there.
  const goalRoomId = sd.challenges.find((c) => c.kind === "goal-location")?.roomId;
  if (!goalRoomId) return [];

  const already = new Set(
    sd.challenges.filter((c) => c.kind === "goal-property").map((c) => c.property.toLowerCase())
  );

  const minted: Challenge[] = [];
  for (const raw of res.goalProperties ?? []) {
    if (minted.length >= 3) break;
    const property = raw.trim();
    if (property === "" || already.has(property.toLowerCase())) continue;
    already.add(property.toLowerCase());
    minted.push({
      id: `ch:goal-property:${payload.goal.ref}:${minted.length}`,
      kind: "goal-property",
      target: "room",
      targetId: goalRoomId,
      roomId: goalRoomId,
      property,
    });
  }

  for (const c of minted) {
    sd.challenges.push(c);
    // INFORMATION, always. A property of the objective is a thing you find out,
    // and there is no object that IS "the fourth seal is the real one".
    const entry: ReserveEntry = { challengeId: c.id, kind: "information", fact: c.property };
    sd.reserve.push(entry);
  }
  return minted;
}
