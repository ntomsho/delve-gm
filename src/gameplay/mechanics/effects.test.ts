/**
 * What a turn did to the character, read off the sheet before and after.
 *
 * The case that justifies comparing sheets rather than reading diffs is the
 * last one here: an item the APPLIER destroyed, which no diff named.
 */

import { describe, expect, it } from "vitest";
import { characterEffects, describeEffects, foeRolls, isLoss } from "./effects.ts";
import { testCharacter } from "../../fixtures/offline.ts";
import type { PlayerCharacter } from "../../rules/knave/character.ts";

const before = () => testCharacter();
const with_ = (f: (pc: PlayerCharacter) => void) => {
  const pc = testCharacter();
  f(pc);
  return pc;
};

describe("what a turn did to the character", () => {
  it("is nothing at all when nothing changed", () => {
    expect(characterEffects(before(), before())).toEqual([]);
  });

  it("states hit points lost, with the arithmetic", () => {
    const fx = characterEffects(before(), with_((pc) => (pc.hp.current = 9)));
    expect(fx).toEqual([{ kind: "hp", from: 15, to: 9, max: 15 }]);
    expect(isLoss(fx[0]!)).toBe(true);
    expect(describeEffects(fx)).toBe("−6 HP (15 → 9)");
  });

  it("states healing too, as a gain", () => {
    const hurt = with_((pc) => (pc.hp.current = 5));
    const fx = characterEffects(hurt, with_((pc) => (pc.hp.current = 8)));
    expect(fx[0]).toMatchObject({ kind: "hp", from: 5, to: 8 });
    expect(isLoss(fx[0]!)).toBe(false);
  });

  it("names an item that lost quality, and by how much", () => {
    const sword = before().inventory.find((i) => i.id === "test-sword")!;
    const q = sword.currentQuality ?? sword.quality ?? 3;
    const fx = characterEffects(
      before(),
      with_((pc) => (pc.inventory.find((i) => i.id === "test-sword")!.currentQuality = q - 1))
    );
    expect(fx).toEqual([expect.objectContaining({ kind: "damaged", name: sword.name, from: q, to: q - 1 })]);
  });

  it("tells an item that left the pack from one that was destroyed, by the applier's word", () => {
    const gone = with_((pc) => (pc.inventory = pc.inventory.filter((i) => i.id !== "test-sword")));

    expect(characterEffects(before(), gone)).toContainEqual(
      expect.objectContaining({ kind: "lost", itemId: "test-sword" })
    );
    // No diff named this — the applier destroyed it at zero quality and said so.
    expect(
      characterEffects(before(), gone, [{ kind: "item-destroyed", entityId: "test-sword", detail: "" }])
    ).toContainEqual(expect.objectContaining({ kind: "destroyed", itemId: "test-sword" }));
  });

  it("says an item came off, and does not say it twice for one that is gone", () => {
    const off = characterEffects(before(), with_((pc) => delete pc.equipped.helmet));
    expect(off).toEqual([expect.objectContaining({ kind: "unequipped", itemId: "test-helmet" })]);

    const gone = characterEffects(
      before(),
      with_((pc) => {
        delete pc.equipped.helmet;
        pc.inventory = pc.inventory.filter((i) => i.id !== "test-helmet");
      })
    );
    expect(gone.map((e) => e.kind)).toEqual(["lost"]);
  });

  it("notices something found, as a gain", () => {
    const fx = characterEffects(
      before(),
      with_((pc) => pc.inventory.push({ id: "bottle", name: "Bottle of oil", type: "Item", slots: 1, parentId: pc.id, value: 0 }))
    );
    expect(fx).toEqual([{ kind: "gained", itemId: "bottle", name: "Bottle of oil" }]);
    expect(isLoss(fx[0]!)).toBe(false);
  });
});

describe("the dice that hurt them", () => {
  const d20 = (total: number, success: boolean) => ({
    rolled: [total], kept: total, bonus: 0, total, success, nat20: false, nat1: false,
  });
  const attack = (id: string, targetDefense: number, success: boolean) => ({
    id, kind: "attack" as const, line: "", failed: false, d20: d20(success ? 16 : 4, success), targetDefense,
    ...(success ? { damage: { expr: "1d6", rolls: [5], total: 5 } } : {}),
  });
  const ARMOR = 14;

  it("shows nothing on a turn that did not hurt them, whatever was rolled", () => {
    // A batch can hold an attack the referee rolled and never used.
    expect(foeRolls([attack("ghoul-attack", ARMOR, true)], ARMOR, false)).toEqual([]);
  });

  it("shows the attacks aimed at them — misses too — and not ones aimed elsewhere", () => {
    const shown = foeRolls(
      [attack("wretched-1-attack", ARMOR, false), attack("wretched-2-attack", ARMOR, true), attack("ghoul-vs-thrall", 11, true)],
      ARMOR,
      true
    );
    expect(shown.map((r) => r.label)).toEqual(["Wretched 1 attack", "Wretched 2 attack"]);
    expect(shown[1]!.damage).toEqual({ expr: "1d6", rolls: [5], total: 5 });
  });

  it("shows a loose damage roll only when no attack explains the wound", () => {
    const fall = { id: "fall", kind: "damage" as const, line: "", failed: false, damage: { expr: "1d6", rolls: [3], total: 3 } };
    expect(foeRolls([fall], ARMOR, true).map((r) => r.label)).toEqual(["Fall"]);
    expect(foeRolls([attack("ghoul-attack", ARMOR, true), fall], ARMOR, true).map((r) => r.label)).toEqual([
      "Ghoul attack",
    ]);
  });

  it("never carries the number the attack had to beat", () => {
    const text = JSON.stringify(foeRolls([attack("ghoul-attack", ARMOR, true)], ARMOR, true));
    expect(text).not.toContain("targetDefense");
    expect(text).not.toContain('"dc"');
  });
});
