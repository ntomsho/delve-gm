/**
 * THE MARKET, in a DOM.
 *
 * `shop.test.ts` beside the engine asserts what money does to a sheet. What is
 * left for this file is the counter: that pressing `+` spends against the purse
 * shown on the screen rather than against a number computed somewhere else,
 * that the control which would overspend is dead before it is pressed, and that
 * the sheet handed to the parent is the one the aside was describing.
 *
 * jsdom, per the extension rule in `vite.config.ts`: this is state and clicks.
 */

import { describe, expect, it } from "vitest";
import { act, createElement as h } from "react";
import { Shop } from "./Shop.tsx";
import { renderDom, type Rendered } from "../test-utils/dom.ts";
import { Rng } from "../../shared/utils/rng.ts";
import { addItem, type PlayerCharacter } from "../../rules/knave/character.ts";
import {
  bonusesOf,
  buyKit,
  finishCharacter,
  purse,
  rollAbilities,
  rollTraits,
  setPurse,
} from "../../rules/knave/character-creation.ts";
import type { IItem } from "../../shared/world/entities.ts";

const SEED = 20260817;
const noop = () => {};

function buyer(copper: number): PlayerCharacter {
  const rng = new Rng(SEED);
  const pc = finishCharacter({
    mode: "normal",
    name: "Tuesday Relish",
    abilities: bonusesOf(rollAbilities(rng, "normal")),
    traits: rollTraits(rng),
    hp: 9,
    kit: buyKit(rng, "sword"),
  });
  setPurse(pc, copper);
  return pc;
}

/**
 * Something out of a dungeon: no catalog row behind it, so the counter reads it
 * as treasure and pays all of what it is worth.
 */
function withTreasure(pc: PlayerCharacter, ...worth: Array<[string, number]>): PlayerCharacter {
  for (const [name, value] of worth) {
    const item: IItem = { id: `t-${name}`, name, type: "Item", parentId: "", slots: 1, value };
    addItem(pc, item, { force: true });
  }
  return pc;
}

function open(pc: PlayerCharacter, onBuy: (pc: PlayerCharacter) => void = noop): Rendered {
  return renderDom(h(Shop, { pc, onBuy, onLeave: noop }));
}

const click = (el: Element) => act(() => void (el as HTMLElement).click());

/** A control by its accessible name, which is how these rows are told apart. */
function byLabel(r: Rendered, label: string): HTMLButtonElement {
  const found = r.all("button").find((b) => b.getAttribute("aria-label") === label);
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found as HTMLButtonElement;
}

function byText(r: Rendered, text: string): HTMLButtonElement {
  const found = r.all("button").find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`no button saying "${text}"`);
  return found as HTMLButtonElement;
}

describe("the shop", () => {
  it("opens on the armor table with the purse counted out", () => {
    const r = open(buyer(400));
    expect(r.container.textContent).toContain("Gambeson");
    expect(r.container.textContent).toContain("400");
    expect(r.container.textContent).toContain("Nothing yet.");
  });

  it("spends against the purse on the screen as things go on the counter", () => {
    const r = open(buyer(400));
    click(byLabel(r, "One more Gambeson"));

    // 400 less the gambeson's 60. The aside says what is left, not what was
    // brought — a player deciding on a second thing needs the number they have.
    expect(r.container.textContent).toContain("340");
    expect(r.container.textContent).toContain("Copper left of 400");
    expect(r.container.textContent).not.toContain("Nothing yet.");
  });

  it("gives it back when it comes off the counter", () => {
    const r = open(buyer(400));
    click(byLabel(r, "One more Gambeson"));
    click(byLabel(r, "One fewer Gambeson"));
    expect(r.container.textContent).toContain("Nothing yet.");
    expect(byText(r, "Buy").disabled).toBe(true);
  });

  it("kills the control that would overspend, rather than refusing at the till", () => {
    const r = open(buyer(70));
    const more = byLabel(r, "One more Gambeson");
    expect(more.disabled).toBe(false);
    click(more);
    // 10 copper left and a gambeson is 60.
    expect(byLabel(r, "One more Gambeson").disabled).toBe(true);
  });

  it("hands the parent the sheet the counter was describing", () => {
    let bought: PlayerCharacter | undefined;
    const r = open(buyer(400), (pc) => void (bought = pc));

    click(byLabel(r, "One more Gambeson"));
    click(byText(r, "Buy ·"));

    expect(bought).toBeDefined();
    expect(purse(bought!)).toBe(340);
    expect(bought!.inventory.some((i) => i.name === "Gambeson")).toBe(true);
    // And it went on, because an empty armor slot is what it is for.
    expect(bought!.equipped.armor).toBeDefined();
  });

  it("counts the cart against the slots before any of it is bought", () => {
    const r = open(buyer(400));
    const before = r.one("aside").textContent ?? "";
    click(byLabel(r, "One more Gambeson"));
    const after = r.one("aside").textContent ?? "";
    // The meter reads "n of capacity"; the gambeson is one slot, so the number
    // before the capacity has to have moved.
    expect(after).not.toBe(before);
    expect(after).toContain("Capacity is your CON defense");
  });

  it("walks the tables and prices a torch off the Light one", () => {
    const r = open(buyer(400));
    click(byText(r, "Light"));
    expect(r.container.textContent).toContain("Torch");
    click(byLabel(r, "One more Torch"));
    // A torch is a single copper.
    expect(r.container.textContent).toContain("399");
  });

  it("groups weapons by class, the way creation asks for them", () => {
    const r = open(buyer(400));
    click(byText(r, "Weapons"));
    const text = r.container.textContent ?? "";
    for (const label of ["Light", "Medium", "Heavy", "Sling", "Bow", "Crossbow"]) {
      expect(text).toContain(label);
    }
    // The class carries the numbers and the names hang off it.
    expect(text).toContain("Halberd");
    expect(text).toContain("1d10");
  });

  it("says the purse is empty rather than hiding the prices", () => {
    const r = open(buyer(0));
    expect(r.container.textContent).toContain("purse is empty");
    expect(r.container.textContent).toContain("Gambeson");
    expect(byLabel(r, "One more Gambeson").disabled).toBe(true);
    expect(byText(r, "Buy").disabled).toBe(true);
  });
});

describe("the counter, selling", () => {
  const seller = (copper = 0) =>
    withTreasure(buyer(copper), ["Silver ewer", 300], ["Carved bone die", 40]);

  it("splits the pack into treasure at full value and gear at half of store", () => {
    const r = open(seller());
    click(byText(r, "Sell"));
    const text = r.container.textContent ?? "";

    expect(text).toContain("Silver ewer");
    expect(text).toContain("treasure · full value");
    expect(text).toContain("300 cp");

    // The sword came from the catalog, so it prices from the catalog and halves.
    expect(text).toContain("Sword");
    expect(text).toContain("equipment · half of store");
  });

  it("raises the purse on the screen the moment something goes on the block", () => {
    const r = open(seller(100));
    click(byText(r, "Sell"));
    click(byLabel(r, "Sell Silver ewer"));

    expect(r.container.textContent).toContain("400");
    expect(r.container.textContent).toContain("Copper, up from 100");
    expect(r.container.textContent).toContain("On the block");
  });

  it("takes it back off the block when it is clicked again", () => {
    const r = open(seller(100));
    click(byText(r, "Sell"));
    click(byLabel(r, "Sell Silver ewer"));
    click(byLabel(r, "Keep Silver ewer"));
    expect(r.container.textContent).not.toContain("On the block");
    expect(byText(r, "Buy").disabled).toBe(true);
  });

  it("says on the button what selling all the treasure would make", () => {
    const r = open(seller());
    click(byText(r, "Sell"));
    expect(byText(r, "Sell all treasure").textContent).toContain("+340 cp");
  });

  it("counts the button down as treasure goes on the block one piece at a time", () => {
    const r = open(seller());
    click(byText(r, "Sell"));
    click(byLabel(r, "Sell Silver ewer"));
    // 340 less the ewer's 300 — the number on the button is always what
    // pressing it would still pay.
    expect(byText(r, "Sell all treasure").textContent).toContain("+40 cp");
  });

  it("sells every piece of treasure at once and leaves the gear alone", () => {
    let sold: PlayerCharacter | undefined;
    const r = open(seller(), (pc) => void (sold = pc));
    click(byText(r, "Sell"));
    click(byText(r, "Sell all treasure"));

    expect(byText(r, "Sell ·").textContent).toContain("+340 cp");
    click(byText(r, "Sell ·"));

    expect(sold).toBeDefined();
    expect(purse(sold!)).toBe(340);
    expect(sold!.inventory.some((i) => i.name === "Silver ewer")).toBe(false);
    expect(sold!.inventory.some((i) => i.name === "Carved bone die")).toBe(false);
    expect(sold!.inventory.some((i) => i.name === "Sword")).toBe(true);
  });

  it("has nothing left to offer once it has all been put on the block", () => {
    const r = open(seller());
    click(byText(r, "Sell"));
    click(byText(r, "Sell all treasure"));
    expect(byText(r, "All treasure on the block").disabled).toBe(true);
  });

  it("lets the sale pay for the purchase, in one press", () => {
    let done: PlayerCharacter | undefined;
    const r = open(seller(0), (pc) => void (done = pc));

    // Broke, so the gambeson is out of reach.
    expect(byLabel(r, "One more Gambeson").disabled).toBe(true);

    click(byText(r, "Sell"));
    click(byLabel(r, "Sell Silver ewer"));
    click(byText(r, "Armor"));

    const more = byLabel(r, "One more Gambeson");
    expect(more.disabled).toBe(false);
    click(more);
    click(byText(r, "Buy ·"));

    expect(done).toBeDefined();
    expect(purse(done!)).toBe(300 - 60);
    expect(done!.inventory.some((i) => i.name === "Gambeson")).toBe(true);
    expect(done!.inventory.some((i) => i.name === "Silver ewer")).toBe(false);
  });

  it("will not buy the purse off them", () => {
    const r = open(seller(100));
    click(byText(r, "Sell"));
    expect(r.all("button").some((b) => b.getAttribute("aria-label") === "Sell Copper")).toBe(
      false
    );
  });

  it("lists what nobody wants rather than leaving a hole in the pack", () => {
    const r = open(withTreasure(buyer(0), ["Bundle of damp rags", 0]));
    click(byText(r, "Sell"));
    expect(r.container.textContent).toContain("Bundle of damp rags");
    expect(r.container.textContent).toContain("no offer");
    expect(byLabel(r, "Sell Bundle of damp rags").disabled).toBe(true);
  });

  it("says there is no treasure rather than offering a button that does nothing", () => {
    const r = open(buyer(400));
    click(byText(r, "Sell"));
    expect(byText(r, "No treasure to sell").disabled).toBe(true);
  });
});
