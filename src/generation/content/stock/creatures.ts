/**
 * STOCKING'S CREATURES: each inhabitant group as a mobile, its minions, the
 * wanderers, and how each is disposed toward the player.
 */

import {
  genMonster,
  genMonsterGroup,
  genPeopleGroup,
  type DungeonBlueprintSeed,
  type InhabitantGroup,
  type Tier,
} from "../blueprint.ts";
import type { MonsterSeed } from "../../../shared/world/seeds.ts";
import {
  DUNGEON_HAZARDS,
  DUNGEON_TRICKS,
  TRAP_EFFECTS,
  TRAP_TRIGGERS,
} from "../../../rules/maze-rats/tables.ts";
import { Rng } from "../../../shared/utils/rng.ts";
import type { Disposition, MobileEntity, SpecialContent } from "../types.ts";
import { mobileId } from "./ids.ts";
import { CAIRN_FEATURE, CAIRN_SPECIAL, roll } from "./tables.ts";

// ---------------------------------------------------------------------------
// CREATURE HELPERS
// ---------------------------------------------------------------------------

/**
 * A Creature entity is a STACK, not an individual: a statblock template, a
 * count, and a location. Any group of creatures sharing a room and a statline
 * is one entity. It splits when part of the group is sent elsewhere and merges
 * back when they reunite, so entity identity is not stable over play.
 *
 * DEFERRED -- counts and split/merge live in `state` for now rather than being
 * modelled here. Two things to pick up if that stops being good enough:
 *   - merging needs a stable key (same template + same room), so templates want
 *     an id rather than being compared structurally
 *   - a split produces a new entity that shares its parent's immutable `base`
 *     while diverging in `state`; base is template-level, state is stack-level
 *
 * The blueprint already carries the template split this implies: people Hordes
 * get one named leader plus `undefinedUnderlings`, monster Hordes get `monster`
 * (simple minions) alongside `biggerSpecimen` (same silhouette, higher tier).
 * Named NPCs are just count-1 stacks whose stats happen to be unique, so they
 * never merge with anything.
 */
function groupLabel(g: InhabitantGroup, gi: number): string {
  return g.kind === "monsters"
    ? `Group ${gi + 1} (${g.tier} ${g.monster.silhouette} monsters)`
    : `Group ${gi + 1} (${g.tier} ${g.faction})`;
}

export function makeGroupMobile(
  group: InhabitantGroup,
  gi: number,
  roomId: string,
  isBase: boolean,
  rng: Rng
): MobileEntity {
  const m: MobileEntity = {
    id: mobileId(),
    kind: "group-member",
    name: `${groupLabel(group, gi)}${isBase ? " -- BASE" : " -- outpost"}`,
    locationRoomId: roomId,
    groupIndex: gi,
    groupId: group.id,
    isBase,
    tier: group.tier,
  };
  if (group.kind === "monsters") m.monster = group.monster;
  return m;
}

/**
 * Downgrade a Solo's statline to something a satellite can carry: same creature,
 * fewer moving parts. Matches what genMonster would have produced at "simple"
 * (one trait/ability line, one feature/mutation line).
 *
 * The weakness is deliberately INHERITED rather than trimmed. Young share the
 * parent's flaw, so a party that fights the brood can learn how to kill the
 * thing that spawned it -- which is the same cross-link the knowledge parcels
 * lean on, arrived at from the other direction.
 */
function downgradeToSimple(m: MonsterSeed): MonsterSeed {
  return {
    ...m,
    complexity: "simple",
    traitsAndAbilities: m.traitsAndAbilities.slice(0, 1),
    featuresAndMutations: m.featuresAndMutations.slice(0, 1),
    weaknesses: m.weaknesses.slice(0, 1),
  };
}

/**
 * A Solo is one creature and cannot literally appear twice, but it can have a
 * minions. For people, that is a handful of hirelings under their command. For
 * monsters, a knot of simple creatures related to it by blood, thrall, or
 * ecology.
 */
function makeMinion(
  group: InhabitantGroup,
  gi: number,
  roomId: string,
  rng: Rng
): MobileEntity {
  const base: MobileEntity = {
    id: mobileId(),
    kind: "group-member",
    name: "",
    locationRoomId: roomId,
    groupIndex: gi,
    groupId: group.id,
    isBase: false,
    // Minions share their parent's tier -- tier describes how many creatures
    // the entity stands for, and a minion stack mirrors the group it serves.
    tier: group.tier,
  };

  if (group.kind === "people") {
    return {
      ...base,
      name: `${groupLabel(group, gi)} -- hirelings`,
      minion: "hirelings",
      notes:
        "A handful of hired hands under the Solo's command. Undefined as " +
        "individuals unless one of them earns a name in play.",
    };
  }

  const kind = rng.pick(["young", "thrall", "ecology"] as const);
  if (kind === "young") {
    return {
      ...base,
      name: `${groupLabel(group, gi)} -- young`,
      minion: "young",
      monster: downgradeToSimple(group.monster),
      notes: "The Solo's brood. Same creature, scaled down; shares its weakness.",
    };
  }
  if (kind === "thrall") {
    return {
      ...base,
      name: `${groupLabel(group, gi)} -- thralls`,
      minion: "thrall",
      monster: genMonster("simple", rng),
      notes: "Simple creatures held under the Solo's control, not its kin.",
    };
  }
  // Ecology: something that simply lives alongside it. Rolled independently --
  // the composition pass is on the hook for working out how it fits the Solo's
  // ecology, which is a judgement call, not a table lookup.
  return {
    ...base,
    name: `${groupLabel(group, gi)} -- attendant creatures`,
    minion: "ecology",
    monster: genMonster("simple", rng),
    notes:
      "Tied to the Solo by ecology rather than obedience or blood. Composition " +
      "pass establishes the relationship (prey, scavenger, symbiote, parasite...).",
  };
}

/**
 * Spend one unit of Creature budget. With probability `cohesion` the encounter
 * belongs to the roster; otherwise it is unaffiliated. Cohesion is rolled once
 * per dungeon, so some dungeons read as tightly populated by their inhabitants
 * and others as a menagerie of unrelated things -- which is its own valid vibe,
 * not a failure mode.
 *
 * Solos now participate, but through minions rather than by duplicating
 * themselves, and they weight lower than Bands and Hordes so they still mostly
 * stay home.
 */
export function makeMinionOrWanderer(
  bp: DungeonBlueprintSeed,
  roomId: string,
  cohesion: number,
  wandererGroups: InhabitantGroup[],
  rng: Rng
): MobileEntity {
  const eligible = bp.inhabitants.map((g, gi) => ({ g, gi }));

  if (eligible.length && rng.chance(cohesion)) {
    const weights = eligible.map(({ g }) =>
      g.tier === "Horde" ? 3 : g.tier === "Band" ? 1.5 : 0.6
    );
    const total = weights.reduce((a, b) => a + b, 0);
    let x = rng.next() * total;
    let k = 0;
    for (; k < eligible.length; k++) {
      x -= weights[k];
      if (x <= 0) break;
    }
    if (k >= eligible.length) k = eligible.length - 1;
    const { g, gi } = eligible[k];
    return g.tier === "Solo"
      ? makeMinion(g, gi, roomId, rng)
      : makeGroupMobile(g, gi, roomId, false, rng);
  }

  // Unaffiliated. This branch is also where Cairn's "at least one NPC who
  // actually prefers dungeon life" comes from.
  //
  // Tier is rolled rather than fixed to Solo: an unaffiliated encounter can be
  // a swarm or a small pack as readily as one lone thing, and a wandering
  // threat that outclasses the resident faction is a feature -- it gives the
  // player something to turn against them. Complexity follows tier so the
  // creature's power matches what the entity represents.
  const tier: Tier = rng.pick(["Solo", "Band", "Horde"] as Tier[]);
  if (rng.chance(0.5)) {
    const group = genMonsterGroup(tier, rng);
    wandererGroups.push(group);
    return {
      id: mobileId(),
      kind: "wanderer-monster",
      name: "Unaffiliated creature",
      locationRoomId: roomId,
      tier,
      groupId: group.id,
      monster: group.monster,
    };
  }
  // Wanderers use the lighter Band weighting -- a group met in a corridor is
  // not worth as much apparatus as one that lives here.
  const group = genPeopleGroup(tier, rng, "wanderer");
  wandererGroups.push(group);
  return {
    id: mobileId(),
    kind: "wanderer-npc",
    name: "Unaffiliated person",
    locationRoomId: roomId,
    tier,
    groupId: group.id,
    npc: group.npcs[0],
  };
}

/**
 * Disposition is a property of the encounter, not of the category. Inhabitants
 * are usually hostile but genuinely need not be -- a faction whose goal aligns
 * with the party's has obvious reason to parley.
 */
export function rollDisposition(
  bp: DungeonBlueprintSeed,
  m: MobileEntity,
  rng: Rng
): Disposition {
  if (m.groupIndex !== undefined) {
    const g = bp.inhabitants[m.groupIndex];
    if (g.kind === "people") {
      if (g.goalBranch === "opposed") {
        return rng.chance(0.85) ? "hostile" : "neutral";
      }
      if (g.goalBranch === "same") {
        // Ally or rival, leaning rival.
        const r = rng.next();
        return r < 0.45 ? "hostile" : r < 0.8 ? "neutral" : "friendly";
      }
      const r = rng.next();
      return r < 0.55 ? "hostile" : r < 0.85 ? "neutral" : "friendly";
    }
    // Monsters: mostly hostile, occasionally just busy.
    return rng.chance(0.8) ? "hostile" : "neutral";
  }
  const r = rng.next();
  return r < 0.6 ? "hostile" : r < 0.88 ? "neutral" : "friendly";
}

export function rollSpecial(rng: Rng): SpecialContent {
  if (rng.coin()) {
    // Hazard half: an environmental hazard, or a built trap.
    if (rng.coin()) {
      return { kind: "hazard", hazard: roll(DUNGEON_HAZARDS, rng) };
    }
    return {
      kind: "hazard",
      trapTrigger: roll(TRAP_TRIGGERS, rng),
      trapEffect: roll(TRAP_EFFECTS, rng),
    };
  }
  // Obstacle half: Cairn Special + (Cairn Feature | MR Trick).
  const useTrick = rng.chance(0.4);
  return {
    kind: "obstacle",
    subject: roll(CAIRN_SPECIAL, rng),
    behaviour: useTrick ? roll(DUNGEON_TRICKS, rng) : roll(CAIRN_FEATURE, rng),
    behaviourSource: useTrick ? "mr-trick" : "cairn-feature",
  };
}
