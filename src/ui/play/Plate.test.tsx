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
import { doorHeading, Plate } from "./Plate.tsx";
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
  shape: "diamond",
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
    expect(spot(r, "c1")!.getAttribute("data-door")).toBe("came-from");
    expect(spot(r, "f1")!.hasAttribute("data-came-from")).toBe(false);
  });

  it("draws a door as an arch with an arrow for which way it leads on the map", async () => {
    const r = await shown(<Plate id="here" subject="The here" load={async () => ready} map={map} />);
    // The hand-built door leads east.
    expect(spot(r, "c1")!.getAttribute("data-door")).toBe("arrow");
    expect(spot(r, "c1")!.getAttribute("data-heading")).toBe("e");
    expect(spot(r, "c1")!.querySelector("g")!.getAttribute("transform")).toBe("rotate(90 12 15)");
  });

  it("draws the way out of the dungeon walking out, whichever way they came in", async () => {
    const out = { ...map, connectors: [{ ...door, surface: true }] };
    const r = await shown(<Plate id="here" subject="The here" load={async () => ready} map={out} cameFrom="c1" />);
    expect(spot(r, "c1")!.getAttribute("data-door")).toBe("way-out");
    expect(spot(r, "c1")!.querySelector("path")!.getAttribute("fill")).toBe(color.verdigris);
  });

  it("gives a feature its map mark", async () => {
    const r = await shown(<Plate id="here" subject="The here" load={async () => ready} map={map} />);
    expect(spot(r, "f1")!.getAttribute("data-shape")).toBe("diamond");
    expect(spot(r, "f1")!.hasAttribute("data-door")).toBe(false);
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
    const lit = () => spot(r, "f1")!.hasAttribute("data-lit");
    const marker = () => r.one("svg[role=img] path[data-shape]");

    await hover(spot(r, "f1")!);
    expect(marker().getAttribute("fill")).toBe(color.torch);
    expect(lit()).toBe(true);
    expect(marker().getAttribute("style")).toContain("scale(1.45)");
    await unhover(spot(r, "f1")!);
    expect(marker().getAttribute("fill")).toBe(color.graphite);

    expect(lit()).toBe(false);
    await hover(r.one("svg[role=img] g[data-hover-id=f1]"));
    expect(lit()).toBe(true);
  });
});

describe("doorHeading", () => {
  it("reads the map's compass, north up", () => {
    const at = { x: 10, y: 10 };
    expect(doorHeading({ at, through: { x: 10, y: 4 } })).toBe("n");
    expect(doorHeading({ at, through: { x: 10, y: 16 } })).toBe("s");
    expect(doorHeading({ at, through: { x: 16, y: 11 } })).toBe("e");
    expect(doorHeading({ at, through: { x: 4, y: 9 } })).toBe("w");
  });

  it("points the way the door LEADS from the plate's room, whichever side the plan put `through`", () => {
    // A room south of the door: its floor is y 10..30. `through` sits inside it,
    // so the door leads north out of it, not south into it.
    const room = { kind: "polygon" as const, points: [{ x: 0, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 30 }, { x: 0, y: 30 }] };
    const at = { x: 10, y: 10 };
    expect(doorHeading({ at, through: { x: 10, y: 16 } }, room)).toBe("n");
    // `through` on the far side already: left alone.
    expect(doorHeading({ at, through: { x: 10, y: 4 } }, room)).toBe("n");
  });
});

describe("the creatures stood in a plate", () => {
  /** jsdom loads no images; this one says it is 200 × 400, two 100-wide halves. */
  class LoadedImage {
    naturalWidth = 200;
    naturalHeight = 400;
    onload: (() => void) | null = null;
    set src(_: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  const figure = { sprite: "monks", x: 0.5, y: 0.8, perFoot: 0.05, flop: true };
  const sprite = async () => ({ status: "ready", url: "https://cdn.example/plates/s.png", size: "medium" }) as const;

  it("stands each figure feet-first at its point, as tall as its size, and keeps it after they leave", async () => {
    const real = globalThis.Image;
    globalThis.Image = LoadedImage as unknown as typeof Image;
    try {
      const r = await shown(
        <Plate id="here" subject="The here" load={async () => ready} map={map} sprite={sprite} figures={[figure]} />
      );
      await act(async () => {});
      const el = r.container.querySelector('[data-figure="monks"]') as HTMLElement;
      expect(el).not.toBeNull();
      expect(el.style.left).toBe("50%");
      expect(el.style.top).toBe("80%");
      // 0.05 of the plate per foot × 6 ft (medium) × FIGURE_SCALE 1.4 = 42%.
      expect(parseFloat(el.style.height)).toBeCloseTo(42, 5);
      expect(parseFloat(el.style.aspectRatio)).toBe(0.25);
      expect(el.style.transform).toContain("scaleX(-1)");

      // They walk out: the plate loses its live figures but keeps the last it showed.
      r.update(<Plate id="here" subject="The here" load={async () => ready} sprite={sprite} />);
      await act(async () => {});
      expect(r.container.querySelector('[data-figure="monks"]')).not.toBeNull();
    } finally {
      globalThis.Image = real;
    }
  });

  it("a sprite still being drawn is not there yet", async () => {
    const r = await shown(
      <Plate
        id="here"
        subject="The here"
        load={async () => ready}
        sprite={async () => ({ status: "none" })}
        figures={[figure]}
      />
    );
    expect(r.container.querySelector("[data-figure]")).toBeNull();
  });
});
