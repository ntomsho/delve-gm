/**
 * CHARACTER CREATION — the flow, and the only thing in it that holds state.
 *
 * Six steps, back-navigable, and **nothing is committed until the last one**.
 * The six steps are the design plan's five with Which rules in front of them;
 * see `StepMode.tsx` for why that is a step rather than a switch.
 *
 * ONE RNG FOR THE WHOLE SESSION. Every roll on every step draws from the same
 * seeded stream, so a reroll advances it rather than restarting it, and a
 * character is a function of its seed and the player's choices. Nothing here
 * calls `Math.random` — that rule holds outside the dungeon too.
 *
 * ONE REROLL BUDGET, SPENT FROM THREE SCREENS. Abilities, hit points and gear
 * all draw on it, traits do not, and the counter lives in the header where the
 * player can see it before spending rather than after. Hardcore starts at zero,
 * which is not a special case anywhere — the buttons are disabled by the same
 * `rerollsLeft <= 0` that a normal character hits on their fourth press.
 *
 * WHAT YOU REVIEW IS WHAT IS SAVED. `preview` is a real `PlayerCharacter` built
 * by `finishCharacter`, and the save button hands that exact object to the
 * store. There is no second construction that could disagree with the sheet.
 */

import { useMemo, useRef, useState } from "react";
import {
  CREATION_RULES,
  bonusesOf,
  buyKit,
  finishCharacter,
  rerollGearSlot,
  rollAbilities,
  rollAbility,
  rollHp,
  rollKit,
  rollName,
  rollTrait,
  rollTraits,
  startingBuy,
  swapAbilities,
  withWeapon,
  type AbilityRolls,
  type GearSlot,
  type HpRoll,
  type StartingKit,
  type TraitKey,
} from "../../rules/knave/character-creation.ts";
import { Rng } from "../../generation/content/blueprint.ts";
import { type Ability } from "../../shared/world/entities.ts";
import {
  type CharacterAbilities,
  type CharacterTraits,
  type CreationMode,
  type PlayerCharacter,
} from "../../rules/knave/character.ts";
import { type WeaponKey } from "../../rules/knave/tables.ts";
import { randomSeed } from "../../generation/seeds.ts";
import { Button } from "./shared.tsx";
import { StepMode } from "./StepMode.tsx";
import { StepAbilities, type AbilityMode } from "./StepAbilities.tsx";
import { StepTraits } from "./StepTraits.tsx";
import { StepHp } from "./StepHp.tsx";
import { StepEquipment, type EquipmentMode } from "./StepEquipment.tsx";
import { StepConfirm } from "./StepConfirm.tsx";

const STEPS = ["Which rules", "Abilities", "Traits", "Hit points", "Equipment", "Name & confirm"] as const;
const LAST = STEPS.length - 1;

/** The picker opens on a sword, which is the middle of the middle class. */
const DEFAULT_WEAPON: WeaponKey = "sword";

interface Draft {
  mode: CreationMode;
  abMode: AbilityMode;
  rolls: AbilityRolls;
  buy: CharacterAbilities;
  /**
   * The swaps taken, oldest first — the pairs, not copies of the spread.
   * `swapAbilities` is its own inverse, so the last pair is all an undo needs.
   */
  swaps: (readonly [Ability, Ability])[];
  /** The card waiting for its partner, mid-swap. */
  swapFrom: Ability | null;
  traits: CharacterTraits;
  hp: HpRoll;
  weapon: WeaponKey;
  eqMode: EquipmentMode;
  /**
   * Both kits are rolled up front and kept. Toggling between them has to be
   * free — a mode switch that re-rolled would be a reroll nobody paid for.
   */
  rolled: StartingKit;
  bought: StartingKit;
  name: string;
  rerollsUsed: number;
  /** Whether any die has been taken yet. Only the mode step reads it. */
  touched: boolean;
}

function freshDraft(rng: Rng, mode: CreationMode): Draft {
  return {
    mode,
    abMode: "roll",
    rolls: rollAbilities(rng, mode),
    buy: startingBuy(),
    swaps: [],
    swapFrom: null,
    traits: rollTraits(rng),
    hp: rollHp(rng, mode),
    weapon: DEFAULT_WEAPON,
    eqMode: "roll",
    rolled: rollKit(rng, DEFAULT_WEAPON),
    bought: buyKit(rng, DEFAULT_WEAPON),
    name: rollName(rng),
    rerollsUsed: 0,
    touched: false,
  };
}

export function CreateCharacter({
  seed,
  onCancel,
  onSave,
}: {
  /**
   * Which character the dice make. Omitted in the app, where every visit to
   * this screen should be a new person; supplied by tests, which otherwise have
   * to assert on whatever six abilities turned up and go flaky on the run where
   * all of them match. Same affordance as `?seed` on a dungeon, for the same
   * reason — a seeded thing you cannot pin is a thing you cannot test.
   */
  seed?: number;
  onCancel: () => void;
  onSave: (pc: PlayerCharacter) => void;
}) {
  // Lazy ref rather than state: the stream is not rendered and must not be
  // rebuilt when anything else changes.
  const rngRef = useRef<Rng>(null);
  if (rngRef.current === null) rngRef.current = new Rng(seed ?? randomSeed());
  const rng = rngRef.current;

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(() => freshDraft(rng, "normal"));

  const rules = CREATION_RULES[draft.mode];
  const rerollsLeft = rules.rerolls - draft.rerollsUsed;
  const swapsLeft = rules.swaps - draft.swaps.length;

  const edit = (f: (d: Draft) => Partial<Draft>) =>
    setDraft((d) => ({ ...d, ...f(d), touched: true }));

  /** Every reroll in the flow goes through here, so the budget cannot be dodged. */
  const spend = (f: (d: Draft) => Partial<Draft>) =>
    setDraft((d) => {
      if (rules.rerolls - d.rerollsUsed <= 0) return d;
      return { ...d, ...f(d), rerollsUsed: d.rerollsUsed + 1, touched: true };
    });

  // --- abilities -----------------------------------------------------------

  const abilities: CharacterAbilities =
    draft.abMode === "roll" ? bonusesOf(draft.rolls) : draft.buy;

  const swapPick = (a: Ability) =>
    edit((d) => {
      if (d.swapFrom === null) return { swapFrom: a };
      if (d.swapFrom === a) return { swapFrom: null };
      return {
        rolls: swapAbilities(d.rolls, d.swapFrom, a),
        swapFrom: null,
        swaps: [...d.swaps, [d.swapFrom, a] as const],
      };
    });

  /**
   * Undo refunds the swap rather than costing another. Trying an arrangement
   * out and disliking it is not a decision the player should have to pay for;
   * only keeping one is. Applying the same pair again restores the spread
   * exactly, because `swapAbilities` is an involution.
   */
  const undoSwap = () =>
    edit((d) => {
      const last = d.swaps.at(-1);
      if (!last) return {};
      return { rolls: swapAbilities(d.rolls, last[0], last[1]), swaps: d.swaps.slice(0, -1), swapFrom: null };
    });

  const buyStep = (a: Ability, delta: 1 | -1) =>
    edit((d) => ({ buy: { ...d.buy, [a]: d.buy[a] + delta } }));

  // --- equipment -----------------------------------------------------------

  const kit = draft.eqMode === "roll" ? draft.rolled : draft.bought;

  /** A weapon change rewrites both kits and disturbs no die. */
  const pickWeapon = (w: WeaponKey) =>
    edit((d) => ({
      weapon: w,
      rolled: withWeapon(d.rolled, rng, w),
      bought: withWeapon(d.bought, rng, w),
    }));

  // --- the sheet -----------------------------------------------------------

  const preview = useMemo(
    () =>
      finishCharacter({
        mode: draft.mode,
        name: draft.name,
        abilities,
        traits: draft.traits,
        hp: draft.hp.hp,
        kit,
      }),
    [draft.mode, draft.name, abilities, draft.traits, draft.hp, kit]
  );

  // No "you have overspent" guard here on purpose. `canRaise` disables the +
  // that would do it and the − stops at +1, so an illegal spread is unreachable
  // from this screen; a branch that can never run would be a lie about what the
  // interface checks. `validatePointBuy` is where that rule is written down, and
  // it is asserted directly in `character-creation.test.ts`.

  return (
    <main className="min-h-screen bg-desk text-ink">
      <div className="mx-auto w-full max-w-[1000px] px-8 pb-20 pt-9">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <button
            type="button"
            onClick={onCancel}
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite transition-colors hover:text-ink active:text-torch"
          >
            ← Characters
          </button>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
            {rules.rerolls === 0 ? (
              "Hardcore · no rerolls"
            ) : (
              <>
                Rerolls left{" "}
                <span className={rerollsLeft > 0 ? "text-torch" : "text-pencil"}>
                  {rerollsLeft} of {rules.rerolls}
                </span>
              </>
            )}
          </span>
        </div>

        <nav className="mb-9 flex items-stretch border-t-2 border-ink border-b border-b-rule">
          {STEPS.map((label, i) => {
            const here = i === step;
            const done = i < step;
            return (
              <button
                key={label}
                type="button"
                onClick={() => setStep(i)}
                aria-current={here ? "step" : undefined}
                className={`flex-1 border-r border-rule-faint px-3.5 py-3 text-left transition-colors last:border-r-0 ${
                  here ? "bg-paper" : "bg-transparent hover:bg-paper/60 active:bg-paper"
                }`}
              >
                <div
                  className={`font-mono text-[10px] tracking-[0.16em] ${
                    here ? "text-torch" : done ? "text-graphite" : "text-pencil"
                  }`}
                >
                  {String(i + 1).padStart(2, "0")}
                </div>
                <div
                  className={`mt-0.5 font-display text-[13.5px] ${
                    here ? "font-medium text-ink" : done ? "text-graphite" : "text-pencil"
                  }`}
                >
                  {label}
                </div>
              </button>
            );
          })}
        </nav>

        {step === 0 ? (
          <StepMode
            mode={draft.mode}
            touched={draft.touched}
            onChange={(m) => {
              if (m === draft.mode) return;
              setDraft(freshDraft(rng, m));
            }}
          />
        ) : null}

        {step === 1 ? (
          <StepAbilities
            mode={draft.mode}
            abMode={draft.abMode}
            rolls={draft.rolls}
            buy={draft.buy}
            swapsLeft={swapsLeft}
            swapsMade={draft.swaps}
            swapFrom={draft.swapFrom}
            rerollsLeft={rerollsLeft}
            onAbMode={(m) => edit(() => ({ abMode: m, swapFrom: null }))}
            // A reroll invalidates the swaps it lands on: the pairs it would
            // undo no longer hold the dice they held. Both spellings clear the
            // history and hand every swap back.
            onRerollOne={(a) =>
              spend((d) => ({ rolls: { ...d.rolls, [a]: rollAbility(rng, d.mode) }, swapFrom: null, swaps: [] }))
            }
            onRerollAll={() => spend((d) => ({ rolls: rollAbilities(rng, d.mode), swapFrom: null, swaps: [] }))}
            onSwapPick={swapPick}
            onUndoSwap={undoSwap}
            onBuy={buyStep}
          />
        ) : null}

        {step === 2 ? (
          <StepTraits
            traits={draft.traits}
            onRerollOne={(k: TraitKey) => edit((d) => ({ traits: { ...d.traits, [k]: rollTrait(k, rng) } }))}
            onRerollAll={() => edit(() => ({ traits: rollTraits(rng) }))}
          />
        ) : null}

        {step === 3 ? (
          <StepHp
            mode={draft.mode}
            roll={draft.hp}
            rerollsLeft={rerollsLeft}
            onReroll={() => spend((d) => ({ hp: rollHp(rng, d.mode) }))}
          />
        ) : null}

        {step === 4 ? (
          <StepEquipment
            kit={kit}
            eqMode={draft.eqMode}
            weapon={draft.weapon}
            capacity={abilities.con + 10}
            rerollsLeft={rerollsLeft}
            onEqMode={(m) => edit(() => ({ eqMode: m }))}
            onWeapon={pickWeapon}
            onRerollSlot={(slot: GearSlot) => spend((d) => ({ rolled: rerollGearSlot(d.rolled, rng, slot) }))}
            onRerollAll={() => spend((d) => ({ rolled: rollKit(rng, d.weapon) }))}
            onRerollCopper={() => spend((d) => ({ bought: buyKit(rng, d.weapon) }))}
          />
        ) : null}

        {step === LAST ? (
          <StepConfirm
            pc={preview}
            name={draft.name}
            onName={(v) => edit(() => ({ name: v }))}
            onRollName={() => edit(() => ({ name: rollName(rng) }))}
            onBack={() => setStep(4)}
            onSave={() => onSave(preview)}
          />
        ) : (
          <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-rule pt-5">
            <Button
              tone="ghost"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0}
              className="px-5 py-3 text-[13px]"
            >
              ← Back
            </Button>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
              Nothing is committed until the last step
            </span>
            <Button
              tone="dark"
              onClick={() => setStep((s) => Math.min(LAST, s + 1))}
              className="px-6 py-3 text-[13px] font-medium"
            >
              Continue →
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
