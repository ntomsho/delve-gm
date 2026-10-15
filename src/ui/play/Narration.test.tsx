/**
 * The narration column's records — the lines the game master did not write.
 */

import { describe, expect, it } from "vitest";
import { act, createElement as h } from "react";
import { Narration, toItems } from "./Narration.tsx";
import { renderDom } from "../test-utils/dom.ts";

describe("what a turn cost, under the prose", () => {
  it("states the wound and the broken thing as their own marks", () => {
    const items = toItems(
      [
        { kind: "game-master", text: "The ledge gives.", turn: 1 },
        {
          kind: "effects",
          text: "",
          turn: 1,
          effects: [
            { kind: "hp", from: 15, to: 9, max: 15 },
            { kind: "damaged", itemId: "s", name: "Sword", from: 3, to: 2, of: 3 },
            { kind: "destroyed", itemId: "t", name: "Torch" },
          ],
        },
      ],
      () => ""
    );
    const t = renderDom(h(Narration, { items })).container.textContent ?? "";
    expect(t).toContain("−6 HP · 15 → 9");
    expect(t).toContain("Sword damaged · 2/3");
    expect(t).toContain("Torch destroyed");
  });

  it("says dead when the hit points reach zero", () => {
    const items = toItems(
      [{ kind: "effects", text: "", turn: 1, effects: [{ kind: "hp", from: 4, to: 0, max: 15 }] }],
      () => ""
    );
    expect(renderDom(h(Narration, { items })).container.textContent).toContain("−4 HP · 4 → 0 · dead");
  });
});

describe("a creature's roll against them", () => {
  it("shows the die, hit or miss, and the damage dice — and no target number", () => {
    const items = toItems(
      [
        {
          kind: "foe",
          text: "",
          turn: 1,
          foe: [
            {
              label: "Ghoul attack",
              d20: { rolled: [17], kept: 17, bonus: 2, total: 19, success: true, nat20: false, nat1: false },
              damage: { expr: "1d6", rolls: [5], total: 5 },
            },
            { label: "Thrall attack", d20: { rolled: [3], kept: 3, bonus: 0, total: 3, success: false, nat20: false, nat1: false } },
          ],
        },
      ],
      () => ""
    );
    const t = renderDom(h(Narration, { items })).container.textContent ?? "";
    expect(t).toContain("Ghoul attack");
    expect(t).toContain("Hit");
    expect(t).toContain("5 damage");
    expect(t).toContain("Thrall attack");
    expect(t).toContain("Miss");
    expect(t).not.toMatch(/vs/i);
  });
});

describe("a room's illustration", () => {
  const log = [
    { kind: "arrival" as const, text: "A hall.", roomId: "r1", turn: 1 },
    { kind: "arrival" as const, text: "A cell.", roomId: "r2", turn: 2 },
    { kind: "arrival" as const, text: "The hall again.", roomId: "r1", turn: 3 },
  ];

  it("is asked for once per room, at its first arrival", () => {
    const asked: string[] = [];
    const illustration = async (roomId: string) => {
      asked.push(roomId);
      return { status: "pending" as const };
    };
    const { container } = renderDom(h(Narration, { items: toItems(log, (id) => id), illustration }));
    expect(asked).toEqual(["r1", "r2"]);
    expect(container.querySelectorAll('[aria-label$="still being drawn"]').length).toBe(2);
  });

  it("on a resumed run, is asked for only in the room the player is in", () => {
    const asked: string[] = [];
    const illustration = async (roomId: string) => {
      asked.push(roomId);
      return { status: "pending" as const };
    };
    renderDom(
      h(Narration, {
        items: toItems(log, (id) => id),
        illustration,
        here: { roomId: "r2" },
        resumed: new Set(["r1", "r2"]),
      })
    );
    expect(asked).toEqual(["r2"]);
  });

  it("is never asked for without a loader, as on a local run", () => {
    const { container } = renderDom(h(Narration, { items: toItems(log, (id) => id) }));
    expect(container.querySelectorAll('[aria-label*="A drawing of"]').length).toBe(0);
  });
});

describe("the dungeon's cover", () => {
  const log = [{ kind: "opening" as const, text: "You came for the egg.", turn: 0 }];
  const dungeon = { name: "The Drowned Aviary", objective: "Steal the brass egg" };

  it("is asked for above the opening", () => {
    let asked = 0;
    const cover = async () => {
      asked++;
      return { status: "pending" as const };
    };
    const { container } = renderDom(h(Narration, { items: toItems(log, () => "", dungeon), cover }));
    expect(asked).toBe(1);
    expect(container.querySelector('[aria-label="A drawing of The Drowned Aviary, still being drawn"]')).not.toBeNull();
  });

  it("is never asked for on a local run", () => {
    const { container } = renderDom(h(Narration, { items: toItems(log, () => "", dungeon) }));
    expect(container.querySelector('[aria-label*="A drawing of"]')).toBeNull();
  });
});

describe("an illustration's buttons", () => {
  const log = [
    { kind: "arrival" as const, text: "A hall.", roomId: "r1", turn: 1 },
    { kind: "arrival" as const, text: "A cell.", roomId: "r2", turn: 2 },
  ];
  const spots = (roomId: string) => [{ id: `door-${roomId}`, how: "shown" as const, x: 0.5, y: 0.5 }];
  const map = {
    bounds: { w: 10, h: 10 },
    rooms: [],
    fixtures: [],
    connectors: ["r1", "r2"].map((r) => ({
      id: `door-${r}`,
      from: r,
      to: "x",
      interChunk: false,
      path: { kind: "line" as const, from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
      known: true,
      toUnknown: true,
      blocked: false,
      surface: false,
      name: "a door",
    })),
  };

  it("are drawn only on the illustration of the room the player is in", async () => {
    const illustration = async (roomId: string) => ({ status: "ready" as const, url: `u/${roomId}`, spots: spots(roomId) });
    const { container } = renderDom(
      h(Narration, { items: toItems(log, (id) => id), illustration, map, here: { roomId: "r2" } })
    );
    await act(async () => {});
    const ids = [...container.querySelectorAll("[data-illustration-spot]")].map((e) => e.getAttribute("data-illustration-spot"));
    expect(ids).toEqual(["door-r2"]);
  });
});

describe("wide, the pictures beside the text", () => {
  const log = [
    { kind: "arrival" as const, text: "A hall.", roomId: "r1", turn: 1 },
    { kind: "arrival" as const, text: "A cell.", roomId: "r2", turn: 2 },
    { kind: "player" as const, text: "I go back.", turn: 3 },
    { kind: "arrival" as const, text: "The hall again.", roomId: "r1", turn: 3 },
    { kind: "game-master" as const, text: "Dust settles.", turn: 4 },
  ];
  const ready = async (roomId: string) => ({ status: "ready" as const, url: `u/${roomId}` });

  /** A chat `width` pixels wide, as a browser would measure it. */
  function at(width: number) {
    const was = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private cb: ResizeObserverCallback) {}
      observe() {
        this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    return () => (globalThis.ResizeObserver = was);
  }

  it("stands each illustration beside its own text, and sticks the current room's lowest one", async () => {
    const undo = at(1000);
    try {
      const { container } = renderDom(
        h(Narration, { items: toItems(log, (id) => id), illustration: ready, here: { roomId: "r1" } })
      );
      await act(async () => {});
      const runs = [...container.querySelectorAll("[data-run]")];
      // r1's first arrival, r2's, and r1's again: wide, the room they are in has its illustration at the bottom too.
      expect(runs.map((r) => r.getAttribute("data-run"))).toEqual(["0", "1", "3"]);
      const sticky = container.querySelectorAll("[data-sticky]");
      expect(sticky).toHaveLength(1);
      expect(runs[2].contains(sticky[0])).toBe(true);
      expect(runs[2].textContent).toContain("Dust settles.");
    } finally {
      undo();
    }
  });

  it("keeps the illustrations in the text when the chat is too narrow", async () => {
    const undo = at(600);
    try {
      const { container } = renderDom(
        h(Narration, { items: toItems(log, (id) => id), illustration: ready, here: { roomId: "r1" } })
      );
      await act(async () => {});
      expect(container.querySelector("[data-run]")).toBeNull();
      expect(container.querySelectorAll('[aria-label^="A drawing of"]')).toHaveLength(2);
    } finally {
      undo();
    }
  });

  it("is never wide on a phone", async () => {
    const undo = at(1000);
    try {
      const { container } = renderDom(
        h(Narration, { items: toItems(log, (id) => id), illustration: ready, here: { roomId: "r1" }, compact: true })
      );
      await act(async () => {});
      expect(container.querySelector("[data-run]")).toBeNull();
    } finally {
      undo();
    }
  });
});
