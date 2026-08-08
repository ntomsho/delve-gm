/**
 * The two screens in front of a run, rendered.
 *
 * There is no DOM and no browser in this project, and adding one to check that
 * a list renders would cost more than it is worth. `renderToStaticMarkup` needs
 * neither: it executes the component bodies, which is what actually catches the
 * failures these screens are prone to — a helper imported under the wrong name,
 * a trait key that does not exist, an empty stock read as if it had a first
 * element. Layout is not asserted and should not be; that is what looking at it
 * is for.
 */

import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Characters } from "./Characters.tsx";
import { RoomCard } from "./play/RoomCard.tsx";
import { RunSetup } from "./RunSetup.tsx";
import { generateOffline, testCharacter } from "../runtime/__fixtures__/offline.ts";
import { newRun, type RunState } from "../store/game.ts";
import { roomView } from "../store/selectors.ts";

const cs = [testCharacter()];
const noop = () => {};

describe("characters", () => {
  it("says so while it is still reading", () => {
    const html = renderToStaticMarkup(h(Characters, { onStartRun: noop }));
    expect(html).toContain("Reading the roll");
  });

  it("draws the card from the character, not from a fixture of its own", () => {
    const html = renderToStaticMarkup(h(Characters, { characters: cs, onStartRun: noop }));
    expect(html).toContain("Testy");
    // The at-a-glance traits are read by key; a renamed key would silently
    // render "undefined · undefined" rather than throw.
    expect(html).toContain("Wiry · Bony · Cautious · Greedy · Burglar");
    expect(html).not.toContain("undefined");
  });

  it("survives an empty stock, which creation will make reachable", () => {
    const html = renderToStaticMarkup(h(Characters, { characters: [], onStartRun: noop }));
    expect(html).toContain("Nobody yet");
  });
});

// The card is a standing reference, so what it puts where is the whole of it:
// the way they came in first and apart, and the unexplored last.
describe("the room card", () => {
  const dungeon = generateOffline(1005, 2);

  function card(over: Partial<RunState> = {}) {
    const run = { ...newRun(dungeon, testCharacter()), ...over };
    return renderToStaticMarkup(h(RoomCard, { room: roomView(run, dungeon)! }));
  }

  it("sets the way they came in apart from the rest", () => {
    const html = card();
    expect(html).toContain("Behind you");
    expect(html).toContain("Other ways out");
    // The way home, at the top, on the first turn of the run.
    expect(html.indexOf("out of the dungeon")).toBeLessThan(html.indexOf("Other ways out"));
  });

  it("is one undivided list when they have not come from anywhere", () => {
    const html = card({ arrivedVia: undefined });
    expect(html).not.toContain("Behind you");
    expect(html).toContain("Exits");
  });

  it("marks what they have not been through yet", () => {
    expect(card()).toContain("unexplored");
  });
});

describe("run setup", () => {
  it("states the cost of the size it is defaulted to", () => {
    const html = renderToStaticMarkup(
      h(RunSetup, { characters: cs, onConfirm: noop, onBack: noop })
    );
    // Size 2 is two regions of six, and one writing call per region. If that
    // ratio changes in `seeds.ts`, this screen is lying and this test says so.
    expect(html).toContain("12 rooms · 2 regions · 2 writing calls");
    expect(html).toContain("Go down");
    expect(html).toContain("Testy");
  });
});
