/**
 * TAKING A LEVEL, in a DOM.
 *
 * `level-up.test.ts` beside the engine asserts what a level does to a sheet.
 * What is left for this file is the modal: that the dice appear when they are
 * asked for and not before, that they are the ones the seed had already decided
 * rather than a fresh handful each time the screen opens, that the button which
 * would commit an illegal choice is dead before it is pressed, and that the
 * sheet handed to the parent is the one the cards were describing.
 *
 * jsdom, per the extension rule in `vite.config.ts`: this is state and clicks.
 */

import { describe, expect, it } from "vitest";
import { act, createElement as h } from "react";
import { LevelUp } from "./LevelUp.tsx";
import { renderDom, type Rendered } from "../test-utils/dom.ts";
import { testCharacter } from "../../fixtures/offline.ts";
import { ABILITY_MAX, levelUpRoll } from "../../rules/knave/level-up.ts";
import { type PlayerCharacter } from "../../rules/knave/character.ts";

const noop = () => {};

/** Somebody a level is owed to. `testCharacter` is +3 across the board on 15 HP. */
const ready = (over: Partial<PlayerCharacter> = {}) => testCharacter({ xp: 1000, ...over });

function open(pc: PlayerCharacter, onConfirm: (pc: PlayerCharacter) => void = noop): Rendered {
  return renderDom(h(LevelUp, { pc, onConfirm, onCancel: noop }));
}

const click = (el: Element) => act(() => void (el as HTMLElement).click());

/** A control by the words on it — how a player tells these apart. */
function byText(r: Rendered, text: string): HTMLButtonElement {
  const found = r.all("button").find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button reading "${text}"`);
  return found as HTMLButtonElement;
}

/** A card by its accessible name, which is the ability spelled out. */
function card(r: Rendered, name: string): HTMLButtonElement {
  const found = r.all("button").find((b) => b.getAttribute("aria-label") === name);
  if (!found) throw new Error(`no card for ${name}`);
  return found as HTMLButtonElement;
}

const confirm = (r: Rendered) => byText(r, "Take the level");
const text = (r: Rendered) => r.container.textContent ?? "";

describe("the dice", () => {
  it("are not on the screen until they are asked for", () => {
    const r = open(ready());
    expect(text(r)).toContain("Roll 2d8");
    expect(text(r)).not.toContain("2d8 →");
  });

  it("show what the engine rolled, and the total behind it", () => {
    const pc = ready();
    const r = open(pc);
    click(byText(r, "Roll 2d8"));

    const roll = levelUpRoll(pc);
    expect(text(r)).toContain(`2d8 → ${roll.dice.join(" ")} = ${roll.total}`);
    expect(text(r)).toContain(String(roll.hpMax));
  });

  it("are the same dice when the screen is closed and opened again", () => {
    const pc = ready();
    const first = open(pc);
    click(byText(first, "Roll 2d8"));
    const shown = text(first);
    first.unmount();

    const second = open(pc);
    click(byText(second, "Roll 2d8"));
    expect(text(second)).toBe(shown);
  });

  it("never pay less than a point, and say when the rule did it", () => {
    // 2d8 cannot beat 40, so this is the floor every time.
    const r = open(ready({ hp: { current: 40, max: 40 } }));
    click(byText(r, "Roll 2d8"));
    expect(text(r)).toContain("raised to 41");
    expect(text(r)).toContain("The rule gives you the point instead");
  });

  it("count one die per level of the level being taken", () => {
    const r = open(ready({ level: 4, xp: 5000 }));
    expect(text(r)).toContain("Roll 5d8");
  });
});

describe("the three raises", () => {
  it("takes three and refuses a fourth rather than dropping the first", () => {
    const r = open(ready());
    for (const a of ["Strength", "Dexterity", "Wisdom"]) click(card(r, a));
    expect(text(r)).toContain("3 of 3 chosen");

    click(card(r, "Charisma"));
    expect(text(r)).toContain("3 of 3 chosen");
    expect(card(r, "Charisma").getAttribute("aria-pressed")).toBe("false");
    expect(card(r, "Strength").getAttribute("aria-pressed")).toBe("true");
  });

  it("gives one back when it is pressed again", () => {
    const r = open(ready());
    click(card(r, "Strength"));
    expect(text(r)).toContain("1 of 3 chosen");
    click(card(r, "Strength"));
    expect(text(r)).toContain("0 of 3 chosen");
  });

  it("shows the ability and its defense one better before anything is committed", () => {
    const r = open(ready());
    click(card(r, "Strength"));
    // +3 becomes +4, and a defense of 13 becomes 14.
    expect(card(r, "Strength").textContent).toContain("+4");
    expect(card(r, "Strength").textContent).toContain("14");
    expect(card(r, "Strength").textContent).toContain("was +3");
  });

  it("kills the card of an ability already at the ceiling", () => {
    const capped = ready({
      abilities: { str: ABILITY_MAX, dex: 3, con: 3, int: 3, wis: 3, cha: 3 },
    });
    const r = open(capped);
    expect(card(r, "Strength").disabled).toBe(true);
    expect(card(r, "Dexterity").disabled).toBe(false);
  });

  it("asks for fewer when there are fewer left under the ceiling", () => {
    const nearly = ready({
      abilities: {
        str: ABILITY_MAX, dex: ABILITY_MAX, con: ABILITY_MAX,
        int: ABILITY_MAX, wis: ABILITY_MAX, cha: 3,
      },
    });
    const r = open(nearly);
    expect(text(r)).toContain("0 of 1 chosen");
    expect(text(r)).toContain("The rest of this level goes nowhere");
  });

  it("says what raising constitution does to the pack", () => {
    const r = open(ready());
    expect(text(r)).not.toContain("slots becomes");
    click(card(r, "Constitution"));
    // CON +3 is 13 slots; a point of it is 14.
    expect(text(r)).toContain("13 slots becomes 14");
  });
});

describe("committing", () => {
  it("is dead until the dice are rolled and three are chosen", () => {
    const r = open(ready());
    expect(confirm(r).disabled).toBe(true);

    click(byText(r, "Roll 2d8"));
    expect(confirm(r).disabled).toBe(true);

    for (const a of ["Strength", "Dexterity", "Wisdom"]) click(card(r, a));
    expect(confirm(r).disabled).toBe(false);
  });

  it("hands back the sheet the screen was describing", () => {
    const pc = ready();
    let saved: PlayerCharacter | undefined;
    const r = open(pc, (next) => (saved = next));

    click(byText(r, "Roll 2d8"));
    for (const a of ["Strength", "Dexterity", "Wisdom"]) click(card(r, a));
    click(confirm(r));

    expect(saved).toBeDefined();
    expect(saved!.level).toBe(2);
    expect(saved!.hp.max).toBe(levelUpRoll(pc).hpMax);
    expect(saved!.abilities).toEqual({ str: 4, dex: 4, con: 3, int: 3, wis: 4, cha: 3 });
    // The XP is a career total and the track is cumulative — nothing is spent.
    expect(saved!.xp).toBe(1000);
    // And the sheet it was given is untouched.
    expect(pc.level).toBe(1);
  });

  it("says how many levels are waiting behind this one", () => {
    const r = open(ready({ xp: 3000 }));
    expect(text(r)).toContain("3 levels are owed");
  });
});
