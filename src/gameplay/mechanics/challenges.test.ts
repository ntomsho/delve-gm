/**
 * CHALLENGES AT RUNTIME
 * =====================
 *
 * The draw, the resolution write, `mapped`, the ledger, and the tally.
 *
 * The through-line of every test below is the same claim: NOTHING HERE ASKS THE
 * MODEL TO JUDGE. A challenge is resolved because the world changed in a way the
 * applier can see, a fact is written in the dungeon's own words rather than the
 * game master's, and the one genuinely uncertain case — the creature talked past —
 * is two timestamps compared at the end.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyTally,
  buildTallyPayload,
  shouldTally,
  XP_FOR_RISK,
  type TallyResponse,
} from "../tally/tally-pass.ts";
import { CHALLENGE_LABEL } from "../../generation/content/challenges.ts";
import type { Challenge } from "../../shared/world/challenges.ts";
import { purse } from "../../rules/knave/character-creation.ts";
import { generateOffline, testCharacter } from "../../fixtures/offline.ts";
import { applyCommit } from "../diffs/apply.ts";
import { PLAYER_ID, type Commit, type World } from "../../shared/types/commit.ts";
import {
  applyDraw,
  bestedByBypass,
  challengeStateOf,
  newChallengeState,
  noteAction,
  noteArrival,
  noteDamage,
  noteResolutions,
  offerDraws,
  recordFact,
  resolutionsFrom,
} from "./challenges.ts";
import type { ChallengeState } from "../../shared/world/challenges.ts";

const SEED = 1005;

function aWorld(): World {
  const gd = generateOffline(SEED, 2);
  return {
    entities: structuredClone(gd.entities),
    pc: testCharacter(),
    currentRoomId: gd.stocked.entranceRoomId,
    goalMet: false,
    fiction: [],
    challenges: gd.stocked.challenges,
    reserve: gd.stocked.reserve,
    challengeState: newChallengeState(gd.stocked.pot.allowance),
    turn: 1,
    runSeed: 4242,
  };
}

const commit = (over: Partial<Commit> = {}): Commit => ({
  nextStage: "awaiting_action",
  nextStep: "1-target",
  timeSpent: "short",
  diffs: [],
  ...over,
});

/** The first challenge of a kind, for tests that need a specific one. */
function pick(world: World, kind: Challenge["kind"]): Challenge {
  const c = world.challenges.find((x) => x.kind === kind);
  expect(c, `seed ${SEED} has no ${kind} challenge; the fixture moved`).toBeDefined();
  return c!;
}

// ===========================================================================
// THE DRAW
// ===========================================================================

describe("drawing from the reserve", () => {
  let world: World;
  beforeEach(() => { world = aWorld(); });

  it("offers only what is still there, nearest first", () => {
    const offers = offerDraws(
      world.challengeState, world.challenges, world.reserve, world.currentRoomId, CHALLENGE_LABEL
    );
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.length).toBeLessThanOrEqual(8);

    // Nearest first, so the game master's easiest pick is also the best one.
    const firstFar = offers.findIndex((o) => !o.here);
    if (firstFar >= 0) expect(offers.slice(firstFar).every((o) => !o.here)).toBe(true);

    // Every offer quotes the reserve's own fact verbatim.
    for (const o of offers) {
      const entry = world.reserve.find((e) => e.challengeId === o.challengeId)!;
      expect(o.fact).toBe(entry.fact);
    }
  });

  it("spends an entry, and refuses to spend it twice", () => {
    const target = world.reserve[0]!.challengeId;
    const first = applyDraw(world.challengeState, world.challenges, world.reserve, { challengeId: target }, 3);
    expect(first.ok).toBe(true);

    const again = applyDraw(world.challengeState, world.challenges, world.reserve, { challengeId: target }, 4);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain("already been drawn");

    // And it stops being offered.
    const offers = offerDraws(
      world.challengeState, world.challenges, world.reserve, world.currentRoomId, CHALLENGE_LABEL
    );
    expect(offers.some((o) => o.challengeId === target)).toBe(false);
  });

  it("refuses an id the dungeon never had", () => {
    const out = applyDraw(
      world.challengeState, world.challenges, world.reserve, { challengeId: "ch:invented:nope" }, 1
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("no reserve entry");
  });

  it("refuses a challenge that is already resolved", () => {
    const target = world.reserve[0]!.challengeId;
    const c = world.challenges.find((x) => x.id === target)!;
    noteResolutions(world.challengeState, world.challenges, [{ challengeId: c.id, resolution: "slain" }], 2);

    const out = applyDraw(world.challengeState, world.challenges, world.reserve, { challengeId: target }, 3);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("already resolved");
  });

  it("goes through the applier, and is refused there too", () => {
    const target = world.reserve[0]!.challengeId;
    const ok = applyCommit(world, commit({ draw: { challengeId: target } }));
    expect(ok.ok).toBe(true);
    expect(ok.events.some((e) => e.kind === "key-drawn")).toBe(true);

    const twice = applyCommit(ok.world!, commit({ draw: { challengeId: target } }));
    expect(twice.ok).toBe(false);
    expect(twice.rejected[0]!.reason).toContain("already been drawn");
  });

  it("refuses a draw naming a ref nothing created", () => {
    const out = applyCommit(
      world,
      commit({ draw: { challengeId: world.reserve[0]!.challengeId, entityRef: "ghost" } })
    );
    expect(out.ok).toBe(false);
    expect(out.rejected[0]!.reason).toContain("ghost");
  });

  it("ties a drawn object to the entity the same commit minted", () => {
    const target = world.reserve[0]!.challengeId;
    const out = applyCommit(
      world,
      commit({
        diffs: [{
          entityId: PLAYER_ID,
          path: "children[]",
          value: { type: "Item", name: "a torn page", base: "Half a page, in a clerk's hand.", ref: "page" },
        }],
        draw: { challengeId: target, entityRef: "page" },
      })
    );
    expect(out.ok).toBe(true);
    const drawn = out.world!.challengeState.drawn.find((d) => d.challengeId === target)!;
    expect(drawn.entityId).toBeDefined();
    expect(out.world!.pc.inventory.some((i) => i.id === drawn.entityId)).toBe(true);
  });

  it("gives nothing away on a turn that changed nothing", () => {
    for (const stage of ["clarifying", "rejected"] as const) {
      const out = applyCommit(world, commit({ nextStage: stage, draw: { challengeId: world.reserve[0]!.challengeId } }));
      expect(out.ok).toBe(false);
      expect(out.rejected[0]!.reason).toContain("handing over a key");
    }
  });
});

// ===========================================================================
// THE RECORD
// ===========================================================================

describe("recording what a key revealed", () => {
  let world: World;
  beforeEach(() => { world = aWorld(); });

  it("writes the dungeon's words, not the game master's, onto the thing itself", () => {
    const c = pick(world, "creature-weakness");
    const out = recordFact(world, world.challenges, c.id, world.challengeState);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.wrote.length).toBeGreaterThan(0);
    for (const w of out.wrote) {
      // THE EXACT WORDING IS THE WHOLE POINT — it is what stops the fact
      // drifting between calls.
      expect(w.state).toContain(c.property);
      const creature = world.entities.creatures.find((x) => x.id === w.entityId)!;
      expect(creature.state).toContain(c.property);
    }
  });

  it("fans out to every body the fact is true of", () => {
    // `state` is per-entity and a rolled weakness lives on the group's template,
    // so one ghoul learning it would leave the other eleven unmarked.
    const c = pick(world, "creature-weakness");
    const bound = world.entities.bindings.filter((b) => b.element === "creature" && b.mobileId === c.targetId);
    const out = recordFact(world, world.challenges, c.id, world.challengeState);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.wrote.map((w) => w.entityId).sort()).toEqual(bound.map((b) => b.entityId).sort());
  });

  it("does not write the same fact twice", () => {
    const c = pick(world, "creature-weakness");
    recordFact(world, world.challenges, c.id, world.challengeState);
    const before = world.entities.creatures.map((x) => x.state);
    recordFact(world, world.challenges, c.id, world.challengeState);
    expect(world.entities.creatures.map((x) => x.state)).toEqual(before);
  });

  it("keeps what was already true of the thing", () => {
    const c = pick(world, "creature-weakness");
    const id = world.entities.bindings.find((b) => b.element === "creature" && b.mobileId === c.targetId)!.entityId;
    const creature = world.entities.creatures.find((x) => x.id === id)!;
    creature.state = "Bleeding from the shoulder.";

    recordFact(world, world.challenges, c.id, world.challengeState);
    expect(creature.state).toContain("Bleeding from the shoulder.");
    expect(creature.state).toContain(c.property);
  });

  it("refuses a challenge that does not exist", () => {
    const out = applyCommit(world, commit({ learned: ["ch:invented:nope"] }));
    expect(out.ok).toBe(false);
    expect(out.rejected[0]!.reason).toContain("no such challenge");
  });

  it("records it on the run so the prompt stops offering it", () => {
    const c = pick(world, "creature-weakness");
    const out = applyCommit(world, commit({ learned: [c.id] }));
    expect(out.ok).toBe(true);
    expect(out.world!.challengeState.known).toContain(c.id);
    expect(out.events.some((e) => e.kind === "fact-recorded")).toBe(true);
  });
});

// ===========================================================================
// RESOLUTION, READ OFF THE WORLD
// ===========================================================================

describe("what a commit resolved", () => {
  let world: World;
  beforeEach(() => { world = aWorld(); });

  it("counts a blocked way as cleared when its condition is gone", () => {
    const c = pick(world, "blocked-way");
    const after = structuredClone(world);
    delete after.entities.connectors.find((x) => x.id === c.targetId)!.conditional;

    const out = resolutionsFrom(world, after, [], world.challenges);
    expect(out).toContainEqual({ challengeId: c.id, resolution: "cleared" });
  });

  it("counts a concealed way as found when it stops being hidden", () => {
    const c = pick(world, "concealed-way");
    const after = structuredClone(world);
    delete after.entities.connectors.find((x) => x.id === c.targetId)!.isHidden;

    const out = resolutionsFrom(world, after, [], world.challenges);
    expect(out).toContainEqual({ challengeId: c.id, resolution: "found" });
  });

  it("counts a creature only when every body of it is down", () => {
    const c = pick(world, "creature-weakness");
    const ids = world.entities.bindings
      .filter((b) => b.element === "creature" && b.mobileId === c.targetId)
      .map((b) => b.entityId);

    if (ids.length > 1) {
      const partial = resolutionsFrom(world, world, [{ kind: "creature-slain", entityId: ids[0]!, detail: "" }], world.challenges);
      expect(partial.some((r) => r.challengeId === c.id)).toBe(false);
    }

    const all = resolutionsFrom(
      world, world, ids.map((entityId) => ({ kind: "creature-slain" as const, entityId, detail: "" })), world.challenges
    );
    expect(all).toContainEqual({ challengeId: c.id, resolution: "slain" });
  });

  it("counts the objective only on the turn the latch closes", () => {
    const after = structuredClone(world);
    after.goalMet = true;
    const out = resolutionsFrom(world, after, [], world.challenges);
    expect(out.some((r) => r.resolution === "completed")).toBe(true);

    // And not again on every turn thereafter.
    const later = resolutionsFrom(after, after, [], world.challenges);
    expect(later.some((r) => r.resolution === "completed")).toBe(false);
  });

  it("does not guess at a creature that was merely walked away from", () => {
    // The one case with no trace in the world. Detecting it here is how a player
    // gets credited for fleeing; it is inferred at the tally instead.
    const out = resolutionsFrom(world, structuredClone(world), [], world.challenges);
    expect(out).toEqual([]);
  });

  it("keeps the first resolution and ignores a later one", () => {
    const cs = newChallengeState(0);
    const c = pick(world, "blocked-way");
    noteResolutions(cs, world.challenges, [{ challengeId: c.id, resolution: "cleared" }], 5);
    noteResolutions(cs, world.challenges, [{ challengeId: c.id, resolution: "slain" }], 9);
    const e = cs.ledger.find((x) => x.challengeId === c.id)!;
    expect(e.resolvedTurn).toBe(5);
    expect(e.resolution).toBe("cleared");
  });
});

// ===========================================================================
// MAPPED
// ===========================================================================

describe("a region key", () => {
  it("puts the whole region on the map without letting the player walk it", () => {
    const world = aWorld();
    const c = pick(world, "region");
    expect(c.roomIds!.length).toBeGreaterThan(1);

    const out = applyDraw(world.challengeState, world.challenges, world.reserve, { challengeId: c.id }, 2);
    expect(out.ok).toBe(true);
    expect(world.challengeState.mapped.sort()).toEqual([...c.roomIds!].sort());

    // MAPPED IS NOT VISITED. Nothing about the rooms themselves changed, so
    // `composed` is still undefined and travel still refuses them.
    for (const roomId of c.roomIds!) {
      const room = world.entities.rooms.find((r) => r.id === roomId)!;
      if (roomId !== world.currentRoomId) expect(room.composed).toBeUndefined();
    }
  });

  it("counts as answered the moment it is drawn", () => {
    const world = aWorld();
    const c = pick(world, "region");
    applyDraw(world.challengeState, world.challenges, world.reserve, { challengeId: c.id }, 2);
    const e = world.challengeState.ledger.find((x) => x.challengeId === c.id)!;
    expect(e.resolvedTurn).toBe(2);
  });
});

// ===========================================================================
// THE LEDGER
// ===========================================================================

describe("the ledger", () => {
  let world: World;
  let cs: ChallengeState;
  beforeEach(() => { world = aWorld(); cs = world.challengeState; });

  it("marks everything in a room as met on arrival", () => {
    const c = world.challenges.find((x) => x.roomId !== world.currentRoomId)!;
    noteArrival(cs, world.challenges, c.roomId, 7);
    expect(cs.ledger.find((e) => e.challengeId === c.id)!.metTurn).toBe(7);

    // The first arrival is the one that counts.
    noteArrival(cs, world.challenges, c.roomId, 12);
    expect(cs.ledger.find((e) => e.challengeId === c.id)!.metTurn).toBe(7);
  });

  it("appends an action to every challenge its target is about", () => {
    const c = pick(world, "creature-weakness");
    const id = world.entities.bindings.find((b) => b.element === "creature" && b.mobileId === c.targetId)!.entityId;

    noteAction(cs, world.challenges, world.entities, [id], {
      turn: 4, action: "swing at it", roll: { kind: "attack", total: 18, success: true },
    });
    const e = cs.ledger.find((x) => x.challengeId === c.id)!;
    expect(e.actions).toHaveLength(1);
    expect(e.actions[0]!.roll!.total).toBe(18);
  });

  it("writes nothing for an action aimed at nothing in particular", () => {
    noteAction(cs, world.challenges, world.entities, [], { turn: 1, action: "look around" });
    expect(cs.ledger).toHaveLength(0);
  });
});

// ===========================================================================
// BYPASS
// ===========================================================================

describe("bypass, inferred at the end", () => {
  it("credits a creature met before something else was accomplished", () => {
    const cs = newChallengeState(0);
    cs.ledger.push({ challengeId: "ch:creature-weakness:m1:0", kind: "creature-weakness", metTurn: 4, actions: [] });
    cs.ledger.push({
      challengeId: "ch:blocked-way:c1", kind: "blocked-way",
      metTurn: 6, resolvedTurn: 9, resolution: "cleared", actions: [],
    });
    expect(bestedByBypass(cs)).toEqual(["ch:creature-weakness:m1:0"]);
  });

  it("refuses to credit one the player fled and never got past", () => {
    const cs = newChallengeState(0);
    cs.ledger.push({
      challengeId: "ch:blocked-way:c1", kind: "blocked-way",
      metTurn: 1, resolvedTurn: 2, resolution: "cleared", actions: [],
    });
    // Met AFTER the only accomplishment, so there is nothing later to point at.
    cs.ledger.push({ challengeId: "ch:creature-weakness:m1:0", kind: "creature-weakness", metTurn: 5, actions: [] });
    expect(bestedByBypass(cs)).toEqual([]);
  });

  it("never credits a door, a hazard or a region — only things that move", () => {
    const cs = newChallengeState(0);
    cs.ledger.push({ challengeId: "ch:hazard:r1", kind: "hazard", metTurn: 1, actions: [] });
    cs.ledger.push({ challengeId: "ch:region:c0", kind: "region", metTurn: 1, actions: [] });
    cs.ledger.push({
      challengeId: "ch:blocked-way:c1", kind: "blocked-way",
      metTurn: 1, resolvedTurn: 8, resolution: "cleared", actions: [],
    });
    expect(bestedByBypass(cs)).toEqual([]);
  });
});

// ===========================================================================
// THE TALLY
// ===========================================================================

describe("the tally", () => {
  const ctx = {
    dungeonContext: "[fiction]",
    outcome: "they walked out alive with what they came for",
    level: 1,
    hp: { current: 4, max: 12 },
    turns: 30,
    bypassed: [] as string[],
  };

  function aLedger(): ChallengeState {
    const cs = newChallengeState(0);
    cs.ledger.push({
      challengeId: "ch:blocked-way:c1", kind: "blocked-way",
      metTurn: 2, resolvedTurn: 5, resolution: "cleared",
      actions: [{ turn: 3, action: "lever it", roll: { kind: "save", total: 9, success: false }, damageTaken: 3 }],
    });
    cs.ledger.push({ challengeId: "ch:creature-weakness:m1:0", kind: "creature-weakness", metTurn: 6, actions: [] });
    return cs;
  }

  it("lists what was accomplished and nothing else", () => {
    const p = buildTallyPayload(aLedger(), [], ctx);
    expect(p.items.map((i) => i.challengeId)).toEqual(["ch:blocked-way:c1"]);
    // Entering a room is not an accomplishment: the creature was met and never
    // got past, and it is not on the list.
  });

  it("includes a bypassed creature, worth the same as any other way past", () => {
    const p = buildTallyPayload(aLedger(), [], { ...ctx, bypassed: ["ch:creature-weakness:m1:0"] });
    expect(p.items).toHaveLength(2);
    expect(p.items.find((i) => i.challengeId === "ch:creature-weakness:m1:0")!.how).toBe("bypassed");
  });

  /*
   * TWO ENDINGS DO NOT TALLY, and for the same reason: nothing came back up. A
   * death forfeits it, and so does a run the player walked away from — the
   * character never came out of anywhere, and a score for a delve nobody
   * finished is a number attached to nothing. The ledger is still written for
   * both; what happened is not conditional on it having been paid for.
   */
  it("does not tally a run that ended in death, or one that was abandoned", () => {
    const p = buildTallyPayload(aLedger(), [], ctx);
    expect(shouldTally("dead", p.items)).toBe(false);
    expect(shouldTally("abandoned", p.items)).toBe(false);
    expect(shouldTally("goal_met", p.items)).toBe(true);
    expect(shouldTally("escaped", p.items)).toBe(true);
    expect(shouldTally("goal_met", [])).toBe(false);
  });

  it("prices the words in code, never taking a number from the response", () => {
    const p = buildTallyPayload(aLedger(), [], { ...ctx, bypassed: ["ch:creature-weakness:m1:0"] });
    const res: TallyResponse = {
      ratings: [
        { challengeId: "ch:blocked-way:c1", risk: "high", why: "It cost them blood." },
        { challengeId: "ch:creature-weakness:m1:0", risk: "moderate", why: "Talked past it." },
      ],
    };
    const out = applyTally(res, p);
    expect(out.awards.map((a) => a.xp)).toEqual([XP_FOR_RISK.high, XP_FOR_RISK.moderate]);
    expect(out.total).toBe(XP_FOR_RISK.high + XP_FOR_RISK.moderate);
    expect(out.unrated).toEqual([]);
  });

  it("drops a rating for something that was not on the list", () => {
    const p = buildTallyPayload(aLedger(), [], ctx);
    const out = applyTally(
      { ratings: [{ challengeId: "ch:invented:nope", risk: "high", why: "made up" }] },
      p
    );
    expect(out.awards).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.unrated).toEqual(["ch:blocked-way:c1"]);
  });

  it("reports what came back unrated rather than guessing a default", () => {
    const p = buildTallyPayload(aLedger(), [], { ...ctx, bypassed: ["ch:creature-weakness:m1:0"] });
    const out = applyTally({ ratings: [{ challengeId: "ch:blocked-way:c1", risk: "low", why: "x" }] }, p);
    expect(out.unrated).toEqual(["ch:creature-weakness:m1:0"]);
    expect(out.total).toBe(XP_FOR_RISK.low);
  });

  it("counts a duplicate rating once", () => {
    const p = buildTallyPayload(aLedger(), [], ctx);
    const out = applyTally(
      { ratings: [
        { challengeId: "ch:blocked-way:c1", risk: "high", why: "a" },
        { challengeId: "ch:blocked-way:c1", risk: "high", why: "b" },
      ] },
      p
    );
    expect(out.awards).toHaveLength(1);
    expect(out.total).toBe(XP_FOR_RISK.high);
  });
});

// ===========================================================================
// SURVIVING A RELOAD
// ===========================================================================

describe("a run saved before any of this existed", () => {
  it("comes back with an empty challenge state rather than a crash", () => {
    const cs = challengeStateOf(undefined, 150);
    expect(cs.ledger).toEqual([]);
    expect(cs.allowanceLeft).toBe(150);
    expect(offerDraws(cs, [], [], "nowhere", CHALLENGE_LABEL)).toEqual([]);
  });
});

// ===========================================================================
// THE ALLOWANCE
// ===========================================================================

describe("coin out of the dungeon's allowance", () => {
  it("rolls the amount in code and never takes one from the game master", () => {
    const world = aWorld();
    const before = world.challengeState.allowanceLeft;
    expect(before).toBeGreaterThan(0);

    const out = applyCommit(world, commit({ coinGrant: { why: "in the silt they were digging" } }));
    expect(out.ok).toBe(true);

    const granted = out.events.find((e) => e.kind === "coin-granted")!;
    expect(granted).toBeDefined();
    const amount = Number.parseInt(granted.detail, 10);
    expect(amount).toBeGreaterThan(0);
    expect(out.world!.challengeState.allowanceLeft).toBe(before - amount);
    expect(purse(out.world!.pc)).toBe(purse(world.pc) + amount);
  });

  it("gives the same figure on a replay of the same turn", () => {
    const a = applyCommit(aWorld(), commit({ coinGrant: { why: "x" } }));
    const b = applyCommit(aWorld(), commit({ coinGrant: { why: "x" } }));
    expect(a.world!.challengeState.allowanceLeft).toBe(b.world!.challengeState.allowanceLeft);
  });

  it("runs out, and cannot be talked into more", () => {
    const world = aWorld();
    world.challengeState.allowanceLeft = 0;
    const out = applyCommit(world, commit({ coinGrant: { why: "surely there is more" } }));
    expect(out.ok).toBe(false);
    expect(out.rejected[0]!.reason).toContain("no loose coin left");
  });

  it("spends the pot exactly, leaving no unspendable stub", () => {
    const world = aWorld();
    let turn = 1;
    let guard = 0;
    while (world.challengeState.allowanceLeft > 0 && guard++ < 200) {
      const out = applyCommit({ ...world, turn }, commit({ coinGrant: { why: "found" } }));
      expect(out.ok).toBe(true);
      world.pc = out.world!.pc;
      world.challengeState = out.world!.challengeState;
      turn += 1;
    }
    expect(world.challengeState.allowanceLeft).toBe(0);
  });

  it("finds no money on a turn that changed nothing", () => {
    const world = aWorld();
    const out = applyCommit(world, commit({ nextStage: "rejected", coinGrant: { why: "no" } }));
    expect(out.ok).toBe(false);
    expect(out.rejected[0]!.reason).toContain("finding money");
  });
});

// ===========================================================================
// WHAT IT COST THEM
// ===========================================================================

describe("damage against the room's challenges", () => {
  it("charges hit points lost to what the player was standing in front of", () => {
    const world = aWorld();
    const c = world.challenges.find((x) => x.roomId === world.currentRoomId)!;
    noteArrival(world.challengeState, world.challenges, world.currentRoomId, 2);

    noteDamage(world.challengeState, world.challenges, world.currentRoomId, 2, 5);
    const e = world.challengeState.ledger.find((x) => x.challengeId === c.id)!;
    expect(e.actions.at(-1)!.damageTaken).toBe(5);
  });

  it("folds a second hit on the same turn into the same line", () => {
    const world = aWorld();
    const c = world.challenges.find((x) => x.roomId === world.currentRoomId)!;
    noteArrival(world.challengeState, world.challenges, world.currentRoomId, 2);
    noteDamage(world.challengeState, world.challenges, world.currentRoomId, 2, 5);
    noteDamage(world.challengeState, world.challenges, world.currentRoomId, 2, 3);
    const e = world.challengeState.ledger.find((x) => x.challengeId === c.id)!;
    expect(e.actions).toHaveLength(1);
    expect(e.actions[0]!.damageTaken).toBe(8);
  });

  it("charges nothing to a thing the player has never met", () => {
    const world = aWorld();
    // No arrival noted, so nothing in this room has a ledger entry yet.
    noteDamage(world.challengeState, world.challenges, world.currentRoomId, 2, 5);
    expect(world.challengeState.ledger).toHaveLength(0);
  });

  it("charges nothing to a thing that is already settled", () => {
    const world = aWorld();
    const c = world.challenges.find((x) => x.roomId === world.currentRoomId)!;
    noteArrival(world.challengeState, world.challenges, world.currentRoomId, 1);
    noteResolutions(world.challengeState, world.challenges, [{ challengeId: c.id, resolution: "slain" }], 2);
    noteDamage(world.challengeState, world.challenges, world.currentRoomId, 3, 5);
    const e = world.challengeState.ledger.find((x) => x.challengeId === c.id)!;
    expect(e.actions).toHaveLength(0);
  });

  it("ignores healing", () => {
    const world = aWorld();
    noteArrival(world.challengeState, world.challenges, world.currentRoomId, 1);
    noteDamage(world.challengeState, world.challenges, world.currentRoomId, 2, -4);
    expect(world.challengeState.ledger.every((e) => e.actions.length === 0)).toBe(true);
  });
});
