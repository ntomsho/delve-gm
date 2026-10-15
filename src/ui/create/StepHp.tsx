/**
 * STEP 3 — HIT POINTS.
 *
 * Both the starting total and the maximum, and there is not another one coming.
 * Two dice floored at nine under normal, one floored at five under hardcore —
 * see `CREATION_RULES` for why the book's unfloored d8 is not what we roll.
 *
 * **The floor is shown as a floor.** When the dice come in under it the card
 * says so and prints what they actually said, rather than quietly displaying a
 * number that was never rolled.
 *
 * **This one spends a reroll**, unlike the traits. An unlimited d8 is an 8.
 */

import { CREATION_RULES, hpCeiling, type HpRoll } from "../../rules/knave/character-creation.ts";
import type { CreationMode } from "../../rules/knave/character.ts";
import { Button, MONO_LABEL, StepHeading } from "./shared.tsx";

/** Said plainly, in the range the mode can actually produce. */
function comment(roll: HpRoll, floor: number, ceiling: number): string {
  if (roll.floored) {
    return `The dice said ${roll.total}. The floor says ${floor}, and the floor is there for rolls exactly like that one.`;
  }
  const room = ceiling - floor;
  const above = roll.hp - floor;
  if (above === 0) return "Exactly the floor, honestly rolled. Nothing spare.";
  if (above <= room / 3) return "Thin. One bad exchange and you are on the floor, so plan to not have the exchange.";
  if (above <= (room * 2) / 3) return "Ordinary. Enough to survive being wrong once.";
  if (roll.hp === ceiling) return `${roll.hp}. The best there is, and it is still only ${roll.hp}.`;
  return "A good roll. It will still not survive a second mistake.";
}

export function StepHp({
  mode,
  roll,
  rerollsLeft,
  onReroll,
}: {
  mode: CreationMode;
  roll: HpRoll;
  rerollsLeft: number;
  onReroll: () => void;
}) {
  const { dice, floor } = CREATION_RULES[mode].hp;
  const ceiling = hpCeiling(mode);

  return (
    <div className="pt-2 text-center">
      <div className="mx-auto max-w-[46ch]">
        <StepHeading title="Hit points">
          {dice === 1 ? "One d8" : `${dice}d8`}, rolled once, never less than {floor}. It is
          your starting total and your maximum both, and you will not get another.
        </StepHeading>
      </div>

      <div
        className={`mx-auto mt-11 flex h-[150px] w-[150px] items-center justify-center border-2 bg-paper shadow-[5px_5px_0_var(--color-ink)] ${
          roll.floored ? "border-torch" : "border-ink"
        }`}
      >
        <span className="font-mono text-[82px] font-bold leading-none text-ink">{roll.hp}</span>
      </div>

      <div className={`${MONO_LABEL} mt-4`}>
        {dice}d8 → {roll.dice.join(" ")}
        {roll.floored ? ` = ${roll.total}, raised to ${floor}` : ""}
      </div>

      <p className="mx-auto mt-9 max-w-[48ch] font-prose text-[17px] italic leading-relaxed text-graphite">
        {comment(roll, floor, ceiling)}
      </p>

      <div className="mt-7">
        <Button onClick={onReroll} disabled={rerollsLeft <= 0} className="px-6 py-2.5 text-[13px]">
          Reroll
        </Button>
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
          {rerollsLeft > 0
            ? `Costs one of your ${rerollsLeft} · ${floor} to ${ceiling}`
            : "No rerolls left — this is your number"}
        </p>
      </div>
    </div>
  );
}
