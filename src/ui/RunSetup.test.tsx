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
function setup(dungeons: DungeonSummary[], characters = [testCharacter()]) {
  const chosen: RunChoice[] = [];
  const page = renderDom(
    h(RunSetup, {
      characters,
      dungeons,
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
   * Size and level are the cost of WRITING a dungeon. Beside one that is
   * already written they would be controls that change nothing, which is a
   * worse thing to put in front of a player than an absence.
   */
  it("drops the size and level controls once a written world is chosen", async () => {
    const { page } = setup([world()]);
    expect(text(page)).toContain("12 rooms · 2 regions · 2 writing calls");

    await press(byText(page, "The Drowned Aviary"));

    expect(text(page)).not.toContain("writing call");
    expect(text(page)).toContain("nothing to wait for and nothing to pay");
    expect(text(page)).toContain("Straight down");
  });

  it("goes back to rolling one when the player changes their mind", async () => {
    const { page, chosen } = setup([world()]);

    await press(byText(page, "The Drowned Aviary"));
    await press(byText(page, "A new one"));
    await press(byText(page, "Go down"));

    expect(chosen).toEqual([
      { world: "new", size: 2, level: 1, character: expect.objectContaining({ id: expect.any(String) }) },
    ]);
    expect(text(page)).toContain("12 rooms · 2 regions · 2 writing calls");
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

    expect(text(page)).toContain("12 rooms · 2 regions · 2 writing calls");
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
 * The big sizes are off for now. They are DRAWN and refused rather than removed,
 * so the control reads as a ceiling instead of as a smaller control -- and so
 * putting them back is deleting one line rather than restoring a widget.
 */
describe("the sizes that are turned off", () => {
  const sizeButton = (page: ReturnType<typeof renderDom>, label: string) => {
    const found = page
      .all("button")
      .find((b) => b.textContent === label && b.className.includes("border"));
    if (!found) throw new Error(`no size button ${label}`);
    return found as HTMLButtonElement;
  };

  it("still draws 4 and 5, refused", () => {
    const { page } = setup([]);
    expect(sizeButton(page, "3").disabled).toBe(false);
    expect(sizeButton(page, "4").disabled).toBe(true);
    expect(sizeButton(page, "5").disabled).toBe(true);
  });

  it("does not let one be chosen", async () => {
    const { page, chosen } = setup([]);

    await press(sizeButton(page, "4"));
    await press(byText(page, "Go down"));

    expect(chosen[0]).toMatchObject({ world: "new", size: 2 });
  });
});
