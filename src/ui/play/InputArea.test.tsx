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

function area(stage: Stage, turns: number) {
  return renderDom(
    h(InputArea, {
      stage,
      turns,
      draft: "",
      onDraft: noop,
      onSubmit: noop,
      onRoll: noop,
      onRetry: noop,
    })
  ).container.textContent!;
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
