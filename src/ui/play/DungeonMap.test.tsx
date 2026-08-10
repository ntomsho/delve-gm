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
import { drag, fire, leave, renderDom } from "../__fixtures__/dom.ts";
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
 * The tooltip is the only text on the page.
 *
 * The map is `<path>`, `<rect>`, `<line>` and `<circle>` and contains no text
 * node of its own, so the container's text IS the hover. Worth stating rather
 * than hiding behind a class selector, which would break the first time the
 * tooltip is restyled.
 */
const tooltip = (r: { container: HTMLElement }) => r.container.textContent ?? "";

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
    expect(r.all("g circle")).toHaveLength(cells);
    expect(cells).toBeGreaterThan(map.fixtures.length);
  });

  it("says where a thing stands in the words the referee was given", () => {
    const map = showing();
    const f = map.fixtures.find((x) => x.id === biggest.id)!;
    const stored = dungeon.entities.features.find((x) => x.id === biggest.id)!.place!.position;
    const r = renderDom(<DungeonMap map={map} />);

    fire(r.all("g")[map.fixtures.indexOf(f)], "mousemove");
    expect(tooltip(r)).toContain(f.name);
    // The PROSE form, not the enum the model picked off the menu. The wire form
    // does not survive being dropped into a sentence — "at throughout" and "at
    // near the entrance" both reached a prompt before `positionPhrase` existed,
    // so the two forms differing is the thing worth asserting.
    expect(f.position).toBe(positionPhrase(stored));
    expect(f.position).not.toBe(stored);
    expect(tooltip(r)).toContain(f.position!);
  });
});

// ===========================================================================
// HOVER
// ===========================================================================

describe("hover", () => {
  it("gives the room's name and the paragraph the player read", () => {
    const map = mapView(seen(entrance), dungeon, plan);
    const here = map.rooms.find((room) => room.id === entrance)!;
    const r = renderDom(<DungeonMap map={map} />);

    expect(tooltip(r)).toBe("");
    fire(r.one("svg > path"), "mousemove");
    expect(tooltip(r)).toContain(here.name!);
    expect(tooltip(r)).toContain(here.composed!);
    expect(tooltip(r)).toContain("you are here");
  });

  it("clears when the cursor leaves the map", () => {
    const r = renderDom(<DungeonMap map={handmade()} />);
    fire(r.one("svg > path"), "mousemove");
    expect(tooltip(r)).not.toBe("");

    leave(r.one("svg"));
    expect(tooltip(r)).toBe("");
  });

  it("tells the player a way is clickable only when it is", () => {
    const clickable = renderDom(
      <DungeonMap map={handmade()} onDoorClick={() => {}} travelable={new Set(["c1"])} />
    );
    fire(clickable.one("rect"), "mousemove");
    expect(tooltip(clickable)).toContain("click to go through");

    const far = renderDom(<DungeonMap map={handmade()} onDoorClick={() => {}} />);
    fire(far.one("rect"), "mousemove");
    expect(tooltip(far)).not.toContain("click to go through");
  });
});

// ===========================================================================
// TRAVEL
// ===========================================================================

describe("clicking a door", () => {
  it("offers the ways out of the room the player is standing in", () => {
    const onDoorClick = vi.fn();
    const r = renderDom(
      <DungeonMap map={handmade()} onDoorClick={onDoorClick} travelable={new Set(["c1"])} />
    );

    fire(r.one("rect"), "click");
    expect(onDoorClick).toHaveBeenCalledWith("c1");
  });

  it("does nothing for a door across the map", () => {
    const onDoorClick = vi.fn();
    // A far door is a route rather than a step, and phrasing a route as a
    // sentence the player never wrote is how the map starts speaking for them.
    const r = renderDom(
      <DungeonMap map={handmade()} onDoorClick={onDoorClick} travelable={new Set(["elsewhere"])} />
    );

    fire(r.one("rect"), "click");
    expect(onDoorClick).not.toHaveBeenCalled();
  });

  it("is read-only when nothing was given to call", () => {
    const r = renderDom(<DungeonMap map={handmade()} travelable={new Set(["c1"])} />);
    expect(() => fire(r.one("rect"), "click")).not.toThrow();
  });

  it("keeps a blocked way clickable, and says what is in the way", () => {
    const onDoorClick = vi.fn();
    const map = handmade({
      connectors: [aDoor({ blocked: true, requirement: "It is barred from the far side." })],
    });
    const r = renderDom(
      <DungeonMap map={map} onDoorClick={onDoorClick} travelable={new Set(["c1"])} />
    );

    // Outlined in torch: the way is there and it is shut, which is the planning
    // information the room card gives them too.
    expect(r.one("rect").getAttribute("stroke")).toBe(color.torch);

    fire(r.one("rect"), "mousemove");
    expect(tooltip(r)).toContain("It is barred from the far side.");

    // The referee is the one that gets to say no. The map only reports.
    fire(r.one("rect"), "click");
    expect(onDoorClick).toHaveBeenCalledWith("c1");
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

  it("says that stepping through ends the run", () => {
    const map = handmade({
      connectors: [aDoor({ to: null, surface: true, name: "the stair up" })],
    });
    const r = renderDom(<DungeonMap map={map} />);

    fire(r.one("rect"), "mousemove");
    expect(tooltip(r)).toContain("the stair up");
    expect(tooltip(r)).toContain("stepping through ends the run");
  });
});

// ===========================================================================
// THE PAPER ITSELF
// ===========================================================================

describe("zoom and pan", () => {
  const full = "0 0 200 100";

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

  it("moves the paper under the cursor on a drag, and puts it back on a double click", () => {
    const r = renderDom(<DungeonMap map={handmade()} />);

    drag(r.one("svg"), { x: 0, y: 0 }, { x: 10, y: 4 });
    expect(r.one("svg").getAttribute("viewBox")).not.toBe(full);

    fire(r.one("svg"), "dblclick");
    expect(r.one("svg").getAttribute("viewBox")).toBe(full);
  });
});
