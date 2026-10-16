/**
 * THE ALLOWANCE RULE, WITHOUT A DATABASE
 *
 * The count itself is a `count(*)` and is exercised against real rows in
 * `app.dbtest.ts`. What is worth pinning here is the arithmetic: who gets how
 * many, when it resets, and that `unlimited` is exempt from all of it.
 */

import { describe, expect, it } from "vitest";
import {
  allowanceFor,
  GUEST_RUNS_PER_DAY,
  hasRunLeft,
  MAX_GENERATED_SIZE,
  mayStartRunIn,
  MEMBER_RUNS_PER_DAY,
  nextUtcMidnight,
  GUEST_TURNS_PER_DAY,
  hasTurnLeft,
  MEMBER_TURNS_PER_DAY,
  refusal,
  turnRefusal,
} from "./allowance.ts";

const NOW = new Date("2026-10-12T23:30:00Z");

describe("allowanceFor", () => {
  it("gives a guest one run a day and a member three", () => {
    expect(GUEST_RUNS_PER_DAY).toBe(1);
    expect(MEMBER_RUNS_PER_DAY).toBe(3);

    const guest = allowanceFor({ guest: true, tier: "member", used: 0, now: NOW });
    expect(guest).toMatchObject({ limit: 1, left: 1, maxSize: MAX_GENERATED_SIZE });

    const member = allowanceFor({ guest: false, tier: "member", used: 2, now: NOW });
    expect(member).toMatchObject({ limit: 3, left: 1, maxSize: MAX_GENERATED_SIZE });
    expect(hasRunLeft(member)).toBe(true);
  });

  it("runs out at the limit and never goes negative", () => {
    const spent = allowanceFor({ guest: true, tier: "member", used: 1, now: NOW });
    expect(spent.left).toBe(0);
    expect(hasRunLeft(spent)).toBe(false);

    // A race can put a player one over. `left` still reads 0, not -1.
    expect(allowanceFor({ guest: true, tier: "member", used: 2, now: NOW }).left).toBe(0);
  });

  it("exempts unlimited from the count and the size cap", () => {
    const author = allowanceFor({ guest: false, tier: "unlimited", used: 40, now: NOW });
    expect(author).toMatchObject({ unlimited: true, limit: null, left: null, used: 40 });
    expect(author.maxSize).toBeGreaterThan(MAX_GENERATED_SIZE);
    expect(hasRunLeft(author)).toBe(true);
  });

  it("caps everyone else at size 1 for now", () => {
    expect(MAX_GENERATED_SIZE).toBe(1);
  });

  it("resets at the next midnight UTC", () => {
    expect(allowanceFor({ guest: true, tier: "member", used: 1, now: NOW }).resetsAt).toBe(
      "2026-10-13T00:00:00.000Z"
    );
    // Exactly on the boundary is the start of a new day, so the reset is a day on.
    expect(nextUtcMidnight(new Date("2026-10-13T00:00:00Z")).toISOString()).toBe(
      "2026-10-14T00:00:00.000Z"
    );
  });
});

describe("turns a day", () => {
  it("gives a guest 30 and a member 60, across every run", () => {
    expect(GUEST_TURNS_PER_DAY).toBe(30);
    expect(MEMBER_TURNS_PER_DAY).toBe(60);
    expect(allowanceFor({ guest: true, tier: "member", used: 0, turnsUsed: 12, now: NOW })).toMatchObject({
      turnsLimit: 30,
      turnsLeft: 18,
    });
    expect(allowanceFor({ guest: false, tier: "member", used: 0, turnsUsed: 12, now: NOW }).turnsLeft).toBe(48);
  });

  it("runs out at the limit and never goes negative", () => {
    const done = allowanceFor({ guest: true, tier: "member", used: 1, turnsUsed: 31, now: NOW });
    expect(done.turnsLeft).toBe(0);
    expect(hasTurnLeft(done)).toBe(false);
  });

  it("exempts unlimited", () => {
    const author = allowanceFor({ guest: false, tier: "unlimited", used: 0, turnsUsed: 500, now: NOW });
    expect(author).toMatchObject({ turnsLimit: null, turnsLeft: null, turnsUsed: 500 });
    expect(hasTurnLeft(author)).toBe(true);
  });

  it("tells the player the run is kept, and points a guest at Google", () => {
    const guest = turnRefusal(allowanceFor({ guest: true, tier: "member", used: 1, turnsUsed: 30, now: NOW }));
    expect(guest).toMatch(/30 turns for today\. Your run is saved/);
    expect(guest).toMatch(/Sign in with Google for 60 a day/);
    const member = turnRefusal(allowanceFor({ guest: false, tier: "member", used: 1, turnsUsed: 60, now: NOW }));
    expect(member).not.toMatch(/Google/);
  });
});

describe("mayStartRunIn", () => {
  it("lets the first run into a dungeon they wrote through with none left", () => {
    const spent = allowanceFor({ guest: true, tier: "member", used: 1, now: NOW, unplayed: ["mine"] });
    expect(hasRunLeft(spent)).toBe(false);
    expect(mayStartRunIn(spent, "mine")).toBe(true);
    expect(mayStartRunIn(spent, "a-copy")).toBe(false);
  });
});

describe("refusal", () => {
  it("points a guest at Google and does not tell a member to sign in", () => {
    const guest = refusal(allowanceFor({ guest: true, tier: "member", used: 1, now: NOW }));
    expect(guest).toMatch(/1 run for today/);
    expect(guest).toMatch(/Sign in with Google for 3 a day/);

    const member = refusal(allowanceFor({ guest: false, tier: "member", used: 3, now: NOW }));
    expect(member).toMatch(/3 runs for today/);
    expect(member).not.toMatch(/Google/);
  });
});
