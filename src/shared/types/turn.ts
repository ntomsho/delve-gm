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
   *
   * Needed because prose
   * is held back until the commit validates and applies, so the player is not
   * watching text arrive. Without a stage for it the interface would have
   * nothing honest to show during the wait — and the wait is the normal case,
   * not the exception.
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
   * WRITTEN BY THE GAME MASTER, NEVER STORED. Which ending a departure is depends on
   * whether the goal was accomplished, and that is world state rather than
   * something the game master should be trusted to remember — so the store resolves
   * this into `goal_met` or `escaped` the moment the commit lands, the same way
   * hit points at zero override whatever came next. The player is never told
   * "departed"; they are told which one it was.
   */
  | "departed"
  /** out alive, without what they came for */
  | "escaped"
  /** out alive, with it */
  | "goal_met"
  /**
   * The player walked away from the run rather than out of the dungeon.
   *
   * THE ONE TERMINAL STAGE NO GAME MASTER CAN WRITE. Every other ending is something
   * that happened in the fiction and arrives on a commit; this one is the player
   * closing the book, so it is set by an endpoint of its own and costs no model
   * call, no dice, and no turn. The character is freed and the run keeps
   * everything it had — abandoning ends a run, it does not delete one.
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
 * Here rather than in `turn.ts` — where it was until the pending request below
 * needed it — because a machine is not the only thing entitled to know what a
 * roll came to. `turn.ts` re-exports it, so the prompts and the journal did not
 * have to move with it.
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
 * THE ASK IN FLIGHT — what a retry has to repeat.
 *
 * It was a closure variable inside the turn machine, which was correct for
 * exactly as long as one machine outlived one run. It does not: the server
 * builds a session per request and `resume`s it from a row, so the machine that
 * lands on `error` is destroyed before the player has finished reading the word,
 * and the one that answers their retry was born knowing nothing. `retry` guards
 * on having a request to repeat, so it repeated nothing — every "Try again" on a
 * deployed run bumped the version and did nothing else.
 *
 * So it is state, and it rides along in the row the run is stored in. That the
 * client can then read it too is not a leak: it names what the player has
 * already done, and the client asserts nothing with it — see `remote-session`,
 * which uses it only to decide which busy stage to show while the server repeats
 * the ask it decided on for itself.
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
