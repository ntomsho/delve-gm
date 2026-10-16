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
import { ActionPill, HoverProvider, InspectSheet, oneParagraph } from "./hover.tsx";
import { RoomCard } from "./RoomCard.tsx";
import { drag, fire, hover, press, renderDom, unhover } from "../test-utils/dom.ts";
import { color } from "../shared/theme.ts";
import { generateOffline, testCharacter } from "../../fixtures/offline.ts";
import { floorplanLayout } from "../../generation/floorplan/map-layout.ts";
import { placedThings } from "../../gameplay/mechanics/occupancy.ts";
import { newRun } from "../../gameplay/state/store.ts";
import { mapView } from "../../gameplay/view/map.ts";
import { roomView } from "../../gameplay/view/room.ts";

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
function both(barred?: string) {
  const run = newRun(dungeon, testCharacter());
  // Something in the way of one door, the way the Frosted Gaol's iron gate was.
  const bar = run.entities.connectors.find((c) => c.id === barred);
  if (bar) bar.conditional = "The bar is down on the far side.";
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
function playing(reachable: string[], onAct = vi.fn(), barred?: string) {
  const { map, room } = both(barred);
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
  r.all("g path[data-shape]").filter((c) => c.getAttribute("fill") === color.torch);

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

  it("gives a way out the wall it cuts, in the words the game master was given", async () => {
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
    // player never has to guess which of two similar things the game master will take
    // them to mean, because the words came off the thing they clicked.
    // Whatever article the name arrived with, `definite` normalises; the words
    // that distinguish this thing from the next one survive intact.
    expect(onAct).toHaveBeenCalledWith(expect.stringContaining(thing.name.replace(/^(an?|the) /i, "")));
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

  it("greys out going through a way something is in, beside a look at it", async () => {
    const exit = both().room.exits.find((e) => !e.toKnown && !e.surface && !e.blocked)!;
    const { r } = playing([exit.connectorId], vi.fn(), exit.connectorId);
    await press(row(r, exit.connectorId));
    expect(pill()!.textContent).toBe("Examine?");
    const greyed = document.querySelector(".react-tooltip__show [data-blocked]") as HTMLButtonElement;
    expect(greyed.textContent).toBe("Go Through?");
    expect(greyed.disabled).toBe(true);
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

    // A press is a tap until it moves — so not dragging yet.
    fire(r.one("svg"), "pointerdown", { clientX: 0, clientY: 0, pointerId: 1 });
    expect(paper.hasAttribute("data-dragging")).toBe(false);

    fire(r.one("svg"), "pointermove", { clientX: 20, clientY: 0, pointerId: 1 });
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

// ===========================================================================
// A FINGER: TAP TO INSPECT
// ===========================================================================

/**
 * The same two panels on a touch screen. No hover card and no pill: a tap
 * selects, and the sheet says what the card and the pill would have.
 */
function tapping(
  reachable: string[],
  { acting = true, onAct = vi.fn(), onActed = vi.fn(), barred }: { acting?: boolean; onAct?: (sentence: string) => void; onActed?: () => void; barred?: string } = {}
) {
  const { map, room } = both(barred);
  const r = renderDom(
    <HoverProvider touch acting={acting} reachable={new Set(reachable)} onAct={onAct}>
      <DungeonMap map={map} />
      <RoomCard room={room} />
      <ActionPill />
      <InspectSheet onActed={onActed} />
    </HoverProvider>
  );
  return { r, map, room, onAct, onActed };
}

const sheet = () => document.querySelector("[role='dialog']");

describe("tapping, on a touch screen", () => {
  it("opens the sheet with the card's words, and lights the thing on both panels", async () => {
    const { r, room } = tapping([]);
    const thing = room.contents.find((c) => c.id === biggest.id)!;

    await press(row(r, thing.id));
    expect(sheet()?.textContent).toContain(thing.name);
    expect(sheet()?.textContent).toContain(thing.position!);
    expect(sheet()?.textContent).toContain(thing.composed!);
    expect(litDots(r)).toHaveLength(biggest.at.length);
    expect(row(r, thing.id).className).toContain("bg-torch-wash");
    // Nothing hovers on a phone, so nothing of react-tooltip's is mounted.
    expect(document.querySelector(".react-tooltip")).toBeNull();
  });

  it("puts it down on a second tap of the same thing", async () => {
    const { r } = tapping([]);
    await press(row(r, biggest.id));
    await press(row(r, biggest.id));
    expect(sheet()).toBeNull();
    expect(litDots(r)).toHaveLength(0);
  });

  it("sends the verb, closes, and says so to whoever switches tabs", async () => {
    const { r, room, onAct, onActed } = tapping([]);
    const thing = room.contents.find((c) => c.id === biggest.id)!;

    await press(row(r, thing.id));
    const button = sheet()!.querySelector("[data-sends]")!;
    expect(button.textContent).toBe("Examine?");
    await press(button);

    expect(onAct).toHaveBeenCalledWith(button.getAttribute("data-sends"));
    expect(onActed).toHaveBeenCalledOnce();
    expect(sheet()).toBeNull();
  });

  it("shows going through a barred way greyed above the look, and never sends it", async () => {
    const exit = both().room.exits.find((e) => !e.toKnown && !e.surface && !e.blocked)!;
    const { r, onAct } = tapping([exit.connectorId], { barred: exit.connectorId });
    await press(row(r, exit.connectorId));
    const greyed = sheet()!.querySelector("[data-blocked]") as HTMLButtonElement;
    expect(greyed.textContent).toBe("Go Through?");
    expect(greyed.disabled).toBe(true);
    await press(greyed);
    expect(onAct).not.toHaveBeenCalled();
    expect(sheet()!.querySelector("[data-sends]")!.textContent).toBe("Examine?");
  });

  it("offers no button while the game master is working, and says why", async () => {
    const { r } = tapping([], { acting: false });
    await press(row(r, biggest.id));
    expect(sheet()!.querySelector("[data-sends]")).toBeNull();
    expect(sheet()!.textContent).toContain("Wait for the game master to act");
  });

  // Through the map's own pointer handlers, as *Markers answer a click* asks:
  // a press that never moves captures nothing, so its click reaches the marker.
  it("selects a map marker tapped through the map's own pointer handlers", async () => {
    const { r, map } = tapping([]);
    const marker = r.all("svg g")[map.fixtures.findIndex((f) => f.id === biggest.id)];
    const dot = marker.querySelector("path[data-shape]")!;

    fire(dot, "pointerdown", { clientX: 10, clientY: 10, pointerId: 1 });
    fire(dot, "pointerup", { clientX: 12, clientY: 11, pointerId: 1 });
    await press(dot);
    expect(sheet()?.textContent).toContain(map.fixtures.find((f) => f.id === biggest.id)!.name);
    expect(litDots(r)).toHaveLength(biggest.at.length);
  });

  it("selects nothing at the end of a drag", async () => {
    const { r, map } = tapping([]);
    const marker = r.all("svg g")[map.fixtures.findIndex((f) => f.id === biggest.id)];
    const dot = marker.querySelector("path[data-shape]")!;

    drag(dot, { x: 10, y: 10 }, { x: 60, y: 10 });
    await press(dot);
    expect(sheet()).toBeNull();
  });

  it("puts the selection down on a tap of empty paper", async () => {
    const { r } = tapping([]);
    await press(row(r, biggest.id));
    await press(r.one("svg"));
    expect(sheet()).toBeNull();
  });

  it("keeps the thing lit, not the sheet, when the player changes tab", async () => {
    const { map, room } = both();
    const at = (scope: string) => (
      <HoverProvider touch acting reachable={new Set()} onAct={() => {}} scope={scope}>
        <DungeonMap map={map} />
        <RoomCard room={room} />
        <InspectSheet />
      </HoverProvider>
    );
    const r = renderDom(at("map"));
    await press(row(r, biggest.id));
    r.update(at("chat"));
    expect(sheet()).toBeNull();
    expect(litDots(r)).toHaveLength(biggest.at.length);
    // The next tap of anything puts it down.
    await press(r.one("svg"));
    expect(litDots(r)).toHaveLength(0);
  });
});
