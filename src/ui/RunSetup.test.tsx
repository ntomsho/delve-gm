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
function setup(dungeons: DungeonSummary[]) {
  const chosen: RunChoice[] = [];
  const page = renderDom(
    h(RunSetup, {
      characters: [testCharacter()],
      dungeons,
      onConfirm: (c: RunChoice) => chosen.push(c),
      onBack: () => {},
    })
  );
  return { page, chosen };
}

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
