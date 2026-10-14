import { describe, expect, it } from "vitest";
import {
  attackRoll,
  consultRoll,
  critEffects,
  d20,
  dcFromDefense,
  die,
  moraleRoll,
  ORDINARY_DC,
  parseDamage,
  rollDamage,
  saveRoll,
  stuntRoll,
  type RollRng,
} from "./rolls.ts";
import { Rng } from "../../generation/content/blueprint.ts";

/** Feeds an exact sequence, so a specific die result can be forced. */
function scripted(...values: number[]): RollRng {
  let i = 0;
  return { next: () => values[i++ % values.length] };
}

/** The float that makes `die(n)` come up exactly `face`. */
const face = (n: number, sides: number) => (n - 1) / sides;

const NAT20 = face(20, 20);
const NAT1 = face(1, 20);

// ===========================================================================
// THRESHOLDS  — the likeliest off-by-one in the codebase
// ===========================================================================

describe("thresholds", () => {
  it("an ordinary save is 16, and 15 fails", () => {
    expect(ORDINARY_DC).toBe(16);
    // d20 shows 14, +2 = 16 -> succeeds
    expect(saveRoll(scripted(face(14, 20)), 2).success).toBe(true);
    // d20 shows 13, +2 = 15 -> fails
    expect(saveRoll(scripted(face(13, 20)), 2).success).toBe(false);
  });

  it("a contest must EXCEED the defense", () => {
    expect(dcFromDefense(14)).toBe(15);
    // Total exactly equal to the defense misses.
    const miss = attackRoll(scripted(face(12, 20)), { bonus: 2, targetDefense: 14 });
    expect(miss.total).toBe(14);
    expect(miss.success).toBe(false);
    // One more hits.
    expect(attackRoll(scripted(face(13, 20)), { bonus: 2, targetDefense: 14 }).success).toBe(true);
  });

  it("a stunt uses the same bar and deals no damage", () => {
    const o = stuntRoll(scripted(face(13, 20)), 2, 14);
    expect(o.success).toBe(true);
    expect(o).not.toHaveProperty("damage");
  });
});

// ===========================================================================
// EDGE
// ===========================================================================

describe("advantage and disadvantage", () => {
  it("rolls two dice and keeps the better or worse", () => {
    const adv = d20(scripted(face(4, 20), face(17, 20)), "advantage");
    expect(adv.rolled).toEqual([4, 17]);
    expect(adv.kept).toBe(17);

    const dis = d20(scripted(face(4, 20), face(17, 20)), "disadvantage");
    expect(dis.kept).toBe(4);
  });

  it("rolls one die without an edge", () => {
    expect(d20(scripted(face(9, 20)), "none").rolled).toHaveLength(1);
  });

  it("reads a natural off the die that counts, not any die shown", () => {
    // A 20 discarded by disadvantage is not a critical.
    expect(d20(scripted(NAT20, face(7, 20)), "disadvantage").nat20).toBe(false);
    expect(d20(scripted(NAT20, face(7, 20)), "advantage").nat20).toBe(true);
  });

  it("shifts the distribution the right way", () => {
    const mean = (edge: "none" | "advantage" | "disadvantage") => {
      const rng = new Rng(1234);
      let total = 0;
      for (let i = 0; i < 20000; i++) total += d20(rng, edge).kept;
      return total / 20000;
    };
    const plain = mean("none");
    expect(plain).toBeGreaterThan(10.0);
    expect(plain).toBeLessThan(11.0);
    expect(mean("advantage")).toBeGreaterThan(13.0);
    expect(mean("disadvantage")).toBeLessThan(8.0);
  });

  it("never applies an edge to damage", () => {
    // Two dice worth of values available, but a 1d6 consumes exactly one.
    const r = rollDamage(scripted(face(6, 6), face(1, 6)), "1d6");
    expect(r.rolls).toEqual([6]);
  });
});

// ===========================================================================
// CRITICALS
// ===========================================================================

describe("criticals", () => {
  it("a natural 20 costs the defender's armour and adds a die", () => {
    const c = critEffects(d20(scripted(NAT20)));
    expect(c).toEqual({ defenderArmor: true, attackerWeapon: false, extraDamageDice: 1 });
  });

  it("a natural 1 costs the attacker's weapon and adds nothing", () => {
    const c = critEffects(d20(scripted(NAT1)));
    expect(c).toEqual({ defenderArmor: false, attackerWeapon: true, extraDamageDice: 0 });
  });

  it("the right weapon for the enemy adds a die of its own", () => {
    expect(critEffects(d20(scripted(face(11, 20))), true).extraDamageDice).toBe(1);
    // Stacks with a natural 20.
    expect(critEffects(d20(scripted(NAT20)), true).extraDamageDice).toBe(2);
  });

  it("rolls the extra die into the damage on a critical hit", () => {
    const r = attackRoll(scripted(NAT20, face(5, 8), face(6, 8)), {
      bonus: 0, targetDefense: 11, damage: "1d8",
    });
    expect(r.success).toBe(true);
    expect(r.damage!.rolls).toEqual([5, 6]); // one weapon die plus the crit die
    expect(r.damage!.total).toBe(11);
  });

  it("deals no damage on a miss, even on a natural 1", () => {
    const r = attackRoll(scripted(NAT1), { bonus: 0, targetDefense: 11, damage: "1d8" });
    expect(r.success).toBe(false);
    expect(r.damage).toBeUndefined();
    expect(r.crit.attackerWeapon).toBe(true);
  });
});

// ===========================================================================
// DAMAGE
// ===========================================================================

describe("damage expressions", () => {
  it.each([
    ["1d6", { count: 1, sides: 6, flat: 0 }],
    ["2d8+1", { count: 2, sides: 8, flat: 1 }],
    ["d10", { count: 1, sides: 10, flat: 0 }],
    ["1d6-1", { count: 1, sides: 6, flat: -1 }],
    [" 3 d 4 + 2 ", { count: 3, sides: 4, flat: 2 }],
  ])("parses %s", (expr, expected) => {
    expect(parseDamage(expr)).toEqual(expected);
  });

  it.each(["", "d", "6", "1d", "1x6", "0d6", "1d0", "abc"])("refuses %s", (expr) => {
    expect(() => parseDamage(expr)).toThrow();
  });

  it("adds the flat modifier and never goes below zero", () => {
    expect(rollDamage(scripted(face(4, 6)), "1d6+2").total).toBe(6);
    expect(rollDamage(scripted(face(1, 6)), "1d6-4").total).toBe(0);
  });

  it("stays within bounds across many rolls", () => {
    const rng = new Rng(99);
    for (let i = 0; i < 2000; i++) {
      const r = rollDamage(rng, "2d6");
      expect(r.total).toBeGreaterThanOrEqual(2);
      expect(r.total).toBeLessThanOrEqual(12);
    }
  });
});

// ===========================================================================
// MORALE
// ===========================================================================

describe("morale", () => {
  it("holds at exactly the rating and breaks one above it", () => {
    // 2d6 showing 3 and 4 = 7
    expect(moraleRoll(scripted(face(3, 6), face(4, 6)), 7).holds).toBe(true);
    // 2d6 showing 4 and 4 = 8
    expect(moraleRoll(scripted(face(4, 6), face(4, 6)), 7).holds).toBe(false);
  });

  it("defaults to a rating of 7", () => {
    expect(moraleRoll(scripted(face(4, 6), face(4, 6))).holds).toBe(false);
  });

  it("stays in the 2..12 range", () => {
    const rng = new Rng(7);
    for (let i = 0; i < 2000; i++) {
      const { total } = moraleRoll(rng);
      expect(total).toBeGreaterThanOrEqual(2);
      expect(total).toBeLessThanOrEqual(12);
    }
  });
});

// ===========================================================================
// CONSULTING A BOOK
// ===========================================================================

describe("consulting a book", () => {
  it("counts the reading, and is spent when the die comes up at or under it", () => {
    // Third reading: a 3 is at the count, so that is the last of it.
    expect(consultRoll(scripted(face(3, 6)), 2)).toMatchObject({ uses: 3, rolled: 3, exhausted: true });
    // Third reading again, on a 4 — there is more in it.
    expect(consultRoll(scripted(face(4, 6)), 2)).toMatchObject({ uses: 3, rolled: 4, exhausted: false });
  });

  it("cannot be spent by the first reading except on a 1", () => {
    for (let n = 2; n <= 6; n++) {
      expect(consultRoll(scripted(face(n, 6))).exhausted, `d6=${n}`).toBe(false);
    }
    expect(consultRoll(scripted(face(1, 6))).exhausted).toBe(true);
  });

  it("is certain by the sixth", () => {
    for (let n = 1; n <= 6; n++) {
      expect(consultRoll(scripted(face(n, 6)), 5).exhausted, `d6=${n}`).toBe(true);
    }
  });

  it("starts from unread when nothing is passed", () => {
    expect(consultRoll(scripted(face(6, 6))).uses).toBe(1);
  });

  // Not a rule, a sanity check on the shape of the curve: a book answers a
  // couple of questions and then stops, and it is the reading that finds out.
  it("gives up after two or three readings on average", () => {
    const rng = new Rng(4242);
    let total = 0;
    const books = 2000;
    for (let i = 0; i < books; i++) {
      let uses = 0;
      for (;;) {
        const o = consultRoll(rng, uses);
        uses = o.uses;
        if (o.exhausted) break;
      }
      total += uses;
    }
    const mean = total / books;
    expect(mean).toBeGreaterThan(2);
    expect(mean).toBeLessThan(3);
  });
});

// ===========================================================================
// DETERMINISM
// ===========================================================================

describe("seeded", () => {
  it("the same seed produces the same sequence", () => {
    const run = () => {
      const rng = new Rng(4242);
      return Array.from({ length: 50 }, () => die(rng, 20));
    };
    expect(run()).toEqual(run());
  });

  it("covers the whole face range", () => {
    const rng = new Rng(11);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(die(rng, 20));
    expect(seen.size).toBe(20);
  });
});
