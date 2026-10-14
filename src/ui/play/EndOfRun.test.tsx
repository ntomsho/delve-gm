/**
 * THE END-OF-RUN SCREEN
 * =====================
 *
 * Four endings, and the screen has to be right about a different thing in each.
 *
 * The load-bearing assertion in this file is the one about LOOT AND KEEPING IT:
 * the list is the same either way — a player who died with four hundred copper
 * of reliquary in the pack should be shown what they lost — but whether it is
 * theirs is a rule, and a screen that got it backwards would be telling a player
 * their sheet says something it does not.
 */

import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { EndOfRun, type Ending, type EndOfRunProps } from "./EndOfRun.tsx";
import { press, renderDom } from "../test-utils/dom.ts";
import type { RunTally } from "../../gameplay/tally/tally-pass.ts";
import type { RunLoot } from "../../gameplay/mechanics/loot.ts";

const noop = () => {};

const NO_LOOT: RunLoot = { found: [], coin: 0, total: 0 };

const SOME_LOOT: RunLoot = {
  found: [
    { id: "reliquary", name: "Silver reliquary", value: 420 },
    { id: "comb", name: "Ivory comb", value: 85 },
  ],
  coin: 112,
  total: 617,
};

const A_TALLY: RunTally = {
  awards: [
    { challengeId: "ch:a", about: "a creature's weakness", risk: "high", xp: 200, why: "Killed the ghoul" },
    { challengeId: "ch:b", about: "a blocked way", risk: "moderate", xp: 100, why: "Talked past the warden" },
  ],
  total: 300,
  unrated: [],
};

function render(stage: Ending, over: Partial<EndOfRunProps> = {}) {
  return renderDom(
    h(EndOfRun, {
      stage,
      turns: 23,
      loot: NO_LOOT,
      keeps: stage === "goal_met" || stage === "escaped",
      onDismiss: noop,
      ...over,
    })
  );
}

const text = (stage: Ending, over: Partial<EndOfRunProps> = {}) =>
  render(stage, over).container.textContent!;

// ---------------------------------------------------------------------------

describe("the four endings", () => {
  it("each say which one it was", () => {
    expect(text("goal_met")).toContain("The run ends well");
    expect(text("escaped")).toContain("The run ends unfinished");
    expect(text("dead")).toContain("The run ends here");
    expect(text("abandoned")).toContain("The run is abandoned");
  });

  it("count the closed turns", () => {
    expect(text("goal_met")).toContain("23 turns");
  });

  /*
   * AN ESCAPE IS A DECISION, NOT A DEFEAT, and the copy used to disagree — it
   * read "with your life and nothing else", which was wrong twice: they keep the
   * whole pack, and cutting your losses is a choice a careful player makes.
   */
  it("does not tell an escaped player they came back empty-handed", () => {
    const said = text("escaped", { loot: SOME_LOOT, keeps: true });
    expect(said).not.toContain("nothing else");
    expect(said).toContain("everything in your pack is yours");
  });

  // The one ending that is not about the fiction at all. It must not claim the
  // character climbed out, because they did not.
  it("does not invent a retreat for an abandoned run", () => {
    const said = text("abandoned");
    expect(said).not.toContain("climbed out");
    expect(said).not.toContain("hit points reached zero");
  });
});

describe("what they were carrying", () => {
  it("lists it, with what each thing is worth", () => {
    const said = text("goal_met", { loot: SOME_LOOT, keeps: true });
    expect(said).toContain("Silver reliquary");
    expect(said).toContain("420 cp");
    expect(said).toContain("Ivory comb");
  });

  it("counts coin as its own line rather than as an object", () => {
    const said = text("goal_met", { loot: SOME_LOOT, keeps: true });
    expect(said).toContain("Coin");
    expect(said).toContain("112 cp");
    expect(said).toContain("617 cp");
  });

  /*
   * THE RULE. Walking out alive is what makes the pack yours, and the two
   * endings that do not walk out have to say so — a player who dies holding six
   * hundred copper of treasure and is shown a list with no verdict on it will
   * reasonably assume they kept it.
   */
  it("says it is theirs when they walked out with it", () => {
    for (const stage of ["goal_met", "escaped"] as Ending[]) {
      const said = text(stage, { loot: SOME_LOOT, keeps: true });
      expect(said).toContain("What you carried out");
      expect(said).toContain("Yours");
      expect(said).not.toContain("None of this reaches your character sheet");
    }
  });

  it("says it is lost when they did not", () => {
    for (const stage of ["dead", "abandoned"] as Ending[]) {
      const said = text(stage, { loot: SOME_LOOT, keeps: false });
      expect(said).toContain("What you were carrying");
      expect(said).toContain("Lost");
      expect(said).toContain("None of this reaches your character sheet");
    }
  });

  // Shown either way, because "you lost something" is a worse ending than being
  // shown the thing you lost.
  it("lists the same things on a death as on a win", () => {
    expect(text("dead", { loot: SOME_LOOT, keeps: false })).toContain("Silver reliquary");
  });

  it("says so plainly when there was nothing", () => {
    expect(text("goal_met", { loot: NO_LOOT, keeps: true })).toContain("came back with the same");
  });
});

describe("what it was worth", () => {
  it("prices each accomplishment, and says how dangerous it was", () => {
    const said = text("goal_met", { tally: A_TALLY, xpTotal: 300 });
    expect(said).toContain("Killed the ghoul");
    expect(said).toContain("200 xp");
    expect(said).toContain("high");
    expect(said).toContain("Talked past the warden");
  });

  it("totals it", () => {
    expect(text("goal_met", { tally: A_TALLY, xpTotal: 300 })).toContain("300 xp");
  });

  /*
   * THE TWO UNSCORED ENDINGS SAY WHY. A blank where a score should be reads as a
   * bug; "a dead character earns nothing" reads as a rule. `shouldTally` is what
   * enforces it — this is the screen agreeing with it.
   */
  it("explains the nothing on a death", () => {
    const said = text("dead");
    expect(said).toContain("Experience is what you carry back out");
    expect(said).not.toContain("Being reckoned up");
  });

  it("explains the nothing on an abandonment", () => {
    expect(text("abandoned")).toContain("A delve nobody finished is not scored");
  });

  // The ending lands before the scoring call comes back, and the screen must not
  // look finished while it is still waiting. See `settle` — a tally that never
  // returns leaves the run ended and this line standing, which is the honest
  // failure rather than a screen held hostage to a model call.
  it("says it is still waiting when the ending has landed and the tally has not", () => {
    expect(text("goal_met")).toContain("Being reckoned up");
  });

  it("says so when they got out having answered nothing", () => {
    const empty: RunTally = { awards: [], total: 0, unrated: [] };
    expect(text("escaped", { tally: empty })).toContain("without answering anything");
  });

  /*
   * LEVELLING IS TAKEN ON THE ROSTER, so this screen reports rather than
   * offers. Without a level to compare against it can only measure a distance,
   * which is what it did before there was anything to announce.
   */
  it("shows the running total and the distance to the next level", () => {
    const said = text("goal_met", { tally: A_TALLY, xpTotal: 1300 });
    expect(said).toContain("1,300 xp in all");
    expect(said).toContain("700 toward the next level");
  });

  it("says a level is waiting when the career total has bought one", () => {
    const said = text("goal_met", { tally: A_TALLY, xpTotal: 1300, level: 1 });
    expect(said).toContain("1,300 xp in all");
    expect(said).toContain("a level is waiting on the roster");
  });

  it("counts them when more than one is unclaimed", () => {
    expect(text("goal_met", { tally: A_TALLY, xpTotal: 3200, level: 1 })).toContain(
      "3 levels are waiting"
    );
  });

  it("goes back to the distance for somebody who has claimed what they earned", () => {
    const said = text("goal_met", { tally: A_TALLY, xpTotal: 1300, level: 2 });
    expect(said).toContain("700 toward the next level");
    expect(said).not.toContain("waiting on the roster");
  });
});

describe("how it happened", () => {
  const DEATH = {
    where: "the Chapel of Rust",
    turn: 23,
    killer: "Ghoul",
    lastAction: "swing at it again",
    present: ["Ghoul", "Thrall (3)"],
  };

  it("names where, when, and what they were fighting", () => {
    const said = text("dead", { death: DEATH });
    expect(said).toContain("the Chapel of Rust");
    expect(said).toContain("turn 23");
    expect(said).toContain("Ghoul");
    expect(said).toContain("swing at it again");
  });

  /*
   * WHAT WAS IN THE ROOM IS NOT AN ACCUSATION. Nothing in the entity model marks
   * a creature hostile, so the killer and the bystanders are two different
   * claims and are two different sentences. The killer is never repeated in the
   * second one.
   */
  it("lists the rest of the room apart from the killer", () => {
    const said = text("dead", { death: DEATH });
    expect(said).toContain("Also in the room: Thrall (3)");
  });

  it("accuses nobody when the game does not know", () => {
    const said = text("dead", { death: { where: "the Sunken Stair", turn: 9, present: [] } });
    expect(said).toContain("You died in the Sunken Stair, on turn 9");
    expect(said).not.toContain("fighting");
  });

  it("is absent on every ending that is not a death", () => {
    for (const stage of ["goal_met", "escaped", "abandoned"] as Ending[]) {
      expect(text(stage)).not.toContain("How it happened");
    }
  });
});

describe("the ways out of it", () => {
  it("can be dismissed back to the map and the scrollback", async () => {
    let dismissed = 0;
    const r = render("goal_met", { onDismiss: () => void dismissed++ });
    await press([...r.container.querySelectorAll("button")].find((b) => b.textContent === "Look around")!);
    expect(dismissed).toBe(1);
  });

  it("offers the roster when there is one to go back to", () => {
    expect(text("dead", { onLeave: noop })).toContain("Back to characters");
  });

  // An `?offline` run has no roster, and a button leading
  // nowhere is worse than the plain statement that the run has ended.
  it("does not, when there is not", () => {
    expect(text("dead")).not.toContain("Back to characters");
  });
});
