/**
 * ILLUSTRATION PROMPTS
 *
 * The assembly is pure text, so the tests pin the contract rather than the
 * wording: what each guide mode adds or leaves out, and that tags only appear
 * when the guide carries them.
 */

import { describe, expect, it } from "vitest";
import {
  exteriorIllustrationPrompt,
  roomIllustrationPrompt,
  type RoomPromptParts,
} from "./prompt.ts";
import {
  ILLUSTRATION_GUIDE_NOTE,
  ILLUSTRATION_PLAIN_GUIDE_NOTE,
  ILLUSTRATION_STYLE,
} from "../prompts/loader.ts";

const parts = (guide: RoomPromptParts["guide"]): RoomPromptParts => ({
  guide,
  setting: "Grey limestone vaults.",
  room: "A square cell with a shallow vault.",
  viewpoint: "Standing by the south wall, looking north.",
  drawn: [
    { tag: "A", look: "a narrow arched doorway", where: "in the facing wall, straight ahead, 15 ft away", doorway: true },
    { tag: "1", look: "a waist-high block of pale stone", where: "in the foreground, on the left, 10 ft away", doorway: false },
  ],
  surfaces: [{ look: "white salt bloom along the joints", where: "throughout the room" }],
});

describe("roomIllustrationPrompt", () => {
  it("always leads with the style", () => {
    for (const g of ["marks", "plain", "none"] as const) expect(roomIllustrationPrompt(parts(g)).startsWith(`STYLE\n${ILLUSTRATION_STYLE}`)).toBe(true);
  });

  it("explains the marks, and tags each thing, only when the guide carries marks", () => {
    const marks = roomIllustrationPrompt(parts("marks"));
    expect(marks).toContain(ILLUSTRATION_GUIDE_NOTE);
    expect(marks).toContain("- [A] Doorway: a narrow arched doorway — in the facing wall");
    expect(marks).toContain("- [1] a waist-high block of pale stone — in the foreground");

    const plain = roomIllustrationPrompt(parts("plain"));
    expect(plain).toContain(ILLUSTRATION_PLAIN_GUIDE_NOTE);
    expect(plain).not.toContain(ILLUSTRATION_GUIDE_NOTE);
    expect(plain).not.toMatch(/\[[A-Z0-9]+\]/);

    const none = roomIllustrationPrompt(parts("none"));
    expect(none).not.toContain("GUIDE");
    expect(none).not.toMatch(/\[[A-Z0-9]+\]/);
  });

  it("puts every thing and every surface in, with where it goes", () => {
    const p = roomIllustrationPrompt(parts("none"));
    for (const d of parts("none").drawn) expect(p).toContain(`${d.look} — ${d.where}`);
    expect(p).toContain("- white salt bloom along the joints — throughout the room");
  });

  it("leaves out empty sections", () => {
    const p = roomIllustrationPrompt({ ...parts("none"), drawn: [], surfaces: [] });
    expect(p).not.toContain("MUST BE DRAWN");
    expect(p).not.toContain("OVER THE WALLS");
  });
});

describe("exteriorIllustrationPrompt", () => {
  it("is the style, the view and the scene, with no interior setting", () => {
    const p = exteriorIllustrationPrompt({ scene: "A brick culvert mouth in a ravine bank." });
    expect(p).toContain(ILLUSTRATION_STYLE);
    expect(p).toContain("SCENE\nA brick culvert mouth in a ravine bank.");
    expect(p).not.toContain("SETTING");
  });
});
