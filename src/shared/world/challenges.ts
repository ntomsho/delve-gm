/**
 * CHALLENGES: what a dungeon asks of the player, and what a run has done about it.
 *
 * The shapes only. Generation builds the challenges and the reserve
 * (`generation/content/challenges.ts`, `rewards.ts`); play keeps the ledger
 * (`gameplay/mechanics/challenges.ts`); the tally reads it. They live here
 * because the world a diff can touch (`shared/types/commit.ts`) holds all three.
 */

import type { Rolled } from "../utils/rng.ts";

/**
 * One row of the table in the spec. Each names a source and the property on it
 * that a key can answer.
 *
 * `goal-property` is DECLARED BUT NOT ENUMERATED HERE. The goal's form is the
 * content pass's call -- `GoalDirective` deliberately does not pick an entity
 * type -- so its keyable properties do not exist until that pass has run, and
 * the keys pass is the first point at which they can be minted. The member is
 * here so that everything reading a challenge already handles the kind.
 */
export type ChallengeKind =
  | "creature-weakness"
  | "creature-ability"
  | "npc-liability"
  | "npc-asset"
  | "blocked-way"
  | "concealed-way"
  | "hazard"
  | "obstacle"
  | "region"
  | "goal-location"
  | "goal-property";

/** Which kind of stocking-level thing `targetId` names. */
export type ChallengeTarget = "mobile" | "connector" | "room" | "chunk";

export interface Challenge {
  /** derived from target and property position; stable across regeneration */
  id: string;
  kind: ChallengeKind;
  target: ChallengeTarget;
  /**
   * The stocking-level id: a `MobileEntity.id`, a `StockedConnector.id`, or a
   * `RoomStock.roomId`. Chunk targets carry the chunk number as a string and
   * `chunk` alongside it.
   */
  targetId: string;
  /**
   * Where the player meets it. For a way, the SHALLOWER endpoint -- the side
   * they arrive from. For a region, the shallowest room in the chunk.
   */
  roomId: string;
  /** set on region challenges only */
  chunk?: number;
  /**
   * Region challenges only: every room the chart covers.
   *
   * Carried on the challenge rather than looked up later because by the time a
   * region key is drawn there is nothing left holding the chunk map — `RoomStock`
   * belongs to generation and the runtime world has entities, which do not know
   * which chunk they were written in. It is one array on one challenge per
   * region, and it is what `mapped` is filled from.
   */
  roomIds?: string[];
  /**
   * The rolled fact being keyed, verbatim: the weakness, the ability, the
   * liability, the hazard, the puzzle's subject. Exact wording matters -- it is
   * what a drawn key restates and what stops the fact drifting between calls.
   */
  property: Rolled;
}

/**
 * A challenge with no placed key, held for a draw in play.
 *
 * PURE GENERATION DATA. No prose -- a reserve entry is written only when it is
 * drawn, so its form can match what the player is doing at the moment they get
 * it: information from an NPC mid-conversation, an object in the cabinet they
 * are searching.
 */
export interface ReserveEntry {
  challengeId: string;
  /** how a draw would reach the player */
  kind: "information" | "object";
  /** the mechanical fact, verbatim from the challenge */
  fact: Rolled;
}

/** One thing the player did with a challenge in front of them. */
export interface LedgerAction {
  turn: number;
  /** what they did, in their own words — the action line, not a narration */
  action: string;
  roll?: { kind: string; total: number; success: boolean };
  /** hit points lost on this turn, if any. Risk is what the tally prices. */
  damageTaken?: number;
}

/**
 * A challenge's whole history.
 *
 * `metTurn` is what makes bypass inferable: a creature the player met on turn 4
 * and never resolved, who then reached the goal on turn 20, got past it
 * somehow. A creature they met and fled from and never got past has no later
 * accomplishment to point at, and is correctly not credited.
 */
export interface LedgerEntry {
  challengeId: string;
  kind: ChallengeKind;
  /** the turn the player was first in the room with it */
  metTurn?: number;
  /** the turn it was resolved outright, if it was */
  resolvedTurn?: number;
  /** how it was resolved, for the tally to read */
  resolution?: "slain" | "cleared" | "found" | "disabled" | "completed";
  actions: LedgerAction[];
}

/** A reserve entry that has been spent. */
export interface DrawnKey {
  challengeId: string;
  turn: number;
  kind: "information" | "object";
  /** the entity minted for it, when the draw put it in the world as a thing */
  entityId?: string;
}

/**
 * Everything the run accumulates about its challenges.
 *
 * FIRST-CLASS RUN STATE, not the journal. The journal defaults to no sink and is
 * explicitly shaped for nobody, so the tally could not read from it — and the
 * tally is the whole reason any of this is written down.
 */
export interface ChallengeState {
  drawn: DrawnKey[];
  /** challenge ids whose fact the player has been told, in the order told */
  known: string[];
  /** rooms a region key put on the map. DISPLAY ONLY — see `mapped` in the spec */
  mapped: string[];
  ledger: LedgerEntry[];
  /** what is left of the 10% held out of the pot, in copper */
  allowanceLeft: number;
}
