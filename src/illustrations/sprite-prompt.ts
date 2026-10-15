/**
 * CREATURE SPRITES — what the models are told
 * ===========================================
 *
 * Two calls per sprite, once per dungeon kind (BUILD-PLAN, *Illustrations*,
 * "2. Creature sprites"):
 *
 *   1. Haiku turns the creature's base into what an illustrator would draw,
 *      and picks a size WORD (`FigureSize`). Code owns the feet.
 *   2. The image model draws one figure on white, against the sprite style
 *      references in `assets/sprite-refs/`.
 *
 * Pure text. The calls are in `src/illustrations/sprites.ts` and `src/server/illustrations/sprites.ts`.
 */

/**
 * Bumped when anything below changes what a sprite looks like. Part of every
 * sprite's key, so a change redraws from then on rather than mixing two looks
 * in one dungeon.
 */
export const SPRITE_STYLE_VERSION = 1;

export const SPRITE_STYLE =
  "Clean black ink line art in the manner of a 1970s-80s fantasy adventure module's illustration " +
  "booklet. Crisp, confident outlines define every form. Shading is sparing: a few hatched strokes only " +
  "in the deepest shadows, no dense cross-hatching, no stippled texture, no large areas of solid black. " +
  "No grey, no colour. No lettering.";

/**
 * A person stands, so a group can be arranged; a creature keeps its own
 * stance, or a rat comes out on its hind legs.
 */
export const SPRITE_FRAME =
  "Draw ONE figure, whole from head to feet or tail, in three-quarter view toward the viewer. A person " +
  "stands. A creature takes its natural stance: upright, hunched, on all fours or crawling, whatever it is. " +
  "The figure is centred, with white paper all around it. Nothing else: no floor, no ground line, no cast " +
  "shadow, no background, no scenery, no frame, no border.";

/**
 * The look the references were picked for, in words, so the prompt does not
 * pull against them: the style text alone asks for crisp outlines, and that
 * came out too clean. Rags are not asked for — worn only where the figure's own
 * description says so.
 */
export const SPRITE_GRIT =
  "The pen line is a working illustrator's: slightly rough and scratchy, never polished or smooth. Nothing " +
  "glamorous or idealised: people look like ordinary people, plain rather than handsome; creatures are " +
  "rough, scarred and unpleasant to look at, but not gory. Clothes and gear are as worn or as well kept as " +
  "the figure's description says.";

/** What the sprite references are for: the manner, never the subjects. */
export function spriteReferenceNote(count: number): string {
  return (
    `The ${count} images are style references only: draw in exactly their manner — the same rough pen line, ` +
    "the same sparing hatching, the same amount of white paper. Take nothing else from them: not their " +
    "subjects, clothes, gear or poses."
  );
}

/** The image prompt for one sprite. */
export function spriteImagePrompt(look: string, references: number): string {
  return [
    ...(references ? ["STYLE REFERENCES", spriteReferenceNote(references), ""] : []),
    SPRITE_STYLE,
    "",
    SPRITE_FRAME,
    "",
    "THE FIGURE",
    look,
    "",
    "CHARACTER",
    SPRITE_GRIT,
  ].join("\n");
}

export const SPRITE_LOOK_SYSTEM =
  "You brief an illustrator who will draw one creature as a single figure. From the creature's " +
  "description, write what can be SEEN: body, build, skin or hide, clothing, gear, posture, anything held. " +
  "20 to 35 words, plain and concrete. Leave out its name, history, purpose, sounds, smells and anything it " +
  "is doing to others. If it is a member of a group, describe one typical member. Also choose its size: " +
  "tiny (rat, cat), small (dog, child, goblin), medium (a person), large (ogre, horse), huge (giant, dragon).";

/** What Haiku is told about one creature. */
export function spriteLookMessage(s: { theme: string; name: string; base: string; member: boolean }): string {
  return [
    "DUNGEON",
    s.theme,
    "",
    `CREATURE (${s.member ? "one member of a group" : "an individual"})`,
    s.name,
    s.base,
  ].join("\n");
}
