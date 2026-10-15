/**
 * STEP 0 — WHICH RULES.
 *
 * Not in the design plan, which predates the two modes. It is a step of its own
 * rather than a switch in the header because it changes four numbers across
 * three later steps, and a control that quietly rewrites the screens after it
 * should be a screen itself.
 *
 * Changing it starts the character again. That is the honest behaviour and it
 * is also the one that cannot be gamed: a mode switch that kept the sheet would
 * be a way to roll hit points under normal, bank the 8, and finish as a
 * hardcore character with three rerolls that were never spent.
 */

import { CREATION_MODES, CREATION_RULES } from "../../rules/knave/character-creation.ts";
import type { CreationMode } from "../../rules/knave/character.ts";
import { LABEL, StepHeading } from "./shared.tsx";

const BLURB: Record<CreationMode, string> = {
  normal:
    "The forgiving read. Two dice an ability and you keep the lower, ten points if you would rather choose, and three rerolls to spend wherever you like.",
  hardcore:
    "Knave as written, and then some. Three dice an ability, still keeping the lower — so most abilities land on +2. Seven points, one swap, and no rerolls at all. What the dice say is what you take down there.",
};

function line(mode: CreationMode): { label: string; value: string }[] {
  const r = CREATION_RULES[mode];
  return [
    { label: "Ability dice", value: `${r.abilityDice}d6, keep lowest` },
    { label: "Swaps", value: `${r.swaps}` },
    { label: "Point buy", value: `${r.pointBuy} points` },
    { label: "Rerolls", value: r.rerolls === 0 ? "none" : `${r.rerolls}` },
  ];
}

export function StepMode({
  mode,
  touched,
  onChange,
}: {
  mode: CreationMode;
  /** Whether anything has been rolled yet, which is what makes a change costly. */
  touched: boolean;
  onChange: (m: CreationMode) => void;
}) {
  return (
    <div>
      <StepHeading title="Which rules">
        Two ways to make someone. Neither is easier to play — the dungeon does not
        know which you picked — but one of them hands you rather less to go in with.
      </StepHeading>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {CREATION_MODES.map((m) => {
          const chosen = m === mode;
          return (
            <button
              key={m}
              type="button"
              aria-pressed={chosen}
              onClick={() => onChange(m)}
              className={`border p-6 text-left transition-colors ${
                chosen ? "border-torch bg-torch-wash" : "border-rule bg-paper hover:border-ink active:bg-desk"
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-prose text-[26px] font-semibold capitalize text-ink">{m}</span>
                {chosen ? <span className={LABEL}>Chosen</span> : null}
              </div>

              <p className="mt-2 font-prose text-[15px] leading-relaxed text-graphite">{BLURB[m]}</p>

              <dl className="mt-5 space-y-1.5 border-t border-rule-faint pt-4">
                {line(m).map(({ label, value }) => (
                  <div key={label} className="flex items-baseline justify-between gap-4">
                    <dt className="font-display text-[10px] uppercase tracking-[0.16em] text-graphite">
                      {label}
                    </dt>
                    <dd className="font-mono text-[12px] text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
            </button>
          );
        })}
      </div>

      {touched ? (
        <p className="mt-6 font-prose text-[15px] italic text-torch">
          Changing this now rolls a new character. The dice you have already taken go
          with it.
        </p>
      ) : null}
    </div>
  );
}
