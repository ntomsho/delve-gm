/**
 * CHOOSING A WORLD — the half of run setup that has state in it.
 *
 * `screens.test.ts` renders this screen statically and checks what is on it
 * before anybody touches anything, which is the cheaper instrument and the right
 * one for that question. This file exists for the other one: what the screen
 * does when a saved world is picked, which is a `useState` branch and therefore
 * invisible to a static render.
 *
 * WHAT IS ACTUALLY WORTH PINNING is that the two answers are different requests.
 * `onConfirm` hands back a tagged union — a size and a level, or a dungeon id,
 * never both — and the failure mode if that ever collapsed into one bag with
 * optional fields is a run that names a world AND restates its dice, leaving the
 * server to decide which it believed. See `RunChoice`.
 */

import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderDom, press } from "./__fixtures__/dom.ts";
import { RunSetup, type RunChoice } from "./RunSetup.tsx";
import { testCharacter } from "../runtime/__fixtures__/offline.ts";
import type { DungeonSummary } from "../store/dungeons.ts";
import type { Allowance } from "../store/allowance.ts";

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

/** The screen, with somewhere to catch what confirming it says. */
function setup(
  dungeons: DungeonSummary[],
  characters = [testCharacter()],
  allowance?: Allowance
) {
  const chosen: RunChoice[] = [];
  const page = renderDom(
    h(RunSetup, {
      characters,
      dungeons,
      ...(allowance ? { allowance, onUpgrade: async () => {} } : {}),
      onConfirm: (c: RunChoice) => chosen.push(c),
      onBack: () => {},
    })
  );
  return { page, chosen };
}

/** The same sheet at a level worth doing arithmetic against. */
const atLevel = (level: number) => ({ ...testCharacter(), level });

/** A button by the text in it — the world rows have no role of their own. */
const byText = (page: ReturnType<typeof renderDom>, text: string): Element => {
  const found = page.all("button").find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`no button saying ${text}`);
  return found;
};

const text = (page: ReturnType<typeof renderDom>) => page.container.textContent ?? "";

describe("choosing a world", () => {
  it("asks for a dungeon by name and states no dice", async () => {
    const { page, chosen } = setup([world()]);

    await press(byText(page, "The Drowned Aviary"));
    await press(byText(page, "Go down"));

    // The whole contract of the existing-world branch: the world is NAMED.
    // Size, level and seed are facts about it already.
    expect(chosen).toEqual([
      { world: "existing", dungeonId: "d-1", character: expect.objectContaining({ id: expect.any(String) }) },
    ]);
  });

  /*
   * Difficulty is a fact about WRITING a dungeon. Beside one that is already
   * written it would be a control that changes nothing, which is a worse thing
   * to put in front of a player than an absence.
   */
  it("drops the difficulty control once a written world is chosen", async () => {
    const { page } = setup([world()]);
    expect(text(page)).toContain("Difficulty");

    await press(byText(page, "The Drowned Aviary"));

    expect(text(page)).not.toContain("Difficulty");
    expect(text(page)).toContain("nothing to wait for and nothing to pay");
    expect(text(page)).toContain("Straight down");
  });

  it("goes back to rolling one when the player changes their mind", async () => {
    const { page, chosen } = setup([world()]);

    await press(byText(page, "The Drowned Aviary"));
    await press(byText(page, "A new one"));
    await press(byText(page, "Go down"));

    expect(chosen).toEqual([
      { world: "new", size: 1, level: 1, character: expect.objectContaining({ id: expect.any(String) }) },
    ]);
  });

  /*
   * The list is read when the screen opens (`openSetup` in `App.tsx`) and the
   * chosen id is held here, so the two can disagree — a world that stopped
   * existing under the screen must not become a run into a dungeon nobody can
   * name. Falling back to a new world is the safe half of that.
   */
  it("falls back to a new world when the chosen one goes away", async () => {
    const { page, chosen } = setup([world()]);
    await press(byText(page, "The Drowned Aviary"));

    // The same root, re-rendered with new props: the chosen id survives, the
    // world it named does not.
    page.update(
      h(RunSetup, {
        characters: [testCharacter()],
        dungeons: [],
        onConfirm: (c: RunChoice) => chosen.push(c),
        onBack: () => {},
      })
    );

    expect(text(page)).toContain("Difficulty");
    await press(byText(page, "Go down"));
    expect(chosen).toEqual([expect.objectContaining({ world: "new" })]);
  });
});

/*
 * DIFFICULTY IS ASKED, LEVEL IS SENT. The screen stopped asking for a dungeon
 * level outright because it is a number the player cannot judge without their
 * own sheet beside it. What has to hold is that the offset is resolved against
 * the CHOSEN character and that `onConfirm` still hands back a level, because
 * that is what generation takes and what the world is stored under.
 */
describe("choosing a difficulty", () => {
  it("sends the character's own level on Medium", async () => {
    const { chosen, page } = setup([], [atLevel(3)]);

    await press(byText(page, "Go down"));

    expect(chosen[0]).toMatchObject({ world: "new", level: 3 });
  });

  it("sends one either side of it on Easy and Hard", async () => {
    const { chosen, page } = setup([], [atLevel(3)]);

    await press(byText(page, "Easy"));
    await press(byText(page, "Go down"));
    await press(byText(page, "Hard"));
    await press(byText(page, "Go down"));

    expect(chosen.map((c) => (c.world === "new" ? c.level : undefined))).toEqual([2, 4]);
  });

  it("goes to 0, which is a dungeon rather than a clamp", async () => {
    const { chosen, page } = setup([], [atLevel(1)]);

    await press(byText(page, "Easy"));
    await press(byText(page, "Go down"));

    // A level 1 character has somewhere easier to go: level 0 stocks the fodder
    // band -- +0, defense 10, half a hit die. See `hitDiceFor` and `maxHp`.
    expect(chosen[0]).toMatchObject({ level: 0 });
  });

  it("does not go below 0", async () => {
    const { chosen, page } = setup([], [atLevel(0)]);

    await press(byText(page, "Easy"));
    await press(byText(page, "Go down"));

    expect(chosen[0]).toMatchObject({ level: 0 });
  });

  it("states the arithmetic rather than making the player do it", () => {
    const { page } = setup([], [atLevel(4)]);
    expect(text(page)).toContain("dungeon level 4");
  });
});

/*
 * NO SIZE CONTROL. Every new world is size 1, for everyone, to hold the cost
 * down; there is nothing to choose and so nothing drawn.
 */
describe("the size of a new world", () => {
  it("is not asked, and is always 1", async () => {
    const { page, chosen } = setup([]);
    expect(text(page)).not.toContain("Size");
    await press(byText(page, "Go down"));
    expect(chosen[0]).toMatchObject({ world: "new", size: 1 });
  });
});

/*
 * THE DAILY ALLOWANCE. The server is the gate; what this screen owes the player
 * is to say how many are left before they press anything, and not to offer a
 * button the server will refuse.
 */
describe("the daily allowance", () => {
  const allowance = (over: Partial<Allowance> = {}): Allowance => ({
    guest: true,
    unlimited: false,
    used: 0,
    limit: 1,
    left: 1,
    maxSize: 1,
    resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    unplayed: [],
    ...over,
  });
  it("says how many are left, and offers a guest Google", () => {
    const { page } = setup([], undefined, allowance());
    expect(text(page)).toContain("1 of 1 run left today");
    expect(text(page)).toContain("Sign in with Google");
  });

  it("will not go down with none left, and says when more arrive", async () => {
    const { page, chosen } = setup(
      [],
      undefined,
      allowance({ guest: false, limit: 3, used: 3, left: 0 })
    );
    expect((byText(page, "Go down") as HTMLButtonElement).disabled).toBe(true);
    expect(text(page)).toMatch(/No runs left today · more in 3 hours/i);
    // A member is not told to sign in.
    expect(text(page)).not.toContain("Sign in with Google");

    await press(byText(page, "Go down"));
    expect(chosen).toEqual([]);
  });

  it("still lets them down a world they wrote and have not been down yet", async () => {
    const spent = allowance({ used: 1, left: 0, unplayed: ["d-1"] });
    const { page, chosen } = setup([world(), world({ id: "d-2", name: "The Relish Quarry" })], undefined, spent);

    // A new one, or somebody's second run: both cost a run they do not have.
    expect((byText(page, "Go down") as HTMLButtonElement).disabled).toBe(true);
    await press(byText(page, "The Relish Quarry"));
    expect((byText(page, "Go down") as HTMLButtonElement).disabled).toBe(true);

    // The one they wrote: its first run was paid for by the writing.
    await press(byText(page, "The Drowned Aviary"));
    expect(text(page)).toContain("paid for when it was written");
    await press(byText(page, "Go down"));
    expect(chosen[0]).toMatchObject({ world: "existing", dungeonId: "d-1" });
  });

  it("limits nothing for an unlimited account", () => {
    const { page } = setup(
      [],
      undefined,
      allowance({ guest: false, unlimited: true, limit: null, left: null, maxSize: 5 })
    );
    expect((byText(page, "Go down") as HTMLButtonElement).disabled).toBe(false);
    expect(text(page)).not.toContain("left today");
  });
});

describe("a world's cover", () => {
  it("is drawn small beside a world that has one", () => {
    const { page } = setup([world({ cover: "https://cdn.example/plates/a.png" }), world({ id: "d-2", name: "Bare" })]);
    const inks = [...page.container.querySelectorAll("div")].filter((d) =>
      (d as HTMLElement).style.maskImage.includes("https://cdn.example/plates/a.png")
    );
    expect(inks).toHaveLength(1);
  });
});
