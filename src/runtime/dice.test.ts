/**
 * The dice tool. What is being tested is the TRANSLATION — that a request the
 * referee wrote maps onto the engine function the rule lives in, and that what
 * comes back says what actually happened. The rules themselves are tested in
 * `engine/dungeon-rolls.test.ts` and are not re-tested here.
 */

import { describe, expect, it } from "vitest";
import { rollBatch, renderOutcomes } from "./dice.ts";
import { CountingRng } from "./rng.ts";
import { attackRoll, consultRoll, dcFromDefense, moraleRoll, saveRoll } from "../engine/index.ts";

const rng = (seed = 7) => new CountingRng(seed);

describe("kinds", () => {
  it("rolls a save against the ordinary DC when none is given", () => {
    const expected = saveRoll(rng(), 2);
    const [got] = rollBatch(rng(), [{ id: "a", kind: "save", bonus: 2 }]);

    expect(got.failed).toBe(false);
    expect(got.line).toContain(`= ${expected.total} vs 16`);
    expect(got.line).toContain(expected.success ? "SUCCESS" : "FAILURE");
  });

  it("converts a creature's defense into a save DC", () => {
    // The playbook says "pass its defense"; the engine wants a number to meet.
    const expected = saveRoll(rng(), 0, dcFromDefense(12));
    const [got] = rollBatch(rng(), [{ id: "a", kind: "save", defenseAsDc: 12 }]);

    expect(got.line).toContain(`vs ${dcFromDefense(12)}`);
    expect(got.line).toContain(expected.success ? "SUCCESS" : "FAILURE");
  });

  it("rolls an attack's damage on a hit, and none on a miss", () => {
    const expected = attackRoll(rng(), { bonus: 4, targetDefense: 10, damage: "1d6" });
    const [got] = rollBatch(rng(), [
      { id: "ghoul", kind: "attack", bonus: 4, targetDefense: 10, damage: "1d6" },
    ]);

    expect(got.line).toContain(expected.success ? "HIT" : "MISS");
    if (expected.damage) {
      expect(got.line).toContain(`= ${expected.damage.total}`);
    } else {
      expect(got.line).not.toContain("damage 1d6");
    }
  });

  it("says plainly that a stunt deals no damage", () => {
    const [got] = rollBatch(rng(), [{ id: "shove", kind: "stunt", bonus: 3, targetDefense: 11 }]);
    if (got.line.includes("SUCCESS")) expect(got.line).toContain("deals no damage");
  });

  it("reports morale as holding or breaking, not as a number to interpret", () => {
    const expected = moraleRoll(rng(), 7);
    const [got] = rollBatch(rng(), [{ id: "nerve", kind: "morale" }]);
    expect(got.line).toContain(expected.holds ? "THEY HOLD" : "THEY BREAK");
  });

  it("adds the reading itself, and says what to write back", () => {
    const expected = consultRoll(rng(), 2);
    const [got] = rollBatch(rng(), [{ id: "herbal", kind: "consult", uses: 2 }]);

    expect(got.failed).toBe(false);
    // The referee passes what the book has HAD; the third reading is this one.
    expect(got.line).toContain("reading 3");
    expect(got.line).toContain("book.uses 3");
    expect(got.line).toContain(expected.exhausted ? "THE LAST OF IT" : "THERE IS MORE IN IT");
    expect(got.line.includes("book.exhausted true")).toBe(expected.exhausted);
  });

  it("treats a book with no count as one nobody has opened", () => {
    const [got] = rollBatch(rng(), [{ id: "herbal", kind: "consult" }]);
    expect(got.line).toContain("reading 1");
  });

  it("rolls loose damage from an expression", () => {
    const [got] = rollBatch(rng(), [{ id: "ceiling", kind: "damage", expr: "2d6" }]);
    expect(got.line).toMatch(/damage — 2d6 → \[\d+, \d+\] = \d+/);
    expect(got.failed).toBe(false);
  });
});

describe("crits report themselves", () => {
  it("names the quality loss rather than leaving it to be remembered", () => {
    // Walk seeds until one lands a natural 20 on an attack.
    for (let seed = 1; seed < 400; seed++) {
      const [got] = rollBatch(rng(seed), [
        { id: "a", kind: "attack", bonus: 0, targetDefense: 11, damage: "1d6" },
      ]);
      if (got.line.includes("NATURAL 20")) {
        expect(got.line).toContain("armour loses 1 currentQuality");
        return;
      }
    }
    throw new Error("no natural 20 in 400 seeds — the d20 is not a d20");
  });
});

describe("bad requests", () => {
  it("refuses an attack with no target, and says why", () => {
    const [got] = rollBatch(rng(), [{ id: "a", kind: "attack", bonus: 2 }]);
    expect(got.failed).toBe(true);
    expect(got.line).toContain("targetDefense");
  });

  it("refuses an unparseable damage expression rather than throwing", () => {
    const [got] = rollBatch(rng(), [{ id: "a", kind: "damage", expr: "some dice" }]);
    expect(got.failed).toBe(true);
  });

  it("keeps rolling the rest of the batch", () => {
    const out = rollBatch(rng(), [
      { id: "bad", kind: "attack" },
      { id: "good", kind: "morale", rating: 9 },
    ]);
    expect(out.map((o) => o.failed)).toEqual([true, false]);
  });
});

describe("the batch", () => {
  it("draws in list order from one stream", () => {
    // The same three requests, rolled together, are the same three rolled one
    // after another off the same seed — which is what makes a run replayable.
    const together = rollBatch(rng(), [
      { id: "a", kind: "morale" },
      { id: "b", kind: "morale" },
      { id: "c", kind: "morale" },
    ]);

    const shared = rng();
    const apart = [
      rollBatch(shared, [{ id: "a", kind: "morale" }])[0],
      rollBatch(shared, [{ id: "b", kind: "morale" }])[0],
      rollBatch(shared, [{ id: "c", kind: "morale" }])[0],
    ];

    expect(together).toEqual(apart);
  });

  it("advances the stream once per die, not once per call", () => {
    const r = rng();
    rollBatch(r, [{ id: "a", kind: "morale" }]); // 2d6
    expect(r.draws).toBe(2);
    rollBatch(r, [{ id: "b", kind: "save", bonus: 0, edge: "advantage" }]); // 2d20
    expect(r.draws).toBe(4);
  });

  it("keys results by the referee's own ids", () => {
    const text = renderOutcomes(
      rollBatch(rng(), [
        { id: "ghoul-1", kind: "morale" },
        { id: "ghoul-2", kind: "morale" },
      ])
    );
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("ghoul-1:");
    expect(text).toContain("ghoul-2:");
  });
});
