/**
 * THE PORTRAIT PROMPT: every rolled feature in, the name out, and what is
 * worn told apart from what is packed.
 */

import { describe, expect, it } from "vitest";
import { portraitImagePrompt } from "./portrait-prompt.ts";
import { testCharacter } from "../fixtures/offline.ts";
import { copperItem } from "../rules/knave/character-creation.ts";

describe("portraitImagePrompt", () => {
  const pc = testCharacter({ name: "Odo Pellwright" });

  it("carries all eleven traits", () => {
    const prompt = portraitImagePrompt(pc, 9);
    for (const value of Object.values(pc.traits)) expect(prompt).toContain(value);
  });

  it("keeps what is seen apart from what is not", () => {
    const prompt = portraitImagePrompt(pc, 9);
    const seen = prompt.slice(prompt.indexOf("WHAT CAN BE SEEN"), prompt.indexOf("WHAT CANNOT BE SEEN"));
    const unseen = prompt.slice(prompt.indexOf("WHAT CANNOT BE SEEN"), prompt.indexOf("CHARACTER\n"));
    expect(seen).toContain(`Face: ${pc.traits.face}`);
    expect(seen).not.toContain(pc.traits.vice);
    expect(unseen).toContain(`Vice: ${pc.traits.vice}`);
    expect(unseen).toContain(`Alignment: ${pc.traits.alignment}`);
  });

  it("dresses them in what they hold and wear, and packs the rest, but not the purse", () => {
    const rich = testCharacter({ inventory: [...testCharacter().inventory, { ...copperItem(40), parentId: "pc-1" }] });
    const prompt = portraitImagePrompt(rich, 9);
    expect(prompt).toContain("weapon: Sword");
    expect(prompt).toContain("armor: Chain");
    expect(prompt).toContain("helmet: Helmet");
    expect(prompt).toMatch(/Packed or slung about them.*Spellbook: Telekinesis/);
    expect(prompt).not.toMatch(/Packed.*Sword/);
    expect(prompt).not.toMatch(/copper|40 cp/i);
  });

  it("says the gender the player chose, among what can be seen, and nothing when they chose none", () => {
    const seen = (p: string) => p.slice(p.indexOf("WHAT CAN BE SEEN"), p.indexOf("WHAT CANNOT BE SEEN"));
    expect(seen(portraitImagePrompt(testCharacter({ gender: "female" }), 9))).toContain("Gender: a woman");
    expect(seen(portraitImagePrompt(testCharacter({ gender: "male" }), 9))).toContain("Gender: a man");
    expect(seen(portraitImagePrompt(testCharacter({ gender: "nonbinary" }), 9))).toMatch(/Gender: non-binary/);
    expect(portraitImagePrompt(pc, 9)).not.toContain("Gender:");
  });

  it("leaves the name out", () => {
    expect(portraitImagePrompt(pc, 9)).not.toContain("Odo");
  });

  it("names the references only when there are some", () => {
    expect(portraitImagePrompt(pc, 9)).toContain("The 9 images are style references only");
    expect(portraitImagePrompt(pc, 0)).not.toContain("STYLE REFERENCES");
  });
});
