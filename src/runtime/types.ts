/**
 * The two axes of where a turn is.
 *
 * `Stage` is what the PLAYER is being told — it drives the input area and
 * nothing else. `Step` is where the REFEREE is in the heuristic — it drives
 * which step files load into the next call.
 *
 * They are not the same shape and cannot be collapsed. One stage arises from
 * several steps (a rejection can come from step 1, step 2, or the information
 * handler) and one step produces several stages (step 4 can re-offer a roll,
 * ask for a clarification, cancel, or roll). Keeping them apart costs a field
 * and makes both well-defined.
 */

export type Stage =
  /** composing / narrating a newly entered room */
  | "room_entry"
  /** "What do you do?" */
  | "awaiting_action"
  /**
   * The action has been sent and the referee is working.
   *
   * Not in BUILD-PLAN §4.1, and needed because of the narration decision: prose
   * is held back until the commit validates and applies, so the player is not
   * watching text arrive. Without a stage for it the interface would have
   * nothing honest to show during the wait — and the wait is the normal case,
   * not the exception.
   */
  | "thinking"
  /** the referee needs the player to disambiguate or justify */
  | "clarifying"
  /** action turned away; no state changed */
  | "rejected"
  /** roll spec on the table; Roll button live */
  | "roll_offered"
  /** dice in flight — client-side, no model call */
  | "rolling"
  /** the referee is writing the outcome */
  | "resolving"
  /**
   * The call failed, or came back unusable twice. The player's text is kept so
   * a retry costs them nothing. Also not in BUILD-PLAN: a turn that cannot be
   * completed is a state the game can be in, and it is the software talking
   * rather than the referee.
   */
  | "error"
  | "dead"
  /**
   * The player walked out through a way to the surface.
   *
   * WRITTEN BY THE REFEREE, NEVER STORED. Which ending a departure is depends on
   * whether the goal was accomplished, and that is world state rather than
   * something the referee should be trusted to remember — so the store resolves
   * this into `goal_met` or `escaped` the moment the commit lands, the same way
   * hit points at zero override whatever came next. The player is never told
   * "departed"; they are told which one it was.
   */
  | "departed"
  /** out alive, without what they came for */
  | "escaped"
  /** out alive, with it */
  | "goal_met";

export type Step =
  | "1-target"
  | "2-classify"
  | "3-information"
  | "3-standard"
  | "4-confirm-roll"
  | "5-resolution"
  | "room-entry";

/**
 * Stages that end the run.
 *
 * `departed` is here because a referee that writes it has ended the run whatever
 * the store resolves it to, and anything asking `isTerminal` of a commit rather
 * than of stored state must get the same answer.
 */
export const TERMINAL_STAGES: readonly Stage[] = ["dead", "departed", "escaped", "goal_met"];

/**
 * Stages in which the world must not change. Enforced by the applier, not by
 * trusting the referee to have read the rule.
 */
export const NO_CHANGE_STAGES: readonly Stage[] = ["clarifying", "rejected"];

export function isTerminal(stage: Stage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

/** Stages where the game is working and the input area is closed. */
const BUSY_STAGES: readonly Stage[] = ["room_entry", "thinking", "rolling", "resolving"];

/** Whether the player can type right now. */
export function acceptsInput(stage: Stage): boolean {
  return !BUSY_STAGES.includes(stage) && !isTerminal(stage);
}

// ---------------------------------------------------------------------------
// ROLLS ON THE TABLE
// ---------------------------------------------------------------------------

import type { Ability, Edge } from "../engine/index.ts";

/**
 * What the player is being offered, and what the interface shows them. Carries
 * the terms of the bet and never the difficulty — no DC, no target defense.
 */
export interface RollSpec {
  kind: "save" | "attack" | "stunt";
  ability: Ability;
  bonus: number;
  edge: Edge;
  /** what they are attempting, in plain words */
  description: string;
  /** attacks: an inventory item id, a described object, or "unarmed" */
  weapon?: string;
  /** attacks: strike to hurt, or to attempt a stunt */
  mode?: "damage" | "stunt";
  /** attacks with advantage: spend it normally, or on stunt-and-damage */
  advantageUse?: "normal" | "stunt-and-damage";

  // --- referee-side, never rendered ---
  /**
   * The number to meet. Hidden from the player.
   *
   * ALREADY CONVERTED, for every kind. A save carries its DC straight; an
   * attack or a stunt carries `dcFromDefense(targetDefense)`, because whoever
   * offers the roll is the one holding the target's defense. So the machine
   * that rolls it needs only the bare contest — `checkRoll` — and the `+1`
   * stays in the one function that owns it.
   */
  dc: number;
  /** the weapon's die, for an attack that deals damage */
  damage?: string;
  /** the entity being acted on, when there is one */
  targetId?: string;
}
