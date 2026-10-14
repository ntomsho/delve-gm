/**
 * The map, rendered.
 *
 * The geometry under this component is already covered — `layout.test.ts` for
 * the outlines and the doors, `geometry.test.ts` for the room as words, and the
 * `mapView` blocks in `selectors.test.ts` for what the player is entitled to
 * see. What none of them touch is the drawing itself, because a static render
 * runs a component body and then stops: it never clicks a door, never hovers a
 * room, and never finds out whether the fog branch draws nothing or draws
 * everything. This is the first test in the project with a DOM under it and
 * those are the reasons it needed one.
 *
 * Two kinds of fixture, on purpose:
 *
 *   THE REAL DUNGEON for anything about counts and correspondence — fog, the
 *   §7 boundary between the two layouts, one mark per cell. Those are the
 *   assertions that have to hold against data nobody arranged.
 *
 *   A HAND-BUILT `MapView` for the interaction branches. Clicking the right one
 *   of fourteen doors means first working out which `<rect>` it is, which means
 *   re-deriving `doorRect` in the test — so the test would be checking its own
 *   arithmetic. One door, placed by hand, checks the component.
 */

import { describe, expect, it, vi } from "vitest";
import { DungeonMap } from "./DungeonMap.tsx";
import { ActionPill, HoverProvider } from "./hover.tsx";
import { drag, fire, hover, press, renderDom, unhover } from "../__fixtures__/dom.ts";
import { color } from "../theme.ts";
import { generateOffline, testCharacter } from "../../runtime/__fixtures__/offline.ts";
import { floorplanLayout, pointLayout, type Shape } from "../../runtime/layout.ts";
import { placedThings } from "../../runtime/occupancy.ts";
import { newRun, type RunState } from "../../store/game.ts";
import { mapView } from "../../store/selectors.ts";
import { positionPhrase } from "../../engine/index.ts";
import type { MapConnectorView, MapRoomView, MapView } from "../../store/selectors.ts";

// ===========================================================================
// FIXTURES
// ===========================================================================

const dungeon = generateOffline(1005, 2);
const entrance = dungeon.stocked.entranceRoomId;

/** What `PlayScreen` builds, built the same way. */
const plan = floorplanLayout(dungeon.blockplan!, dungeon.graph, {
  placed: placedThings(dungeon.entities),
});
const points = pointLayout(dungeon.graph);

/** A run in which exactly the named rooms have been described, and nothing else. */
function seen(...roomIds: string[]): RunState {
  const run = newRun(dungeon, testCharacter());
  for (const id of roomIds) {
    const room = run.entities.rooms.find((r) => r.id === id)!;
    room.composed = `You are standing in ${room.name}.`;
  }
  return run;
}

/**
 * The tooltip, WHICH IS NOT IN THE MAP.
 *
 * It used to be the only text inside the container, and the helper read
 * `container.textContent`. It is now a child of `document.body`, portalled
 * there so that nothing above the map can clip it or paint over it — which is
 * the whole reason react-tooltip was added, and `renders where nothing can clip
 * it` below is the test that says so.
 *
 * `react-tooltip__show` rather than `react-tooltip`, because a dismissed card
 * stays mounted through its fade — with no transitions in jsdom, matching the
 * bare class would report a closed tooltip as open forever.
 */
function tooltip(): string {
  const shown = document.querySelectorAll(".react-tooltip__show");
  // One map, one card. Two would mean two tooltips answering to the same id,
  // and every assertion below would be reading whichever came first.
  expect(shown.length).toBeLessThan(2);
  return shown[0]?.textContent ?? "";
}

// --- the hand-built one ----------------------------------------------------

const box = (x: number, y: number, w = 40): Shape => ({
  kind: "polygon",
  points: [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + w },
    { x, y: y + w },
  ],
});

function aRoom(id: string, over: Partial<MapRoomView> = {}): MapRoomView {
  return {
    id,
    shape: box(0, 0),
    centre: { x: 20, y: 20 },
    chunk: 0,
    known: true,
    mapped: false,
    current: false,
    name: `The ${id}`,
    composed: `A description of the ${id}.`,
    ...over,
  };
}

function aDoor(over: Partial<MapConnectorView> = {}): MapConnectorView {
  return {
    id: "c1",
    from: "here",
    to: "there",
    interChunk: false,
    path: { kind: "line", from: { x: 40, y: 20 }, to: { x: 60, y: 20 } },
    door: { at: { x: 40, y: 20 }, wall: "v", through: { x: 60, y: 20 }, length: 12 },
    known: true,
    toUnknown: false,
    blocked: false,
    surface: false,
    name: "an iron door",
    composed: "Studded, and sagging on its hinges.",
    ...over,
  };
}

function handmade(over: Partial<MapView> = {}): MapView {
  return {
    bounds: { w: 200, h: 100 },
    rooms: [aRoom("here", { current: true }), aRoom("there", { shape: box(60, 0) })],
    connectors: [aDoor()],
    fixtures: [],
    ...over,
  };
}

// ===========================================================================
// FOG
// ===========================================================================

describe("fog of war", () => {
  it("draws nothing at all before the first room has been described", () => {
    const r = renderDom(<DungeonMap map={mapView(seen(), dungeon, plan)} />);
    // An unvisited room is blank paper, and on the first turn every room is
    // unvisited. Not a faint outline, not a placeholder — nothing.
    expect(r.all("svg > path")).toHaveLength(0);
    // The marker too: it would otherwise sit alone in the void, telling the
    // player where they are on a map that has not been drawn.
    expect(r.all("svg > circle")).toHaveLength(0);
  });

  it("lights exactly the rooms that have been described", () => {
    const r = renderDom(<DungeonMap map={mapView(seen(entrance), dungeon, plan)} />);
    expect(r.all("svg > path")).toHaveLength(1);
    expect(dungeon.entities.rooms.length).toBeGreaterThan(1); // the test means something
  });

  it("stands the player on the room's own centre, not its average corner", () => {
    const map = mapView(seen(entrance), dungeon, plan);
    const here = map.rooms.find((room) => room.id === entrance)!;
    const r = renderDom(<DungeonMap map={map} />);

    // `LayoutRoom.centre` exists because averaging the vertices of an L puts
    // the marker in the rock outside the room. Reading `shape` here would
    // reintroduce exactly that bug with the tests still green.
    const you = r.one("svg > circle");
    expect(Number(you.getAttribute("cx"))).toBe(here.centre.x);
    expect(Number(you.getAttribute("cy"))).toBe(here.centre.y);
  });

  it("draws no door into a room nobody has been near", () => {
    const map = mapView(seen(), dungeon, plan);
    expect(map.connectors.every((c) => !c.known)).toBe(true);
    const r = renderDom(<DungeonMap map={map} />);
    expect(r.all("rect")).toHaveLength(0);
    expect(r.all("line")).toHaveLength(0);
  });
});

// ===========================================================================
// THE §7 BOUNDARY
// ===========================================================================
//
// One component, two layouts. This is what the `Layout` interface was for, and
// it is the only test that renders `pointLayout` — the fallback a run saved
// before the block plan existed still comes back on.

describe("both layouts render through the one component", () => {
  const run = seen(entrance);

  it("draws the floorplan as doors cut into walls", () => {
    const map = mapView(run, dungeon, plan);
    const known = map.connectors.filter((c) => c.known);
    expect(known.length).toBeGreaterThan(0);
    expect(known.every((c) => c.door !== undefined)).toBe(true);

    const r = renderDom(<DungeonMap map={map} />);
    expect(r.all("rect")).toHaveLength(known.length);
  });

  it("draws the point layout as lines between dots, with no doors anywhere", () => {
    const map = mapView(run, dungeon, points);
    expect(map.connectors.every((c) => c.door === undefined)).toBe(true);

    const r = renderDom(<DungeonMap map={map} />);
    expect(r.all("rect")).toHaveLength(0);
    expect(r.all("line")).toHaveLength(map.connectors.filter((c) => c.known).length);

    // A room is the SAME `<path>` element either way — `roomPath` answers the
    // discriminated union with arcs here and with corners over the floorplan,
    // and swapping the two is the whole of what §7 promised the map component.
    const d = r.one("svg > path").getAttribute("d")!;
    expect(d).toContain("a"); // an arc
    expect(d).not.toContain("L"); // no straight run
  });
});

// ===========================================================================
// WHAT IS STANDING IN THE ROOM
// ===========================================================================

describe("the fixture layer", () => {
  /**
   * The biggest thing the content pass placed, and the room it is in.
   *
   * Taken by cell count rather than by position in the list, because the whole
   * point of the assertion below is one entity with SEVERAL cells — a colonnade
   * is six dots the player points at as "the pillars". Picking the first
   * fixture would have quietly tested a one-cell thing and proved nothing.
   */
  const biggest = [...plan.fixtures].sort((a, b) => b.at.length - a.at.length)[0];

  function showing() {
    const run = seen(biggest.roomId);
    const entity =
      run.entities.features.find((f) => f.id === biggest.id) ??
      run.entities.items.find((i) => i.id === biggest.id)!;
    entity.composed = "Squat pillars, streaked with damp.";
    // Connectors are dropped so every <g> on the page is a fixture. The doors
    // have their own section and share the element.
    return { ...mapView(run, dungeon, plan), connectors: [] };
  }

  it("has something with more than one cell to draw", () => {
    expect(biggest.at.length).toBeGreaterThan(1);
  });

  it("draws one group per entity and one mark per cell", () => {
    const map = showing();
    expect(map.fixtures.length).toBeGreaterThan(0);

    const r = renderDom(<DungeonMap map={map} />);
    // One <g> per thing, so the hover reads the entity, not the cell.
    expect(r.all("g")).toHaveLength(map.fixtures.length);
    const cells = map.fixtures.reduce((n, f) => n + f.at.length, 0);
    expect(r.all("g path[data-shape]")).toHaveLength(cells);
    expect(cells).toBeGreaterThan(map.fixtures.length);
  });

  it("says where a thing stands in the words the referee was given", async () => {
    const map = showing();
    const f = map.fixtures.find((x) => x.id === biggest.id)!;
    const stored = dungeon.entities.features.find((x) => x.id === biggest.id)!.place!.position;
    const r = renderDom(<DungeonMap map={map} />);

    await hover(r.all("g")[map.fixtures.indexOf(f)]);
    expect(tooltip()).toContain(f.name);
    // The PROSE form, not the enum the model picked off the menu. The wire form
    // does not survive being dropped into a sentence — "at throughout" and "at
    // near the entrance" both reached a prompt before `positionPhrase` existed,
    // so the two forms differing is the thing worth asserting.
    expect(f.position).toBe(positionPhrase(stored));
    expect(f.position).not.toBe(stored);
    expect(tooltip()).toContain(f.position!);
  });

  it("lights every cell of the thing being pointed at, and only that thing", async () => {
    const map = showing();
    const f = map.fixtures.find((x) => x.id === biggest.id)!;
    // Inside a provider, because the highlight is shared state by design — its
    // whole point is that the room card can raise it too. Without one the map
    // still hovers and simply lights nothing, which is what "there is no other
    // panel" should mean. `hover.test.tsx` is where both panels meet.
    const r = renderDom(
      <HoverProvider>
        <DungeonMap map={map} />
      </HoverProvider>
    );

    const torch = () => r.all("g path[data-shape]").filter((c) => c.getAttribute("fill") === color.torch);
    expect(torch()).toHaveLength(0);

    await hover(r.all("g")[map.fixtures.indexOf(f)]);
    // A colonnade is six dots the player points at as one thing, so all six
    // light — that is the same reason the hover reads the entity and not the cell.
    expect(torch()).toHaveLength(f.at.length);
  });
});

// ===========================================================================
// HOVER
// ===========================================================================

describe("hover", () => {
  it("gives the room's name and the paragraph the player read", async () => {
    const map = mapView(seen(entrance), dungeon, plan);
    const here = map.rooms.find((room) => room.id === entrance)!;
    const r = renderDom(<DungeonMap map={map} />);

    expect(tooltip()).toBe("");
    await hover(r.one("svg > path"));
    expect(tooltip()).toContain(here.name!);
    expect(tooltip()).toContain(here.composed!);
    expect(tooltip()).toContain("you are here");
  });

  /**
   * THE REASON react-tooltip IS HERE.
   *
   * The tooltip this replaced was an absolutely positioned div inside the map's
   * own box, so a hover near the edge of a 320px panel was cut off — and the
   * room card, a later grid sibling with a background of its own, painted over
   * anything that spilled downward. There is no layout in jsdom to measure the
   * clipping with, but there is a parentage, and parentage is what the bug was:
   * a card that is a child of the document cannot be clipped by the map.
   */
  it("renders where nothing on the page can clip it", async () => {
    const r = renderDom(<DungeonMap map={handmade()} />);
    await hover(r.one("svg > path"));

    const card = document.querySelector(".react-tooltip__show")!;
    expect(card).not.toBeNull();
    expect(r.container.contains(card)).toBe(false);
    expect(card.parentElement).toBe(document.body);
  });

  it("clears when the cursor leaves the thing it was on", async () => {
    const r = renderDom(<DungeonMap map={handmade()} />);
    await hover(r.one("svg > path"));
    expect(tooltip()).not.toBe("");

    await unhover(r.one("svg > path"));
    expect(tooltip()).toBe("");
  });

  it("no longer tells the player to click, because everything is clickable", async () => {
    const r = renderDom(<DungeonMap map={handmade()} />);
    await hover(r.one("rect"));
    // The pill says what a click offers, on the thing itself, at the moment they
    // ask. A standing instruction in the hover card would be one more place for
    // the same fact — and the fact it stated was only ever true of some doors.
    expect(tooltip()).not.toContain("click to go through");
  });
});

// ===========================================================================
// WHAT A CLICK OFFERS
// ===========================================================================
//
// The pill is `hover.tsx` and the words on it are `verbs.ts`; what belongs here
// is the wiring between them and the drawing — that the map's own elements carry
// a verb at all, that the door gate reads the room the player is standing in, and
// that a press sends the sentence the button was showing.
//
// Rendered under a provider, because whether the game will take an action is a
// fact the provider carries. Bare, the map draws and offers nothing.

const inPlay = (map: MapView, over: Partial<ProviderProps> = {}) =>
  renderDom(
    <HoverProvider acting onAct={over.onAct ?? (() => {})} reachable={over.reachable}>
      <DungeonMap map={map} />
      <ActionPill />
    </HoverProvider>
  );

interface ProviderProps {
  onAct?(sentence: string): void;
  reachable?: ReadonlySet<string>;
}

/**
 * The pill, found by the attribute that carries what it would send.
 *
 * Scoped to `__show` for the reason `tooltip()` above gives: a dismissed tooltip
 * stays in the document through a fade that never finishes in jsdom, so the bare
 * attribute reports a closed pill as open forever — which it did, until this was
 * scoped.
 */
const pill = () => document.querySelector(".react-tooltip__show [data-sends]");

/**
 * Two rooms with names worth putting in a sentence.
 *
 * One brings its own article and one does not, which is the whole of `definite`
 * — "I make my way to the Kennel", "I look around The Sunken Vestibule" — and
 * the pair is why the pill tests do not use `aRoom`'s "The here".
 */
const twoRooms = (over: Partial<MapView> = {}) =>
  handmade({
    rooms: [
      aRoom("here", { current: true, name: "The Sunken Vestibule" }),
      aRoom("there", { shape: box(60, 0), name: "Kennel" }),
    ],
    ...over,
  });

describe("clicking a thing on the map", () => {
  it("offers to walk to a room the player has been in but is not standing in", async () => {
    const r = inPlay(twoRooms());
    expect(pill()).toBeNull();

    // `there` is the second path — the first is `here`, where they stand.
    await press(r.all("svg > path")[1]);
    expect(pill()!.textContent).toBe("Go To?");
    expect(pill()!.getAttribute("data-sends")).toBe("I make my way to the Kennel.");
  });

  it("offers to look around the room they are standing in", async () => {
    const r = inPlay(twoRooms());
    await press(r.all("svg > path")[0]);
    expect(pill()!.textContent).toBe("Examine?");
    // "The Sunken Vestibule" on the map, "the Sunken Vestibule" in a sentence —
    // `definite` moves the article and nothing else.
    expect(pill()!.getAttribute("data-sends")).toBe("I look around the Sunken Vestibule.");
  });

  it("sends the sentence the button was showing, once, on a press", async () => {
    const onAct = vi.fn();
    const r = inPlay(twoRooms(), { onAct });

    await press(r.all("svg > path")[1]);
    await press(pill()!);

    expect(onAct).toHaveBeenCalledTimes(1);
    expect(onAct).toHaveBeenCalledWith("I make my way to the Kennel.");
    // Answered and gone: a pill left open over a turn that is already running
    // would be a second click on a stale question.
    expect(pill()).toBeNull();
  });

  it("closes with no effect when the next click lands anywhere else", async () => {
    const onAct = vi.fn();
    const r = inPlay(twoRooms(), { onAct });

    await press(r.all("svg > path")[1]);
    expect(pill()).not.toBeNull();

    await press(r.one("svg"));
    expect(pill()).toBeNull();
    expect(onAct).not.toHaveBeenCalled();
  });

  it("offers a thing standing in the room nothing but a look at it", async () => {
    const map = handmade({
      fixtures: [
        {
          id: "f1",
          roomId: "here",
          kind: "RoomFeature",
          shape: "circle",
          at: [{ x: 10, y: 10 }],
          r: 3,
          name: "a cracked font",
          composed: "Dry, and lined with green.",
        },
      ],
    });
    const r = inPlay(map);

    await press(r.one("g path[data-shape]"));
    expect(pill()!.textContent).toBe("Examine?");
    expect(pill()!.getAttribute("data-sends")).toBe("I examine the cracked font.");
  });

  it("offers nothing at all while the game is not taking actions", async () => {
    const r = renderDom(
      <HoverProvider reachable={new Set(["c1"])} onAct={() => {}}>
        <DungeonMap map={handmade()} />
        <ActionPill />
      </HoverProvider>
    );

    // No attribute, so there is no anchor for the pill to open on — the gate is
    // one test in `useAnchor` rather than one per drawn thing.
    expect(r.all("[data-verb]")).toHaveLength(0);
    await press(r.all("svg > path")[1]);
    expect(pill()).toBeNull();
  });
});

describe("clicking a door", () => {
  const reachable = new Set(["c1"]);

  it("offers to go through one whose far side has not been seen", async () => {
    const map = handmade({ connectors: [aDoor({ toUnknown: true })] });
    const r = inPlay(map, { reachable });

    await press(r.one("rect"));
    expect(pill()!.textContent).toBe("Go Through?");
    expect(pill()!.getAttribute("data-sends")).toBe("I go through the iron door.");
  });

  it("offers only a look at one that joins two rooms they have both seen", async () => {
    // Two clicks for one move, and the room is the clearer statement of intent —
    // so the door stops offering it and the player clicks the room.
    const r = inPlay(handmade(), { reachable });

    await press(r.one("rect"));
    expect(pill()!.textContent).toBe("Examine?");
  });

  it("offers only a look at a door across the map", async () => {
    // A route rather than a step, and `routeTo` walks only where the player has
    // already been. The room they want is the thing to click.
    const map = handmade({ connectors: [aDoor({ toUnknown: true })] });
    const r = inPlay(map, { reachable: new Set(["elsewhere"]) });

    await press(r.one("rect"));
    expect(pill()!.textContent).toBe("Examine?");
  });

  it("offers only a look at a blocked way, and says what is in the way", async () => {
    const map = handmade({
      connectors: [
        aDoor({ toUnknown: true, blocked: true, requirement: "It is barred from the far side." }),
      ],
    });
    const r = inPlay(map, { reachable });

    // Outlined in torch: the way is there and it is shut, which is the planning
    // information the room card gives them too.
    expect(r.one("rect").getAttribute("stroke")).toBe(color.torch);

    // This is the one reversal of `TravelConfirm`, which offered travel through
    // anything and let the referee say no. The pill sends immediately, so
    // "go through the barred door" would spend a turn on an answer the card has
    // already given them; the bar is the thing to look at.
    await press(r.one("rect"));
    expect(pill()!.textContent).toBe("Examine?");
    expect(pill()!.getAttribute("data-sends")).toBe("I examine the iron door.");
  });

  it("offers to leave the dungeon through the way out", async () => {
    const map = handmade({
      connectors: [aDoor({ to: null, surface: true, name: "the stair up" })],
    });
    const r = inPlay(map, { reachable });

    // The one place the undiscovered-far-side rule is overridden: a way out has
    // no room on its far side to click instead, and never will have.
    await press(r.one("rect"));
    expect(pill()!.textContent).toBe("Leave the Dungeon?");
    expect(pill()!.getAttribute("data-sends")).toBe("I leave the dungeon through the stair up.");
  });
});

// ===========================================================================
// THE WAY OUT
// ===========================================================================

describe("the way out", () => {
  it("is the only door that reaches into blank paper", () => {
    const map = handmade({
      connectors: [aDoor(), aDoor({ id: "c2", to: null, surface: true, name: "the stair up" })],
    });
    const r = renderDom(<DungeonMap map={map} />);

    // Two doors, one stub. Every other door on the map joins two enclosed
    // places; this one goes off the edge of it and stops.
    expect(r.all("rect")).toHaveLength(2);
    expect(r.all("line")).toHaveLength(1);
    expect(r.one("line").getAttribute("stroke-dasharray")).toBe("3 3");
  });

  it("says that stepping through ends the run", async () => {
    const map = handmade({
      connectors: [aDoor({ to: null, surface: true, name: "the stair up" })],
    });
    const r = renderDom(<DungeonMap map={map} />);

    await hover(r.one("rect"));
    expect(tooltip()).toContain("the stair up");
    expect(tooltip()).toContain("stepping through ends the run");
  });
});

// ===========================================================================
// THE PAPER ITSELF
// ===========================================================================

describe("zoom and pan", () => {
  const full = "0 0 200 100";

  /** The viewBox as four numbers, and where the middle of it falls. */
  function frame(r: { one(s: string): Element }) {
    const [x, y, w, h] = r.one("svg").getAttribute("viewBox")!.split(" ").map(Number);
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
  }

  /**
   * How big the map's box is on screen.
   *
   * jsdom lays nothing out and reports every rect as zero, which for the zoom
   * is not a detail — a zoom that aims at the cursor has to turn a client
   * coordinate into a map one, and with no box there is nothing to divide by.
   * The component treats that case as "aim at the middle", so a test about
   * aiming ANYWHERE ELSE has to say how big the box is.
   */
  function measured(el: Element, width: number, height: number) {
    Object.defineProperty(el, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height,
        toJSON: () => ({}),
      }),
    });
  }

  it("starts showing the whole thing", () => {
    const r = renderDom(<DungeonMap map={handmade()} />);
    expect(r.one("svg").getAttribute("viewBox")).toBe(full);
  });

  it("narrows the view on a wheel up and will not go wider than the whole map", () => {
    const r = renderDom(<DungeonMap map={handmade()} />);

    fire(r.one("svg"), "wheel", { deltaY: -1 });
    const [, , w] = r.one("svg").getAttribute("viewBox")!.split(" ").map(Number);
    expect(w).toBeLessThan(200);

    // Back out past 1:1 and it clamps rather than shrinking the drawing into
    // the middle of an empty panel.
    for (let i = 0; i < 6; i++) fire(r.one("svg"), "wheel", { deltaY: 1 });
    expect(r.one("svg").getAttribute("viewBox")).toBe(full);
  });

  it("keeps the middle of the view where it was when there is nothing to aim at", () => {
    const r = renderDom(<DungeonMap map={handmade()} />);
    // No box measured, so no cursor position can be worked out. The zoom is
    // centre-preserving rather than corner-preserving, which is what it used to
    // be: the old one pinned the top-left and walked the drawing out of frame.
    fire(r.one("svg"), "wheel", { deltaY: -1 });
    expect(frame(r).cx).toBeCloseTo(100);
    expect(frame(r).cy).toBeCloseTo(50);
  });

  it("takes the view half the way toward what the cursor is over", () => {
    const r = renderDom(<DungeonMap map={handmade()} />);
    measured(r.one("div"), 200, 100); // one pixel per map unit

    // In far enough that the edges are not in the way, aiming at the middle so
    // this first part moves nothing.
    for (let i = 0; i < 8; i++) {
      fire(r.one("svg"), "wheel", { deltaY: -1, clientX: 100, clientY: 50 });
    }
    const before = frame(r);
    expect(before.cx).toBeCloseTo(100);

    // Now point at the right-hand side of the panel. Where that lands in map
    // units is read off the view, not re-derived from the zoom's own arithmetic.
    const aim = before.x + (150 / 200) * before.w;
    fire(r.one("svg"), "wheel", { deltaY: -1, clientX: 150, clientY: 50 });

    const moved = frame(r).cx - before.cx;
    expect(moved / (aim - before.cx)).toBeCloseTo(0.5, 1);
    // Toward it, and not past it: one wheel click should not throw the map
    // across the panel.
    expect(frame(r).cx).toBeGreaterThan(before.cx);
    expect(frame(r).cx).toBeLessThan(aim);
  });

  it("will not let a zoom push the drawing off the paper", () => {
    const r = renderDom(<DungeonMap map={handmade()} />);
    measured(r.one("div"), 200, 100);

    // Hard into the top-left corner, repeatedly. A zoom that aimed freely would
    // walk the view off the edge of the map; a drag still may, because pushing
    // the sheet aside is what a drag is for.
    for (let i = 0; i < 6; i++) {
      fire(r.one("svg"), "wheel", { deltaY: -1, clientX: 0, clientY: 0 });
    }
    const f = frame(r);
    expect(f.x).toBeGreaterThanOrEqual(0);
    expect(f.y).toBeGreaterThanOrEqual(0);
    expect(f.x + f.w).toBeLessThanOrEqual(200);
    expect(f.y + f.h).toBeLessThanOrEqual(100);
  });

  it("moves the paper under the cursor on a drag, and puts it back on a double click", () => {
    const r = renderDom(<DungeonMap map={handmade()} />);

    drag(r.one("svg"), { x: 0, y: 0 }, { x: 10, y: 4 });
    expect(r.one("svg").getAttribute("viewBox")).not.toBe(full);

    fire(r.one("svg"), "dblclick");
    expect(r.one("svg").getAttribute("viewBox")).toBe(full);
  });
});
