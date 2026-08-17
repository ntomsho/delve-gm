/**
 * The area around the input, in a DOM.
 *
 * `screens.test.ts` renders the standing panels statically and that is the right
 * instrument for them. This component is refs and effects — the box measures
 * itself, focus follows the stage — so it lands on the jsdom side of the split
 * described in `vite.config.ts`, even where a test here only reads text.
 */

import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { InputArea } from "./InputArea.tsx";
import { renderDom } from "../__fixtures__/dom.ts";
import type { Stage } from "../../runtime/types.ts";

const noop = () => {};

function render(stage: Stage, turns: number, over: { onLeave?: () => void } = {}) {
  return renderDom(
    h(InputArea, {
      stage,
      turns,
      draft: "",
      onDraft: noop,
      onSubmit: noop,
      onRoll: noop,
      onRetry: noop,
      onAbandon: noop,
      ...over,
    })
  ).container;
}

function area(stage: Stage, turns: number, over: { onLeave?: () => void } = {}) {
  return render(stage, turns, over).textContent!;
}

describe("the turn tracker", () => {
  // `run.turnCount` is CLOSED turns and has been since Phase 2. The player is
  // living through the next one, which is also the number the referee is given.
  it("counts the turn in progress, not the turns behind it", () => {
    expect(area("awaiting_action", 0)).toContain("Turn 1");
    expect(area("awaiting_action", 7)).toContain("Turn 8");
  });

  it("keeps counting while the game is working, since the turn is still open", () => {
    expect(area("thinking", 3)).toContain("Turn 4");
    expect(area("roll_offered", 3)).toContain("Turn 4");
  });

  // A finished run has no turn in progress, and the end-of-run card a few lines
  // below states the closed count. Both numbers at once, labelled the same way
  // and one apart, would be worse than no tracker.
  it("stands aside at the end, where the card counts closed turns", () => {
    const text = area("goal_met", 8);
    expect(text).not.toContain("Turn 9");
    expect(text).toContain("8 turns");
  });
});

/*
 * PHASE 12. A run can now be ended by the player rather than only by the
 * fiction, and every ending has somewhere to go afterwards.
 */

describe("walking away", () => {
  it("offers the way out for as long as the run is live", () => {
    // Including while the referee is working, which is when a player in front of
    // a `thinking` that will never finish most needs it.
    for (const stage of ["awaiting_action", "roll_offered", "thinking", "error"] as Stage[]) {
      expect(area(stage, 2)).toContain("Abandon run");
    }
  });

  it("does not offer it once the run is over", () => {
    for (const stage of ["dead", "escaped", "goal_met", "abandoned"] as Stage[]) {
      expect(area(stage, 2)).not.toContain("Abandon run");
    }
  });

  it("reads as an ending of its own, not as a death or an escape", () => {
    const text = area("abandoned", 6);
    expect(text).toContain("The run is abandoned");
    expect(text).toContain("6 turns");
    // The one ending that is not about the fiction. It should not claim the
    // character climbed out, because they did not.
    expect(text).not.toContain("open air");
    expect(text).not.toContain("hit points reached zero");
  });

  it("closes the input like any other ending", () => {
    const box = render("abandoned", 3).querySelector("textarea");
    expect(box?.disabled).toBe(true);
  });
});

describe("the way back to the roster", () => {
  it("is offered at every ending when there is one to go back to", () => {
    for (const stage of ["dead", "escaped", "goal_met", "abandoned"] as Stage[]) {
      expect(area(stage, 4, { onLeave: noop })).toContain("Back to characters");
    }
  });

  // A local run — `?offline`, `?stub` — has no roster, and a button leading
  // nowhere is worse than the plain statement that the run has ended.
  it("is absent when there is not", () => {
    expect(area("goal_met", 4)).not.toContain("Back to characters");
  });
});
