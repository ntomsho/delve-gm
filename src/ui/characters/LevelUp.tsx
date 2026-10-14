/**
 * LEVELLING UP — the one modal in the game.
 *
 * Everything else outside a run is a screen you go to. This is not: it is a
 * short, committing exchange about a character whose row you are already
 * looking at, and taking the player somewhere else and bringing them back would
 * be more travel than the decision is worth. So it comes up over the roster,
 * with the row still behind it.
 *
 * TWO THINGS HAPPEN, IN ORDER, and Knave says both:
 *
 *   the dice     a number of d8s equal to the NEW level, for a new hit point
 *                maximum — and a point instead when they come in short
 *   the raises   three different abilities, one point each, none past +10
 *
 * NOTHING IS COMMITTED UNTIL CONFIRM, exactly as in creation and at the shop.
 * The sheet the parent saves is built here by `applyLevelUp` from the roll and
 * the picks on the screen, so there is no second construction that could
 * disagree with what the player was shown.
 *
 * THE ROLL IS NOT A REROLL. Pressing the button reveals dice that `levelUpSeed`
 * had already decided — closing this and opening it again finds the same ones,
 * which is why cancelling is free and why there is no reroll control to argue
 * about. The reveal is a beat, not a decision.
 *
 * ONE LEVEL AT A TIME. A character back from a size 5 dungeon may be owed three;
 * each is its own handful of dice and its own three raises, so this closes after
 * one and the row offers the button again.
 */

import { useEffect, useState } from "react";
import { ABILITIES } from "../../rules/knave/character-creation.ts";
import {
  ABILITY_MAX,
  applyLevelUp,
  levelUpRoll,
  nextLevel,
  pendingLevels,
  raisableAbilities,
  requiredRaises,
  type LevelUpRoll,
} from "../../rules/knave/level-up.ts";
import { slotCapacity, type PlayerCharacter } from "../../rules/knave/character.ts";
import { type Ability } from "../../shared/world/entities.ts";
import { Button, LABEL, MONO_LABEL, signed } from "../create/shared.tsx";

const ABILITY_NAME: Record<Ability, string> = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

/** What the dice did, in a sentence. The floor is never printed as if it rolled. */
function hpComment(roll: LevelUpRoll, previousMax: number): string {
  if (roll.floored) {
    return `The dice said ${roll.total}, which is no better than the ${previousMax} you had. The rule gives you the point instead.`;
  }
  const gain = roll.hpMax - previousMax;
  if (gain <= 2) return `${gain} more than you had. It is not nothing, and it is not much.`;
  if (gain >= 8) return `${gain} more than you had — the kind of roll that changes what you are willing to walk into.`;
  return `${gain} more than you had. Another mistake's worth.`;
}

/**
 * One ability, and what pressing it would do to it.
 *
 * The defense is on the card because that is the number a foe has to meet and
 * the number a save is made against — the same reasoning as the creation step's
 * cards, which is also where the shape comes from.
 */
function AbilityCard({
  ability,
  bonus,
  chosen,
  atCap,
  onClick,
}: {
  ability: Ability;
  bonus: number;
  chosen: boolean;
  atCap: boolean;
  onClick: () => void;
}) {
  const shown = chosen ? bonus + 1 : bonus;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={atCap}
      aria-pressed={chosen}
      aria-label={ABILITY_NAME[ability]}
      title={atCap ? `${ABILITY_NAME[ability]} is at the ceiling, +${ABILITY_MAX}` : undefined}
      className={`border bg-paper px-3 pb-3 pt-3.5 text-center transition-colors ${
        atCap
          ? "border-rule-faint bg-transparent"
          : chosen
            ? "border-torch bg-torch-wash active:border-torch-deep"
            : "border-rule hover:border-ink active:bg-desk"
      }`}
    >
      <div className="font-display text-[11px] uppercase tracking-[0.18em] text-graphite">
        {ability}
      </div>

      <div
        className={`mt-1 font-mono text-[34px] font-bold leading-none ${
          atCap ? "text-pencil" : chosen ? "text-torch" : "text-ink"
        }`}
      >
        {signed(shown)}
      </div>

      <div className="my-2 h-px bg-rule-faint" />

      <div className="font-display text-[9px] uppercase tracking-[0.16em] text-graphite">Defense</div>
      <div className={`font-mono text-[16px] ${chosen ? "text-torch-deep" : "text-indigo"}`}>
        {shown + 10}
      </div>

      {/* What it was, said only when it is about to be something else — a card
          printing "was +3" under a +3 is noise on five cards out of six. */}
      <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-pencil">
        {atCap ? "At the ceiling" : chosen ? `was ${signed(bonus)}` : " "}
      </div>
    </button>
  );
}

export function LevelUp({
  pc,
  onCancel,
  onConfirm,
}: {
  pc: PlayerCharacter;
  onCancel(): void;
  /** The finished sheet, one level on. The parent saves it. */
  onConfirm(next: PlayerCharacter): void;
}) {
  const [roll, setRoll] = useState<LevelUpRoll>();
  const [picked, setPicked] = useState<Ability[]>([]);

  const level = nextLevel(pc);
  const wanted = requiredRaises(pc);
  const raisable = new Set(raisableAbilities(pc));
  const owed = pendingLevels(pc);
  const ready = roll !== undefined && picked.length === wanted;

  // Escape is the way out of everything in this game that covers the page.
  // Nothing here is saved until Confirm and the dice do not change, so leaving
  // costs the player nothing at all.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  /**
   * Pressing a chosen card takes it back, and pressing a fourth is refused
   * rather than quietly dropping the oldest — three is a choice the player is
   * making, and a control that silently undoes an earlier press is one they
   * cannot trust. The cards past the third read as dead because they are.
   */
  const toggle = (a: Ability) =>
    setPicked((cur) =>
      cur.includes(a) ? cur.filter((x) => x !== a) : cur.length >= wanted ? cur : [...cur, a]
    );

  const commit = () => {
    if (roll === undefined || picked.length !== wanted) return;
    onConfirm(applyLevelUp(pc, { roll, raises: picked }));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      style={{ background: "rgba(34, 32, 28, 0.55)" }}
      role="dialog"
      aria-modal="true"
      aria-label={`${pc.name} reaches level ${level}`}
      // The scrim is a way out, and only the scrim: a click that started inside
      // the sheet and ended on the backdrop is a drag, not a dismissal.
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="my-auto w-full max-w-[40rem] border-2 border-ink bg-paper px-5 py-5 shadow-[6px_6px_0_var(--color-ink)] sm:px-8 sm:py-7">
        <div className={MONO_LABEL}>Levelling up</div>
        <h2 className="mt-1.5 font-prose text-[32px] font-semibold leading-tight text-ink">
          {pc.name} reaches level {level}
        </h2>
        <p className="mt-1.5 max-w-[52ch] font-prose text-[15px] leading-relaxed text-graphite">
          {(pc.xp ?? 0).toLocaleString()} XP earned.{" "}
          {owed > 1
            ? `${owed} levels are owed — this is the first of them, and the rest are waiting when you are done.`
            : "This is what it buys: a new hit point maximum, and three abilities a point better."}
        </p>

        {/* ------------------------------------------------------------------
            THE DICE */}
        <div className="mt-7 border-t border-rule pt-5">
          <div className={LABEL}>Your new maximum</div>

          {roll === undefined ? (
            <div className="mt-3 flex flex-wrap items-center gap-5">
              <Button
                tone="primary"
                onClick={() => setRoll(levelUpRoll(pc))}
                className="px-6 py-3 text-[14px]"
              >
                Roll {level}d8
              </Button>
              <p className="max-w-[38ch] font-prose text-[15px] leading-snug text-graphite">
                {level}d8 against the {pc.hp.max} you have. Come in short and you get a point
                anyway — but only a point.
              </p>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-6">
              <div className="flex h-[92px] w-[92px] shrink-0 items-center justify-center border-2 border-ink bg-paper shadow-[4px_4px_0_var(--color-ink)]">
                <span className="font-mono text-[44px] font-bold leading-none text-ink">
                  {roll.hpMax}
                </span>
              </div>

              <div className="min-w-0 flex-1">
                <div className={MONO_LABEL}>
                  {level}d8 → {roll.dice.join(" ")} = {roll.total}
                  {roll.floored ? `, raised to ${roll.hpMax}` : ""}
                </div>
                <p className="mt-2 max-w-[40ch] font-prose text-[15px] leading-snug text-graphite">
                  {hpComment(roll, pc.hp.max)}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ------------------------------------------------------------------
            THE RAISES */}
        <div className="mt-7 border-t border-rule pt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <span className={LABEL}>
              {wanted === 1 ? "One ability" : `${wanted} different abilities`}, a point each
            </span>
            <span
              className={`font-mono text-[11px] tracking-[0.08em] ${
                picked.length === wanted ? "text-graphite" : "text-torch"
              }`}
            >
              {picked.length} of {wanted} chosen
            </span>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2.5 sm:grid-cols-6">
            {ABILITIES.map((a) => (
              <AbilityCard
                key={a}
                ability={a}
                bonus={pc.abilities[a]}
                chosen={picked.includes(a)}
                atCap={!raisable.has(a)}
                onClick={() => toggle(a)}
              />
            ))}
          </div>

          {/* CON IS NOT ONLY A DEFENSE, and the one place that bites is the
              pack: capacity is CON defense, so raising it is a slot. Said here
              because nothing else on this screen would say it. */}
          {picked.includes("con") && (
            <p className="mt-3 font-prose text-[14px] leading-snug text-graphite">
              Constitution is what you can carry: {slotCapacity(pc)} slots becomes{" "}
              {slotCapacity(pc) + 1}.
            </p>
          )}

          {wanted < 3 && (
            <p className="mt-3 font-prose text-[14px] leading-snug text-graphite">
              Knave stops an ability at +{ABILITY_MAX}, and you are there in all but{" "}
              {wanted === 1 ? "one of them" : `${wanted} of them`}. The rest of this level goes
              nowhere.
            </p>
          )}
        </div>

        {/* ------------------------------------------------------------------
            THE COMMITMENT */}
        <div className="mt-7 flex flex-wrap items-center gap-3 border-t border-rule pt-5">
          <span className="min-w-0 flex-1 font-prose text-[14px] leading-snug text-graphite">
            {ready
              ? "Nothing is saved until you take it."
              : roll === undefined
                ? "Roll first."
                : `Choose ${wanted - picked.length} more.`}
          </span>
          <Button tone="ghost" onClick={onCancel} className="px-5 py-2.5 text-[13px]">
            Not now
          </Button>
          <Button
            tone="primary"
            onClick={commit}
            disabled={!ready}
            className="px-6 py-2.5 text-[13px]"
          >
            Take the level
          </Button>
        </div>
      </div>
    </div>
  );
}
