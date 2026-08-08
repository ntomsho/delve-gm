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

import type { EntityPassResult, PlayerCharacter } from "../../engine/index.ts";
import type { RollSpec, Stage, Step } from "../types.ts";

export interface Diff {
  /** an existing entity id, "player", or a `ref` created earlier in this commit */
  entityId: string;
  /** e.g. "state", "hp.current", "inventory[1]", "equipped.shield", "children[]" */
  path: string;
  value: unknown;
}

export interface Commit {
  nextStage: Stage;
  nextStep: Step;
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
    /** a walk ended short of where it was aimed — `detail` says what stopped it */
    | "movement-stopped"
    /** the objective was accomplished this turn; the run is not over yet */
    | "goal-met";
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
}
