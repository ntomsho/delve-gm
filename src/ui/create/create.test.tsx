/**
 * CHARACTER CREATION, in a DOM.
 *
 * What is actually worth asserting here is the reroll budget, because it is the
 * one rule that lives nowhere else: `character-creation.ts` knows how many
 * rerolls a mode gets and knows how to roll, but the accounting — three presses
 * and no more, spent from three screens, and traits not among them — is a fact
 * about this component. So these tests press buttons and count.
 *
 * jsdom, per the extension rule in `vite.config.ts`: this is state and clicks.
 */

import { describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { CreateCharacter } from "./CreateCharacter.tsx";
import { renderDom, type Rendered } from "../__fixtures__/dom.ts";
import { act } from "react";

const noop = () => {};

/**
 * Creation is seeded here, not left to `randomSeed()`. Without a pin these
 * tests assert against whatever six abilities turned up, and the swap tests in
 * particular go quiet on the roughly one run in nine hundred where all six
 * match and a swap has nothing visible to do.
 */
const SEED = 20260813;

function open(onSave: (pc: unknown) => void = noop, seed = SEED): Rendered {
  return renderDom(h(CreateCharacter, { seed, onCancel: noop, onSave }));
}

const click = (el: Element) => act(() => void (el as HTMLElement).click());

/** The step rail is the only navigation these tests need. */
function goToStep(r: Rendered, label: string) {
  const tab = r.all("nav button").find((b) => b.textContent?.includes(label));
  if (!tab) throw new Error(`no step called ${label}`);
  click(tab);
}

const rerollButtons = (r: Rendered) =>
  r.all("button").filter((b) => /^Reroll/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));

const headerCount = (r: Rendered) => r.container.textContent ?? "";

// --- the equipment step, read through its own markup ------------------------

const carrying = (r: Rendered) =>
  r.all("aside[aria-label='What you are carrying'] li").map((li) => li.textContent!.replace(/\d+$/, ""));

const usedSlots = (r: Rendered) =>
  Number(/(\d+) of \d+/.exec(r.one("aside[aria-label='What you are carrying']").textContent!)![1]);

const nameChoices = (r: Rendered) => r.all("div[role='group'] button").map((b) => b.textContent!);

/** Whichever weapon is pressed — a name for a melee class, the class itself otherwise. */
function weaponName(r: Rendered): string {
  const named = r.all("div[role='group'] button").find((b) => b.getAttribute("aria-pressed") === "true");
  if (named) return named.textContent!;
  const cls = r.all("button[aria-label$='weapon']").find((b) => b.getAttribute("aria-pressed") === "true")!;
  return (cls.getAttribute("aria-label") ?? "").replace(" weapon", "");
}

// ===========================================================================

describe("the reroll budget", () => {
  it("starts a normal character at three and counts down", () => {
    const r = open();
    expect(headerCount(r)).toContain("Rerolls left");
    expect(headerCount(r)).toContain("3 of 3");

    goToStep(r, "Abilities");
    click(rerollButtons(r)[0]);
    expect(headerCount(r)).toContain("2 of 3");
  });

  it("goes dead at zero, and the buttons say so by being disabled", () => {
    const r = open();
    goToStep(r, "Abilities");

    for (let i = 0; i < 3; i++) {
      const live = rerollButtons(r).filter((b) => !(b as HTMLButtonElement).disabled);
      expect(live.length, `press ${i + 1}`).toBeGreaterThan(0);
      click(live[0]);
    }

    expect(headerCount(r)).toContain("0 of 3");
    expect(rerollButtons(r).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("stops changing the sheet once it is spent", () => {
    const r = open();
    goToStep(r, "Hit points");

    const hp = () => r.one(".text-\\[82px\\]").textContent;
    for (let i = 0; i < 3; i++) {
      const button = r.all("button").find((b) => b.textContent === "Reroll")!;
      click(button);
    }
    const settled = hp();

    const spent = r.all("button").find((b) => b.textContent === "Reroll") as HTMLButtonElement;
    expect(spent.disabled).toBe(true);
    click(spent);
    expect(hp()).toBe(settled);
  });

  it("is one budget across abilities, hit points and gear", () => {
    const r = open();

    goToStep(r, "Abilities");
    click(rerollButtons(r)[0]);
    expect(headerCount(r)).toContain("2 of 3");

    goToStep(r, "Hit points");
    click(r.all("button").find((b) => b.textContent === "Reroll")!);
    expect(headerCount(r)).toContain("1 of 3");

    goToStep(r, "Equipment");
    click(r.all("button").find((b) => b.textContent === "Reroll the lot")!);
    expect(headerCount(r)).toContain("0 of 3");
  });
});

describe("what a reroll does not cost", () => {
  it("leaves the traits sheet free, all eleven of it and the lot together", () => {
    const r = open();
    goToStep(r, "Traits");

    for (const b of rerollButtons(r)) click(b);
    click(r.all("button").find((x) => x.textContent === "Reroll all")!);

    expect(headerCount(r)).toContain("3 of 3");
  });

  it("leaves switching between rolling and buying free, and does not re-roll on the way back", () => {
    const r = open();
    goToStep(r, "Equipment");

    const copper = () => r.one(".text-\\[42px\\]").textContent;
    click(r.all("button").find((b) => b.textContent === "BUY INSTEAD")!);
    const first = copper();

    click(r.all("button").find((b) => b.textContent === "ROLL GEAR")!);
    click(r.all("button").find((b) => b.textContent === "BUY INSTEAD")!);

    expect(copper()).toBe(first);
    expect(headerCount(r)).toContain("3 of 3");
  });

  it("leaves the weapon choice free and does not disturb the rolled tables", () => {
    const r = open();
    goToStep(r, "Equipment");

    // The carried list, minus the weapon row that is supposed to change.
    const rolled = () => carrying(r).filter((n) => n !== weaponName(r));
    const before = rolled();
    expect(before.length).toBeGreaterThan(3);

    click(r.one("button[aria-label='Bow weapon']"));

    expect(weaponName(r)).toBe("Bow");
    expect(rolled()).toEqual(before);
    expect(headerCount(r)).toContain("3 of 3");
  });
});

describe("the weapon picker", () => {
  const chosenClass = (r: Rendered) =>
    (r.all("button[aria-label$='weapon']").find((b) => b.getAttribute("aria-pressed") === "true")!
      .getAttribute("aria-label") ?? "").replace(" weapon", "");

  it("asks for a class first, and only then for a name", () => {
    const r = open();
    goToStep(r, "Equipment");

    expect(r.all("button[aria-label$='weapon']").map((b) => b.textContent!.split("1d")[0])).toEqual([
      "Light",
      "Medium",
      "Heavy",
      "Sling",
      "Bow",
      "Crossbow",
    ]);

    click(r.one("button[aria-label='Heavy weapon']"));
    expect(chosenClass(r)).toBe("Heavy");
    expect(r.container.textContent).toContain("And which one");
    expect(nameChoices(r)).toEqual(["Halberd", "War Hammer", "Long Sword", "Battle Axe"]);
  });

  it("does not ask which sling you meant", () => {
    const r = open();
    goToStep(r, "Equipment");
    click(r.one("button[aria-label='Sling weapon']"));
    expect(chosenClass(r)).toBe("Sling");
    expect(r.container.textContent).not.toContain("And which one");
    expect(weaponName(r)).toBe("Sling");
  });

  it("takes the first name of a class when the class changes, and keeps the class when the name does", () => {
    const r = open();
    goToStep(r, "Equipment");

    click(r.one("button[aria-label='Light weapon']"));
    expect(weaponName(r)).toBe("Dagger");

    click(r.all("button").find((b) => b.textContent === "Staff")!);
    expect(weaponName(r)).toBe("Staff");
    expect(chosenClass(r)).toBe("Light");
  });

  it("changes only the fiction when the name changes — the slots are the class's", () => {
    const r = open();
    goToStep(r, "Equipment");

    click(r.one("button[aria-label='Medium weapon']"));
    expect(weaponName(r)).toBe("Spear");
    // Every Medium weapon is 2 slots, so the meter cannot move between them.
    const used = usedSlots(r);
    click(r.all("div[role='group'] button").find((b) => b.textContent === "Flail")!);
    expect(weaponName(r)).toBe("Flail");
    expect(usedSlots(r)).toBe(used);

    // ...but a lighter class is a real change, and the meter says so.
    click(r.one("button[aria-label='Light weapon']"));
    expect(usedSlots(r)).toBe(used - 1);
  });

  it("does not print the dice the tables were rolled on", () => {
    const r = open();
    goToStep(r, "Equipment");
    expect(r.container.textContent).not.toMatch(/d20/);
  });
});

describe("swapping abilities", () => {
  const cards = (r: Rendered) => r.all("button[aria-pressed]").filter((b) => /Defense/.test(b.textContent ?? ""));
  const bonuses = (r: Rendered) => cards(r).map((c) => /[+-]\d+/.exec(c.textContent!)![0]);
  // The card button ends at its dice — the reroll button is its sibling, not
  // a child, so there is nothing after them to anchor against.
  const dice = (r: Rendered) => cards(r).map((c) => /d6 → ([\d ]+)$/.exec(c.textContent!)![1].trim());
  const undo = (r: Rendered) => r.all("button").find((b) => b.textContent?.startsWith("↩ Undo"));

  const swap = (r: Rendered, i: number, j: number) => {
    click(cards(r)[i]);
    click(cards(r)[j]);
  };

  /**
   * A pair whose bonuses actually differ. Rolled abilities come from a random
   * seed per mount, so swapping a fixed pair would pass without moving anything
   * whenever the two happened to match — and the whole point is that they move.
   */
  function differingPair(r: Rendered): [number, number] {
    const b = bonuses(r);
    for (let i = 0; i < b.length; i++) {
      for (let j = i + 1; j < b.length; j++) if (b[i] !== b[j]) return [i, j];
    }
    throw new Error(`all six abilities rolled the same: ${b.join(" ")}`);
  }

  it("trades two abilities and offers the swap back", () => {
    const r = open();
    goToStep(r, "Abilities");
    const before = bonuses(r);
    const diceBefore = dice(r);
    expect(undo(r)).toBeUndefined();

    const [i, j] = differingPair(r);
    swap(r, i, j);

    const after = bonuses(r);
    expect(after[i]).toBe(before[j]);
    expect(after[j]).toBe(before[i]);
    expect(after[i]).not.toBe(before[i]);
    // The dice travel with the bonus, so a card can never show a number over a
    // roll that did not produce it.
    expect(dice(r)[i]).toBe(diceBefore[j]);
    expect(dice(r)[j]).toBe(diceBefore[i]);

    expect(undo(r)!.textContent).toMatch(/↩ Undo [A-Z]{3}↔[A-Z]{3}/);
  });

  it("refunds the swap on undo, rather than charging a second one", () => {
    const r = open();
    goToStep(r, "Abilities");
    const before = bonuses(r);

    // Normal has two swaps. Spend both, undo both, spend both again.
    swap(r, 0, 1);
    swap(r, 2, 3);
    expect(r.container.textContent).toContain("Both swaps are spent");

    click(undo(r)!);
    click(undo(r)!);
    expect(bonuses(r)).toEqual(before);
    expect(undo(r)).toBeUndefined();
    expect(r.container.textContent).toContain("swap two pairs");

    swap(r, 0, 1);
    swap(r, 4, 5);
    expect(r.container.textContent).toContain("Both swaps are spent");
  });

  it("undoes them one at a time, most recent first", () => {
    const r = open();
    goToStep(r, "Abilities");
    swap(r, 0, 1);
    const afterFirst = bonuses(r);
    swap(r, 2, 3);

    click(undo(r)!);
    expect(bonuses(r)).toEqual(afterFirst);
    expect(undo(r)!.textContent).toContain("STR↔DEX");
  });

  it("costs no rerolls at all", () => {
    const r = open();
    goToStep(r, "Abilities");
    swap(r, 0, 1);
    click(undo(r)!);
    swap(r, 2, 3);
    expect(headerCount(r)).toContain("3 of 3");
  });

  // A reroll lands new dice on the cards, so the pairs an undo would restore no
  // longer hold what they held. Both the swaps and the undo go with it.
  it("hands the swaps back when a reroll replaces the dice under them", () => {
    const r = open();
    goToStep(r, "Abilities");
    swap(r, 0, 1);
    swap(r, 2, 3);
    expect(r.container.textContent).toContain("Both swaps are spent");

    click(rerollButtons(r)[0]);
    expect(undo(r)).toBeUndefined();
    expect(r.container.textContent).toContain("swap two pairs");
  });

  it("gives hardcore one swap, not two", () => {
    const r = open();
    click(r.all("button").find((b) => b.textContent?.startsWith("hardcore"))!);
    goToStep(r, "Abilities");

    swap(r, 0, 1);
    expect(r.container.textContent).toContain("The swap is spent");
    click(undo(r)!);
    expect(r.container.textContent).toContain("swap one pair");
  });
});

describe("hit points", () => {
  const shown = (r: Rendered) => Number(r.one(".text-\\[82px\\]").textContent);

  it("rolls two dice floored at nine for a normal character", () => {
    const r = open();
    goToStep(r, "Hit points");
    expect(r.container.textContent).toContain("2d8, rolled once, never less than 9");
    expect(shown(r)).toBeGreaterThanOrEqual(9);
    expect(shown(r)).toBeLessThanOrEqual(16);
  });

  it("rolls one floored at five for a hardcore character", () => {
    const r = open();
    click(r.all("button").find((b) => b.textContent?.startsWith("hardcore"))!);
    goToStep(r, "Hit points");
    expect(r.container.textContent).toContain("One d8, rolled once, never less than 5");
    expect(shown(r)).toBeGreaterThanOrEqual(5);
    expect(shown(r)).toBeLessThanOrEqual(8);
  });

  it("stays inside the floor and the ceiling however often it is rerolled", () => {
    const r = open();
    goToStep(r, "Hit points");
    for (let i = 0; i < 3; i++) {
      expect(shown(r)).toBeGreaterThanOrEqual(9);
      expect(shown(r)).toBeLessThanOrEqual(16);
      click(r.all("button").find((b) => b.textContent === "Reroll")!);
    }
  });
});

describe("hardcore", () => {
  const toHardcore = (r: Rendered) =>
    click(r.all("button").find((b) => b.textContent?.startsWith("hardcore"))!);

  it("never offers a reroll at all", () => {
    const r = open();
    toHardcore(r);
    expect(headerCount(r)).toContain("Hardcore · no rerolls");

    goToStep(r, "Abilities");
    expect(rerollButtons(r).length).toBeGreaterThan(0);
    expect(rerollButtons(r).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);

    goToStep(r, "Hit points");
    expect((r.all("button").find((b) => b.textContent === "Reroll") as HTMLButtonElement).disabled).toBe(true);
  });

  it("still rerolls traits, which cost nothing under either mode", () => {
    const r = open();
    toHardcore(r);
    goToStep(r, "Traits");
    expect(rerollButtons(r).every((b) => (b as HTMLButtonElement).disabled)).toBe(false);
  });

  it("rolls three dice an ability where normal rolls two", () => {
    const r = open();
    goToStep(r, "Abilities");
    expect(r.container.textContent).toContain("2d6 →");

    goToStep(r, "Which rules");
    toHardcore(r);
    goToStep(r, "Abilities");
    expect(r.container.textContent).toContain("3d6 →");
    expect(r.container.textContent).not.toContain("2d6 →");
  });

  // A mode switch that kept the sheet would be a way to bank a good hit point
  // roll under normal and arrive as a hardcore character who never spent one.
  it("starts the character again, so the budget cannot be laundered", () => {
    const r = open();
    goToStep(r, "Abilities");
    click(rerollButtons(r)[0]);
    expect(headerCount(r)).toContain("2 of 3");

    goToStep(r, "Which rules");
    expect(r.container.textContent).toContain("Changing this now rolls a new character");
    toHardcore(r);
    expect(headerCount(r)).toContain("Hardcore · no rerolls");

    // ...and back again is a clean normal character, not one with 2 left.
    click(r.all("button").find((b) => b.textContent?.startsWith("normal"))!);
    expect(headerCount(r)).toContain("3 of 3");
  });
});

describe("committing", () => {
  it("saves nothing until the last button", () => {
    const onSave = vi.fn();
    const r = open(onSave);

    for (const label of ["Abilities", "Traits", "Hit points", "Equipment"]) {
      goToStep(r, label);
      for (const b of rerollButtons(r)) if (!(b as HTMLButtonElement).disabled) click(b);
    }
    expect(onSave).not.toHaveBeenCalled();

    goToStep(r, "Name & confirm");
    click(r.all("button").find((b) => b.textContent === "Save and send them down")!);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("saves the character the sheet was showing", () => {
    const onSave = vi.fn();
    const r = open(onSave);
    goToStep(r, "Name & confirm");

    const name = r.one("input[aria-label='Name']") as HTMLInputElement;
    const shown = name.value;
    click(r.all("button").find((b) => b.textContent === "Save and send them down")!);

    const pc = onSave.mock.calls[0][0] as { name: string; level: number; mode: string; inventory: unknown[] };
    expect(pc.name).toBe(shown);
    expect(pc.level).toBe(1);
    expect(pc.mode).toBe("normal");
    expect(pc.inventory.length).toBeGreaterThan(3);
  });
});

describe("point buy", () => {
  const toBuy = (r: Rendered) => click(r.all("button").find((b) => b.textContent === "POINT BUY")!);
  const raises = (r: Rendered) => r.all("button[aria-label^='Raise']") as HTMLButtonElement[];

  it("hands out ten points and spends them down to nothing", () => {
    const r = open();
    goToStep(r, "Abilities");
    toBuy(r);
    expect(r.container.textContent).toContain("Points left");

    let pressed = 0;
    while (raises(r).some((b) => !b.disabled) && pressed < 40) {
      click(raises(r).find((b) => !b.disabled)!);
      pressed++;
    }

    // Every + is dead, which is what makes an overspent spread unreachable —
    // there is no guard on the Continue button and there should not be one.
    expect(raises(r)).toHaveLength(6);
    expect(raises(r).every((b) => b.disabled)).toBe(true);
    expect(pressed).toBeGreaterThan(0);
    const carryOn = r.all("button").find((b) => b.textContent?.startsWith("Continue")) as HTMLButtonElement;
    expect(carryOn.disabled).toBe(false);
  });

  it("caps a single ability at +4 with points still in hand", () => {
    const r = open();
    goToStep(r, "Abilities");
    toBuy(r);

    const str = () => r.one("button[aria-label='Raise str']") as HTMLButtonElement;
    let pressed = 0;
    while (!str().disabled && pressed < 8) {
      click(str());
      pressed++;
    }

    // +1 -> +4 is three presses costing 1 + 1 + 2, so six of the ten survive.
    expect(pressed).toBe(3);
    expect(r.container.textContent).toContain("+4");
    expect(raises(r).some((b) => !b.disabled)).toBe(true);
  });

  it("does not spend a reroll on any of it", () => {
    const r = open();
    goToStep(r, "Abilities");
    toBuy(r);
    while (raises(r).some((b) => !b.disabled)) click(raises(r).find((b) => !b.disabled)!);
    click(r.one("button[aria-label='Lower str']"));
    expect(headerCount(r)).toContain("3 of 3");
  });
});
