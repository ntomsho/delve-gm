/**
 * Loads every prompt the app sends to a model.
 *
 * Prompts are text for the model to follow, not code, so they are kept as
 * markdown files and imported as raw strings. This is the only file that
 * imports them. Vite's `?raw` import also works under vitest, so prompt
 * building can be snapshot-tested without a browser. Plain `node` needs the
 * loader hook in `src/dev/lib/raw-md.ts`.
 *
 * Line endings are always converted to LF, whatever the checkout did (`lf`
 * and `text` below). This matters: the illustration and sprite cache keys
 * hash some of this text, so a `\r` from a Windows checkout would give every
 * locally drawn image a different key from production's.
 *
 * The file is in four sections: the game master's prompts, the generation
 * passes, the tally, and the illustration and sprite prompts.
 *
 * The game master is not sent every step file on every call, only the ones
 * the current step can lead to (docs/ARCHITECTURE.md section 5.3). That is
 * usually more than one file. A new action runs steps 1, 2 and 3 in one call:
 * the game master finds what the action is aimed at, checks it, classifies
 * it, and then either lets it happen or offers a roll, all before the player
 * hears back. Sending only step 1 would leave it with no instructions for
 * what comes next.
 *
 * So each step sends the chain of files reachable from it (`CHAIN` below). A
 * new action never loads steps 4 or 5, a roll confirmation loads only step 4,
 * a resolution only step 5, and a room entry only its own file, so most of
 * the step files are left out of every call.
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
 * Normalises a game master prompt file: LF line endings, keeping the final
 * newline. The newline is kept because production has always sent it, and
 * changing the text at all would stop the prompt cache matching.
 */
function lf(raw: string): string {
  return raw.replace(/\r\n/g, "\n");
}

/** Normalises any other prompt file: LF line endings, with the final newline removed. */
function text(raw: string): string {
  const lf = raw.replace(/\r\n/g, "\n");
  return lf.endsWith("\n") ? lf.slice(0, -1) : lf;
}

/**
 * Fills a template's `{{name}}` placeholders. Every placeholder must have a
 * value and every value must have a placeholder, so a renamed placeholder or a
 * leftover value throws, instead of sending a prompt with a gap in it.
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

/** The game master's main prompt, sent on every call: the conventions, the commit and the `roll` tool. */
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
  // A new action, from the start. Ends with a roll offered, the action
  // rejected, a question to the player, or an action with nothing at stake
  // carried out.
  "1-target": [STEP_1_TARGET, STEP_2_CLASSIFY, STEP_3_DISPATCH, STEP_3_INFORMATION, STEP_3_STANDARD],
  // The player has answered a question about what the action is aimed at.
  // The same chain without step 1, which asked it.
  "2-classify": [STEP_2_CLASSIFY, STEP_3_DISPATCH, STEP_3_INFORMATION, STEP_3_STANDARD],
  "3-information": [STEP_3_INFORMATION],
  "3-standard": [STEP_3_STANDARD],
  // A roll has been offered, and the player typed something instead of
  // taking it.
  "4-confirm-roll": [STEP_4_CONFIRM],
  // The player has made the roll.
  "5-resolution": [STEP_5_RESOLUTION],
  "room-entry": [STEP_ROOM_ENTRY],
};

/** The step files for `step`, in the order the game master works through them. */
export function stepPrompt(step: Step): string {
  return CHAIN[step].join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// THE GENERATION PASSES
// ---------------------------------------------------------------------------

export const DUNGEON_PASS_INSTRUCTIONS = text(GENERATION_DUNGEON_PASS_MD);

export const DUNGEON_PASS_SCHEMA = text(GENERATION_DUNGEON_PASS_SCHEMA_MD);

/**
 * The rule for naming connectors (the ways between rooms).
 *
 * A connector is one entity with one name, seen from both of its rooms. If it
 * were named "Corridor to the Kennel", a player in the Kennel would see an
 * exit called "Corridor to the Kennel", pointing at the room they're in. Asked
 * to "go back to the Laboratory", the game master would then see two exits
 * that both claim to lead to the Kennel, and have to guess. So the name only
 * says what kind of way it is, and `renderRoom` in
 * `src/gameplay/game-master/render.ts` adds the room on the other side, which
 * is right from either end.
 */
export const CONNECTOR_NAMING = text(GENERATION_CONNECTOR_NAMING_MD);

/**
 * The rule for describing a connector that changes height, like a stair.
 *
 * A stair has a top and a bottom, but one connector seen from both rooms has
 * no single "up". So the description names which room is the upper one. That
 * is the only wording that is right from both sides; without it, the same
 * stair could be described as going down from both rooms, which a player
 * walking back the way they came would notice.
 *
 * The writer always knows both rooms' names: a content-pass chunk only writes
 * connectors whose two rooms it is also naming, and the seams pass is given
 * the room names the chunks chose.
 */
export const CONNECTOR_HEIGHT = text(GENERATION_CONNECTOR_HEIGHT_MD);

export const GOAL_INSTRUCTION = text(GENERATION_GOAL_MD);

/**
 * The content pass's instructions, with `{{placeholders}}` for values that
 * come from code: the connector rules above, the list of fixtures, the
 * position words and the goal line. Filled in
 * `src/generation/content/passes/content-pass/prompt.ts`.
 */
export const CONTENT_PASS_TEMPLATE = text(GENERATION_CONTENT_PASS_MD);

export const CONTENT_PASS_SCHEMA = text(GENERATION_CONTENT_PASS_SCHEMA_MD);

/**
 * The seams pass's instructions, with `{{placeholders}}` for the connector
 * rules it shares with the content pass. Filled in
 * `src/generation/content/passes/seams-pass.ts`.
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
 * The illustration style, version 2 ("sparse"). Version 1 asked for
 * cross-hatching and stippling and got dense, dark engraving that turned
 * cluttered or black when reduced to black and white. This version asks for
 * mostly white paper with shading only in the deepest shadows. It says "no
 * border" in several ways because FLUX.2 [klein] drew one anyway.
 */
export const ILLUSTRATION_STYLE = text(ILLUSTRATIONS_STYLE_MD);

/**
 * Explains the marks on the guide image. The marks show where things go, the
 * text says what they are, and no mark should appear in the finished drawing.
 */
export const ILLUSTRATION_GUIDE_NOTE = text(ILLUSTRATIONS_GUIDE_NOTE_MD);

/** The same, for a guide image with no marks, which shows only the room's shape. */
export const ILLUSTRATION_PLAIN_GUIDE_NOTE = text(ILLUSTRATIONS_PLAIN_GUIDE_NOTE_MD);

/**
 * Asks the model to leave a patch of floor empty, where creature sprites are
 * placed afterwards (`illustrationStage` in `src/illustrations/figures.ts`).
 * Only sent with the marked guide, which has the dotted outline this refers
 * to.
 */
export const ILLUSTRATION_OPEN_FLOOR_NOTE = text(ILLUSTRATIONS_OPEN_FLOOR_NOTE_MD);

export const ILLUSTRATION_VISUAL_SYSTEM = text(ILLUSTRATIONS_VISUAL_SYSTEM_MD);

export const ILLUSTRATION_SETTING_SYSTEM = text(ILLUSTRATIONS_SETTING_SYSTEM_MD);

/** The system prompt for describing an exterior: the place and its entrance, seen from outside. */
export const ILLUSTRATION_EXTERIOR_SYSTEM = text(ILLUSTRATIONS_EXTERIOR_SYSTEM_MD);

export const SPRITE_STYLE = text(ILLUSTRATIONS_SPRITE_STYLE_MD);

/**
 * How to pose a sprite. People are drawn standing, so a group can be lined
 * up; other creatures keep their natural stance (otherwise a rat would be
 * drawn standing on its hind legs).
 */
export const SPRITE_FRAME = text(ILLUSTRATIONS_SPRITE_FRAME_MD);

/**
 * Describes in words the rough look the sprite reference images were chosen
 * for, so the prompt agrees with them. The style text alone asks for crisp
 * outlines, and the results looked too clean. It doesn't ask for ragged
 * clothes; a sprite looks worn only if its own description says so.
 */
export const SPRITE_GRIT = text(ILLUSTRATIONS_SPRITE_GRIT_MD);

export const SPRITE_LOOK_SYSTEM = text(ILLUSTRATIONS_SPRITE_LOOK_SYSTEM_MD);
