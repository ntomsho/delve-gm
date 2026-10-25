/**
 * Challenges: what a dungeon asks of the player, and what a run has done about
 * them. See docs/ARCHITECTURE.md section 8.
 *
 * This file holds only the types. Generation builds the challenges and the
 * reserve (`src/generation/content/challenges.ts` and `rewards.ts`). During
 * play, `src/gameplay/mechanics/challenges.ts` keeps the ledger, and the
 * end-of-run tally reads it. The types are in `shared/` because `World` in
 * `src/shared/types/commit.ts` holds all three.
 */

import type { Rolled } from "../utils/rng.ts";

/**
 * The kinds of challenge. Each names a kind of thing and the property of it
 * that a key can answer, such as a creature's weakness or a blocked way.
 *
 * `goal-property` challenges are not created with the others in
 * `src/generation/content/challenges.ts`. The content pass decides what the
 * goal is (`GoalDirective` doesn't fix its entity type), so its properties
 * aren't known until that pass has run. The keys pass
 * (`src/generation/content/passes/keys-pass.ts`) creates them afterwards.
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
  /** built from the target and the property's position, so regenerating from the same seed gives the same id */
  id: string;
  kind: ChallengeKind;
  target: ChallengeTarget;
  /**
   * The id from stocking (the generation step that fills rooms): a
   * `MobileEntity.id`, a `StockedConnector.id` or a `RoomStock.roomId`. For a
   * chunk target it is the chunk number as a string, and `chunk` holds the
   * number too.
   */
  targetId: string;
  /**
   * The room where the player meets it. For a way between rooms, this is the
   * end nearer the entrance, the side the player arrives from. For a region,
   * it is the room in the chunk nearest the entrance.
   */
  roomId: string;
  /** set on region challenges only */
  chunk?: number;
  /**
   * Region challenges only: every room the region's chart covers.
   *
   * Stored here because nothing at play time can work it out. The chunk map
   * (`RoomStock`) only exists during generation, and runtime entities don't
   * record which chunk they came from. When the region key is drawn,
   * `ChallengeState.mapped` is filled from this list.
   */
  roomIds?: string[];
  /**
   * The rolled fact a key answers, word for word: the weakness, the ability,
   * the liability, the hazard, the puzzle's subject. The exact wording matters:
   * a drawn key repeats it, which keeps the fact the same from one model call
   * to the next.
   */
  property: Rolled;
}

/**
 * A challenge whose key wasn't placed in a room, kept so the game master can
 * hand it out during play (`Commit.draw`).
 *
 * It holds only the fact, no prose. The game master writes the key when it is
 * drawn, in a form that fits what the player is doing: something an NPC says
 * in conversation, an object in the cabinet they're searching.
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
  /** what the player did, as they typed it, not the narration */
  action: string;
  roll?: { kind: string; total: number; success: boolean };
  /** hit points lost this turn, if any. The tally counts risk taken when it awards experience. */
  damageTaken?: number;
}

/**
 * Everything the run has recorded about one challenge.
 *
 * `metTurn` lets the tally tell when a challenge was bypassed. If the player
 * met a creature on turn 4, never dealt with it, and reached the goal on turn
 * 20, they got past it somehow and get credit. If they met it, fled, and never
 * achieved anything beyond it, they get none.
 */
export interface LedgerEntry {
  challengeId: string;
  kind: ChallengeKind;
  /** the turn the player was first in the same room as it */
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
  /** the entity created for it, when the key was a physical object */
  entityId?: string;
}

/**
 * Everything the run records about its challenges.
 *
 * This is saved as part of the run, not written to the journal. The journal is
 * a debugging record that by default writes nowhere (`NO_JOURNAL`), so the tally can't
 * rely on it, and the tally is what this record is for.
 */
export interface ChallengeState {
  drawn: DrawnKey[];
  /** challenge ids whose fact the player has been told, in the order told */
  known: string[];
  /**
   * Rooms a region key put on the map. Only the map display reads this; the
   * player still can't travel to a room they have never entered.
   */
  mapped: string[];
  ledger: LedgerEntry[];
  /** copper left in the coin allowance (10% of the dungeon's wealth, held back at generation) */
  allowanceLeft: number;
}
