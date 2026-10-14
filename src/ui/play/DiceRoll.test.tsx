/**
 * THE PLAYER'S ROLL, DRAWN.
 *
 * The load-bearing assertion is the one about the DC: it is in the outcome the
 * component is handed, and it must never reach the page.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { DiceRoll } from "./DiceRoll.tsx";
import { renderDom } from "../test-utils/dom.ts";
import type { RolledOutcome } from "../../shared/types/turn.ts";

afterEach(() => vi.useRealTimers());

const outcome = (over: Partial<RolledOutcome> = {}): RolledOutcome => ({
  spec: { kind: "save", ability: "str", bonus: 2, edge: "none", description: "Force the grate.", dc: 16 },
  rolled: [15],
  kept: 15,
  total: 17,
  success: true,
  nat20: false,
  nat1: false,
  crit: { defenderArmor: false, attackerWeapon: false },
  ...over,
});

const text = (o: RolledOutcome, live: boolean) => renderDom(h(DiceRoll, { outcome: o, live })).container.textContent ?? "";

describe("a roll in the scrollback", () => {
  it("states the die, the sum and the verdict", () => {
    const t = text(outcome(), false);
    expect(t).toContain("STR save");
    expect(t).toContain("15 +2 = 17");
    expect(t).toContain("Success");
  });

  it("never shows the difficulty", () => {
    // 16 is the DC and appears nowhere else in this outcome.
    expect(text(outcome(), false)).not.toContain("16");
    expect(text(outcome({ success: false, kept: 9, rolled: [9], total: 11 }), false)).not.toContain("16");
  });

  it("names a critical, a fumble and the damage", () => {
    const crit = outcome({
      spec: { kind: "attack", ability: "str", bonus: 1, edge: "none", description: "Swing.", dc: 13 },
      rolled: [20], kept: 20, total: 21, nat20: true,
      damage: { expr: "1d8", rolls: [6], flat: 0, total: 6 },
    });
    const t = text(crit, false);
    expect(t).toContain("Critical");
    expect(t).toContain("1d8 → 6 damage");
    expect(text(outcome({ rolled: [1], kept: 1, total: 3, success: false, nat1: true }), false)).toContain("Fumble");
  });
});

describe("the roll being resolved", () => {
  it("tumbles first, then lands on the die that counted", () => {
    vi.useFakeTimers();
    const { container } = renderDom(h(DiceRoll, { outcome: outcome(), live: true }));
    // In the air: no verdict yet.
    expect(container.textContent).not.toContain("Success");

    act(() => void vi.advanceTimersByTime(2000));
    expect(container.textContent).toContain("15 +2 = 17");
    expect(container.textContent).toContain("Success");
  });

  it("throws the damage dice after the hit lands, not with it", () => {
    vi.useFakeTimers();
    const hit = outcome({
      spec: { kind: "attack", ability: "str", bonus: 1, edge: "none", description: "Swing.", dc: 13 },
      rolled: [15], kept: 15, total: 16,
      damage: { expr: "2d6", rolls: [4, 2], flat: 0, total: 6 },
    });
    const { container } = renderDom(h(DiceRoll, { outcome: hit, live: true }));

    act(() => void vi.advanceTimersByTime(12 * 75 + 10));
    // The d20 has landed; the damage is still in the air.
    expect(container.textContent).toContain("Success");
    expect(container.textContent).not.toContain("6 damage");

    act(() => void vi.advanceTimersByTime(2000));
    expect(container.textContent).toContain("6 damage");
    const faces = [...container.querySelectorAll("svg text")].map((t) => t.textContent);
    expect(faces).toEqual(["15", "4", "2"]);
  });

  it("shows both dice under advantage, the dropped one among them", () => {
    vi.useFakeTimers();
    const adv = outcome({
      spec: { kind: "save", ability: "dex", bonus: 0, edge: "advantage", description: "Dodge.", dc: 12 },
      rolled: [4, 18], kept: 18, total: 18,
    });
    const { container } = renderDom(h(DiceRoll, { outcome: adv, live: true }));
    act(() => void vi.advanceTimersByTime(2000));
    const faces = [...container.querySelectorAll("svg text")].map((t) => t.textContent);
    expect(faces).toEqual(["18", "4"]);
    expect(container.textContent).toContain("advantage");
  });
});
