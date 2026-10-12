/**
 * The narration column's records — the lines the referee did not write.
 */

import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { Narration, toItems } from "./Narration.tsx";
import { renderDom } from "../__fixtures__/dom.ts";

describe("what a turn cost, under the prose", () => {
  it("states the wound and the broken thing as their own marks", () => {
    const items = toItems(
      [
        { kind: "referee", text: "The ledge gives.", turn: 1 },
        {
          kind: "effects",
          text: "",
          turn: 1,
          effects: [
            { kind: "hp", from: 15, to: 9, max: 15 },
            { kind: "damaged", itemId: "s", name: "Sword", from: 3, to: 2, of: 3 },
            { kind: "destroyed", itemId: "t", name: "Torch" },
          ],
        },
      ],
      () => ""
    );
    const t = renderDom(h(Narration, { items })).container.textContent ?? "";
    expect(t).toContain("−6 HP · 15 → 9");
    expect(t).toContain("Sword damaged · 2/3");
    expect(t).toContain("Torch destroyed");
  });

  it("says dead when the hit points reach zero", () => {
    const items = toItems(
      [{ kind: "effects", text: "", turn: 1, effects: [{ kind: "hp", from: 4, to: 0, max: 15 }] }],
      () => ""
    );
    expect(renderDom(h(Narration, { items })).container.textContent).toContain("−4 HP · 4 → 0 · dead");
  });
});

describe("a creature's roll against them", () => {
  it("shows the die, hit or miss, and the damage dice — and no target number", () => {
    const items = toItems(
      [
        {
          kind: "foe",
          text: "",
          turn: 1,
          foe: [
            {
              label: "Ghoul attack",
              d20: { rolled: [17], kept: 17, bonus: 2, total: 19, success: true, nat20: false, nat1: false },
              damage: { expr: "1d6", rolls: [5], total: 5 },
            },
            { label: "Thrall attack", d20: { rolled: [3], kept: 3, bonus: 0, total: 3, success: false, nat20: false, nat1: false } },
          ],
        },
      ],
      () => ""
    );
    const t = renderDom(h(Narration, { items })).container.textContent ?? "";
    expect(t).toContain("Ghoul attack");
    expect(t).toContain("Hit");
    expect(t).toContain("5 damage");
    expect(t).toContain("Thrall attack");
    expect(t).toContain("Miss");
    expect(t).not.toMatch(/vs/i);
  });
});
