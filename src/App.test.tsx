/**
 * The app, mounted, playing a turn.
 *
 * One test, and it exists for one reason: `App.tsx` is where the session, the
 * store subscription and the dev switches are wired together, and none of that
 * is reachable from the tests below it. `screens.test.ts` renders the screens
 * in front of a run; `turn.test.ts` drives the machine behind one; nothing
 * checked that the thing in the middle still starts.
 *
 * It runs on `?offline=1`, which means the fixture dungeon AND the fixture
 * referee — no network, no key, no model. Everything here is free and fast, and
 * a failure means the wiring broke rather than that a model said something
 * unexpected.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { act } from "react";
import { renderDom } from "./ui/__fixtures__/dom.ts";

// Before App is imported: the switches are read once, at module scope, from
// whatever the URL said when the bundle loaded.
history.replaceState({}, "", "/?offline=1");

// `?offline=1` is played entirely in the browser and talks to nothing, but a
// stray fetch reaching a server that is not here would fail noisily. Stubbed so
// a failure in this test means the wiring broke, not that a socket did.
vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({}) }));

// jsdom has no layout, so it has no `scrollIntoView` — which the scrollback
// calls on every new line.
HTMLElement.prototype.scrollIntoView = () => {};

let App: typeof import("./App.tsx").default;

beforeAll(async () => {
  App = (await import("./App.tsx")).default;
});

/** Let generation, the room entry, and the effects they schedule finish. */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe("?offline=1", () => {
  it("generates, walks in, and takes a turn", async () => {
    const page = renderDom(h(App));
    await settle();

    // Past the loading screen: the briefing and the first room are on the page.
    const text = () => page.container.textContent ?? "";
    expect(text()).toContain("You were paid half in advance");
    expect(text()).not.toContain("Could not build a dungeon");

    const input = page.one("textarea") as HTMLTextAreaElement;
    // React tracks the value on the node, so assigning it directly is not seen.
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!;

    act(() => {
      setValue.call(input, "I search the floor");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    await settle();

    // The stub referee's search branch. What matters is that a turn went all
    // the way through the session and back onto the page.
    expect(text()).toContain("I search the floor");
    expect(text()).toContain("tin box");
  });
});
