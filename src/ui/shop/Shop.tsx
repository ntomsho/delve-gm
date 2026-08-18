/**
 * THE SHOP — the market, and the only screen outside a run that spends money.
 *
 * Reached two ways, and they are the same screen: from a character's row on the
 * roster whenever they are not in a run, and straight off the last button of
 * creation for anybody who took the copper instead of rolling gear. The second
 * is why this exists — a purse with nothing to spend it on made buying the
 * thinner half of a choice that was meant to be a real one.
 *
 * NOTHING IS COMMITTED UNTIL THE BUY BUTTON, exactly as in creation. The cart
 * is local, `checkout` is a pure function of the sheet and the cart, and the
 * sheet the parent saves is the one this screen was showing. There is no second
 * construction that could disagree with the counter.
 *
 * SLOTS READ AS LOUDLY AS PRICE. The brief asks for it and Knave means it: a
 * lantern costs 30 copper and a tenth of everything a strong character can
 * carry, and only one of those is felt in a dungeon. Both columns are the same
 * size and weight, and the meter counts the cart as though it were already
 * bought.
 *
 * WHAT THEY ALREADY HAVE IS ON THE SCREEN. The aside lists the pack, because
 * the commonest way to waste a purse is to buy a second crowbar.
 */

import { useState } from "react";
import {
  EMPTY_CART,
  SHOP_DISPLAY,
  addToCart,
  canAffordOneMore,
  cartLines,
  cartSlots,
  cartTotal,
  purse,
  removeFromCart,
  setQty,
  slotCapacity,
  slotsUsed,
  weaponClass,
  checkout,
  type Cart,
  type PlayerCharacter,
  type ShopGood,
} from "../../engine/index.ts";
import { Button, LABEL, SlotMeter } from "../create/shared.tsx";

/** Copper, written the way every other number on these screens is. */
const cp = (n: number) => `${n.toLocaleString()} cp`;

/**
 * What a thing is, in the few words a row has room for. Armor and weapons carry
 * the numbers that decide whether to buy them; a sack does not need a sentence.
 */
function goodNote(good: ShopGood): string | null {
  if (good.armor) {
    return good.armor.armorType === "body"
      ? `body armor · defense ${good.armor.defense} · quality ${good.armor.quality}`
      : `+1 defense · quality ${good.armor.quality}`;
  }
  if (good.weapon) {
    const w = good.weapon;
    return `${w.damage} · ${w.ranged ? "ranged" : `${w.hands} hand${w.hands === 1 ? "" : "s"}`} · quality ${w.quality}`;
  }
  return null;
}

function GoodRow({
  good,
  qty,
  canAdd,
  onAdd,
  onRemove,
}: {
  good: ShopGood;
  qty: number;
  canAdd: boolean;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const note = goodNote(good);

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-4 border-b border-rule-faint px-4 py-2.5 last:border-b-0 ${
        qty > 0 ? "bg-torch-wash" : ""
      }`}
    >
      <span className="font-prose text-[17px] text-ink">
        {good.name}
        {good.amount ? <span className="text-graphite"> ({good.amount})</span> : null}
        {note ? <span className="text-[14px] text-graphite"> — {note}</span> : null}
      </span>

      {/* Slots and price, same size and same weight. Neither is the small print. */}
      <span className="font-mono text-[13px] text-ink">
        {good.slots} slot{good.slots === 1 ? "" : "s"}
      </span>
      <span className="font-mono text-[13px] text-ink">{cp(good.cost)}</span>

      <span className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onRemove}
          disabled={qty === 0}
          aria-label={`One fewer ${good.name}`}
          className="h-6 w-6 border border-rule font-mono text-[13px] leading-none text-graphite transition-colors hover:border-ink hover:text-ink disabled:cursor-not-allowed disabled:border-rule-faint disabled:text-rule"
        >
          −
        </button>
        <span
          className={`w-5 text-center font-mono text-[13px] ${qty > 0 ? "text-ink" : "text-pencil"}`}
        >
          {qty}
        </span>
        <button
          type="button"
          onClick={onAdd}
          disabled={!canAdd}
          aria-label={`One more ${good.name}`}
          title={canAdd ? undefined : "Not enough copper"}
          className="h-6 w-6 border border-ink font-mono text-[13px] leading-none text-ink transition-colors hover:bg-ink hover:text-paper disabled:cursor-not-allowed disabled:border-rule disabled:bg-transparent disabled:text-rule"
        >
          +
        </button>
      </span>
    </div>
  );
}

export function Shop({
  pc,
  onBuy,
  onLeave,
}: {
  pc: PlayerCharacter;
  /** The sheet after buying. The parent saves exactly this. */
  onBuy: (pc: PlayerCharacter) => void;
  onLeave: () => void;
}) {
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [section, setSection] = useState<string>(SHOP_DISPLAY[0].key);

  const held = purse(pc);
  const lines = cartLines(cart);
  const total = cartTotal(cart);
  const change = held - total;
  const capacity = slotCapacity(pc);
  const used = slotsUsed(pc) + cartSlots(cart);
  const open = SHOP_DISPLAY.find((s) => s.key === section) ?? SHOP_DISPLAY[0];

  const row = (good: ShopGood) => (
    <GoodRow
      key={good.key}
      good={good}
      qty={cart[good.key] ?? 0}
      canAdd={canAffordOneMore(pc, cart, good)}
      onAdd={() => setCart((c) => addToCart(c, good.key))}
      onRemove={() => setCart((c) => removeFromCart(c, good.key))}
    />
  );

  /**
   * The weapons table is drawn by class, the way the creation step asks for one:
   * the class is every number that matters and the names inside it are the same
   * weapon called different things.
   */
  const weaponBlocks = () => {
    const classes = [...new Set(open.goods.map((g) => g.weapon?.classKey))].filter(
      (k): k is NonNullable<typeof k> => k !== undefined
    );
    return classes.map((key) => {
      const c = weaponClass(key);
      return (
        <div key={key} className="border-b border-rule last:border-b-0">
          <div className="flex items-baseline justify-between gap-4 bg-desk px-4 py-2">
            <span className="font-display text-[13px] tracking-[0.1em] text-ink">{c.label}</span>
            <span className="font-mono text-[11px] text-graphite">
              {c.damage} · {c.ranged ? "ranged" : `${c.hands}h`} · {c.slots} slot
              {c.slots === 1 ? "" : "s"} · {cp(c.cost)}
            </span>
          </div>
          {open.goods.filter((g) => g.weapon?.classKey === key).map(row)}
        </div>
      );
    });
  };

  return (
    <main className="min-h-screen bg-desk text-ink">
      <div className="mx-auto w-full max-w-[1000px] px-8 pb-20 pt-9">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <button
            type="button"
            onClick={onLeave}
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite transition-colors hover:text-ink"
          >
            ← Characters
          </button>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
            Knave 1.0 · Item costs
          </span>
        </div>

        <header className="border-b border-rule pb-5">
          <h1 className="font-prose text-[46px] font-semibold leading-none text-ink">The market</h1>
          <p className="mt-2 max-w-[62ch] font-prose text-[17px] leading-relaxed text-graphite">
            {held > 0 ? (
              <>
                {pc.name} has {cp(held)} to spend, and everything bought has to be carried
                down.
              </>
            ) : (
              <>
                {pc.name}'s purse is empty. The prices stand for the next time it is not —
                nothing here is going anywhere.
              </>
            )}
          </p>
        </header>

        <div className="mt-7 grid gap-7 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div>
            <nav className="flex flex-wrap gap-2">
              {SHOP_DISPLAY.map((s) => {
                const here = s.key === open.key;
                return (
                  <button
                    key={s.key}
                    type="button"
                    aria-pressed={here}
                    onClick={() => setSection(s.key)}
                    className={`px-4 py-2 font-display text-[12.5px] tracking-[0.1em] transition-colors ${
                      here
                        ? "border-2 border-torch bg-torch-wash text-ink"
                        : "border border-rule bg-paper text-graphite hover:border-ink hover:text-ink"
                    }`}
                  >
                    {s.label}
                  </button>
                );
              })}
            </nav>

            <div className="mt-5">
              <div className="mb-2.5 flex items-baseline justify-between gap-4">
                <span className={LABEL}>{open.label}</span>
                {open.note ? (
                  <span className="font-prose text-[14px] italic text-graphite">{open.note}</span>
                ) : null}
              </div>

              <div className="border border-rule bg-paper">
                {open.key === "weapons" ? weaponBlocks() : open.goods.map(row)}
              </div>
            </div>
          </div>

          <aside
            aria-label="The counter"
            className="self-start border border-rule bg-paper p-4 lg:sticky lg:top-0"
          >
            <div className="mb-2.5 flex items-baseline justify-between">
              <span className={LABEL}>Purse</span>
              <span className="font-mono text-[12px] text-graphite">3d6 × 20</span>
            </div>
            <div className="font-mono text-[34px] font-bold leading-none text-ink">
              {change.toLocaleString()}
            </div>
            <div className={`${LABEL} mt-1.5`}>
              {total > 0 ? `Copper left of ${held.toLocaleString()}` : "Copper pennies"}
            </div>

            <div className="my-3.5 h-px bg-rule-faint" />
            <SlotMeter used={used} capacity={capacity} />

            <div className="my-3.5 h-px bg-rule-faint" />
            <div className={`${LABEL} mb-2`}>On the counter</div>
            {lines.length === 0 ? (
              <p className="font-prose text-[15px] italic leading-snug text-pencil">
                Nothing yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {lines.map((l) => (
                  <li
                    key={l.good.key}
                    className="flex items-baseline justify-between gap-3 font-prose text-[15px] text-ink"
                  >
                    <button
                      type="button"
                      onClick={() => setCart((c) => setQty(c, l.good.key, 0))}
                      title={`Put back the ${l.good.name.toLowerCase()}`}
                      aria-label={`Put back ${l.good.name}`}
                      className="text-left transition-colors hover:text-torch"
                    >
                      {l.qty > 1 ? `${l.qty} × ` : ""}
                      {l.good.name}
                    </button>
                    <span className="font-mono text-[11px] text-graphite">{cp(l.cost)}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 flex flex-col gap-2">
              <Button
                tone="primary"
                disabled={lines.length === 0}
                onClick={() => onBuy(checkout(pc, cart).pc)}
                className="px-5 py-3 text-[14px]"
              >
                {lines.length === 0 ? "Buy" : `Buy · ${cp(total)}`}
              </Button>
              <Button tone="ghost" onClick={onLeave} className="px-5 py-2.5 text-[12px]">
                {lines.length === 0 ? "Done" : "Leave it all"}
              </Button>
            </div>

            <div className="my-3.5 h-px bg-rule-faint" />
            <div className={`${LABEL} mb-2`}>Already carrying</div>
            <ul className="flex flex-col gap-1.5">
              {pc.inventory.map((item) => (
                <li
                  key={item.id}
                  className="flex justify-between gap-3 font-prose text-[15px] text-graphite"
                >
                  <span>
                    {item.name}
                    {item.amount ? <span className="text-pencil"> ({item.amount})</span> : null}
                  </span>
                  <span className="font-mono text-[11px] text-pencil">{item.slots}</span>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </div>
    </main>
  );
}
