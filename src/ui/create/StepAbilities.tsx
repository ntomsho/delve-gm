/**
 * STEP 1 — ABILITIES.
 *
 * Six bonuses, and every one of them carries its defense (bonus + 10) because
 * that is the number a foe has to meet and the number a save is made against.
 * The dice that produced a bonus are printed under it, which is the reason
 * `rollAbility` hands them back rather than just the minimum.
 *
 * A SWAP MOVES THE DICE WITH THE NUMBER. Click one card, click another; the two
 * exchange bonus and dice together, so "2d6 → 5 3" under a +3 is never a lie
 * about where the +3 came from.
 */

import {
  ABILITIES,
  CREATION_RULES,
  POINT_BUY,
  canRaise,
  costOfAbility,
  pointsLeft,
  type AbilityRolls,
} from "../../rules/knave/character-creation.ts";
import type { Ability } from "../../shared/world/entities.ts";
import type { CharacterAbilities, CreationMode } from "../../rules/knave/character.ts";
import { Button, LABEL, StepHeading, Toggle } from "./shared.tsx";
import { signed } from "../../shared/utils/format.ts";

export type AbilityMode = "roll" | "buy";

const MODES = [
  { value: "roll" as const, label: "ROLL" },
  { value: "buy" as const, label: "POINT BUY" },
];

function Card({
  ability,
  bonus,
  dice,
  chosen,
  onClick,
  footer,
}: {
  ability: Ability;
  bonus: number;
  dice?: number[];
  chosen?: boolean;
  onClick?: () => void;
  footer?: React.ReactNode;
}) {
  const body = (
    <>
      <div className="font-display text-[12px] tracking-[0.18em] text-graphite uppercase">{ability}</div>
      <div
        className={`mt-1.5 font-mono text-[44px] font-bold leading-none ${
          bonus > 0 ? "text-ink" : "text-graphite"
        }`}
      >
        {signed(bonus)}
      </div>
      <div className="my-2.5 h-px bg-rule-faint" />
      <div className="font-display text-[9px] tracking-[0.16em] text-graphite uppercase">Defense</div>
      <div className="font-mono text-[19px] text-indigo">{bonus + 10}</div>
      {dice ? (
        <div className="mt-2 font-mono text-[9.5px] text-graphite">
          {dice.length}d6 → {dice.join(" ")}
        </div>
      ) : null}
    </>
  );

  const shell = `border bg-paper px-3 pb-3.5 pt-4 text-center ${
    chosen ? "border-torch bg-torch-wash" : "border-rule"
  }`;

  return (
    <div className={onClick ? "" : shell}>
      {onClick ? (
        <button type="button" onClick={onClick} aria-pressed={chosen} className={`w-full ${shell} transition-colors hover:border-ink active:bg-desk`}>
          {body}
        </button>
      ) : (
        body
      )}
      {footer}
    </div>
  );
}

export function StepAbilities({
  mode,
  abMode,
  rolls,
  buy,
  swapsLeft,
  swapsMade,
  swapFrom,
  rerollsLeft,
  onAbMode,
  onRerollOne,
  onRerollAll,
  onSwapPick,
  onUndoSwap,
  onBuy,
}: {
  mode: CreationMode;
  abMode: AbilityMode;
  rolls: AbilityRolls;
  buy: CharacterAbilities;
  swapsLeft: number;
  /** The swaps taken, oldest first. Only the last one can be given back. */
  swapsMade: readonly (readonly [Ability, Ability])[];
  swapFrom: Ability | null;
  rerollsLeft: number;
  onAbMode: (m: AbilityMode) => void;
  onRerollOne: (a: Ability) => void;
  onRerollAll: () => void;
  onSwapPick: (a: Ability) => void;
  onUndoSwap: () => void;
  onBuy: (a: Ability, delta: 1 | -1) => void;
}) {
  const rules = CREATION_RULES[mode];
  const left = pointsLeft(buy, mode);
  const swapping = swapsLeft > 0;
  const lastSwap = swapsMade.at(-1);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <StepHeading title="Abilities">
          Six bonuses. Every ability's <em>defense</em> is its bonus plus ten — that is
          the number a foe has to meet, and the number you save against.
        </StepHeading>
        <Toggle options={MODES} value={abMode} onChange={onAbMode} />
      </div>

      {abMode === "roll" ? (
        <>
          <div className="mt-7 grid grid-cols-3 gap-3 lg:grid-cols-6">
            {ABILITIES.map((a) => (
              <Card
                key={a}
                ability={a}
                bonus={rolls[a].bonus}
                dice={rolls[a].dice}
                chosen={swapFrom === a}
                onClick={swapping ? () => onSwapPick(a) : undefined}
                footer={
                  <Button
                    tone="ghost"
                    onClick={() => onRerollOne(a)}
                    disabled={rerollsLeft <= 0}
                    aria-label={`Reroll ${a}`}
                    title={
                      rerollsLeft > 0
                        ? `Costs one of your ${rerollsLeft}`
                        : "No rerolls left"
                    }
                    className="mt-1.5 w-full px-2 py-1.5 text-[11px]"
                  >
                    ↻ Reroll
                  </Button>
                }
              />
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-5">
            <p className="max-w-[62ch] font-prose text-[16px] italic text-graphite">
              {rules.abilityDice === 2 ? "Two" : "Three"} dice each, and you keep the lowest.{" "}
              {swapping
                ? `You may still swap ${swapsLeft === 1 ? "one pair" : "two pairs"} — click a card, then the card you want it traded with.`
                : `${rules.swaps === 1 ? "The swap is" : "Both swaps are"} spent.`}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              {/* Undo hands the swap back rather than costing a second one, so
                  trying an arrangement out is free and only keeping it is not. */}
              {lastSwap ? (
                <Button
                  tone="ghost"
                  onClick={onUndoSwap}
                  className="px-4 py-2.5 text-[13px]"
                >
                  ↩ Undo {lastSwap[0].toUpperCase()}↔{lastSwap[1].toUpperCase()}
                </Button>
              ) : null}
              <Button
                onClick={onRerollAll}
                disabled={rerollsLeft <= 0}
                className="px-5 py-2.5 text-[13px]"
              >
                Reroll all six
              </Button>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="mt-7 grid grid-cols-3 gap-3 lg:grid-cols-6">
            {ABILITIES.map((a) => (
              <Card
                key={a}
                ability={a}
                bonus={buy[a]}
                footer={
                  <div className="mt-1.5 flex items-center justify-center gap-2">
                    <Button
                      tone="ghost"
                      onClick={() => onBuy(a, -1)}
                      disabled={buy[a] <= POINT_BUY.START}
                      aria-label={`Lower ${a}`}
                      className="px-2.5 py-1 text-[12px]"
                    >
                      −
                    </Button>
                    <span className="font-mono text-[10px] text-graphite">
                      {costOfAbility(buy[a])}
                    </span>
                    <Button
                      tone="ghost"
                      onClick={() => onBuy(a, 1)}
                      disabled={!canRaise(buy, a, mode)}
                      aria-label={`Raise ${a}`}
                      className="px-2.5 py-1 text-[12px]"
                    >
                      +
                    </Button>
                  </div>
                }
              />
            ))}
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-6 border border-rule bg-paper px-5 py-4">
            <p className="max-w-[54ch] font-prose text-[17px] text-ink">
              Everything starts at +1. Raising an ability costs half the number you are
              raising it to, rounded down, and nothing goes above{" "}
              {signed(POINT_BUY.MAX)} at level one.
            </p>
            <div className="flex items-baseline gap-2.5">
              <span
                className={`font-mono text-[30px] font-bold ${left === 0 ? "text-graphite" : "text-torch"}`}
              >
                {left}
              </span>
              <span className={LABEL}>Points left</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
