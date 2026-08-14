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
import { MapHeader } from "./play/DungeonMap.tsx";
import { RoomCard } from "./play/RoomCard.tsx";
import { RunSetup } from "./RunSetup.tsx";
import { generateOffline, testCharacter } from "../runtime/__fixtures__/offline.ts";
import { newRun, type RunState } from "../store/game.ts";
import { mapView, roomView } from "../store/selectors.ts";

const cs = [testCharacter()];
const noop = () => {};

const doors = { onStartRun: noop, onCreate: noop, onDelete: noop };

describe("characters", () => {
  it("says so while it is still reading", () => {
    const html = renderToStaticMarkup(h(Characters, doors));
    expect(html).toContain("Reading the roll");
  });

  it("draws the row from the character, not from a fixture of its own", () => {
    const html = renderToStaticMarkup(h(Characters, { ...doors, characters: cs }));
    expect(html).toContain("Testy");
    // The prose line reads all eleven traits by key; a renamed key would
    // silently render "undefined" rather than throw.
    expect(html).toContain("Wiry");
    expect(html).toContain("burglar");
    expect(html).not.toContain("undefined");
  });

  it("names the numbers that decide whether they come back", () => {
    const html = renderToStaticMarkup(h(Characters, { ...doors, characters: cs }));
    expect(html).toContain("HP 15/15");
    expect(html).toContain("ARMOR DEF");
    expect(html).toContain("SLOTS");
  });

  it("badges a hardcore character and leaves a normal one unmarked", () => {
    const hard = renderToStaticMarkup(
      h(Characters, { ...doors, characters: [testCharacter({ mode: "hardcore" })] })
    );
    expect(hard).toContain("Hardcore");
    expect(renderToStaticMarkup(h(Characters, { ...doors, characters: cs }))).not.toContain("Hardcore");
  });

  // Reachable at last: deleting the only character is now possible, which is
  // what CODING-PLAN §1.2 item 13 was waiting on.
  it("invites you to roll one up when the stock is empty", () => {
    const html = renderToStaticMarkup(h(Characters, { ...doors, characters: [] }));
    expect(html).toContain("No one here yet");
    expect(html).toContain("Roll one up");
  });
});

// The card is a standing reference, so what it puts where is the whole of it:
// where they can go first, the way they came in apart and below it, and the
// unexplored last within each.
describe("the room card", () => {
  const dungeon = generateOffline(1005, 2);

  function card(over: Partial<RunState> = {}) {
    const run = { ...newRun(dungeon, testCharacter()), ...over };
    return renderToStaticMarkup(h(RoomCard, { room: roomView(run, dungeon)! }));
  }

  it("sets the way they came in apart, below the ways on", () => {
    const html = card();
    expect(html).toContain("Exits");
    expect(html).toContain("You came in from");
    // On the first turn the way they came in IS the way home, so the way out of
    // the dungeon is the thing below the rule — which is what says the two
    // sections are this way round and not the other.
    expect(html.indexOf("Exits")).toBeLessThan(html.indexOf("out of the dungeon"));
    expect(html.indexOf("You came in from")).toBeLessThan(html.indexOf("out of the dungeon"));
  });

  it("is one undivided list when they have not come from anywhere", () => {
    const html = card({ arrivedVia: undefined });
    expect(html).not.toContain("You came in from");
    expect(html).toContain("Exits");
  });

  it("marks what they have not been through yet", () => {
    expect(card()).toContain("unexplored");
  });
});

// The one thing on the screen that says where the player IS, in the sense of
// "which dungeon" rather than "which room", and the one progress signal the
// game has.
describe("the map header", () => {
  const dungeon = generateOffline(1005, 2);

  function header(seen: number) {
    const run = newRun(dungeon, testCharacter());
    // Explored is `composed !== undefined` — the same test the fog is drawn
    // from — so describing rooms is how a run gets explored, here as in play.
    for (const room of run.entities.rooms.slice(0, seen)) {
      room.composed = `You are standing in ${room.name}.`;
    }
    return renderToStaticMarkup(
      h(MapHeader, { name: dungeon.pass.name, map: mapView(run, dungeon) })
    );
  }

  it("names the place the dungeon pass named", () => {
    expect(header(0)).toContain(dungeon.pass.name);
  });

  it("counts what has been described against the whole plan", () => {
    const total = dungeon.graph.rooms.length;
    expect(header(0)).toContain(`0/${total} explored`);
    expect(header(3)).toContain(`3/${total} explored`);
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
