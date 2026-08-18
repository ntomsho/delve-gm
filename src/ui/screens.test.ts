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
import { NO_RECORD, type CharacterEntry, type CharacterRecord } from "../store/characters.ts";
import type { DungeonSummary } from "../store/dungeons.ts";
import type { PlayerCharacter } from "../engine/index.ts";

const noop = () => {};

/**
 * A roster entry: the sheet, plus the two things about a character that live in
 * `runs` rather than on them — what has happened, and where they are.
 */
function entry(
  sheet: PlayerCharacter = testCharacter(),
  over: Partial<Omit<CharacterEntry, "sheet">> = {}
): CharacterEntry {
  return { sheet, record: NO_RECORD, ...over };
}

const IN_A_RUN: CharacterEntry["activeRun"] = {
  id: "run-1",
  dungeonId: "d-1",
  dungeonName: "The Sunken Vault",
  turnCount: 13,
};

const cs = [entry()];

const doors = {
  onStartRun: noop,
  onResumeRun: noop,
  onAbandonRun: noop,
  onShop: noop,
  onCreate: noop,
  onDelete: noop,
};

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
      h(Characters, { ...doors, characters: [entry(testCharacter({ mode: "hardcore" }))] })
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

  /*
   * PHASE 12. A character is in one run at a time, and the row is the only place
   * the player finds that out — so what it offers has to follow what the game
   * will accept, not merely describe it.
   */

  it("offers the run they are in instead of a new one", () => {
    const html = renderToStaticMarkup(
      h(Characters, { ...doors, characters: [entry(testCharacter(), { activeRun: IN_A_RUN })] })
    );
    expect(html).toContain("Resume run");
    expect(html).toContain("Abandon run");
    // The two the game would refuse. Deleting is refused by the server, and
    // sending them down is refused by the index.
    expect(html).not.toContain("Send down");
    expect(html).not.toContain(">Delete<");
  });

  it("names where they are and how far in", () => {
    const html = renderToStaticMarkup(
      h(Characters, { ...doors, characters: [entry(testCharacter(), { activeRun: IN_A_RUN })] })
    );
    expect(html).toContain("In a run");
    expect(html).toContain("The Sunken Vault");
    // `turnCount` is CLOSED turns, and the turn a player is living through is the
    // next one — the same off-by-one the input area's tracker makes, and they
    // are read on the same screen often enough to have to agree.
    expect(html).toContain("turn 14");
  });

  it("offers the ordinary doors when they are not in one", () => {
    const html = renderToStaticMarkup(h(Characters, { ...doors, characters: cs }));
    expect(html).toContain("Send down");
    expect(html).not.toContain("Resume run");
  });

  // The market. Open to anybody standing on this screen, and shut to anybody
  // underground — the sheet a run is playing from is the run's until it ends.
  it("offers the shop to a character who is not in a run", () => {
    const html = renderToStaticMarkup(h(Characters, { ...doors, characters: cs }));
    expect(html).toContain(">Shop<");
  });

  it("does not offer the shop to a character who is in one", () => {
    const html = renderToStaticMarkup(
      h(Characters, { ...doors, characters: [entry(testCharacter(), { activeRun: IN_A_RUN })] })
    );
    expect(html).not.toContain(">Shop<");
  });

  /*
   * PHASE 13b. The shelf is a second door beside `Send down`, not a field on
   * it: one rolls a world for a minute and a real bill, the other picks one
   * somebody already wrote for neither.
   */

  it("offers the library beside the character who would go down it", () => {
    const html = renderToStaticMarkup(
      h(Characters, { ...doors, characters: cs, onBrowse: noop })
    );
    expect(html).toContain("Browse worlds");
    expect(html).toContain("Send down");
  });

  it("does not offer the library to a character already in a run", () => {
    const html = renderToStaticMarkup(
      h(Characters, {
        ...doors,
        characters: [entry(testCharacter(), { activeRun: IN_A_RUN })],
        onBrowse: noop,
      })
    );
    expect(html).not.toContain("Browse worlds");
  });

  /*
   * A LOCAL RUN HAS NO LIBRARY. `?offline` and `?stub` never touch the server,
   * so the button is absent rather than present and refused — the same call the
   * sign-out control makes.
   */
  it("does not offer the library at all when there is no server to read it from", () => {
    const html = renderToStaticMarkup(h(Characters, { ...doors, characters: cs }));
    expect(html).not.toContain("Browse worlds");
    expect(html).toContain("Send down");
  });

  it("says nothing at all about a character nothing has happened to", () => {
    const html = renderToStaticMarkup(h(Characters, { ...doors, characters: cs }));
    for (const word of ["DIED", "WALKED AWAY", "OUT EMPTY-HANDED", "DONE"]) {
      expect(html).not.toContain(word);
    }
  });

  it("counts what has happened, worst first", () => {
    const record: CharacterRecord = { dead: 2, abandoned: 1, escaped: 4, goalMet: 5 };
    const html = renderToStaticMarkup(
      h(Characters, { ...doors, characters: [entry(testCharacter(), { record })] })
    );
    expect(html).toContain("2 DIED · 1 WALKED AWAY · 4 OUT EMPTY-HANDED · 5 DONE");
  });

  it("leaves out the endings that have not happened", () => {
    const record: CharacterRecord = { dead: 0, abandoned: 0, escaped: 0, goalMet: 12 };
    const html = renderToStaticMarkup(
      h(Characters, { ...doors, characters: [entry(testCharacter(), { record })] })
    );
    expect(html).toContain("12 DONE");
    expect(html).not.toContain("0 DIED");
  });

  it("puts the server's refusal in front of the player", () => {
    const html = renderToStaticMarkup(
      h(Characters, { ...doors, characters: cs, notice: "that character is in a run" })
    );
    expect(html).toContain("that character is in a run");
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
      // Sheets, not roster entries: run setup only ever sees the characters who
      // can actually go, which App filters before it gets here.
      h(RunSetup, { characters: cs.map((e) => e.sheet), onConfirm: noop, onBack: noop })
    );
    // Size 2 is two regions of six, and one writing call per region. If that
    // ratio changes in `seeds.ts`, this screen is lying and this test says so.
    expect(html).toContain("12 rooms · 2 regions · 2 writing calls");
    expect(html).toContain("Go down");
    expect(html).toContain("Testy");
  });

  /*
   * PHASE 13a. The screen asks which world first, and the size and level
   * controls belong to the branch that is actually rolling one — beside a
   * chosen dungeon they would be controls that change nothing.
   */

  const world = (over: Partial<DungeonSummary> = {}): DungeonSummary => ({
    id: "d-1",
    name: "The Drowned Aviary",
    objective: "Steal the brass egg",
    size: 3,
    level: 2,
    seed: 15341,
    status: "complete",
    createdAt: "2026-08-10T00:32:05.000Z",
    ...over,
  });

  const setup = (dungeons?: DungeonSummary[]) =>
    renderToStaticMarkup(
      h(RunSetup, {
        characters: cs.map((e) => e.sheet),
        ...(dungeons ? { dungeons } : {}),
        onConfirm: noop,
        onBack: noop,
      })
    );

  it("offers a new world even when the player has none saved", () => {
    // The question is asked whether or not there is a second answer to it —
    // which is how a player learns that worlds are kept at all.
    expect(setup()).toContain("A new one");
  });

  it("names a saved world by what distinguishes it", () => {
    const html = setup([world()]);
    expect(html).toContain("The Drowned Aviary");
    // The objective, because two worlds of one size and level are otherwise
    // told apart by nothing.
    expect(html).toContain("Steal the brass egg");
    expect(html).toContain("Size 3 · Level 2");
  });

  it("still defaults to a new world, so the size controls are there", () => {
    const html = setup([world()]);
    expect(html).toContain("12 rooms · 2 regions · 2 writing calls");
    expect(html).toContain("The dungeon starts being written the moment you press it");
  });
});
