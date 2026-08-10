/**
 * "Go through this door?"
 *
 * The dialog exists to put a keystroke of friction back in front of a click and
 * to show the player the sentence before it is sent. Both of those are behaviour
 * rather than markup — the sentence has to be the one that gets handed back, and
 * the ways out have to actually get out — so none of it is reachable from a
 * static render. That is what this file is for.
 */

import { describe, expect, it, vi } from "vitest";
import { TravelConfirm, travelSentence } from "./TravelConfirm.tsx";
import { fire, renderDom } from "../__fixtures__/dom.ts";
import type { ExitView } from "../../store/selectors.ts";

function exit(over: Partial<ExitView> = {}): ExitView {
  return {
    connectorId: "c1",
    toRoomId: "r2",
    surface: false,
    toRoomName: "Flooded Cellar",
    name: "an iron door",
    blocked: false,
    toKnown: false,
    cameFrom: false,
    ...over,
  };
}

function open(over: Partial<ExitView> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const r = renderDom(<TravelConfirm exit={exit(over)} onConfirm={onConfirm} onCancel={onCancel} />);
  return { ...r, onConfirm, onCancel };
}

describe("the travel confirmation", () => {
  it("hands back the exact sentence it showed", () => {
    const r = open();
    const shown = r.one('[role="dialog"] p:last-of-type').textContent ?? "";
    // Quoted on the page; the quotes are not part of what is sent.
    expect(shown).toContain(travelSentence(exit()));

    fire(r.one("button:last-of-type"), "click");
    expect(r.onConfirm).toHaveBeenCalledWith(travelSentence(exit()));
  });

  it("puts the cursor on Go, so Enter confirms without a click", () => {
    const r = open();
    expect(document.activeElement).toBe(r.one("button:last-of-type"));
  });

  it("takes Escape as staying put", () => {
    const r = open();
    fire(window, "keydown", { key: "Escape" });
    expect(r.onCancel).toHaveBeenCalledTimes(1);
    expect(r.onConfirm).not.toHaveBeenCalled();
  });

  it("stops listening for Escape once it is gone", () => {
    const r = open();
    r.unmount();
    fire(window, "keydown", { key: "Escape" });
    // A window listener that outlives its dialog cancels the NEXT one too.
    expect(r.onCancel).not.toHaveBeenCalled();
  });

  it("cancels on the backdrop and not on the dialog itself", () => {
    const r = open();
    fire(r.one('[role="dialog"]'), "click");
    expect(r.onCancel).not.toHaveBeenCalled();

    fire(r.one('[role="presentation"]'), "click");
    expect(r.onCancel).toHaveBeenCalledTimes(1);
  });

  it("says what stands in the way and still offers to go", () => {
    const r = open({ blocked: true, requirement: "The lock wants a key you do not have." });
    expect(r.container.textContent).toContain("The lock wants a key you do not have.");

    // The referee is the one that gets to say no. The map only reports what the
    // player has been told, so a blocked way is offered rather than refused.
    fire(r.one("button:last-of-type"), "click");
    expect(r.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("marks the way out as the end of the run", () => {
    const r = open({ surface: true, toRoomId: null, name: "the stair up" });
    expect(r.container.textContent).toContain("Leave the dungeon");
    expect(r.container.textContent).toContain("the run ends there");
    expect(r.one("button:last-of-type").textContent).toBe("Leave");

    fire(r.one("button:last-of-type"), "click");
    expect(r.onConfirm).toHaveBeenCalledWith("I leave the dungeon through the stair up.");
  });

  it("names where they are going only once they have been there", () => {
    expect(open({ toKnown: true }).container.textContent).toContain("Back to the Flooded Cellar");
    expect(open({ toKnown: false }).container.textContent).toContain(
      "You do not know what is on the other side"
    );
  });
});
