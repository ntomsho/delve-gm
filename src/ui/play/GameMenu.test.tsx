/**
 * THE GAME MENU — back to the main menu without ending the run.
 *
 * What matters is that it is the roster door and nothing else: no abandon on
 * the way out, and no leaving while a turn is still being saved.
 */

import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { GameMenu } from "./GameMenu.tsx";
import { press, renderDom } from "../test-utils/dom.ts";

const button = (c: Element) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent?.includes("Main menu"))!;

describe("the game menu", () => {
  it("goes back to the main menu when pressed", async () => {
    let left = 0;
    const r = renderDom(h(GameMenu, { onMainMenu: () => left++, busy: false }));
    await press(button(r.container));
    expect(left).toBe(1);
  });

  it("waits while the referee is working, because the turn is still being saved", async () => {
    let left = 0;
    const r = renderDom(h(GameMenu, { onMainMenu: () => left++, busy: true }));
    expect(button(r.container).disabled).toBe(true);
    await press(button(r.container));
    expect(left).toBe(0);
  });
});
