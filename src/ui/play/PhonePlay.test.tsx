/**
 * THE PHONE'S SHELL: tabs, swiping between them, and what the tab bar says.
 *
 * Rendered on its own with stand-in bodies, because none of this is about what
 * is IN a tab. jsdom has no layout, so the growing tabs are not under test —
 * which tab is open, and what each one is wearing, is.
 */

import { describe, expect, it } from "vitest";
import { act, useState } from "react";
import { PhonePlay, swipeTo, type Tab } from "./PhonePlay.tsx";
import { fire, renderDom } from "../test-utils/dom.ts";
import { STAGE_TONE } from "../shared/theme.ts";
import { generateOffline, testCharacter } from "../../fixtures/offline.ts";
import { newRun } from "../../gameplay/state/store.ts";
import { characterView } from "../../gameplay/view/selectors.ts";
import type { Stage } from "../../shared/types/turn.ts";

const pc = characterView(newRun(generateOffline(1005, 2), testCharacter()));

function Shell({
  stage = "awaiting_action",
  busy = false,
  narrated = 3,
  explored = 2,
  who = pc,
  start = "chat" as Tab,
}) {
  const [tab, setTab] = useState<Tab>(start);
  return (
    <PhonePlay
      stage={stage as Stage}
      busy={busy}
      narrated={narrated}
      explored={explored}
      pc={who}
      tab={tab}
      onTab={setTab}
      map={<div data-no-swipe>the map</div>}
      chat={<textarea aria-label="box" />}
      sheet={<div>the sheet</div>}
    />
  );
}

const open = (r: { one(s: string): Element }) => r.one("[role='tab'][aria-selected='true']").getAttribute("data-tab");
const tabButton = (r: { one(s: string): Element }, id: Tab) => r.one(`[data-tab='${id}']`) as HTMLElement;

/**
 * A one-finger swipe. jsdom has no `Touch` to build a real `TouchEvent` from, so
 * the two lists React reads are set on a plain event — the same native shape a
 * browser hands it.
 */
function swipe(target: Element, dx: number, dy = 0) {
  const at = (type: string, x: number, y: number, list: "touches" | "changedTouches") => {
    const e = new Event(type, { bubbles: true });
    Object.assign(e, { touches: list === "touches" ? [{ clientX: x, clientY: y }] : [], changedTouches: [{ clientX: x, clientY: y }] });
    return e;
  };
  act(() => {
    target.dispatchEvent(at("touchstart", 200, 300, "touches"));
  });
  act(() => {
    target.dispatchEvent(at("touchend", 200 + dx, 300 + dy, "changedTouches"));
  });
}

describe("which way a swipe goes", () => {
  it("steps one tab toward the side the finger came from", () => {
    expect(swipeTo("chat", -100)).toBe("sheet");
    expect(swipeTo("chat", 100)).toBe("map");
  });

  it("stops at either end rather than wrapping", () => {
    expect(swipeTo("sheet", -100)).toBe("sheet");
    expect(swipeTo("map", 100)).toBe("map");
  });
});

describe("swiping the screen", () => {
  it("opens the next tab on a sideways swipe anywhere", () => {
    const r = renderDom(<Shell />);
    swipe(r.one("header"), -120);
    expect(open(r)).toBe("sheet");
    swipe(r.one("header"), 120);
    swipe(r.one("header"), 120);
    expect(open(r)).toBe("map");
  });

  it("ignores a mostly-vertical drag, which is a scroll", () => {
    const r = renderDom(<Shell />);
    swipe(r.one("header"), -80, 200);
    expect(open(r)).toBe("chat");
  });

  it("leaves the map's drags to the map, and the text box's to the text box", () => {
    const r = renderDom(<Shell start="map" />);
    swipe(r.one("[data-no-swipe]"), -120);
    expect(open(r)).toBe("map");

    const chat = renderDom(<Shell />);
    swipe(chat.one("textarea"), -120);
    expect(open(chat)).toBe("chat");
  });
});

describe("the chat tab", () => {
  it("wears the stage's colour, open or not", () => {
    const r = renderDom(<Shell stage="roll_offered" start="map" />);
    expect(tabButton(r, "chat").style.color).toBe(hexToRgb(STAGE_TONE.roll_offered.label));
  });

  it("runs a working bar while the game is busy", () => {
    expect(renderDom(<Shell busy stage="thinking" />).one("[data-tab='chat']").querySelector("[aria-label='Working']")).not.toBeNull();
    expect(renderDom(<Shell />).one("[data-tab='chat']").querySelector("[aria-label='Working']")).toBeNull();
  });

  it("carries a dot when narration lands while the player is elsewhere, until they look", () => {
    const r = renderDom(<Shell start="map" narrated={3} />);
    const dot = () => tabButton(r, "chat").querySelector("[data-unread]");
    expect(dot()).toBeNull();

    r.update(<Shell start="map" narrated={4} />);
    expect(dot()).not.toBeNull();

    fire(tabButton(r, "chat"), "click");
    expect(dot()).toBeNull();
    fire(tabButton(r, "map"), "click");
    expect(dot()).toBeNull();
  });

  it("carries no dot for narration read as it arrived", () => {
    const r = renderDom(<Shell narrated={3} />);
    r.update(<Shell narrated={5} />);
    fire(tabButton(r, "map"), "click");
    expect(tabButton(r, "chat").querySelector("[data-unread]")).toBeNull();
  });
});

describe("the map and character tabs", () => {
  const dot = (r: { one(s: string): Element }, id: Tab) => tabButton(r, id).querySelector("[data-unread]");

  it("dot the map when the player first stands in a room, until they open it", () => {
    const r = renderDom(<Shell explored={2} />);
    expect(dot(r, "map")).toBeNull();
    r.update(<Shell explored={3} />);
    expect(dot(r, "map")).not.toBeNull();
    fire(tabButton(r, "map"), "click");
    expect(dot(r, "map")).toBeNull();
    fire(tabButton(r, "chat"), "click");
    expect(dot(r, "map")).toBeNull();
  });

  it("do not dot the map for a room entered while it was open", () => {
    const r = renderDom(<Shell start="map" explored={2} />);
    r.update(<Shell start="map" explored={3} />);
    fire(tabButton(r, "chat"), "click");
    expect(dot(r, "map")).toBeNull();
  });

  it("dot the character on any change to the sheet — healing as much as harm, a lost item as much as a found one", () => {
    const healed = { ...pc, hp: { ...pc.hp, current: pc.hp.current + 1 } };
    const robbed = { ...pc, inventory: pc.inventory.slice(1) };
    const sick = { ...pc, conditions: ["poisoned"] };
    for (const changed of [healed, robbed, sick]) {
      const r = renderDom(<Shell />);
      expect(dot(r, "sheet")).toBeNull();
      r.update(<Shell who={changed} />);
      expect(dot(r, "sheet")).not.toBeNull();
      fire(tabButton(r, "sheet"), "click");
      expect(dot(r, "sheet")).toBeNull();
    }
  });

  it("do not dot the character for the same sheet in a new object", () => {
    const r = renderDom(<Shell />);
    r.update(<Shell who={{ ...pc }} />);
    expect(dot(r, "sheet")).toBeNull();
  });
});

/** jsdom reports an inline colour back as `rgb(…)`. */
function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
