import { SPRITE_FRAME, SPRITE_GRIT, SPRITE_STYLE } from "../prompts/loader.ts";
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
