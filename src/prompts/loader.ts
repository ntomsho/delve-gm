/**
 * EVERY INSTRUCTION TO A MODEL, AS TEXT
 * =====================================
 *
 * Prompts are prose the model performs, not code, so they live in the repo as
 * markdown and are imported raw — here and nowhere else. Vite's `?raw` works
 * identically under vitest, which is what lets prompt assembly be
 * snapshot-tested headlessly; plain `node` needs the hook in `dev/lib/raw-md.ts`.
 *
 * AS THE MODEL READS IT. `text()` gives every file LF line endings, whatever the
 * checkout did, and drops the newline the file ends on. That matters beyond
 * tidiness: the illustration and sprite cache keys hash some of this text, so a
 * `\r` from a Windows checkout would give every local image a different key
 * from production's.
 *
 * THE GAME MASTER'S PLAYBOOK comes first, then the generation passes, the tally,
 * and the illustration and sprite prompts.
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
import STEP_1_TARGET_MD from "./game-master/steps/1-determine-target.md?raw";
import STEP_2_CLASSIFY_MD from "./game-master/steps/2-validate-and-classify.md?raw";
import STEP_3_DISPATCH_MD from "./game-master/steps/3-handle-by-type.md?raw";
import STEP_3_INFORMATION_MD from "./game-master/steps/3-information.md?raw";
import STEP_3_STANDARD_MD from "./game-master/steps/3-standard.md?raw";
import STEP_4_CONFIRM_MD from "./game-master/steps/4-confirm-and-roll.md?raw";
import STEP_5_RESOLUTION_MD from "./game-master/steps/5-resolution.md?raw";
import STEP_ROOM_ENTRY_MD from "./game-master/steps/room-entry.md?raw";
import GENERATION_DUNGEON_PASS_MD from "./generation/dungeon-pass.md?raw";
import GENERATION_DUNGEON_PASS_SCHEMA_MD from "./generation/dungeon-pass.schema.md?raw";
import GENERATION_CONNECTOR_NAMING_MD from "./generation/connector-naming.md?raw";
import GENERATION_CONNECTOR_HEIGHT_MD from "./generation/connector-height.md?raw";
import GENERATION_GOAL_MD from "./generation/goal.md?raw";
import GENERATION_CONTENT_PASS_MD from "./generation/content-pass.md?raw";
import GENERATION_CONTENT_PASS_SCHEMA_MD from "./generation/content-pass.schema.md?raw";
import GENERATION_SEAMS_PASS_MD from "./generation/seams-pass.md?raw";
import GENERATION_SEAMS_PASS_SCHEMA_MD from "./generation/seams-pass.schema.md?raw";
import GENERATION_KEYS_PASS_MD from "./generation/keys-pass.md?raw";
import GENERATION_KEYS_PASS_SCHEMA_MD from "./generation/keys-pass.schema.md?raw";
import TALLY_TALLY_MD from "./tally/tally.md?raw";
import TALLY_TALLY_SCHEMA_MD from "./tally/tally.schema.md?raw";
import ILLUSTRATIONS_STYLE_MD from "./illustrations/style.md?raw";
import ILLUSTRATIONS_GUIDE_NOTE_MD from "./illustrations/guide-note.md?raw";
import ILLUSTRATIONS_PLAIN_GUIDE_NOTE_MD from "./illustrations/plain-guide-note.md?raw";
import ILLUSTRATIONS_OPEN_FLOOR_NOTE_MD from "./illustrations/open-floor-note.md?raw";
import ILLUSTRATIONS_VISUAL_SYSTEM_MD from "./illustrations/visual-system.md?raw";
import ILLUSTRATIONS_SETTING_SYSTEM_MD from "./illustrations/setting-system.md?raw";
import ILLUSTRATIONS_EXTERIOR_SYSTEM_MD from "./illustrations/exterior-system.md?raw";
import ILLUSTRATIONS_SPRITE_STYLE_MD from "./illustrations/sprite-style.md?raw";
import ILLUSTRATIONS_SPRITE_FRAME_MD from "./illustrations/sprite-frame.md?raw";
import ILLUSTRATIONS_SPRITE_GRIT_MD from "./illustrations/sprite-grit.md?raw";
import ILLUSTRATIONS_SPRITE_LOOK_SYSTEM_MD from "./illustrations/sprite-look-system.md?raw";

/**
 * The playbook as it is sent: LF line endings, and its final newline kept,
 * because production has always sent it and the prompt cache's prefix is
 * matched byte for byte.
 */
function lf(raw: string): string {
  return raw.replace(/\r\n/g, "\n");
}

/** Any other prompt file as the model reads it: LF line endings, without the final newline. */
function text(raw: string): string {
  const lf = raw.replace(/\r\n/g, "\n");
  return lf.endsWith("\n") ? lf.slice(0, -1) : lf;
}

/**
 * A template with its `{{name}}` slots filled. Every slot must be given a value
 * and every value must have a slot, so a renamed slot or a stale value is an
 * error at load rather than a prompt with a hole in it.
 */
export function fill(template: string, values: Record<string, string>): string {
  const slots = new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
  for (const slot of slots) if (!(slot in values)) throw new Error(`prompt slot {{${slot}}} has no value`);
  for (const key of Object.keys(values)) if (!slots.has(key)) throw new Error(`prompt has no slot {{${key}}}`);
  return template.replace(/\{\{(\w+)\}\}/g, (_, slot: string) => values[slot]);
}

// ---------------------------------------------------------------------------
// THE GAME MASTER'S PLAYBOOK
// ---------------------------------------------------------------------------

/** The standing instructions: the conventions, the commit, and the dice tool. */
export const SKILL = lf(SKILL_MD);

const STEP_1_TARGET = lf(STEP_1_TARGET_MD);
const STEP_2_CLASSIFY = lf(STEP_2_CLASSIFY_MD);
const STEP_3_DISPATCH = lf(STEP_3_DISPATCH_MD);
const STEP_3_INFORMATION = lf(STEP_3_INFORMATION_MD);
const STEP_3_STANDARD = lf(STEP_3_STANDARD_MD);
const STEP_4_CONFIRM = lf(STEP_4_CONFIRM_MD);
const STEP_5_RESOLUTION = lf(STEP_5_RESOLUTION_MD);
const STEP_ROOM_ENTRY = lf(STEP_ROOM_ENTRY_MD);

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

// ---------------------------------------------------------------------------
// THE GENERATION PASSES
// ---------------------------------------------------------------------------

export const DUNGEON_PASS_INSTRUCTIONS = text(GENERATION_DUNGEON_PASS_MD);

export const DUNGEON_PASS_SCHEMA = text(GENERATION_DUNGEON_PASS_SCHEMA_MD);

/**
 * A connector is read from both ends, and it is one entity with one name.
 *
 * Name it "Corridor to the Kennel" and the player standing IN the Kennel reads
 * "Corridor to the Kennel" on the way out — pointing at where they already are.
 * A game master asked to route "go back to the Laboratory" then has two exits both
 * claiming to lead to the Kennel and picks by coin toss. So the name carries the
 * nature of the crossing and nothing else, and `renderRoom` appends the room on
 * the far side, correct from whichever end is being read.
 */
export const CONNECTOR_NAMING = text(GENERATION_CONNECTOR_NAMING_MD);

/**
 * A stair has a top and a bottom, and one entity read from both ends has no
 * "up" of its own.
 *
 * So the form says which ROOM is the upper one, by name. That is the one phrasing
 * that survives being read from either side, and without it the same flight of
 * steps is written as descending from both of its rooms -- which is what a player
 * walking back the way they came finds out.
 *
 * Both rooms are named by whoever is writing: a chunk writes only the connectors
 * whose two rooms it is naming in the same response, and the seams pass is handed
 * the names the chunks settled.
 */
export const CONNECTOR_HEIGHT = text(GENERATION_CONNECTOR_HEIGHT_MD);

export const GOAL_INSTRUCTION = text(GENERATION_GOAL_MD);

/**
 * The content pass's standing instructions, with `{{slots}}` for what code
 * knows: the connector rules above, the fixture menu, the position words and
 * the goal line. Filled in `generation/content/passes/content-pass/prompt.ts`.
 */
export const CONTENT_PASS_TEMPLATE = text(GENERATION_CONTENT_PASS_MD);

export const CONTENT_PASS_SCHEMA = text(GENERATION_CONTENT_PASS_SCHEMA_MD);

/**
 * The seams pass's standing instructions, with `{{slots}}` for the connector
 * rules it shares with the content pass. Filled in `seams-pass.ts`.
 */
export const SEAMS_PASS_TEMPLATE = text(GENERATION_SEAMS_PASS_MD);

export const SEAMS_PASS_SCHEMA = text(GENERATION_SEAMS_PASS_SCHEMA_MD);

export const KEYS_PASS_INSTRUCTIONS = text(GENERATION_KEYS_PASS_MD);

export const KEYS_PASS_SCHEMA = text(GENERATION_KEYS_PASS_SCHEMA_MD);

// ---------------------------------------------------------------------------
// THE TALLY
// ---------------------------------------------------------------------------

export const TALLY_INSTRUCTIONS = text(TALLY_TALLY_MD);

export const TALLY_SCHEMA = text(TALLY_TALLY_SCHEMA_MD);

// ---------------------------------------------------------------------------
// ILLUSTRATIONS AND SPRITES
// ---------------------------------------------------------------------------

/**
 * Version 2, "sparse". Version 1 asked for cross-hatching and stippling and got
 * exactly that: dense, dark engraving that turned busy or black at 1-bit. This
 * asks for mostly white paper and shading only where a shadow is deepest, and
 * says "no border" more than one way because klein drew one anyway.
 */
export const ILLUSTRATION_STYLE = text(ILLUSTRATIONS_STYLE_MD);

/**
 * What the marks in the guide image mean. The marks say WHERE; the prose says
 * WHAT; and none of them may survive into the drawing.
 */
export const ILLUSTRATION_GUIDE_NOTE = text(ILLUSTRATIONS_GUIDE_NOTE_MD);

/** The same, for a guide drawn with no marks: architecture only. */
export const ILLUSTRATION_PLAIN_GUIDE_NOTE = text(ILLUSTRATIONS_PLAIN_GUIDE_NOTE_MD);

/**
 * The patch of floor every illustration keeps clear for creatures, which are stood in
 * it afterwards (`illustrationStage`, src/illustrations/figures.ts). Only with the
 * marked guide, which carries the dotted outline it refers to.
 */
export const ILLUSTRATION_OPEN_FLOOR_NOTE = text(ILLUSTRATIONS_OPEN_FLOOR_NOTE_MD);

export const ILLUSTRATION_VISUAL_SYSTEM = text(ILLUSTRATIONS_VISUAL_SYSTEM_MD);

export const ILLUSTRATION_SETTING_SYSTEM = text(ILLUSTRATIONS_SETTING_SYSTEM_MD);

/** What Haiku is asked for an exterior: the place and its entrance, from outside. */
export const ILLUSTRATION_EXTERIOR_SYSTEM = text(ILLUSTRATIONS_EXTERIOR_SYSTEM_MD);

export const SPRITE_STYLE = text(ILLUSTRATIONS_SPRITE_STYLE_MD);

/**
 * A person stands, so a group can be arranged; a creature keeps its own
 * stance, or a rat comes out on its hind legs.
 */
export const SPRITE_FRAME = text(ILLUSTRATIONS_SPRITE_FRAME_MD);

/**
 * The look the references were picked for, in words, so the prompt does not
 * pull against them: the style text alone asks for crisp outlines, and that
 * came out too clean. Rags are not asked for — worn only where the figure's own
 * description says so.
 */
export const SPRITE_GRIT = text(ILLUSTRATIONS_SPRITE_GRIT_MD);

export const SPRITE_LOOK_SYSTEM = text(ILLUSTRATIONS_SPRITE_LOOK_SYSTEM_MD);
