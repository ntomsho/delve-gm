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
  | "dead"
  | "goal_met";

export type Step =
  | "1-target"
  | "2-classify"
  | "3-information"
  | "3-standard"
  | "4-confirm-roll"
  | "5-resolution"
  | "room-entry";

/** Stages that end the run. */
export const TERMINAL_STAGES: readonly Stage[] = ["dead", "goal_met"];

/**
 * Stages in which the world must not change. Enforced by the applier, not by
 * trusting the referee to have read the rule.
 */
export const NO_CHANGE_STAGES: readonly Stage[] = ["clarifying", "rejected"];

export function isTerminal(stage: Stage): boolean {
  return TERMINAL_STAGES.includes(stage);
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
  /** the number to meet. Hidden from the player. */
  dc: number;
  /** the weapon's die, for an attack that deals damage */
  damage?: string;
  /** the entity being acted on, when there is one */
  targetId?: string;
}
