/**
 * CHALLENGES AT RUNTIME
 * =====================
 *
 * What the dungeon asked, what the player did about it, and what they were told
 * along the way. Three jobs that share one list and are otherwise unrelated:
 *
 *   THE DRAW        a challenge with no placed key can still be answered in
 *                   play — the reserve is thirty entries deep and the placed set
 *                   is four. `offerDraws` builds the list the game master chooses
 *                   from; `applyDraw` refuses everything it should not pick.
 *
 *   THE RECORD      what a key reveals is a fact about the WORLD, not about the
 *                   player, so it is written onto the thing it is true of. See
 *                   `recordFact`.
 *
 *   THE LEDGER      every action aimed at a challenge, so the end-of-run tally
 *                   can price it. NEVER ENTERS A PROMPT, and so costs nothing
 *                   per turn. Written by code — see `resolutionsFrom`, which
 *                   reads what a commit DID rather than asking anyone's opinion.
 *
 * NOTHING HERE ASKS THE MODEL TO JUDGE. A creature is resolved because the
 * applier raised `creature-slain`; a way is cleared because its `conditional`
 * is gone; a hazard is disabled because its `resolved` flag is set. The one
 * genuinely uncertain case — the creature that was talked past or slipped by —
 * is not detected at all, and is inferred from two timestamps at the tally. See
 * `bestedByBypass`.
 */

import { anchorOf } from "../../generation/content/challenges.ts";
import { type Challenge, type ChallengeKind } from "../../shared/world/challenges.ts";
import { isSurfaceExit } from "../../shared/world/entities.ts";
import { purse, setPurse } from "../../rules/knave/character-creation.ts";
import { Rng } from "../../shared/utils/rng.ts";
import { type EntityPassResult } from "../../shared/world/entities.ts";
import { type ReserveEntry } from "../../shared/world/challenges.ts";
import type { World, WorldEvent } from "../../shared/types/commit.ts";
import type {
  ChallengeState,
  DrawnKey,
  LedgerAction,
  LedgerEntry,
} from "../../shared/world/challenges.ts";

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

export function newChallengeState(allowance: number): ChallengeState {
  return { drawn: [], known: [], mapped: [], ledger: [], allowanceLeft: allowance };
}

/** A run saved before any of this existed comes back without it. */
export function challengeStateOf(cs: ChallengeState | undefined, allowance: number): ChallengeState {
  return cs ?? newChallengeState(allowance);
}

// ---------------------------------------------------------------------------
// THE LEDGER
// ---------------------------------------------------------------------------

function entryFor(cs: ChallengeState, c: Challenge): LedgerEntry {
  let e = cs.ledger.find((x) => x.challengeId === c.id);
  if (!e) {
    e = { challengeId: c.id, kind: c.kind, actions: [] };
    cs.ledger.push(e);
  }
  return e;
}

/**
 * Mark every challenge in this room as met.
 *
 * Called on arrival rather than on interaction, because meeting a thing is what
 * `metTurn` means and because bypass is measured from it: a player who walked
 * into the room with the ghoul in it has met the ghoul, whatever they did next.
 */
export function noteArrival(cs: ChallengeState, challenges: readonly Challenge[], roomId: string, turn: number): void {
  for (const c of challenges) {
    if (c.roomId !== roomId) continue;
    const e = entryFor(cs, c);
    e.metTurn ??= turn;
  }
}

/**
 * Append what the player did to every challenge they did it to.
 *
 * `targetIds` is the turn's resolved target — the turn loop already works one
 * out at step 1, so nothing new has to be inferred here.
 */
export function noteAction(
  cs: ChallengeState,
  challenges: readonly Challenge[],
  ep: EntityPassResult,
  targetIds: readonly string[],
  action: LedgerAction
): void {
  if (targetIds.length === 0) return;
  const wanted = new Set(targetIds);
  for (const c of challenges) {
    const anchor = anchorOf(c, ep);
    if (!anchor || !anchor.entityIds.some((id) => wanted.has(id))) continue;
    entryFor(cs, c).actions.push(action);
  }
}

/**
 * Hit points lost this turn, against whatever was in the room.
 *
 * THE TALLY'S SHARPEST SIGNAL. Its instructions say to rate what happened rather
 * than what it sounded like, and the evidence for that is the rolls and the
 * damage — a ghoul described in three terrifying sentences that died to one
 * attack roll was low risk, and a stuck door that cost eight hit points was not.
 * Without this the rater would have the adjectives and nothing else.
 *
 * Charged to everything the player was standing in front of, because the applier
 * knows the hit points moved and does not know which of them did it. Over a run
 * that is the right shape: the thing that actually hurt them is the thing they
 * were also rolling against, and the rater has both columns.
 */
export function noteDamage(
  cs: ChallengeState,
  challenges: readonly Challenge[],
  roomId: string,
  turn: number,
  amount: number
): void {
  if (amount <= 0) return;
  for (const c of challenges) {
    if (c.roomId !== roomId) continue;
    const e = cs.ledger.find((x) => x.challengeId === c.id);
    // Only things the player has actually met. A challenge they have never been
    // in the room with has no ledger entry, and did not hurt them.
    if (!e || e.metTurn === undefined || e.resolvedTurn !== undefined) continue;
    const last = e.actions[e.actions.length - 1];
    if (last && last.turn === turn) last.damageTaken = (last.damageTaken ?? 0) + amount;
    else e.actions.push({ turn, action: "(hurt in this room)", damageTaken: amount });
  }
}

// ---------------------------------------------------------------------------
// RESOLUTION, READ OFF WHAT THE COMMIT DID
// ---------------------------------------------------------------------------

/**
 * Which challenges this commit resolved, and how.
 *
 * NO MODEL JUDGEMENT ANYWHERE IN HERE. Every case is a difference between the
 * world before the commit and the world after it, or an event the applier
 * raised on its own:
 *
 *   a creature      `creature-slain`, which the applier raises at zero HP
 *   a blocked way   its `conditional` is gone — the way is open
 *   a concealed way `isHidden` is gone — it has been found
 *   a hazard        `resolved` set on the hazard's feature
 *   an obstacle     likewise, which is what `resolved` was whitelisted for
 *   the objective   `goalMet` latched
 *
 * The creature that was talked down, driven off or slipped past is deliberately
 * NOT here. It leaves no trace in the world to read, and guessing at one is how
 * a player gets credited for fleeing. It is inferred at the tally instead.
 */
export function resolutionsFrom(
  before: World,
  after: World,
  events: readonly WorldEvent[],
  challenges: readonly Challenge[]
): Array<{ challengeId: string; resolution: NonNullable<LedgerEntry["resolution"]> }> {
  const out: Array<{ challengeId: string; resolution: NonNullable<LedgerEntry["resolution"]> }> = [];

  const slain = new Set(events.filter((e) => e.kind === "creature-slain").map((e) => e.entityId));

  const connBefore = new Map(before.entities.connectors.map((c) => [c.id, c]));
  const featBefore = new Map(before.entities.features.map((f) => [f.id, f]));
  const featAfter = new Map(after.entities.features.map((f) => [f.id, f]));
  const hazAfter = new Map(after.entities.hazards.map((h) => [h.id, h]));

  for (const c of challenges) {
    const anchor = anchorOf(c, after.entities);
    if (!anchor) continue;

    switch (c.kind) {
      case "creature-weakness":
      case "creature-ability":
      case "npc-liability":
      case "npc-asset":
        // EVERY body of it. A weakness true of the pack is answered when the
        // pack is dead, not when one of six entities is.
        if (anchor.entityIds.length > 0 && anchor.entityIds.every((id) => slain.has(id))) {
          out.push({ challengeId: c.id, resolution: "slain" });
        }
        break;

      case "blocked-way": {
        const was = connBefore.get(c.targetId);
        const now = after.entities.connectors.find((x) => x.id === c.targetId);
        if (was?.conditional !== undefined && now !== undefined && now.conditional === undefined) {
          out.push({ challengeId: c.id, resolution: "cleared" });
        }
        break;
      }

      case "concealed-way": {
        const was = connBefore.get(c.targetId);
        const now = after.entities.connectors.find((x) => x.id === c.targetId);
        if (was?.isHidden === true && now !== undefined && now.isHidden !== true && !isSurfaceExit(now)) {
          out.push({ challengeId: c.id, resolution: "found" });
        }
        break;
      }

      case "hazard": {
        // A hazard's own entity carries no resolved flag — `resolved` lives on
        // room features, which is where the whitelist put it. A trap that was
        // disarmed is a feature of the room marked so; a hazard entity that has
        // been removed from the world entirely counts too.
        const gone = anchor.entityIds.some((id) => !hazAfter.has(id));
        const disarmed = anchor.entityIds.some((id) => featAfter.get(id)?.resolved === true);
        if (gone || disarmed) out.push({ challengeId: c.id, resolution: "disabled" });
        break;
      }

      case "obstacle": {
        const newly = anchor.entityIds.some(
          (id) => featBefore.get(id)?.resolved !== true && featAfter.get(id)?.resolved === true
        );
        if (newly) out.push({ challengeId: c.id, resolution: "disabled" });
        break;
      }

      case "goal-location":
      case "goal-property":
        // Finding the objective is the arrival, which `noteArrival` records.
        // COMPLETING it is `goalMet`, and only the latch counts.
        if (!before.goalMet && after.goalMet) {
          out.push({ challengeId: c.id, resolution: "completed" });
        }
        break;

      case "region":
        // A region is answered by being MAPPED, not by anything done in it.
        // `applyDraw` records that directly.
        break;
    }
  }
  return out;
}

/** Write resolutions into the ledger. Idempotent: the first one is the one that counts. */
export function noteResolutions(
  cs: ChallengeState,
  challenges: readonly Challenge[],
  found: ReturnType<typeof resolutionsFrom>,
  turn: number
): void {
  for (const { challengeId, resolution } of found) {
    const c = challenges.find((x) => x.id === challengeId);
    if (!c) continue;
    const e = entryFor(cs, c);
    if (e.resolvedTurn !== undefined) continue;
    e.resolvedTurn = turn;
    e.resolution = resolution;
    e.metTurn ??= turn;
  }
}

// ---------------------------------------------------------------------------
// THE DRAW
// ---------------------------------------------------------------------------

/** One thing the game master may hand over this turn. */
export interface DrawOffer {
  challengeId: string;
  /** how it would reach the player */
  kind: "information" | "object";
  /** the mechanical fact, verbatim. The game master writes the fiction around it. */
  fact: string;
  /** what the fact is about, in words */
  about: string;
  /** the room the challenge is in — the prompt prefers something nearby */
  roomId: string;
  /** true when the challenge is in the room the player is standing in */
  here: boolean;
}

/**
 * What may be drawn right now.
 *
 * A challenge is offered when it has a reserve entry, has not already been
 * drawn, and has not already been resolved — there is nothing to learn about a
 * door you have already opened.
 *
 * THE LIST IS TRIMMED IN CODE, NOT BY THE PROMPT. Thirty offers is a wall of
 * text on every turn that could conceivably produce one, so same-room challenges
 * come first and the rest are capped. If the choices come out weird, this
 * function is the place to lean on it — the spec is explicit that the fallback
 * is trimming the list rather than moving the choice.
 */
export function offerDraws(
  cs: ChallengeState,
  challenges: readonly Challenge[],
  reserve: readonly ReserveEntry[],
  currentRoomId: string,
  labels: Record<ChallengeKind, string>,
  limit = 8
): DrawOffer[] {
  const drawn = new Set(cs.drawn.map((d) => d.challengeId));
  const resolved = new Set(
    cs.ledger.filter((e) => e.resolvedTurn !== undefined).map((e) => e.challengeId)
  );

  const offers: DrawOffer[] = [];
  for (const entry of reserve) {
    if (drawn.has(entry.challengeId) || resolved.has(entry.challengeId)) continue;
    const c = challenges.find((x) => x.id === entry.challengeId);
    if (!c) continue;
    offers.push({
      challengeId: c.id,
      kind: entry.kind,
      fact: entry.fact,
      about: labels[c.kind],
      roomId: c.roomId,
      here: c.roomId === currentRoomId,
    });
  }

  // Nearby first, and otherwise in the reserve's own order, which is the
  // enumeration order and so stable for a seed.
  offers.sort((a, b) => Number(b.here) - Number(a.here));
  return offers.slice(0, limit);
}

export interface DrawRequest {
  challengeId: string;
  /** where the object went, when the draw minted one */
  entityId?: string;
}

export type DrawOutcome = { ok: true; drawn: DrawnKey } | { ok: false; reason: string };

/**
 * Spend a reserve entry.
 *
 * REFUSES ANYTHING NOT ON THE LIST. An id that is not in the reserve, one
 * already drawn, or one whose challenge is already resolved — all three are the
 * game master handing out something the dungeon did not have to give, and all three
 * are refused rather than warned about.
 */
export function applyDraw(
  cs: ChallengeState,
  challenges: readonly Challenge[],
  reserve: readonly ReserveEntry[],
  req: DrawRequest,
  turn: number
): DrawOutcome {
  const entry = reserve.find((e) => e.challengeId === req.challengeId);
  if (!entry) return { ok: false, reason: `no reserve entry for challenge ${req.challengeId}` };
  if (cs.drawn.some((d) => d.challengeId === req.challengeId)) {
    return { ok: false, reason: `that has already been drawn` };
  }
  const led = cs.ledger.find((e) => e.challengeId === req.challengeId);
  if (led?.resolvedTurn !== undefined) {
    return { ok: false, reason: `that challenge is already resolved; there is nothing left to learn` };
  }
  const c = challenges.find((x) => x.id === req.challengeId);
  if (!c) return { ok: false, reason: `no such challenge: ${req.challengeId}` };

  const drawn: DrawnKey = {
    challengeId: c.id,
    turn,
    kind: entry.kind,
    ...(req.entityId !== undefined ? { entityId: req.entityId } : {}),
  };
  cs.drawn.push(drawn);

  // A REGION KEY IS A MAP, and drawing it is the whole of its effect: the rooms
  // it covers go onto the chart and nothing else in the dungeon changes.
  //
  // MAPPED IS NOT VISITED. The rooms are drawn from `base` — what the chart
  // recorded — and `travel.ts` is untouched, so `shortestPath` keeps refusing
  // them. A player does not get to walk through a room they have never entered
  // because they read about it.
  if (c.kind === "region") {
    for (const roomId of c.roomIds ?? [c.roomId]) {
      if (!cs.mapped.includes(roomId)) cs.mapped.push(roomId);
    }
    const e = entryFor(cs, c);
    e.resolvedTurn ??= turn;
    e.resolution ??= "found";
  }

  return { ok: true, drawn };
}

// ---------------------------------------------------------------------------
// THE RECORD
// ---------------------------------------------------------------------------

export type RecordOutcome =
  | { ok: true; wrote: Array<{ entityId: string; state: string }> }
  | { ok: false; reason: string };

/**
 * Write what a key revealed onto the thing it is true of.
 *
 * THE FACT IS A FACT ABOUT THE WORLD. A journal saying the ghoul is driven back
 * by chimes means the ghoul IS driven back by chimes — so it goes on the ghoul,
 * worded as the fact and nothing else, at the precision of the property it
 * answers. Exact wording is the entire point: it is what stops the fact drifting
 * between calls, which is why the value written is the challenge's `property`
 * rather than anything the game master typed.
 *
 * It goes in `state`, which is already writable on every entity kind and already
 * marks `needUpdate` — so the target's description is rewritten to account for
 * the newly-known fact the next time the player is in front of it. That the fact
 * then reaches `composed` and so the player is not a leak: they are the one who
 * just learned it.
 *
 * THE FAN-OUT IS DELIBERATE. `state` is per-entity and a rolled weakness lives on
 * the group's template, so one ghoul learning it would leave the other eleven
 * unmarked. Every entity the challenge anchors to gets the same line — the spec
 * names this as the fix if the single-entity version bit, and writing it now
 * costs one loop.
 */
export function recordFact(
  world: World,
  challenges: readonly Challenge[],
  challengeId: string,
  cs: ChallengeState
): RecordOutcome {
  const c = challenges.find((x) => x.id === challengeId);
  if (!c) return { ok: false, reason: `no such challenge: ${challengeId}` };

  const anchor = anchorOf(c, world.entities);
  if (!anchor || anchor.entityIds.length === 0) {
    return { ok: false, reason: `challenge ${challengeId} is about nothing that exists` };
  }

  const wrote: Array<{ entityId: string; state: string }> = [];
  for (const id of anchor.entityIds) {
    const target = findEntity(world.entities, id);
    if (!target) continue;
    const line = factLine(c);
    // Appended rather than replaced: `state` is what is true of the thing NOW,
    // and a creature that is bleeding and has a known weakness is both.
    const existing = target.state?.trim();
    if (existing !== undefined && existing !== "" && existing.includes(line)) continue;
    target.state = existing ? `${existing} ${line}` : line;
    wrote.push({ entityId: id, state: target.state });
  }

  if (!cs.known.includes(challengeId)) cs.known.push(challengeId);
  return { ok: true, wrote };
}

/**
 * The fact, worded as a fact and nothing else.
 *
 * Prefixed by what KIND of property it is, because "Bells" written bare onto a
 * ghoul says nothing — the precision the spec asks for is the property's own
 * precision, and the property is "its weakness is Bells".
 */
function factLine(c: Challenge): string {
  switch (c.kind) {
    case "creature-weakness":
      return `Known weakness: ${c.property}.`;
    case "creature-ability":
      return `Known ability: ${c.property}.`;
    case "npc-liability":
      return `Known liability: ${c.property}.`;
    case "npc-asset":
      return `Known asset: ${c.property}.`;
    case "blocked-way":
    case "concealed-way":
      return `Known: ${c.property}.`;
    case "hazard":
      return `Known hazard: ${c.property}.`;
    case "obstacle":
      return `Known about this: ${c.property}.`;
    case "region":
      return `Mapped: ${c.property}.`;
    case "goal-location":
      return `Known: ${c.property}.`;
    case "goal-property":
      return `Known of the objective: ${c.property}.`;
  }
}

function findEntity(ep: EntityPassResult, id: string) {
  return (
    ep.creatures.find((e) => e.id === id) ??
    ep.connectors.find((e) => e.id === id) ??
    ep.features.find((e) => e.id === id) ??
    ep.hazards.find((e) => e.id === id) ??
    ep.rooms.find((e) => e.id === id) ??
    ep.items.find((e) => e.id === id)
  );
}

// ---------------------------------------------------------------------------
// BYPASS, INFERRED
// ---------------------------------------------------------------------------

/**
 * Creatures the player got past without leaving a mark on the world.
 *
 * TWO TIMESTAMPS, COMPARED ONCE, AT THE END. A creature is bested if the player
 * met it and then achieved something AFTERWARDS — completed the objective, or
 * resolved any other challenge. Talked down, deceived, driven off and slipped
 * past all look identical from here, and all of them are worth the same, so
 * there is nothing to tell apart.
 *
 * It correctly refuses to credit a creature the player fled and never got past:
 * fleeing produces no later accomplishment to point at.
 *
 * Judging this at the tally rather than in the turn is what keeps the model out
 * of it entirely — there is no per-turn detection to get wrong, and no prompt
 * asking anyone whether that counted.
 */
export function bestedByBypass(cs: ChallengeState): string[] {
  const resolvedTurns = cs.ledger
    .filter((e) => e.resolvedTurn !== undefined)
    .map((e) => e.resolvedTurn!);
  if (resolvedTurns.length === 0) return [];

  const out: string[] = [];
  for (const e of cs.ledger) {
    if (e.resolvedTurn !== undefined || e.metTurn === undefined) continue;
    if (!CREATURE_KINDS.includes(e.kind)) continue;
    // Something was accomplished after they met it. Strictly after: a challenge
    // resolved on the same turn they walked in is not evidence they got past
    // anything.
    if (resolvedTurns.some((t) => t > e.metTurn!)) out.push(e.challengeId);
  }
  return out;
}

const CREATURE_KINDS: readonly ChallengeKind[] = [
  "creature-weakness",
  "creature-ability",
  "npc-liability",
  "npc-asset",
];

// ---------------------------------------------------------------------------
// THE ALLOWANCE
// ---------------------------------------------------------------------------

/**
 * What a single grant can be worth, before the remaining allowance caps it.
 *
 * A band rather than a fraction, so that an early grant cannot swallow the whole
 * allowance and a late one is not reduced to three coppers. The last grant takes
 * whatever is left, which is how the pot stays exactly conserved.
 */
const GRANT_BAND: readonly [number, number] = [10, 60];

export type GrantOutcome = { ok: true; amount: number } | { ok: false; reason: string };

/**
 * Hand over coin out of the dungeon's allowance.
 *
 * THE AMOUNT IS ROLLED HERE, from the run's own seed, because the model does not
 * write numbers and a game master inventing them is how a dungeon's total take stops
 * being a number anybody chose. The 10% held back at generation is the whole of
 * what play may give away, and when it is gone it is gone.
 *
 * Seeded on the run seed and the turn, so a reload lands on the same figure.
 */
export function grantCoin(
  world: World,
  cs: ChallengeState,
  turn: number
): GrantOutcome {
  if (cs.allowanceLeft <= 0) {
    return { ok: false, reason: `this dungeon has no loose coin left to find` };
  }
  const rng = new Rng(world.runSeed + 7919 * (turn + 1));
  // NEVER MORE THAN HALF OF WHAT IS LEFT. A size 2 dungeon's whole allowance is
  // 50-80cp, so a flat band would hand the lot over on the first grant and
  // answer no forever after -- which reads as the dungeon being broken rather
  // than being finite. Halving converges instead: several diminishing finds,
  // and the last one closes the account.
  const ceiling = Math.max(GRANT_BAND[0], Math.floor(cs.allowanceLeft / 2));
  const rolled = rng.range(GRANT_BAND[0], Math.min(GRANT_BAND[1], ceiling));
  // The last grant takes the remainder rather than leaving an unspendable
  // stub behind, which is what keeps the pot exactly conserved.
  const amount = cs.allowanceLeft - rolled < GRANT_BAND[0] ? cs.allowanceLeft : rolled;

  setPurse(world.pc, purse(world.pc) + amount);
  cs.allowanceLeft -= amount;
  return { ok: true, amount };
}
