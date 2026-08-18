/**
 * STEP 4 — EQUIPMENT.
 *
 * Two days of rations and a weapon of your choosing, free. Everything after
 * that is rolled, or bought — and buying leaves the player holding 3d6×20
 * copper, which the shop is where they spend. Saving a character with anything
 * in the purse walks straight into it; see `App.tsx`.
 *
 * THE WEAPON IS TWO CHOICES, and only the first is mechanical. A class fixes
 * damage, hands, slots, quality and price; the name on top of it is fiction.
 * The three ranged classes are their own single weapon, so they skip the second
 * question rather than asking it with one answer.
 *
 * THE DICE ARE NOT SHOWN HERE. The engine keeps them — `GearGroup.d20` is what
 * the band tests are written against — but a table result is not a number the
 * player is being asked to check, the way an ability's d6s are. What matters on
 * this screen is what you are carrying and what it costs you in slots.
 *
 * THE SLOT METER IS A BUDGET BEING SPENT, not a bar being filled — the brief is
 * specific about that. Capacity is CON defense, and going over is allowed and
 * flagged rather than refused: the dice gave the player that rope.
 */

import {
  GEAR_SLOT_LABEL,
  WEAPON_CLASSES,
  kitItems,
  weaponsIn,
  type GearSlot,
  type IItem,
  type StartingKit,
  type WeaponClass,
  type WeaponStat,
} from "../../engine/index.ts";
import { Button, LABEL, RerollGlyph, SlotMeter, StepHeading, Toggle } from "./shared.tsx";

export type EquipmentMode = "roll" | "buy";

const MODES = [
  { value: "roll" as const, label: "ROLL GEAR" },
  { value: "buy" as const, label: "BUY INSTEAD" },
];

const classLine = (c: WeaponClass) =>
  `${c.damage} · ${c.ranged ? "ranged" : `${c.hands}h`} · ${c.slots} slot${c.slots === 1 ? "" : "s"}`;

/**
 * What an item is, in the few words a row has space for. A spellbook's effect
 * is a sentence rather than a clause, so it is not one of these — it goes on
 * its own line under the name, where it can be read rather than skimmed past.
 */
function itemNote(item: IItem): string | null {
  if (item.spellBook) return "one spell, once a day";
  if (item.armor?.armorType === "body") return `body armor, defense ${item.armor.defense}`;
  if (item.armor) return "+1 defense";
  return null;
}

export function StepEquipment({
  kit,
  eqMode,
  weapon,
  capacity,
  rerollsLeft,
  onEqMode,
  onWeapon,
  onRerollSlot,
  onRerollAll,
  onRerollCopper,
}: {
  kit: StartingKit;
  eqMode: EquipmentMode;
  weapon: WeaponStat;
  capacity: number;
  rerollsLeft: number;
  onEqMode: (m: EquipmentMode) => void;
  onWeapon: (w: WeaponStat) => void;
  onRerollSlot: (slot: GearSlot) => void;
  onRerollAll: () => void;
  onRerollCopper: () => void;
}) {
  const carried = kitItems(kit);
  const used = carried.reduce((n, i) => n + i.slots, 0);
  const spent = rerollsLeft <= 0;
  const chosenClass = WEAPON_CLASSES.find((c) => c.key === weapon.classKey) ?? WEAPON_CLASSES[0];

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <StepHeading title="Equipment">
          Two days of rations and a weapon of your choosing, free. Everything after
          that is rolled — or bought, if you would rather choose your own poverty.
        </StepHeading>
        <Toggle options={MODES} value={eqMode} onChange={onEqMode} />
      </div>

      <div className="mt-7 grid gap-7 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div>
          <div className={`${LABEL} mb-2.5`}>Your weapon — what kind</div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
            {WEAPON_CLASSES.map((c) => {
              const chosen = c.key === weapon.classKey;
              return (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={chosen}
                  aria-label={`${c.label} weapon`}
                  onClick={() => onWeapon(weaponsIn(c)[0])}
                  className={`p-3 text-left transition-colors ${
                    chosen ? "border-2 border-torch bg-torch-wash" : "border border-rule bg-paper hover:border-ink"
                  }`}
                >
                  <div className="font-prose text-[17px] text-ink">{c.label}</div>
                  <div className="mt-1 font-mono text-[11px] text-graphite">{classLine(c)}</div>
                </button>
              );
            })}
          </div>

          {/* The second question, and only where there is one to ask: a sling
              is a sling. Nothing below this line changes a single number. */}
          {chosenClass.names.length > 1 ? (
            <div className="mt-5">
              <div className={`${LABEL} mb-2.5`} id="weapon-name-label">
                And which one — {chosenClass.label.toLowerCase()}, {classLine(chosenClass)}
              </div>
              <div role="group" aria-labelledby="weapon-name-label" className="flex flex-wrap gap-2.5">
                {weaponsIn(chosenClass).map((w) => {
                  const chosen = w.name === weapon.name;
                  return (
                    <button
                      key={w.name}
                      type="button"
                      aria-pressed={chosen}
                      onClick={() => onWeapon(w)}
                      className={`px-4 py-2 font-prose text-[17px] transition-colors ${
                        chosen
                          ? "border-2 border-torch bg-torch-wash text-ink"
                          : "border border-rule bg-paper text-graphite hover:border-ink hover:text-ink"
                      }`}
                    >
                      {w.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {eqMode === "roll" ? (
            <div className="mt-7">
              <div className="mb-2.5 flex items-baseline justify-between">
                <span className={LABEL}>Rolled on the tables</span>
                <span className="font-mono text-[10.5px] tracking-[0.1em] text-graphite">
                  KNAVE 1.0 · P.2
                </span>
              </div>

              <div className="border border-rule bg-paper">
                {kit.groups.map((g) => (
                  <div key={g.slot} className="border-b border-rule-faint last:border-b-0">
                    {g.items.map((item, i) => (
                      <div
                        key={item.id}
                        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-3.5 px-4 py-2.5"
                      >
                        <span className="font-prose text-[17px] text-ink">
                          {item.name}
                          {item.amount ? <span className="text-graphite"> ({item.amount})</span> : null}
                          {itemNote(item) ? (
                            <span className="text-[14px] text-graphite"> — {itemNote(item)}</span>
                          ) : null}
                          {item.spellBook ? (
                            <span className="mt-0.5 block max-w-[52ch] text-[14px] italic leading-snug text-graphite">
                              {item.spellBook.spellDescription}
                            </span>
                          ) : null}
                        </span>
                        <span className="font-mono text-[13px] text-ink">
                          {item.slots} slot{item.slots === 1 ? "" : "s"}
                        </span>
                        <span className="text-right">
                          {i === 0 ? (
                            <RerollGlyph
                              onClick={() => onRerollSlot(g.slot)}
                              disabled={spent}
                              title={
                                spent
                                  ? "No rerolls left"
                                  : `Reroll ${GEAR_SLOT_LABEL[g.slot]} — costs one of your ${rerollsLeft}`
                              }
                              label={`Reroll ${GEAR_SLOT_LABEL[g.slot]}`}
                            />
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              <div className="mt-3.5 flex flex-wrap items-center gap-4">
                <Button onClick={onRerollAll} disabled={spent} className="px-5 py-2.5 text-[13px]">
                  Reroll the lot
                </Button>
                <p className="font-prose text-[14px] italic text-graphite">
                  {spent
                    ? "No rerolls left. This is what you are taking down."
                    : `${rerollsLeft} reroll${rerollsLeft === 1 ? "" : "s"} left. One table or all six — both cost the same.`}
                </p>
              </div>
            </div>
          ) : (
            <div className="mt-7">
              <div className={`${LABEL} mb-2.5`}>The purse</div>
              <div className="flex flex-wrap items-center justify-between gap-5 border border-rule bg-paper px-5 py-6">
                <div>
                  <div className="font-mono text-[42px] font-bold leading-none text-ink">
                    {kit.copper}
                  </div>
                  <div className={`${LABEL} mt-1.5`}>Copper pennies · 3d6 × 20</div>
                </div>
                <Button
                  onClick={onRerollCopper}
                  disabled={spent}
                  className="px-5 py-2.5 text-[13px]"
                >
                  Reroll
                </Button>
              </div>
              <p className="mt-3.5 max-w-[54ch] font-prose text-[15px] italic leading-relaxed text-graphite">
                No tables. You take the money instead, and the market opens the moment
                this character is saved — everything on the Item Costs page, at the
                price the book prints. What you don't spend, you carry.
              </p>
            </div>
          )}
        </div>

        <aside
          aria-label="What you are carrying"
          className="self-start border border-rule bg-paper p-4 lg:sticky lg:top-0"
        >
          <SlotMeter used={used} capacity={capacity} />
          <div className="my-3.5 h-px bg-rule-faint" />
          <ul className="flex flex-col gap-1.5">
            {carried.map((item) => (
              <li key={item.id} className="flex justify-between gap-3 font-prose text-[15px] text-ink">
                <span>
                  {item.name}
                  {item.amount ? <span className="text-graphite"> ({item.amount})</span> : null}
                </span>
                <span className="font-mono text-[11px] text-graphite">{item.slots}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
