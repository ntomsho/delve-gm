import { PORTRAIT_FRAME, SPRITE_GRIT, SPRITE_STYLE } from "../prompts/loader.ts";
import { spriteReferenceNote } from "./sprite-prompt.ts";
import { EQUIP_SLOTS, heldItem, type Gender, type PlayerCharacter } from "../rules/knave/character.ts";
import { purseItem } from "../rules/knave/character-creation.ts";
/**
 * CHARACTER PORTRAITS — what the image model is told
 * ==================================================
 *
 * The player's own character, drawn once at creation on request and again
 * only on request (`src/server/illustrations/portraits.ts`). One paid call: the
 * prompt is written here from the sheet, with no model in between, because a
 * rolled trait is already the words an illustrator needs.
 *
 * EVERY ROLLED FEATURE GOES IN. The eleven traits and what is held and worn,
 * and the gender the player chose, when they chose one. The ones nobody could
 * see (virtue, vice, speech, alignment, background, and mostly misfortune)
 * are told apart from the ones they could, and `PORTRAIT_FRAME` says what to
 * do with each. The name does not go in: it adds nothing to a drawing and
 * invites lettering.
 *
 * Drawn in the creature sprites' style, against the sprite references, so the
 * player's character belongs to the same booklet as the things they meet.
 *
 * Pure text.
 */

/** What the character carries that would show: everything held or packed but the purse. */
function gear(pc: PlayerCharacter): { worn: string[]; packed: string[] } {
  const worn = EQUIP_SLOTS.flatMap((slot) => {
    const item = heldItem(pc, pc.equipped[slot]);
    return item ? [`${slot}: ${item.name}`] : [];
  });
  const equipped = new Set(Object.values(pc.equipped));
  const purse = purseItem(pc);
  const packed = pc.inventory.filter((i) => !equipped.has(i.id) && i !== purse).map((i) => i.name);
  return { worn, packed };
}

/** How the prompt says each gender. Left out when the player chose none, and the model decides. */
const GENDER_WORDS: Record<Gender, string> = {
  male: "a man",
  female: "a woman",
  nonbinary: "non-binary: neither plainly a man nor plainly a woman",
};

/** The image prompt for one character's portrait. */
export function portraitImagePrompt(pc: PlayerCharacter, references: number): string {
  const t = pc.traits;
  const { worn, packed } = gear(pc);
  return [
    ...(references ? ["STYLE REFERENCES", spriteReferenceNote(references), ""] : []),
    SPRITE_STYLE,
    "",
    PORTRAIT_FRAME,
    "",
    "WHAT CAN BE SEEN",
    ...(pc.gender ? [`Gender: ${GENDER_WORDS[pc.gender]}`] : []),
    `Physique: ${t.physique}`,
    `Face: ${t.face}`,
    `Skin: ${t.skin}`,
    `Hair: ${t.hair}`,
    `Clothing: ${t.clothing}`,
    ...(worn.length ? [`Held and worn: ${worn.join("; ")}`] : ["Held and worn: nothing but their clothes"]),
    ...(packed.length ? [`Packed or slung about them, small and in the background: ${packed.join(", ")}`] : []),
    "",
    "WHAT CANNOT BE SEEN",
    `Background: ${t.background}`,
    `Virtue: ${t.virtue}`,
    `Vice: ${t.vice}`,
    `Speech: ${t.speech}`,
    `Alignment: ${t.alignment}`,
    `Misfortune: ${t.misfortunes} (draw it only if it would leave a mark on them)`,
    "",
    "CHARACTER",
    SPRITE_GRIT,
  ].join("\n");
}
