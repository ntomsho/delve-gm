/**
 * The eleven traits as one sentence.
 *
 * Used in two places that must agree — the confirm step's sheet and the row on
 * the Characters screen — so it lives beside neither of them. A player who
 * approved a description should meet the same description in the list.
 *
 * Distinct from `renderPc` in `runtime/prompts/render.ts`, which lists the same
 * traits as `key value` pairs for the referee. That one is for a machine to
 * parse and this one is for a person to read; they are the same data twice on
 * purpose, not a duplication to collapse.
 */

import type { CharacterTraits } from "../engine/index.ts";

export function describePerson(t: CharacterTraits): string {
  return [
    `${t.physique}, ${t.face.toLowerCase()} face, ${t.skin.toLowerCase()} skin,`,
    `${t.hair.toLowerCase()} hair, in ${t.clothing.toLowerCase()} clothes.`,
    `A ${t.background.toLowerCase()} — ${t.virtue.toLowerCase()} and ${t.vice.toLowerCase()},`,
    `${t.speech.toLowerCase()} of speech, ${t.misfortunes.toLowerCase()} once already.`,
    `${t.alignment}.`,
  ].join(" ");
}
