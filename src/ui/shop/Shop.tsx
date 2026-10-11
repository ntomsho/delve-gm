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
 * the commonest way to waste a purse is to buy a second crowbar. What is on the
 * block is struck through there, so the pack and the counter never disagree
 * about what is still theirs.
 *
 * SELLING IS A TABLE LIKE ANY OTHER, and it is the last tab rather than a
 * separate screen: money made and money spent settle at the same button, and a
 * player selling a gambeson to afford brigandine should never have to leave and
 * come back. `sold` is a list of ids beside the cart and is just as uncommitted;
 * `checkout` takes both. Prices are the engine's — half of store for equipment,
 * all of it for treasure — and the reason is in `shop.ts`.
 *
 * SELL ALL TREASURE SAYS THE NUMBER. A player who has come up with eleven
 * carved things wants one click and wants to know what it pays before they make
 * it, so the button carries the total of what it would put on the block, and
 * counts down as rows go on individually.
 */

import { useRef, useState } from "react";
import {
  EMPTY_CART,
  EMPTY_SOLD,
  Rng,
  SHOP_DISPLAY,
  WEAPON_CLASSES,
  addToCart,
  armorFacts,
  canAffordOneMore,
  cartLines,
  cartSlots,
  cartTotal,
  proceeds,
  purse,
  removeFromCart,
  sellOffers,
  setQty,
  slotCapacity,
  slotsUsed,
  soldLines,
  soldSlots,
  toggleSold,
  treasureOffers,
  weaponFacts,
  checkout,
  type Cart,
  type PlayerCharacter,
  type SellOffer,
  type ShopGood,
  type Sold,
} from "../../engine/index.ts";
import { randomSeed } from "../../runtime/seeds.ts";
import { Button, LABEL, SlotMeter } from "../create/shared.tsx";

/** Copper, written the way every other number on these screens is. */
const cp = (n: number) => `${n.toLocaleString()} cp`;

/**
 * The one tab that is not a `SHOP_DISPLAY` section. It sits in the same nav
 * because it is the same counter; it is a string beside the section keys rather
 * than a second piece of state because exactly one table is ever open.
 */
const SELL_TAB = "sell";

/**
 * What a thing is, in the few words a row has room for. Armor and weapons carry
 * the numbers that decide whether to buy them; a sack does not need a sentence.
 */
function goodNote(good: ShopGood): string | null {
  const quality = good.template.quality;
  const armor = armorFacts(good.key);
  if (armor) {
    return armor.armorType === "body"
      ? `body armor · defense ${armor.defense} · quality ${quality}`
      : `+1 defense · quality ${quality}`;
  }
  const w = weaponFacts(good.key);
  if (w) {
    const hands = w.hands ?? 1;
    return `${w.damage} · ${w.ranged ? "ranged" : `${hands} hand${hands === 1 ? "" : "s"}`} · quality ${quality}`;
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
          className="h-6 w-6 border border-rule font-mono text-[13px] leading-none text-graphite transition-colors hover:border-ink hover:text-ink active:bg-desk active:text-ink disabled:border-rule-faint disabled:text-rule"
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
          className="h-6 w-6 border border-ink font-mono text-[13px] leading-none text-ink transition-colors hover:bg-ink hover:text-paper active:bg-graphite active:text-paper disabled:border-rule disabled:bg-transparent disabled:text-rule"
        >
          +
        </button>
      </span>
    </div>
  );
}

/**
 * One thing in the pack, with what the counter will give for it.
 *
 * A TOGGLE, NOT A COUNTER. Every carried thing is its own object with its own
 * name and its own quality, so there is no "two of these" to press twice; the
 * control is on or off and says which in its own label.
 *
 * WHAT IT WOULD HAVE COST IS SHOWN BESIDE WHAT IT FETCHES, for equipment only,
 * because "30 cp" against a lantern the player remembers paying 60 for reads as
 * a mistake until the 60 is on the row next to it. Treasure is not halved and
 * has nothing to compare against, so it gets one number.
 */
function SellRow({
  offer,
  chosen,
  onToggle,
}: {
  offer: SellOffer;
  chosen: boolean;
  onToggle: () => void;
}) {
  const { item, kind, offer: pays, worth } = offer;
  const nothingDoing = pays === 0;

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-4 border-b border-rule-faint px-4 py-2.5 last:border-b-0 ${
        chosen ? "bg-torch-wash" : ""
      }`}
    >
      <span
        className={`font-prose text-[17px] ${chosen ? "text-graphite line-through" : "text-ink"}`}
      >
        {item.name}
        {item.amount ? <span className="text-graphite"> ({item.amount})</span> : null}
        <span className="text-[14px] text-graphite">
          {" "}
          — {kind === "equipment" ? "equipment · half of store" : "treasure · full value"}
        </span>
      </span>

      <span className="font-mono text-[13px] text-ink">
        {item.slots} slot{item.slots === 1 ? "" : "s"}
      </span>
      <span className="font-mono text-[13px] text-ink">
        {nothingDoing ? (
          <span className="text-pencil">no offer</span>
        ) : (
          <>
            {kind === "equipment" ? (
              <span className="text-pencil line-through">{worth.toLocaleString()}</span>
            ) : null}{" "}
            {cp(pays)}
          </>
        )}
      </span>

      <button
        type="button"
        onClick={onToggle}
        disabled={nothingDoing}
        aria-pressed={chosen}
        aria-label={`${chosen ? "Keep" : "Sell"} ${item.name}`}
        title={nothingDoing ? "Nobody here wants it" : undefined}
        className={`h-6 px-2 border font-mono text-[11px] uppercase tracking-[0.1em] leading-none transition-colors active:bg-desk disabled:border-rule-faint disabled:bg-transparent disabled:text-rule ${
          chosen
            ? "border-torch bg-torch-wash text-ink"
            : "border-ink text-ink hover:bg-ink hover:text-paper"
        }`}
      >
        {chosen ? "On the block" : "Sell"}
      </button>
    </div>
  );
}

export function Shop({
  pc,
  onBuy,
  onLeave,
  seed,
}: {
  pc: PlayerCharacter;
  /** The sheet after buying. The parent saves exactly this. */
  onBuy: (pc: PlayerCharacter) => void;
  onLeave: () => void;
  /**
   * The stream a purchase draws from — a book rolls for what is in it, so even
   * a shop needs one. Pinnable for the same reason creation's is: a seeded
   * thing you cannot fix is a thing you cannot test.
   */
  seed?: number;
}) {
  const rngRef = useRef<Rng>(null);
  if (rngRef.current === null) rngRef.current = new Rng(seed ?? randomSeed());
  const rng = rngRef.current;

  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [sold, setSold] = useState<Sold>(EMPTY_SOLD);
  const [section, setSection] = useState<string>(SHOP_DISPLAY[0].key);

  const held = purse(pc);
  const lines = cartLines(cart);
  const total = cartTotal(cart);
  const earned = proceeds(pc, sold);
  const onTheBlock = soldLines(pc, sold);
  const change = held + earned - total;
  const capacity = slotCapacity(pc);
  // Both directions. Selling the chain gives three slots back before the cart
  // is weighed, which is the order the transaction actually happens in.
  const used = slotsUsed(pc) - soldSlots(pc, sold) + cartSlots(cart);
  const open = SHOP_DISPLAY.find((s) => s.key === section) ?? SHOP_DISPLAY[0];
  const atTheBlock = section === SELL_TAB;

  const offers = sellOffers(pc);
  const chosen = new Set(sold);
  // What "sell all" would still add — it counts down as rows go on one at a
  // time, so the number on the button is always what pressing it pays.
  const restOfTheTreasure = treasureOffers(pc).filter((o) => !chosen.has(o.item.id));
  const restOfTheTreasurePays = restOfTheTreasure.reduce((n, o) => n + o.offer, 0);
  const nothingOnTheCounter = lines.length === 0 && onTheBlock.length === 0;
  /** What the whole pack would fetch, for the one line of prose that needs to know. */
  const sellable = offers.reduce((n, o) => n + o.offer, 0);

  const row = (good: ShopGood) => (
    <GoodRow
      key={good.key}
      good={good}
      qty={cart[good.key] ?? 0}
      canAdd={canAffordOneMore(pc, cart, good, sold)}
      onAdd={() => setCart((c) => addToCart(c, good.key))}
      onRemove={() => setCart((c) => removeFromCart(c, good.key))}
    />
  );

  const sellRow = (o: SellOffer) => (
    <SellRow
      key={o.item.id}
      offer={o}
      chosen={chosen.has(o.item.id)}
      onToggle={() => setSold((cur) => toggleSold(cur, o.item.id))}
    />
  );

  /**
   * The pack, treasure first. Treasure is what a player who has just come up
   * from a run is here to turn into money, and equipment is what they are here
   * to keep — putting the answer above the question saves a scroll on the one
   * screen where it matters.
   */
  const sellBlocks = () => {
    if (offers.length === 0) {
      return (
        <p className="px-4 py-4 font-prose text-[15px] italic text-pencil">
          {pc.name} is carrying nothing anybody here would buy.
        </p>
      );
    }
    return (["treasure", "equipment"] as const).map((kind) => {
      const group = offers.filter((o) => o.kind === kind);
      if (group.length === 0) return null;
      const pays = group.reduce((n, o) => n + o.offer, 0);
      return (
        <div key={kind} className="border-b border-rule last:border-b-0">
          <div className="flex items-baseline justify-between gap-4 bg-desk px-4 py-2">
            <span className="font-display text-[13px] tracking-[0.1em] text-ink">
              {kind === "treasure" ? "Treasure" : "Equipment"}
            </span>
            <span className="font-mono text-[11px] text-graphite">
              {kind === "treasure" ? "sells for what it is worth" : "sells for half of store"} ·{" "}
              {cp(pays)} in all
            </span>
          </div>
          {group.map(sellRow)}
        </div>
      );
    });
  };

  /**
   * The weapons table is drawn by class, the way the creation step asks for one:
   * the class is every number that matters and the names inside it are the same
   * weapon called different things.
   */
  const weaponBlocks = () =>
    WEAPON_CLASSES.map((c) => {
      const goods = open.goods.filter((g) => (c.members as readonly string[]).includes(g.key));
      if (goods.length === 0) return null;
      const first = goods[0];
      const w = weaponFacts(first.key);
      return (
        <div key={c.key} className="border-b border-rule last:border-b-0">
          <div className="flex items-baseline justify-between gap-4 bg-desk px-4 py-2">
            <span className="font-display text-[13px] tracking-[0.1em] text-ink">{c.label}</span>
            <span className="font-mono text-[11px] text-graphite">
              {w?.damage} · {w?.ranged ? "ranged" : `${w?.hands ?? 1}h`} · {first.slots} slot
              {first.slots === 1 ? "" : "s"} · {cp(first.cost)}
            </span>
          </div>
          {goods.map(row)}
        </div>
      );
    });

  return (
    <main className="min-h-screen bg-desk text-ink">
      <div className="mx-auto w-full max-w-[1000px] px-8 pb-20 pt-9">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <button
            type="button"
            onClick={onLeave}
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite transition-colors hover:text-ink active:text-torch"
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
                down. The counter buys as well — treasure at what it is worth, gear at half
                of what it costs.
              </>
            ) : sellable > 0 ? (
              <>
                {pc.name}'s purse is empty, but the pack is not. The counter pays what
                treasure is worth and half of store for gear.
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
                const here = !atTheBlock && s.key === open.key;
                return (
                  <button
                    key={s.key}
                    type="button"
                    aria-pressed={here}
                    onClick={() => setSection(s.key)}
                    className={`px-4 py-2 font-display text-[12.5px] tracking-[0.1em] transition-colors ${
                      here
                        ? "border-2 border-torch bg-torch-wash text-ink"
                        : "border border-rule bg-paper text-graphite hover:border-ink hover:text-ink active:bg-desk"
                    }`}
                  >
                    {s.label}
                  </button>
                );
              })}

              {/* Selling, set off by the gap: it is the counter looking the
                  other way, not a sixth shelf. */}
              <button
                type="button"
                aria-pressed={atTheBlock}
                onClick={() => setSection(SELL_TAB)}
                className={`ml-auto px-4 py-2 font-display text-[12.5px] tracking-[0.1em] transition-colors ${
                  atTheBlock
                    ? "border-2 border-torch bg-torch-wash text-ink"
                    : "border border-rule bg-paper text-graphite hover:border-ink hover:text-ink active:bg-desk"
                }`}
              >
                Sell
              </button>
            </nav>

            <div className="mt-5">
              <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-4">
                <span className={LABEL}>{atTheBlock ? "What they are carrying" : open.label}</span>
                {atTheBlock ? (
                  <button
                    type="button"
                    onClick={() =>
                      setSold((cur) =>
                        restOfTheTreasure.reduce((acc, o) => toggleSold(acc, o.item.id), cur)
                      )
                    }
                    disabled={restOfTheTreasure.length === 0}
                    className="border border-ink px-3 py-1.5 font-display text-[12.5px] tracking-[0.1em] text-ink transition-colors hover:bg-ink hover:text-paper active:bg-graphite active:text-paper disabled:border-rule disabled:bg-transparent disabled:text-rule"
                  >
                    {restOfTheTreasure.length === 0
                      ? treasureOffers(pc).length === 0
                        ? "No treasure to sell"
                        : "All treasure on the block"
                      : `Sell all treasure · +${cp(restOfTheTreasurePays)}`}
                  </button>
                ) : open.note ? (
                  <span className="font-prose text-[14px] italic text-graphite">{open.note}</span>
                ) : null}
              </div>

              <div className="border border-rule bg-paper">
                {atTheBlock
                  ? sellBlocks()
                  : open.key === "weapons"
                    ? weaponBlocks()
                    : open.goods.map(row)}
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
              {total > 0
                ? `Copper left of ${held.toLocaleString()}`
                : earned > 0
                  ? `Copper, up from ${held.toLocaleString()}`
                  : "Copper pennies"}
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
                      className="text-left transition-colors hover:text-torch active:text-torch-deep"
                    >
                      {l.qty > 1 ? `${l.qty} × ` : ""}
                      {l.good.name}
                    </button>
                    <span className="font-mono text-[11px] text-graphite">{cp(l.cost)}</span>
                  </li>
                ))}
              </ul>
            )}

            {onTheBlock.length > 0 ? (
              <>
                <div className="my-3.5 h-px bg-rule-faint" />
                <div className={`${LABEL} mb-2`}>On the block</div>
                <ul className="flex flex-col gap-1.5">
                  {onTheBlock.map((o) => (
                    <li
                      key={o.item.id}
                      className="flex items-baseline justify-between gap-3 font-prose text-[15px] text-ink"
                    >
                      <button
                        type="button"
                        onClick={() => setSold((cur) => toggleSold(cur, o.item.id))}
                        title={`Keep the ${o.item.name.toLowerCase()}`}
                        aria-label={`Keep ${o.item.name}`}
                        className="text-left transition-colors hover:text-torch active:text-torch-deep"
                      >
                        {o.item.name}
                      </button>
                      <span className="font-mono text-[11px] text-graphite">+{cp(o.offer)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <div className="mt-4 flex flex-col gap-2">
              <Button
                tone="primary"
                disabled={nothingOnTheCounter}
                onClick={() => onBuy(checkout(pc, cart, rng, sold).pc)}
                className="px-5 py-3 text-[14px]"
              >
                {lines.length > 0
                  ? `Buy · ${cp(total)}`
                  : onTheBlock.length > 0
                    ? `Sell · +${cp(earned)}`
                    : "Buy"}
              </Button>
              <Button tone="ghost" onClick={onLeave} className="px-5 py-2.5 text-[12px]">
                {nothingOnTheCounter ? "Done" : "Leave it all"}
              </Button>
            </div>

            <div className="my-3.5 h-px bg-rule-faint" />
            <div className={`${LABEL} mb-2`}>Already carrying</div>
            <ul className="flex flex-col gap-1.5">
              {pc.inventory.map((item) => (
                <li
                  key={item.id}
                  className={`flex justify-between gap-3 font-prose text-[15px] ${
                    chosen.has(item.id) ? "text-pencil line-through" : "text-graphite"
                  }`}
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
