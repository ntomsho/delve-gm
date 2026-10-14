/**
 * THE SHELF, READ DOWN IN BATCHES.
 *
 * Every test here is about paging or about what a card may say, because those
 * are the two things that can be wrong in a way looking at the screen would not
 * catch: a batch that replaces the last instead of appending, a cursor sent for
 * the wrong row, a second request fired while the first is still out, a `doc`
 * appearing on a card.
 *
 * NO `IntersectionObserver` IN JSDOM, which is exactly why the sentinel at the
 * foot of the grid is a real button rather than an observer with a button
 * bolted on as a fallback. Every test below presses it, and that is the same
 * path a browser takes when the observer fires — the observer only presses it
 * earlier.
 */

import { describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { act } from "react";
import { renderDom, press } from "../test-utils/dom.ts";
import { Library } from "./Library.tsx";
import { testCharacter } from "../../fixtures/offline.ts";
import type { DungeonSummary, LibraryPage } from "../../api-client/dungeons.ts";

const world = (n: number, over: Partial<DungeonSummary> = {}): DungeonSummary => ({
  id: `d-${n}`,
  name: `Hole ${n}`,
  objective: `Steal thing ${n}`,
  size: 2,
  level: 1,
  seed: 1000 + n,
  status: "complete",
  createdAt: new Date(Date.now() - n * 86_400_000).toISOString(),
  ...over,
});

/** A shelf of `total` worlds, handed out `per` at a time, cursor by index. */
function shelf(total: number, per = 3) {
  const all = Array.from({ length: total }, (_, i) => world(i + 1));
  const asked: (string | undefined)[] = [];

  const load = async (cursor?: string): Promise<LibraryPage> => {
    asked.push(cursor);
    const from = cursor ? Number(cursor) : 0;
    const page = all.slice(from, from + per);
    const next = from + per;
    return { dungeons: page, ...(next < total ? { cursor: String(next) } : {}) };
  };

  return { all, asked, load };
}

const text = (page: ReturnType<typeof renderDom>) => page.container.textContent ?? "";

/** Let the first batch's promise resolve and its state land. */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

async function open(load: (c?: string) => Promise<LibraryPage>, onChoose = async () => {}) {
  const page = renderDom(
    h(Library, {
      character: testCharacter(),
      load,
      onChoose,
      onBack: () => {},
    })
  );
  await settle();
  return page;
}

const button = (page: ReturnType<typeof renderDom>, label: string): Element => {
  const found = page.all("button").find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button saying "${label}"`);
  return found;
};

describe("reading the shelf", () => {
  it("asks for the first batch with no cursor and shows it", async () => {
    const { asked, load } = shelf(7, 3);
    const page = await open(load);

    expect(asked).toEqual([undefined]);
    expect(page.all("li")).toHaveLength(3);
    expect(text(page)).toContain("Hole 1");
    expect(text(page)).toContain("Steal thing 1");
  });

  /*
   * APPENDED, NOT REPLACED. A shelf being read down that replaced its last
   * batch would be a screen that scrolls nowhere — and the bug would look like
   * "the list flickers" rather than like a paging fault.
   */
  it("adds each batch to the ones already read", async () => {
    const { asked, load } = shelf(7, 3);
    const page = await open(load);

    await press(button(page, "More"));
    expect(page.all("li")).toHaveLength(6);
    expect(text(page)).toContain("Hole 1");
    expect(text(page)).toContain("Hole 6");

    // And the cursor it sent was the LAST row of the batch before, not the first.
    expect(asked).toEqual([undefined, "3"]);
  });

  it("says when the shelf has been read to the end, and stops asking", async () => {
    const { load } = shelf(5, 3);
    const page = await open(load);

    await press(button(page, "More"));
    expect(page.all("li")).toHaveLength(5);
    expect(text(page)).toContain("That is the whole shelf");
    expect(page.all("button").filter((b) => b.textContent?.trim() === "More")).toHaveLength(0);
  });

  /*
   * The observer presses the same button the player does, so both triggers can
   * arrive at once — near the foot of a fast scroll, that is two requests for
   * one page and a batch appended twice.
   */
  it("does not ask twice for one batch", async () => {
    const { asked } = shelf(9, 3);
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => (release = r));

    const { load } = shelf(9, 3);
    const slow = async (cursor?: string) => {
      asked.push(cursor);
      if (asked.length > 1) await held;
      return load(cursor);
    };

    const page = await open(slow);
    const more = button(page, "More");

    // Pressed twice before the first answer lands.
    await act(async () => {
      more.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      more.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    release!();
    await settle();

    // One request for the second batch, and one batch appended.
    expect(asked.filter((c) => c === "3")).toHaveLength(1);
    expect(page.all("li")).toHaveLength(6);
  });

  it("shows an empty shelf as one rather than as a wait", async () => {
    const page = await open(async () => ({ dungeons: [] }));
    expect(text(page)).toContain("Nobody else has finished a world yet");
    expect(text(page)).not.toContain("Reading the shelf");
  });

  /*
   * A failure to fetch MORE must not take away what the player is looking at.
   * The batches already read are still true.
   */
  it("keeps the batches it has when the next one fails", async () => {
    let calls = 0;
    const { load } = shelf(9, 3);
    const flaky = async (cursor?: string) => {
      if (++calls > 1) throw new Error("the shelf is unreachable");
      return load(cursor);
    };

    const page = await open(flaky);
    await press(button(page, "More"));

    expect(text(page)).toContain("the shelf is unreachable");
    expect(page.all("li")).toHaveLength(3);
    // And the button is still there to try again with.
    expect(button(page, "More")).toBeDefined();
  });
});

describe("a card", () => {
  it("carries the world's cover when it has one, and no picture when it has none", async () => {
    const load = async (): Promise<LibraryPage> => ({
      dungeons: [world(1, { cover: "https://cdn.example/illustrations/a.png" }), world(2)],
    });
    const page = await open(load);
    const covers = [...page.container.querySelectorAll('[role="img"]')];
    expect(covers.map((c) => c.getAttribute("aria-label"))).toEqual(["Hole 1, from outside"]);
    expect((covers[0] as HTMLElement).style.maskImage).toContain("https://cdn.example/illustrations/a.png");
  });

  it("names the character who would go down, on every one", async () => {
    const { load } = shelf(3, 3);
    const page = await open(load);
    const pc = testCharacter();

    const sends = page.all("button").filter((b) => b.textContent?.includes(`Send ${pc.name} down`));
    expect(sends).toHaveLength(3);
  });

  /*
   * THE WHOLE CROSS-OWNER VOCABULARY IS THE SUMMARY. A card that could show a
   * room, a creature or the goal's location would be a walkthrough for a
   * dungeon nobody had walked — and there is no maker named on it either,
   * because the only name this project holds for an account is their email.
   */
  it("shows what a summary holds and cannot show more", async () => {
    const { load } = shelf(1, 3);
    const page = await open(load);

    expect(text(page)).toContain("Hole 1");
    expect(text(page)).toContain("Steal thing 1");
    expect(text(page)).toContain("SIZE 2");
    expect(text(page)).toContain("LEVEL 1");
    expect(text(page)).toContain("12 ROOMS");
    // Nothing on the card carries an address for a person.
    expect(text(page)).not.toContain("@");
  });

  it("hands the chosen world up and says which card is working", async () => {
    const { load } = shelf(3, 3);
    const chosen: DungeonSummary[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => (release = r));

    const page = await open(load, async (d?: DungeonSummary) => {
      chosen.push(d!);
      await held;
    });

    const pc = testCharacter();
    const card = page.all("button").filter((b) => b.textContent?.includes(`Send ${pc.name} down`))[1]!;
    await act(async () => void card.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(chosen.map((d) => d.id)).toEqual(["d-2"]);
    // The pressed card says what it is doing; the others are shut while it does.
    expect(text(page)).toContain("Taking a copy…");
    expect(page.all("button").filter((b) => (b as HTMLButtonElement).disabled).length).toBeGreaterThan(0);

    release!();
    await settle();
  });

  it("reports a copy that failed beside the shelf and reopens the card", async () => {
    const { load } = shelf(3, 3);
    const page = await open(load, async () => {
      throw new Error("that world is gone");
    });

    const pc = testCharacter();
    await press(page.all("button").find((b) => b.textContent?.includes(`Send ${pc.name} down`))!);

    expect(text(page)).toContain("that world is gone");
    expect(text(page)).not.toContain("Taking a copy…");
  });
});

describe("the observer", () => {
  /*
   * The lazy half. jsdom has no `IntersectionObserver`, so this stands one up
   * and fires it — what is being checked is that the screen ASKS when the foot
   * of the shelf comes into view, not that a browser's observer works.
   */
  it("asks for the next batch when the foot of the shelf comes into view", async () => {
    const observers: Array<(entries: { isIntersecting: boolean }[]) => void> = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      }
    );

    try {
      const { asked, load } = shelf(9, 3);
      const page = await open(load);
      expect(asked).toEqual([undefined]);

      await act(async () => observers.forEach((cb) => cb([{ isIntersecting: true }])));
      await settle();

      expect(asked).toEqual([undefined, "3"]);
      expect(page.all("li")).toHaveLength(6);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
