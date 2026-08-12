/**
 * THE MAP AND THE ROOM CARD, AGREEING ABOUT WHERE THINGS ARE.
 *
 * The complaint this answers is "the model got minor position details wrong",
 * and the cheapest true answer to it is not a better prompt: it is letting the
 * player point at a name in the card and see which dot on the map the game
 * means by it. So these tests render BOTH panels, as `PlayScreen` does, over one
 * room of a real generated dungeon.
 *
 * `DungeonMap.test.tsx` covers the map's own hovers and `screens.test.ts` covers
 * what the card lists. What is only true of the two together is here: the same
 * card of words from either side, and each lighting the other.
 */

import { describe, expect, it, vi } from "vitest";
import { DungeonMap } from "./DungeonMap.tsx";
import { ActionPill, HoverProvider, oneParagraph } from "./hover.tsx";
import { RoomCard } from "./RoomCard.tsx";
import { drag, fire, hover, press, renderDom, unhover } from "../__fixtures__/dom.ts";
import { color } from "../theme.ts";
import { generateOffline, testCharacter } from "../../runtime/__fixtures__/offline.ts";
import { floorplanLayout } from "../../runtime/layout.ts";
import { placedThings } from "../../runtime/occupancy.ts";
import { newRun } from "../../store/game.ts";
import { mapView, roomView } from "../../store/selectors.ts";

// ===========================================================================
// ONE ROOM, DRAWN TWICE
// ===========================================================================

const dungeon = generateOffline(1005, 2);
const plan = floorplanLayout(dungeon.blockplan!, dungeon.graph, {
  placed: placedThings(dungeon.entities),
});

/** The thing with the most cells, so "all its dots light" means something. */
const biggest = [...plan.fixtures].sort((a, b) => b.at.length - a.at.length)[0];

/**
 * A run standing in the room that thing is in, with the room and the thing both
 * described — which is what makes them drawable at all. See `MapFixtureView`.
 */
function both() {
  const run = newRun(dungeon, testCharacter());
  const room = run.entities.rooms.find((r) => r.id === biggest.roomId)!;
  room.composed = `You are standing in ${room.name}.`;
  const entity =
    run.entities.features.find((f) => f.id === biggest.id) ??
    run.entities.items.find((i) => i.id === biggest.id)!;
  entity.composed = "Squat pillars, streaked with damp.";

  return {
    map: mapView(run, dungeon, plan),
    room: roomView(run, dungeon, biggest.roomId)!,
  };
}

/** The two panels under one provider, which is the whole subject of this file. */
function panels() {
  const { map, room } = both();
  const r = renderDom(
    <HoverProvider>
      <DungeonMap map={map} />
      <RoomCard room={room} />
    </HoverProvider>
  );
  return { r, map, room };
}

const shown = () => document.querySelector(".react-tooltip__show")?.textContent ?? "";

/**
 * The two panels with a game around them, and the pill mounted once for both.
 *
 * `acting` is what the provider carries and what `useAnchor` gates on, so a
 * provider without it — `panels()` above — draws everything and offers nothing.
 * That is the read-only case, and it is what every hover test in this file wants.
 */
function playing(reachable: string[], onAct = vi.fn()) {
  const { map, room } = both();
  const r = renderDom(
    <HoverProvider acting reachable={new Set(reachable)} onAct={onAct}>
      <DungeonMap map={map} />
      <RoomCard room={room} />
      <ActionPill />
    </HoverProvider>
  );
  return { r, map, room, onAct };
}

/** Scoped to `__show`, because a dismissed tooltip lingers — see `DungeonMap.test.tsx`. */
const pill = () => document.querySelector(".react-tooltip__show [data-sends]");

/** The card row for a thing, found the way the highlight finds it: by id. */
const row = (r: { one(s: string): Element }, id: string) => r.one(`li[data-hover-id="${id}"]`);

/** Dots drawn in torch — the map's half of the highlight. */
const litDots = (r: { all(s: string): Element[] }) =>
  r.all("g circle").filter((c) => c.getAttribute("fill") === color.torch);

// ===========================================================================
// THE SAME HOVER FROM EITHER SIDE
// ===========================================================================

describe("the room card entries hover like the map markers", () => {
  it("gives a thing's name, where it stands and what the player read", async () => {
    const { r, room } = panels();
    const thing = room.contents.find((c) => c.id === biggest.id)!;

    await hover(row(r, thing.id));
    expect(shown()).toContain(thing.name);
    // The map marker's own two fields, from the same view. The card and the dot
    // do not merely agree about this thing; they are reading one source.
    expect(shown()).toContain(thing.position!);
    expect(shown()).toContain(thing.composed!);
  });

  it("gives a way out the wall it cuts, in the words the referee was given", async () => {
    const { r, room } = panels();
    const exit = room.exits.find((e) => e.wall !== undefined)!;

    await hover(row(r, exit.connectorId));
    expect(shown()).toContain(exit.name);
    expect(shown()).toContain(exit.wall!);
  });

  it("renders the card where nothing on the page can clip it", async () => {
    const { r, room } = panels();
    await hover(row(r, room.contents.find((c) => c.id === biggest.id)!.id));

    // The room card is the narrowest panel on the sheet, so a hover on a row
    // near its edge is the case that was cut off before react-tooltip. jsdom has
    // no layout to measure that with, but parentage is what the bug was.
    const card = document.querySelector(".react-tooltip__show")!;
    expect(card).not.toBeNull();
    expect(r.container.contains(card)).toBe(false);
    expect(card.parentElement).toBe(document.body);
  });
});

// ===========================================================================
// EACH LIGHTS THE OTHER
// ===========================================================================

describe("hovering either one highlights the other", () => {
  it("lights the map marker when the cursor is on the card row", async () => {
    const { r } = panels();
    expect(litDots(r)).toHaveLength(0);

    await hover(row(r, biggest.id));
    // Every cell of it: the colonnade is six dots and one thing.
    expect(litDots(r)).toHaveLength(biggest.at.length);
  });

  it("lights the card row when the cursor is on the map marker", async () => {
    const { r, map } = panels();
    const marker = r.all("svg g")[map.fixtures.findIndex((f) => f.id === biggest.id)];

    expect(row(r, biggest.id).className).not.toContain("bg-torch-wash");
    await hover(marker);
    expect(row(r, biggest.id).className).toContain("bg-torch-wash");
  });

  it("lights the door on the map when the cursor is on the way out in the card", async () => {
    const { r, room } = panels();
    const exit = room.exits[0];
    // Weight rather than colour: a blocked way is already outlined in torch, so
    // colour alone would say nothing new about it.
    const heavy = () => r.all("rect").filter((x) => x.getAttribute("stroke-width") === "2.8");
    expect(heavy()).toHaveLength(0);

    await hover(row(r, exit.connectorId));
    expect(heavy()).toHaveLength(1);
  });

  it("puts everything out again when the cursor leaves", async () => {
    const { r } = panels();
    await hover(row(r, biggest.id));
    expect(litDots(r)).toHaveLength(biggest.at.length);

    await unhover(row(r, biggest.id));
    expect(litDots(r)).toHaveLength(0);
    expect(shown()).toBe("");
  });
});

// ===========================================================================
// WHAT A CLICK ON A CARD ROW OFFERS
// ===========================================================================
//
// The table is `verbs.test.ts` and the map's wiring is `DungeonMap.test.tsx`.
// What is only true of the card is here: that its rows carry verbs from the same
// factory the map's markers do, that the exit rows read the same reachable set
// the doors do, and that the pill survives being raised over the narrowest panel
// on the sheet — which is the clipping case the whole tooltip arrangement exists
// for.

describe("clicking a room card row", () => {
  it("offers a look at a thing in the room, and sends it", async () => {
    const { r, room, onAct } = playing([]);
    const thing = room.contents.find((c) => c.id === biggest.id)!;

    await press(row(r, thing.id));
    expect(pill()!.textContent).toBe("Examine?");

    await press(pill()!);
    // The name as the game holds it, with an article a sentence can carry. The
    // player never has to guess which of two similar things the referee will take
    // them to mean, because the words came off the thing they clicked.
    expect(onAct).toHaveBeenCalledWith(expect.stringContaining(thing.name.replace(/^an? /i, "")));
    expect(onAct).toHaveBeenCalledWith(expect.stringMatching(/^I examine the /));
  });

  it("offers to go through a way out whose far side has not been seen", async () => {
    const { room } = both();
    // Not the way they came in, not the way out of the dungeon, and open: the
    // one case a door offers travel rather than a look. See `wayVerb`.
    const exit = room.exits.find((e) => !e.toKnown && !e.surface && !e.blocked)!;
    expect(exit).toBeDefined();

    const { r } = playing([exit.connectorId]);
    await press(row(r, exit.connectorId));
    expect(pill()!.textContent).toBe("Go Through?");
    expect(pill()!.getAttribute("data-sends")).toMatch(/^I go through the /);
  });

  it("offers only a look at that same way when it is not reachable", async () => {
    const { room } = both();
    const exit = room.exits.find((e) => !e.toKnown && !e.surface && !e.blocked)!;

    // The same row, the same view, one fact about the game changed — which is the
    // point of the reachable set living on the provider rather than in the panel.
    const { r } = playing([]);
    await press(row(r, exit.connectorId));
    expect(pill()!.textContent).toBe("Examine?");
  });

  it("raises the pill where the room card cannot paint over it", async () => {
    const { r, room } = playing([]);
    await press(row(r, room.contents.find((c) => c.id === biggest.id)!.id));

    // Same bug, same fix as the hover card: the room card is a grid sibling with
    // a background of its own, so a pill above a row near its top edge would be
    // overpainted. jsdom has no layout to measure that with; parentage is what
    // the bug was.
    const raised = pill()!;
    expect(r.container.contains(raised)).toBe(false);
    expect(raised.closest(".react-tooltip")!.parentElement).toBe(document.body);
  });

  it("offers nothing anywhere when there is no game to act in", () => {
    const { r } = panels();
    // `panels()` is a provider with no `acting` and no `onAct` — the read-only
    // case every hover test above renders. Not one verb, in either panel.
    expect(r.all("[data-verb]")).toHaveLength(0);
  });
});

// ===========================================================================
// HOW MUCH IT SHOWS
// ===========================================================================
//
// A room's description is not one paragraph — measured over five recorded runs
// it is a median of 947 characters and up to 1878, in three or so. The card
// shows the opening and marks the rest with an ellipsis; the whole of it is a
// scroll away in the narration, which is where it was written to be read.

describe("a description is cut to about a paragraph", () => {
  const LIMIT = 320;

  it("leaves a short description exactly as it was written", () => {
    const short = "A squat iron chest, its lid warped by damp.";
    expect(oneParagraph(short)).toBe(short);
  });

  it("keeps the first paragraph whole and marks that more follows", () => {
    const text = "The water is still and cold.\n\nA broad flight of steps rises out of it.";
    expect(oneParagraph(text)).toBe("The water is still and cold. …");
  });

  it("stops at the last sentence that fits rather than mid-breath", () => {
    const sentence = "The stair climbs into the dark. ";
    const long = sentence.repeat(20);
    const cut = oneParagraph(long);

    expect(cut.endsWith("dark. …")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(LIMIT + 2);
    // Enough of the paragraph to be worth reading — a full stop four words in
    // would be tidy and useless.
    expect(cut.length).toBeGreaterThan(LIMIT / 2);
  });

  it("cuts at a word, never through one, when no sentence ends in time", () => {
    const long = `${"whispering ".repeat(60)}end.`;
    const cut = oneParagraph(long);

    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(LIMIT + 1);
    // The ellipsis sits against the word, and the word is a whole word.
    expect(cut.slice(0, -1).split(" ").pop()).toBe("whispering");
  });

  it("shows the player the cut version, not the whole of it", async () => {
    const { map, room } = both();
    const thing = room.contents.find((c) => c.id === biggest.id)!;
    const long = `${"The pillars are streaked with damp. ".repeat(15)}`;
    // Written onto both views at once, as the composition pass writes it.
    map.fixtures.find((f) => f.id === biggest.id)!.composed = long;
    thing.composed = long;

    const r = renderDom(
      <HoverProvider>
        <DungeonMap map={map} />
        <RoomCard room={room} />
      </HoverProvider>
    );

    await hover(row(r, thing.id));
    expect(shown()).toContain("The pillars are streaked with damp.");
    expect(shown()).toContain("…");
    expect(shown().length).toBeLessThan(long.length);
  });
});

// ===========================================================================
// THE CURSOR
// ===========================================================================
//
// jsdom has no stylesheet and no layout, so what is asserted here is the hook
// the two rules in `index.css` hang on — the attribute on every hoverable
// thing, and the one the map raises while it is being dragged. Whether those
// rules then say `pointer` and `grabbing` is a question for the browser.

describe("what the cursor says", () => {
  it("marks every hoverable thing, in both panels, with the same attribute", () => {
    const { r, map, room } = panels();
    const anchors = r.all("[data-hover-id]");

    // Rooms, doors and markers on the map; contents and ways out in the card.
    const expected =
      map.rooms.filter((x) => x.known).length +
      map.connectors.filter((c) => c.known && c.door).length +
      map.fixtures.length +
      room.contents.length +
      room.exits.length;
    expect(anchors).toHaveLength(expected);
    expect(anchors.length).toBeGreaterThan(4); // the test means something
  });

  it("says the map is being dragged for as long as the press is held", () => {
    const { r } = panels();
    const paper = r.one("div[class*='cursor-']");
    expect(paper.className).toContain("cursor-grab");
    expect(paper.hasAttribute("data-dragging")).toBe(false);

    fire(r.one("svg"), "pointerdown", { clientX: 0, clientY: 0, pointerId: 1 });
    expect(paper.className).toContain("cursor-grabbing");
    // What lets the drag beat the pointer the markers underneath it ask for.
    expect(paper.hasAttribute("data-dragging")).toBe(true);

    fire(r.one("svg"), "pointerup", { clientX: 4, clientY: 4, pointerId: 1 });
    expect(paper.hasAttribute("data-dragging")).toBe(false);
    expect(paper.className).toContain("cursor-grab");
  });

  it("lets go when the cursor leaves the map mid-drag", () => {
    const { r } = panels();
    const paper = r.one("div[class*='cursor-']");

    drag(r.one("svg"), { x: 0, y: 0 }, { x: 10, y: 4 });
    expect(paper.hasAttribute("data-dragging")).toBe(false);
  });
});
