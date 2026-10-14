/**
 * The buttons on a room's plate: each dot is the map's marker for the same
 * thing — the same card, the same question, the same highlight.
 *
 * A hand-built `MapView` with one door and one bench, for the reason
 * `DungeonMap.test.tsx` gives: the test should check the component, not
 * re-derive where a real dungeon's door ends up.
 */

import { act } from "react";
import { describe, expect, it } from "vitest";
import { DungeonMap } from "./DungeonMap.tsx";
import { ActionPill, HoverProvider } from "./hover.tsx";
import { Plate } from "./Plate.tsx";
import { color } from "../theme.ts";
import { hover, press, renderDom, unhover } from "../__fixtures__/dom.ts";
import type { PlateAnswer } from "../../runtime/plates.ts";
import type { MapConnectorView, MapFixtureView, MapView } from "../../store/selectors.ts";

const door: MapConnectorView = {
  id: "c1",
  from: "here",
  to: "there",
  interChunk: false,
  path: { kind: "line", from: { x: 40, y: 20 }, to: { x: 60, y: 20 } },
  door: { at: { x: 40, y: 20 }, wall: "v", through: { x: 60, y: 20 }, length: 12 },
  known: true,
  toUnknown: true,
  blocked: false,
  surface: false,
  name: "an iron door",
  composed: "Studded, and sagging on its hinges.",
};

const bench: MapFixtureView = {
  id: "f1",
  roomId: "here",
  at: [{ x: 10, y: 10 }],
  r: 3,
  name: "a stone bench",
  composed: "Worn smooth.",
  position: "along the west wall",
};

const map: MapView = {
  bounds: { w: 200, h: 100 },
  rooms: [
    {
      id: "here",
      shape: { kind: "polygon", points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }] },
      centre: { x: 20, y: 20 },
      chunk: 0,
      known: true,
      mapped: false,
      current: true,
      name: "The here",
      composed: "A room.",
    },
  ],
  connectors: [door],
  fixtures: [bench],
};

const ready: PlateAnswer = {
  status: "ready",
  url: "https://cdn.example/plates/a.png",
  spots: [
    { id: "c1", x: 0.25, y: 0.5 },
    { id: "f1", x: 0.6, y: 0.8 },
    // Not on the map yet, so not on the plate either.
    { id: "f-unseen", x: 0.9, y: 0.9 },
  ],
};

async function shown(el: React.ReactElement) {
  const r = renderDom(el);
  await act(async () => {});
  return r;
}

const spot = (r: { container: HTMLElement }, id: string) =>
  r.container.querySelector(`[data-plate-spot="${id}"]`) as HTMLElement | null;
const pill = () => document.querySelector(".react-tooltip__show [data-sends]");

describe("a plate's buttons", () => {
  it("puts a dot where each spot is, for what the map shows and nothing else", async () => {
    const r = await shown(<Plate id="here" subject="The here" load={async () => ready} map={map} />);
    expect(spot(r, "c1")!.style.left).toBe("25%");
    expect(spot(r, "c1")!.style.top).toBe("50%");
    expect(spot(r, "f1")).not.toBeNull();
    expect(spot(r, "f-unseen")).toBeNull();
  });

  it("marks the way they came in by with a U-turn, and only that one", async () => {
    const r = await shown(<Plate id="here" subject="The here" load={async () => ready} map={map} cameFrom="c1" />);
    expect(spot(r, "c1")!.hasAttribute("data-came-from")).toBe(true);
    expect(spot(r, "c1")!.querySelector("svg")).not.toBeNull();
    expect(spot(r, "f1")!.hasAttribute("data-came-from")).toBe(false);
    expect(spot(r, "f1")!.querySelector("svg")).toBeNull();
  });

  it("is only a picture without a map", async () => {
    const r = await shown(<Plate id="here" subject="The here" load={async () => ready} />);
    expect(r.container.querySelector("[data-plate-spot]")).toBeNull();
  });

  it("asks the map's question, and a click on a dot does not open the full size", async () => {
    const r = await shown(
      <HoverProvider acting onAct={() => {}} reachable={new Set(["c1"])}>
        <Plate id="here" subject="The here" load={async () => ready} map={map} />
        <ActionPill />
      </HoverProvider>
    );
    await press(spot(r, "c1")!);
    expect(pill()!.textContent).toBe("Go Through?");
    expect(pill()!.getAttribute("data-sends")).toBe("I go through the iron door.");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("lights with the map, both ways", async () => {
    const r = await shown(
      <HoverProvider>
        <Plate id="here" subject="The here" load={async () => ready} map={map} />
        <DungeonMap map={map} />
      </HoverProvider>
    );
    const dot = () => spot(r, "f1")!.firstElementChild!;
    const marker = () => r.one("svg g circle");

    await hover(spot(r, "f1")!);
    expect(marker().getAttribute("fill")).toBe(color.torch);
    expect(dot().className).toContain("bg-torch");
    await unhover(spot(r, "f1")!);
    expect(marker().getAttribute("fill")).toBe(color.graphite);

    await hover(r.one("svg g"));
    expect(dot().className).toContain("bg-torch");
  });
});
