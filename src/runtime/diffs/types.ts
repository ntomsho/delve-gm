/**
 * THE COMMIT
 *
 * One uniform diff shape. The referee states what is now TRUE — a destination
 * value — and the applier works out what that means and does it properly.
 *
 *   { entityId: "<player>", path: "inventory[1]", value: null }
 *
 * says the second carried thing is no longer in hand. The applier clears the
 * slot, closes the gap, drops any equipment slot pointing at it, and reparents
 * the item to the room the player is standing in. Four consequences, one stated
 * fact. Putting that logic here rather than in the prompt means it is tested
 * rather than merely instructed.
 */

import type {
  Challenge,
  EntityPassResult,
  PlayerCharacter,
  ReserveEntry,
} from "../../engine/index.ts";
import type { ChallengeState } from "../challenges.ts";
import type { RollSpec, Stage, Step } from "../types.ts";

export interface Diff {
  /** an existing entity id, "player", or a `ref` created earlier in this commit */
  entityId: string;
  /** e.g. "state", "hp.current", "inventory[1]", "equipped.shield", "children[]" */
  path: string;
  value: unknown;
}

/**
 * HOW LONG THE PLAYER'S ACTION TOOK — AND THERE IS NO CLOCK.
 *
 * The obvious shape was a number of minutes, because "rest for the night" and
 * "swing a sword" plainly differ and a number is how you say so. But nothing in
 * this game consumes elapsed time — light and rations are prototype non-goals —
 * so the number would exist to be read back by the thing that wrote it. `RunState`
 * gains no `elapsedMinutes` and `turnCount` stays what it is: closed turns.
 *
 * What the difference is actually FOR is deciding which creatures get to act
 * while the player was busy. That is a scope selector, not a quantity, so it is
 * typed as one:
 *
 *   instant  a glance, a word, drawing a blade — nobody moves
 *   round    ≤10s, one exchange — the alerted move a room
 *   short    up to an hour, searching or picking a lock — likewise
 *   long     a night's rest — anything may go anywhere it likes
 *
 * The applier reads exactly one thing off it: whether `approach` advances. See
 * the sweep at the foot of `applyCommit`.
 *
 * `long` is unsayable until the Rest button exists (Phase 16) and is refused in
 * `referee.ts` until then. It ships anyway, because the alternative is touching
 * the schema, two step files and the tests a second time for nothing.
 */
export type TimeSpent = "instant" | "round" | "short" | "long";

export interface Commit {
  nextStage: Stage;
  nextStep: Step;
  /**
   * What the turn cost in time, and so who else got to move. Required: a commit
   * that did not say is a commit the applier would have to guess for, and the
   * guess would be wrong in whichever direction mattered.
   */
  timeSpent: TimeSpent;
  /** present iff nextStage === "roll_offered" */
  rollRequest?: RollSpec;
  /** MUST be empty when nextStage is "clarifying" or "rejected" */
  diffs: Diff[];
  /**
   * The dungeon's objective has been accomplished. A LATCH: once true it stays
   * true, so a referee that stops mentioning it cannot take the win back.
   *
   * Not a stage, because accomplishing the goal does not end the run — walking
   * out with it does, and the two can be many turns apart. Not a diff either: it
   * is a fact about the RUN rather than about anything in the world.
   */
  goalMet?: boolean;
  /**
   * Something the turn established about the DUNGEON — not about any one thing
   * in it. Why the cells were dug, who the carvings are of, what the miners
   * were actually down here for.
   *
   * Prose written during play adds to the story of the place, and without this
   * it is gone by the turn after next: the transcript is cleared when the action
   * closes, the records carry two turns, and an entity's `state` can only hold
   * what is true of that entity. So a fact about the whole place has nowhere to
   * live, and the referee invents the history again, differently, three rooms
   * later.
   *
   * Appended to the run's fiction, never merged into `dungeonContext` — that was
   * written before play and stays as written, the way a `base` does.
   */
  fictionNote?: string;
  /**
   * A CHALLENGE ANSWERED OUT OF THE RESERVE.
   *
   * The dungeon places about four keys and holds thirty in reserve, because a
   * key written into a room before play cannot be about what the player turned
   * out to be doing. This is the other thirty: the referee names one challenge
   * the reserve still holds, and the applier spends it.
   *
   * A GRANT MUST BE JUSTIFIED BY THE ACTION THAT EARNED IT — found in the rubble
   * they were digging through, given by the thing they talked down, carried by
   * the thing they killed. An object that simply appears in a room they have
   * already searched is the same broken promise as an invented ledge. The
   * applier cannot check that; the playbook asks for it and the offer list is
   * weighted to make it easy.
   *
   * `entityRef` names an entity created by a `children[]` diff in this same
   * commit, for a draw that put a physical thing in the world. Information
   * draws leave it unset: what the player got was told to them.
   */
  draw?: { challengeId: string; entityRef?: string };
  /**
   * Challenges whose fact the player now KNOWS.
   *
   * Separate from the draw because the two are separate events: a key drawn
   * this turn is usually read this turn, but a key placed during generation was
   * picked up three rooms ago and is being read now. Both end in the same place
   * — the fact written onto the thing it is true of, in the exact words the
   * dungeon rolled. See `recordFact`.
   */
  learned?: string[];
  /**
   * The player found money.
   *
   * THE REFEREE SAYS THAT THEY DID; CODE SAYS HOW MUCH. A dungeon's wealth is a
   * conserved pot settled at generation, and 10% of it is held back for exactly
   * this — coin handed over in play, when the fiction puts some in front of
   * them. `why` is one line for the record and is not spent on anything else.
   *
   * Refused when the allowance is spent: the dungeon does not have infinite
   * money and a referee cannot mint any.
   */
  coinGrant?: { why: string };
}

/** The id the referee uses for the player character. */
export const PLAYER_ID = "player";

/**
 * A newly established thing — the keyring on the guard's belt. Created by
 * appending to a holder's `children[]`.
 *
 * `ref` is optional and exists so later diffs in the SAME commit can address
 * the new entity: the referee cannot know the id, because the applier mints it.
 */
export interface EntitySpec {
  type: "Item" | "RoomFeature";
  name: string;
  /** its fixed identity — what it is, with nothing in it that will stop being true */
  base: string;
  /** its current condition, if the player is looking at it now */
  state?: string;
  /** Item only */
  slots?: number;
  amount?: string;
  hidden?: boolean;
  /** address it from a later diff in this same commit */
  ref?: string;
}

// ---------------------------------------------------------------------------
// RESULT
// ---------------------------------------------------------------------------

export interface Rejection {
  diff: Diff;
  reason: string;
}

/**
 * Consequences the referee did not state but the applier performed — an item
 * destroyed at zero quality, a creature slain, armour that fell off because it
 * became illegal. The narration should be able to acknowledge these, and the
 * retry prompt should be able to mention them.
 */
export interface WorldEvent {
  kind:
    | "item-destroyed"
    | "creature-slain"
    | "unequipped"
    | "overburdened"
    | "player-died"
    | "entity-created"
    /** a book gave up the last of what it had — the reading still happened */
    | "book-exhausted"
    /** a walk ended short of where it was aimed — `detail` says what stopped it */
    | "movement-stopped"
    /** the objective was accomplished this turn; the run is not over yet */
    | "goal-met"
    /** a reserve entry was spent — `detail` is the fact that was handed over */
    | "key-drawn"
    /** a fact was written onto the thing it is true of — `entityId` is that thing */
    | "fact-recorded"
    /** a challenge was resolved outright — `detail` says how */
    | "challenge-resolved"
    /** coin came out of the dungeon's allowance — `detail` is the amount */
    | "coin-granted";
  entityId: string;
  detail: string;
}

export interface ApplyResult {
  /** false means NOTHING was applied — the batch is atomic */
  ok: boolean;
  applied: Diff[];
  rejected: Rejection[];
  events: WorldEvent[];
}

/** Everything a diff can touch. */
export interface World {
  entities: EntityPassResult;
  pc: PlayerCharacter;
  /** where the player is standing — dropped things land here */
  currentRoomId: string;
  /**
   * The way they came in by: the last connector the walk actually crossed.
   *
   * Written by the applier rather than by the referee, because the applier is
   * what routes the walk and so is the only thing that knows which of several
   * ways into a room was used. Absent only before the first move.
   */
  arrivedVia?: string;
  /** the objective is done; what makes walking out a win rather than an escape */
  goalMet: boolean;
  /**
   * What play has added to the story of the place, oldest first. Appended by
   * `fictionNote`, never rewritten — this is a record of what the game has
   * already told the player, and editing it is going back on it.
   */
  fiction: string[];
  /**
   * What this dungeon asks, and what is left to be given out. Both are
   * GENERATION DATA and neither is written here — the challenges are fixed when
   * the dungeon is stocked, and a reserve entry is spent by recording the draw
   * rather than by removing the entry.
   */
  challenges: readonly Challenge[];
  reserve: readonly ReserveEntry[];
  /** what the run has accumulated about them; the one part of this that changes */
  challengeState: ChallengeState;
  /** which turn this is, for the ledger */
  turn: number;
  /**
   * The run's seed, for the one thing in here that needs randomness: how much
   * coin a grant is worth. The model never writes a number, so somebody has to
   * roll it, and it has to be the same number on a replay.
   */
  runSeed: number;
}
