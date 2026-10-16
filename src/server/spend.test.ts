/**
 * THE SPEND RULE, WITHOUT A DATABASE
 *
 * The sum is a `sum(cost_usd)` and is exercised against real rows in
 * `spend.dbtest.ts`. Pinned here: where the two lines sit, who is exempt from
 * which, and which run or dungeon a request is charged to.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_DAILY_USD, gateFor, limitsFrom, subjectOf } from "./spend.ts";

describe("limitsFrom", () => {
  it("is $5 and $5 with nothing set", () => {
    expect(DEFAULT_DAILY_USD).toBe(5);
    expect(limitsFrom({})).toEqual({ budget: 5, ceiling: 5 });
  });

  it("reads both, and takes junk for the default", () => {
    expect(limitsFrom({ DAILY_BUDGET_USD: "2.5", DAILY_CEILING_USD: "8" })).toEqual({ budget: 2.5, ceiling: 8 });
    expect(limitsFrom({ DAILY_BUDGET_USD: "lots", DAILY_CEILING_USD: "-1" })).toEqual({ budget: 5, ceiling: 5 });
    expect(limitsFrom({ DAILY_BUDGET_USD: " " })).toEqual({ budget: 5, ceiling: 5 });
  });

  it("never puts the ceiling under the budget", () => {
    expect(limitsFrom({ DAILY_BUDGET_USD: "10", DAILY_CEILING_USD: "4" })).toEqual({ budget: 10, ceiling: 10 });
  });
});

describe("gateFor", () => {
  const limits = { budget: 5, ceiling: 8 };

  it("is open under the budget", () => {
    expect(gateFor({ spent: 4.99, limits, unlimited: false })).toEqual({ mayStart: true, mayCall: true });
  });

  it("stops new things at the budget and lets what is running carry on", () => {
    expect(gateFor({ spent: 5, limits, unlimited: false })).toEqual({ mayStart: false, mayCall: true });
  });

  it("lets an unlimited account past the budget but not the ceiling", () => {
    expect(gateFor({ spent: 6, limits, unlimited: true })).toEqual({ mayStart: true, mayCall: true });
    expect(gateFor({ spent: 8, limits, unlimited: true })).toEqual({ mayStart: false, mayCall: false });
  });

  it("stops every call at the ceiling", () => {
    expect(gateFor({ spent: 8.01, limits, unlimited: false })).toEqual({ mayStart: false, mayCall: false });
  });
});

describe("subjectOf", () => {
  const id = "0b9e7c1a-3f2d-4e5b-8a6c-1d2e3f4a5b6c";

  it("names the run of a run's paths", () => {
    expect(subjectOf(`/api/runs/${id}/turn`)).toEqual({ runId: id });
    expect(subjectOf(`/api/runs/${id}/illustrations/room_3`)).toEqual({ runId: id });
  });

  it("names the dungeon of a dungeon's paths", () => {
    expect(subjectOf(`/api/dungeons/${id}/chunks/2`)).toEqual({ dungeonId: id });
  });

  it("names nothing for a path that is about no one thing", () => {
    expect(subjectOf("/api/dungeons")).toEqual({});
    expect(subjectOf("/api/dungeons/library")).toEqual({});
    expect(subjectOf("/api/runs")).toEqual({});
  });
});
