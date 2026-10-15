/**
 * STEP 2 — WHO IS THIS.
 *
 * Eleven rolls, none of them mechanical, all of them read by the game master every
 * turn. The design plan asks for more room than a form deserves, and gives it
 * two columns of a single ruled sheet.
 *
 * **These rerolls are free.** They are the one place in creation where a player
 * fishing for something they like is not taking anything from the game — a face
 * they believe in is worth more to the run than a face they shrugged at.
 */

import { TRAIT_KEYS, type TraitKey } from "../../rules/knave/character-creation.ts";
import type { CharacterTraits } from "../../rules/knave/character.ts";
import { describePerson } from "../shared/person.ts";
import { Button, RerollGlyph, StepHeading } from "./shared.tsx";

const HEADING: Record<TraitKey, string> = {
  physique: "Physique",
  face: "Face",
  skin: "Skin",
  hair: "Hair",
  clothing: "Clothing",
  virtue: "Virtue",
  vice: "Vice",
  speech: "Speech",
  background: "Background",
  misfortunes: "Misfortune",
  alignment: "Alignment",
};

export function StepTraits({
  traits,
  onRerollOne,
  onRerollAll,
}: {
  traits: CharacterTraits;
  onRerollOne: (k: TraitKey) => void;
  onRerollAll: () => void;
}) {
  return (
    <div>
      <StepHeading title="Who is this?">
        Eleven rolls. None of them do anything mechanically, and all of them will
        change how the game master answers you. Reroll any one you don't believe — these
        cost nothing.
      </StepHeading>

      <div className="mt-7 border border-rule bg-paper py-2">
        <div className="grid md:grid-cols-2">
          {TRAIT_KEYS.map((k, i) => (
            <div
              key={k}
              className={`grid grid-cols-[110px_1fr_auto] items-baseline gap-2.5 border-b border-rule-faint px-5 py-2.5 last:border-b-0 ${
                i % 2 === 0 ? "md:border-r md:border-r-rule-faint" : ""
              }`}
            >
              <span className="font-display text-[10px] uppercase tracking-[0.16em] text-graphite">
                {HEADING[k]}
              </span>
              <span className="font-prose text-[20px] text-ink">{traits[k]}</span>
              <RerollGlyph
                onClick={() => onRerollOne(k)}
                title={`Reroll ${HEADING[k].toLowerCase()}`}
                label={`Reroll ${HEADING[k].toLowerCase()}`}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-5">
        <p className="max-w-[64ch] font-prose text-[18px] italic leading-relaxed text-indigo">
          {describePerson(traits)}
        </p>
        <Button onClick={onRerollAll} className="px-5 py-2.5 text-[13px]">
          Reroll all
        </Button>
      </div>
    </div>
  );
}
