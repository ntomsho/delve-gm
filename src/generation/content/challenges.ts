/**
 * CHALLENGES
 * ==========
 *
 * What a dungeon ASKS of you, enumerated.
 *
 * A challenge is ONE KEYABLE PROPERTY OF ONE ENTITY -- not the entity. A
 * creature with a rolled weakness and a rolled ability is two challenges; a
 * creature with two weaknesses is two more. That granularity is the whole
 * point: a key answers a property, and "the ghoul" is not something a vial of
 * acid or a line in a journal can answer.
 *
 * This is the phase's real product and everything else reads from it. Keys
 * answer challenges, accomplishments resolve them, XP prices them, and
 * generation can assert that no challenge is unanswerable and no key sits
 * behind the thing it opens.
 *
 * WHY IT RUNS AT STOCKING LEVEL. All four sources -- creature seeds, gated and
 * hidden connectors, special content, the goal room -- are settled by the rooms
 * loop, and the pass that turns them into entities runs after. Hazards and
 * obstacles in particular have no entity id yet, so a challenge names the
 * STOCKING-level thing it is about: a mobile id, a connector id, a room id.
 * `entities-pass.ts` carries the mapping back the other way, through
 * the bindings it already writes.
 *
 * IDS ARE DERIVED, NOT MINTED. Same seed in, same challenge ids out -- they are
 * built from the target and the property's position on it, never from
 * `makeId()`, because a reward that names a challenge and a ledger that names
 * one have to agree across a save and a reload.
 */

import type { MobileEntity, RoomStock, StockedConnector } from "./types.ts";
import type { Challenge, ChallengeKind } from "../../shared/world/challenges.ts";

// ---------------------------------------------------------------------------
// THE TAXONOMY
// ---------------------------------------------------------------------------

/** Whether this challenge is one of the goal's. Goal challenges are placed AND reserved. */
export function isGoalChallenge(c: Challenge): boolean {
  return c.kind === "goal-location" || c.kind === "goal-property";
}

/** Human-readable, for prompts and dev dumps. Never parsed. */
export const CHALLENGE_LABEL: Record<ChallengeKind, string> = {
  "creature-weakness": "a creature's weakness",
  "creature-ability": "a creature's ability",
  "npc-liability": "a person's liability",
  "npc-asset": "a person's asset",
  "blocked-way": "a blocked way",
  "concealed-way": "a concealed way",
  hazard: "a hazard",
  obstacle: "an obstacle",
  region: "a region of the map",
  "goal-location": "where the objective is",
  "goal-property": "the objective itself",
};

// ---------------------------------------------------------------------------
// ENUMERATION
// ---------------------------------------------------------------------------

/**
 * What enumeration reads. Narrower than `StockedDungeon` so that stocking can
 * call it BEFORE it has assembled one -- placement needs the challenges, and
 * placement happens inside `stockDungeon`. A full `StockedDungeon` satisfies it.
 */
export interface ChallengeSource {
  rooms: RoomStock[];
  mobiles: MobileEntity[];
  connectors: StockedConnector[];
  goalRoomId: string;
}

const idOf = (kind: ChallengeKind, targetId: string, index?: number): string =>
  index === undefined ? `ch:${kind}:${targetId}` : `ch:${kind}:${targetId}:${index}`;

/**
 * Every challenge in a stocked dungeon, in a stable order: creatures by mobile
 * order, then ways by connector order, then room content by room order, then
 * the goal.
 *
 * The order is part of the determinism guarantee -- the reserve is drawn from
 * this list and a run replays only if the list is the same list.
 */
export function enumerateChallenges(sd: ChallengeSource): Challenge[] {
  const out: Challenge[] = [];
  const byRoom = new Map<string, RoomStock>();
  for (const r of sd.rooms) byRoom.set(r.roomId, r);

  // --- creatures and people ------------------------------------------------
  // A minion's flaw is not a challenge. Minions are nameless rank and file
  // sharing a parent's identity, and a key promising a way past "one of the
  // thralls" answers nothing the player was ever going to be asked.
  for (const m of sd.mobiles) {
    if (m.minion) continue;
    pushCreature(out, m);
    pushNpc(out, m);
  }

  // --- ways ----------------------------------------------------------------
  // `gated` and `hidden` are independent, so a way that is both is two
  // challenges: getting through it and finding it at all.
  const depth = new Map<string, number>();
  for (const r of sd.rooms) depth.set(r.roomId, r.depth);
  const nearer = (c: StockedConnector): string =>
    (depth.get(c.a) ?? 0) <= (depth.get(c.b) ?? 0) ? c.a : c.b;

  for (const c of sd.connectors) {
    if (c.gated) {
      out.push({
        id: idOf("blocked-way", c.id),
        kind: "blocked-way",
        target: "connector",
        targetId: c.id,
        roomId: nearer(c),
        property: "the way is blocked",
      });
    }
    if (c.hidden) {
      out.push({
        id: idOf("concealed-way", c.id),
        kind: "concealed-way",
        target: "connector",
        targetId: c.id,
        roomId: nearer(c),
        property: "the way is concealed",
      });
    }
  }

  // --- room content --------------------------------------------------------
  // A trap's keyable property is its TRIGGER -- what sets it off is what a
  // player can be told and can act on, where the effect is only what happens
  // when they could not. An environmental hazard has no trigger and is keyed by
  // the hazard itself.
  for (const r of sd.rooms) {
    const s = r.special;
    if (!s) continue;
    if (s.kind === "hazard") {
      const property = s.trapTrigger ?? s.hazard;
      if (property) {
        out.push({
          id: idOf("hazard", r.roomId),
          kind: "hazard",
          target: "room",
          targetId: r.roomId,
          roomId: r.roomId,
          property,
        });
      }
    } else if (s.subject) {
      out.push({
        id: idOf("obstacle", r.roomId),
        kind: "obstacle",
        target: "room",
        targetId: r.roomId,
        roomId: r.roomId,
        property: s.behaviour ? `${s.subject}, which ${s.behaviour.toLowerCase()}` : s.subject,
      });
    }
  }

  // --- regions -------------------------------------------------------------
  // None at the moment (*Named areas* in docs/ROADMAP.md). The kind and its key
  // (which charts the region's rooms) stay in the engine for them.

  // --- the goal ------------------------------------------------------------
  // Where it is. What it IS cannot be enumerated yet -- see `goal-property`.
  const goal = byRoom.get(sd.goalRoomId);
  if (goal) {
    out.push({
      id: idOf("goal-location", goal.roomId),
      kind: "goal-location",
      target: "room",
      targetId: goal.roomId,
      roomId: goal.roomId,
      // The outline's words for the objective when there are any, because the rolled
      // reward is a table's category and the player reads this fact in play.
      property: goal.goalDirective?.objective
        ? `where to find ${goal.goalDirective.objective.form}`
        : goal.goalDirective
          ? `where ${goal.goalDirective.reward} lies`
          : "where the objective lies",
    });
  }

  return out;
}

function pushCreature(out: Challenge[], m: MobileEntity): void {
  const mon = m.monster;
  if (!mon) return;
  mon.weaknesses.forEach((w, i) => {
    out.push({
      id: idOf("creature-weakness", m.id, i),
      kind: "creature-weakness",
      target: "mobile",
      targetId: m.id,
      roomId: m.locationRoomId,
      property: w,
    });
  });
  // Traits and abilities share one rolled list; only the abilities are things
  // that stand in a player's way. A trait is what the thing is LIKE.
  mon.traitsAndAbilities.forEach((ta, i) => {
    if (ta.table !== "Ability") return;
    out.push({
      id: idOf("creature-ability", m.id, i),
      kind: "creature-ability",
      target: "mobile",
      targetId: m.id,
      roomId: m.locationRoomId,
      property: ta.result,
    });
  });
}

function pushNpc(out: Challenge[], m: MobileEntity): void {
  const npc = m.npc;
  if (!npc) return;
  if (npc.liability) {
    out.push({
      id: idOf("npc-liability", m.id),
      kind: "npc-liability",
      target: "mobile",
      targetId: m.id,
      roomId: m.locationRoomId,
      property: npc.liability,
    });
  }
  if (npc.asset) {
    out.push({
      id: idOf("npc-asset", m.id),
      kind: "npc-asset",
      target: "mobile",
      targetId: m.id,
      roomId: m.locationRoomId,
      property: npc.asset,
    });
  }
}

/**
 * The goal's location, reworded by the objective's written name once the content pass
 * has named it: "where to find the Oracle", not the outline's whole description of it.
 * The player reads this fact in play, and the reserve keeps its own copy.
 */
export function nameGoalLocation(
  sd: { challenges: Challenge[]; reserve: { challengeId: string; fact: string }[] },
  name: string,
  /** a person or creature, whose name is said as it is: "Eldress Gilse Tallow", not "the Eldress" */
  named = false
): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const article = /^(the|a|an)\b/i.test(trimmed)
    ? trimmed.replace(/^(the|a|an)\b/i, (w) => w.toLowerCase())
    : named
      ? trimmed
      : `the ${trimmed}`;
  const fact = `where to find ${article}`;
  for (const c of sd.challenges) {
    if (c.kind !== "goal-location") continue;
    c.property = fact;
    for (const e of sd.reserve) if (e.challengeId === c.id) e.fact = fact;
  }
}

// ---------------------------------------------------------------------------
// FROM A CHALLENGE TO THE THING IN THE ROOM
// ---------------------------------------------------------------------------

/**
 * What a challenge is ABOUT, as an entity a player can meet.
 *
 * A challenge names stocking-level things -- a mobile id, a connector id, a room
 * id -- because that is all that exists when it is enumerated. Everything after
 * generation deals in entities, and this is the one crossing between them. Both
 * the keys pass (writing what a key answers) and the runtime (writing the fact
 * onto the thing it is true of) go through here, so there is exactly one answer
 * to "which entity is this challenge about" rather than two that can drift.
 *
 * A creature challenge can anchor to SEVERAL entities: one mobile becomes a
 * consolidated group and the distinct specimens standing beside it, and the
 * weakness is true of all of them. The array is in binding order, which is the
 * order the entities pass emitted them in.
 */
export interface ChallengeAnchor {
  entityIds: string[];
  type: "Creature" | "RoomConnector" | "Hazard" | "RoomFeature" | "Room";
}

/**
 * The bindings this needs, narrowed so `dungeon-challenges` does not depend on
 * the entities pass. `EntityPassResult["bindings"]` satisfies it.
 */
export interface AnchorSource {
  bindings: readonly {
    entityId: string;
    roomId: string;
    element: string;
    mobileId?: string | undefined;
  }[];
}

export function anchorOf(c: Challenge, src: AnchorSource): ChallengeAnchor | undefined {
  const byElement = (roomId: string, element: string): string[] =>
    src.bindings.filter((b) => b.roomId === roomId && b.element === element).map((b) => b.entityId);

  switch (c.kind) {
    case "creature-weakness":
    case "creature-ability":
    case "npc-liability":
    case "npc-asset": {
      // Through the bindings, NOT through a creature's own fields: the content
      // pass throws away the placeholder roster and mints its own, and the
      // binding is what gets rewritten to follow it.
      const ids = src.bindings
        .filter((b) => b.element === "creature" && b.mobileId === c.targetId)
        .map((b) => b.entityId);
      return ids.length ? { entityIds: ids, type: "Creature" } : undefined;
    }

    case "blocked-way":
    case "concealed-way":
      // Connector ids survive the entities pass unchanged.
      return { entityIds: [c.targetId], type: "RoomConnector" };

    case "hazard": {
      const ids = byElement(c.targetId, "hazard");
      return ids.length ? { entityIds: ids, type: "Hazard" } : undefined;
    }

    case "obstacle": {
      const ids = byElement(c.targetId, "obstacle");
      return ids.length ? { entityIds: ids, type: "RoomFeature" } : undefined;
    }

    // A region and the objective's location are both answered by a PLACE. The
    // objective's own properties are true of the objective, but it stands in
    // that room and the room is the thing already guaranteed to exist.
    case "region":
    case "goal-location":
    case "goal-property":
      return { entityIds: [c.roomId], type: "Room" };
  }
}
