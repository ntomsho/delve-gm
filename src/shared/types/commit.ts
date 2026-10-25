/**
 * The commit: what the game master sends back at the end of a turn.
 *
 * Every change to the world is a `Diff` of the same shape. A diff states the
 * value something should now have, not the steps to get there, and the applier
 * (`src/gameplay/diffs/apply.ts`) works out the consequences. For example,
 *
 *   { entityId: "player", path: "inventory[1]", value: null }
 *
 * says the player is no longer carrying their second item. The applier removes
 * it from the inventory, closes the gap, unequips it if it was equipped, and
 * puts it on the floor of the room the player is in. Doing that in code rather
 * than asking for it in the prompt means it is tested, not just requested.
 */

import type { Challenge } from "../world/challenges.ts";
import type { EntityPassResult } from "../world/entities.ts";
import type { PlayerCharacter } from "../../rules/knave/character.ts";
import type { ReserveEntry } from "../world/challenges.ts";
import type { ChallengeState } from "../world/challenges.ts";
import type { RollSpec, Stage, Step } from "./turn.ts";

export interface Diff {
  /** an existing entity id, "player", or a `ref` created earlier in this commit */
  entityId: string;
  /** e.g. "state", "hp.current", "inventory[1]", "equipped.shield", "children[]" */
  path: string;
  value: unknown;
}

/**
 * Roughly how long the player's action took.
 *
 * A category, not a number of minutes, because the game has no clock: nothing
 * uses up time (light and rations are not in the game), so a minute count would
 * only be read back by the game master that wrote it. What the category decides
 * is whether other creatures get to move while the player is busy:
 *
 *   instant  a glance, a word, drawing a blade: nobody moves
 *   round    up to 10 seconds, one exchange: approaching creatures move one room
 *   short    up to an hour, such as searching or picking a lock: the same
 *   long     a night's rest: anything may go anywhere
 *
 * The applier only checks whether it is `instant`. Anything else moves each
 * creature with an `approach` destination one room closer (`walkApproaching` in
 * `src/gameplay/diffs/apply.ts`).
 *
 * `long` is in the type but not usable yet. `timeNotSpent` in
 * `src/gameplay/game-master/game-master.ts` refuses it until resting exists
 * (docs/ROADMAP.md, "Rest"). It is defined now so that adding resting won't
 * mean changing the schema, the step files and the tests again.
 */
export type TimeSpent = "instant" | "round" | "short" | "long";

export interface Commit {
  nextStage: Stage;
  nextStep: Step;
  /**
   * How long the action took, which decides whether other creatures move. It is
   * required because the applier has no safe default: guessing too short lets
   * the player act for free, and guessing too long moves creatures that
   * shouldn't have moved.
   */
  timeSpent: TimeSpent;
  /** present iff nextStage === "roll_offered" */
  rollRequest?: RollSpec;
  /** MUST be empty when nextStage is "clarifying" or "rejected" */
  diffs: Diff[];
  /**
   * The player has achieved the dungeon's goal. Once set it stays set: a later
   * commit that leaves this out does not undo it.
   *
   * It is not a stage because achieving the goal does not end the run; leaving
   * the dungeon afterwards does, and that can be many turns later. It is not a
   * diff because it is a fact about the run, not about any entity.
   */
  goalMet?: boolean;
  /**
   * A fact this turn established about the dungeon as a whole, not about one
   * thing in it: why the cells were dug, who the carvings show, what the miners
   * were looking for.
   *
   * Without this, such a fact would be forgotten within a couple of turns. The
   * transcript is cleared when each action closes, only the last two turn
   * records are sent to the game master, and an entity's `state` only holds
   * facts about that entity. The game master would then make up a different
   * history a few rooms later.
   *
   * The note is added to the end of `World.fiction`. It never changes
   * `dungeonContext`, which was written at generation and, like an entity's
   * `base`, never changes.
   */
  fictionNote?: string;
  /**
   * Hands the player a key from the reserve.
   *
   * Generation places only some of a dungeon's keys in rooms and keeps the rest
   * in a reserve. A key placed before play can't respond to what the player
   * ends up doing; a reserve key can be given out when the moment fits. Here
   * the game master names a challenge the reserve still holds a key for, and
   * the applier spends that entry.
   *
   * The key has to come from what the player just did: found in the rubble
   * they were digging through, given by someone they talked round, carried by
   * a creature they killed. An object that just appears in a room they already
   * searched is as unfair as an invented ledge. The applier can't check this;
   * the prompt asks for it.
   *
   * `entityRef` is the `ref` of an entity created by a `children[]` diff in the
   * same commit, when the key is a physical object. It is left out when the key
   * is information the player was told.
   */
  draw?: { challengeId: string; entityRef?: string };
  /**
   * Ids of challenges whose key fact the player learned this turn.
   *
   * Separate from `draw` because getting a key and learning what it says can
   * happen on different turns. A key drawn this turn is usually read this turn,
   * but a key placed at generation may have been picked up rooms ago and read
   * only now. Either way the applier writes the fact, in the exact words
   * generation rolled, onto the entity it is about (`recordFact` in
   * `src/gameplay/mechanics/challenges.ts`).
   */
  learned?: string[];
  /**
   * The player found money.
   *
   * The game master says that they found some; code rolls how much. A
   * dungeon's total wealth is fixed at generation, and 10% of it is held back
   * as an allowance for coin found during play. `why` is a one-line reason
   * kept for the record; nothing else reads it.
   *
   * The applier refuses the grant once the allowance is used up, so the game
   * master can't create money.
   */
  coinGrant?: { why: string };
}

/** The id the game master uses for the player character. */
export const PLAYER_ID = "player";

/**
 * A new entity the game master introduces, such as the keyring on the guard's
 * belt. It is created by a diff that appends it to a holder's `children[]`.
 *
 * The applier assigns the new entity's id, so the game master can't know it.
 * To refer to the new entity in a later diff of the same commit, the game
 * master gives it a `ref` and uses that instead.
 */
export interface EntitySpec {
  type: "Item" | "RoomFeature";
  name: string;
  /** what it is, worded so that it stays true for the rest of the run */
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
 * Something that happened while applying a commit, usually a consequence the
 * game master didn't state: an item destroyed at zero quality, a creature
 * killed, armour unequipped because it could no longer be worn. They are
 * reported so the narration and the retry prompt can mention them.
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
  /** false means none of the diffs were applied: a commit applies whole or not at all */
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
   * The connector the player last walked through to reach this room.
   *
   * The applier sets this, not the game master, because the applier chooses the
   * route for a move and so is the only thing that knows which way into the
   * room was used. Unset until the player first moves.
   */
  arrivedVia?: string;
  /** the goal is achieved, so leaving the dungeon ends as `goal_met`, not `escaped` */
  goalMet: boolean;
  /**
   * Facts about the dungeon established during play, oldest first. Each
   * `Commit.fictionNote` adds one to the end. Entries are never edited, because
   * the player has already been told them.
   */
  fiction: string[];
  /**
   * The dungeon's challenges, and its reserve of keys not yet given out. Both
   * come from generation and the applier never changes them. Spending a reserve
   * entry is recorded in `challengeState`; the entry stays in this list.
   */
  challenges: readonly Challenge[];
  reserve: readonly ReserveEntry[];
  /** what the run has done about the challenges so far; unlike the two lists above, this changes */
  challengeState: ChallengeState;
  /** the current turn number, stamped on whatever `challengeState` records this turn */
  turn: number;
  /**
   * The run's seed. Used only to roll how much coin a `coinGrant` is worth. The
   * model never picks a number, so code rolls it, and seeding it from the run
   * means a replay rolls the same amount.
   */
  runSeed: number;
}
