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
import { createElement as h } from "react";
import { act } from "react";
import { Shop } from "./Shop.tsx";
import { renderDom, type Rendered } from "../__fixtures__/dom.ts";
import {
  Rng,
  bonusesOf,
  buyKit,
  finishCharacter,
  purse,
  rollAbilities,
  rollTraits,
  setPurse,
  type PlayerCharacter,
} from "../../engine/index.ts";

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
