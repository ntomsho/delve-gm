/**
 * THE PLAYBOOK, AS TEXT
 * =====================
 *
 * The skill is prose the model performs, not code — so it lives in the repo as
 * markdown and is imported raw. Vite's `?raw` works identically under vitest,
 * which is what lets prompt assembly be snapshot-tested headlessly.
 *
 * WHICH FILES LOAD, AND WHY IT IS NOT ONE.
 *
 * BUILD-PLAN §2.8 says to load the current step's file and not the whole
 * playbook, and that is the rule this implements — but the unit is the ENTRY
 * POINT, not the single file. A fresh action runs steps 1, 2 and 3 inside one
 * call: the game master finds the target, judges it, classifies it, and either lets
 * it happen or puts a roll on the table, all before the player is spoken to
 * again. Handing it step 1 alone would leave it at the end of that file with
 * nowhere to go.
 *
 * So each entry point carries the chain reachable from it, and nothing else.
 * The saving is real and it is where the plan expected it: a fresh action never
 * loads step 4 or step 5, a roll confirmation loads only step 4, a resolution
 * only step 5, and a room entry only its own file — which is most of the
 * playbook left on the shelf on every call.
 */

import type { Step } from "../shared/types/turn.ts";

import SKILL_MD from "./game-master/SKILL.md?raw";
import STEP_1_TARGET from "./game-master/steps/1-determine-target.md?raw";
import STEP_2_CLASSIFY from "./game-master/steps/2-validate-and-classify.md?raw";
import STEP_3_DISPATCH from "./game-master/steps/3-handle-by-type.md?raw";
import STEP_3_INFORMATION from "./game-master/steps/3-information.md?raw";
import STEP_3_STANDARD from "./game-master/steps/3-standard.md?raw";
import STEP_4_CONFIRM from "./game-master/steps/4-confirm-and-roll.md?raw";
import STEP_5_RESOLUTION from "./game-master/steps/5-resolution.md?raw";
import STEP_ROOM_ENTRY from "./game-master/steps/room-entry.md?raw";

/** The standing instructions: the conventions, the commit, and the dice tool. */
export const SKILL = SKILL_MD;

const CHAIN: Record<Step, readonly string[]> = {
  // A fresh action, from the top. Runs to a roll offer, a rejection, a
  // question, or a completed no-stakes action.
  "1-target": [STEP_1_TARGET, STEP_2_CLASSIFY, STEP_3_DISPATCH, STEP_3_INFORMATION, STEP_3_STANDARD],
  // The player has answered a question about the target. Same chain, minus the
  // step that asked.
  "2-classify": [STEP_2_CLASSIFY, STEP_3_DISPATCH, STEP_3_INFORMATION, STEP_3_STANDARD],
  "3-information": [STEP_3_INFORMATION],
  "3-standard": [STEP_3_STANDARD],
  // The negotiation. The roll is on the table and the player said something
  // instead of taking it.
  "4-confirm-roll": [STEP_4_CONFIRM],
  // The dice have come back.
  "5-resolution": [STEP_5_RESOLUTION],
  "room-entry": [STEP_ROOM_ENTRY],
};

/** The step files for an entry point, in the order the heuristic runs them. */
export function stepPrompt(step: Step): string {
  return CHAIN[step].join("\n\n---\n\n");
}
