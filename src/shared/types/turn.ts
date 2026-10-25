/**
 * The two axes of where a turn is.
 *
 * `Stage` is what the PLAYER is being told — it drives the input area and
 * nothing else. `Step` is where the GAME MASTER is in the heuristic — it drives
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
   * The action has been sent and the game master is working.
   */
  | "thinking"
  /** the game master needs the player to disambiguate or justify */
  | "clarifying"
  /** action turned away; no state changed */
  | "rejected"
  /** roll spec on the table; Roll button live */
  | "roll_offered"
  /** dice in flight — client-side, no model call */
  | "rolling"
  /** the game master is writing the outcome */
  | "resolving"
  /**
   * The call failed, or came back unusable twice. The player's text is kept so
   * a retry costs them nothing. A turn that cannot be
   * completed is a state the game can be in, and it is the software talking
   * rather than the game master.
   */
  | "error"
  | "dead"
  /**
   * The player walked out through a way to the surface.
   *
   * This is a placeholder stage where the game master has determined the player has left
   * the dungeon, but the store has not yet resolved whether they achieved their goal yet or not.
   * In the next stage, the game master will be sent a prompt including the player's goal state
   * to determine which run ending they receive.
   */
  | "departed"
  /** The player escaped alive, but without achieving their goal */
  | "escaped"
  /** The player achieved their goal and escaped alive */
  | "goal_met"
  /**
   * The player abandoned the run artificially.
   * 
   * This is a non-gameplay ending provided as QoL for players that want to stop a run without having
   * to finish it. It ends immediately with no rewards and allows the character to be used in a new run.
   */
  | "abandoned";

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
 * `departed` is here because a game master that writes it has ended the run whatever
 * the store resolves it to, and anything asking `isTerminal` of a commit rather
 * than of stored state must get the same answer.
 */
export const TERMINAL_STAGES: readonly Stage[] = [
  "dead",
  "departed",
  "escaped",
  "goal_met",
  "abandoned",
];

/**
 * Stages in which the world must not change. Enforced by the applier, not by
 * trusting the game master to have read the rule.
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

import type { Ability } from "../world/entities.ts";
import type { DamageResult, Edge } from "../../rules/knave/rolls.ts";

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

  // --- game-master-side, never rendered ---
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

/**
 * A roll the player has already made. The game master reads it; it never rolls.
 *
 * Defined here, not in the turn machine (`src/gameplay/turn.ts`), because
 * `PendingRequest.roll` below uses it, and `PendingRequest` is stored with the
 * run and read by the client. `src/gameplay/turn.ts` re-exports it for its
 * existing importers.
 */
export interface RolledOutcome {
  spec: RollSpec;
  /** one die, or two under advantage / disadvantage */
  rolled: number[];
  /** the die that counted */
  kept: number;
  total: number;
  success: boolean;
  nat20: boolean;
  nat1: boolean;
  /** attacks that land and deal damage */
  damage?: DamageResult;
  /** a natural 20 costs the defender's armour a point, a natural 1 the weapon */
  crit: { defenderArmor: boolean; attackerWeapon: boolean };
}

/**
 * The game master request currently in progress, or the last one that failed.
 * `retry` sends it again.
 *
 * Stored in the run's state (`RunState.pending`) rather than held in memory by
 * the turn machine (`src/gameplay/turn.ts`). On the deployed server each HTTP
 * request builds a fresh turn machine from the stored run, so a request kept
 * only in memory was gone by the time the player clicked "Try again", and the
 * retry silently did nothing.
 *
 * The client can read it too. That is safe: it only contains what the player
 * already sent. `remote-session`'s `retry` uses it only to choose which busy
 * stage to show (`room_entry`, `resolving` or `thinking`) while the server
 * repeats the request.
 */
export interface PendingRequest {
  /** what the player typed, when this ask was triggered by input */
  input?: string;
  /** the roll they had just made, when it was a resolution */
  roll?: RolledOutcome;
  /** where the heuristic resumes */
  step: Step;
  /** the room-entry pass, which must not chain another one */
  entering: boolean;
}
