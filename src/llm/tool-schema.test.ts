import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canBeStrict, fitStrict, toolSchema } from "./tool-schema.ts";
import {
  commitSchema,
  contentPassSchema,
  dungeonPassSchema,
  rollBatchSchema,
} from "./schemas.ts";

/**
 * The bug these guard against: `input_schema` was
 * `{ type: "object", additionalProperties: true }`, on the theory that the
 * prompt described the shape and zod enforced it. It does not work — the tool's
 * parameters ARE the shape, so with an empty schema the model invents the
 * top-level key. Observed on one seed: `region_data` on one attempt, `rooms` on
 * the next, `{}` on the run that failed.
 */

describe("toolSchema", () => {
  it("carries the real property names, which is the whole point", () => {
    const s = toolSchema(contentPassSchema);
    expect(Object.keys(s.properties)).toEqual(["rooms"]);
    expect(s.required).toEqual(["rooms"]);

    const d = toolSchema(dungeonPassSchema);
    expect(Object.keys(d.properties).sort()).toEqual(
      ["goal", "groups", "history", "name", "openingProse", "theme"]
    );
  });

  it("closes every object, at every depth", () => {
    const closed = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.every(closed);
      if (node === null || typeof node !== "object") return true;
      const o = node as Record<string, unknown>;
      if (o.type === "object" && o.additionalProperties !== false) return false;
      return Object.values(o).every(closed);
    };
    expect(closed(toolSchema(contentPassSchema))).toBe(true);
    expect(closed(toolSchema(dungeonPassSchema))).toBe(true);
  });

  it("drops the keywords structured outputs rejects", () => {
    // zod emits minLength/minItems happily; the API 400s on them. They stay
    // enforced by zod on the way back in.
    const json = JSON.stringify(toolSchema(contentPassSchema));
    for (const k of ["minLength", "maxLength", "minItems", "maxItems", "pattern", "$schema"]) {
      expect(json, k).not.toContain(`"${k}"`);
    }
  });

  it("refuses an open-ended record rather than letting the API 400", () => {
    // `z.record(...)` becomes `additionalProperties: { … }`, which strict mode
    // rejects outright. Better to fail here, with a message saying what to do.
    const withRecord = z.object({ modifiers: z.record(z.string(), z.number()) });
    expect(() => toolSchema(withRecord)).toThrow(/additionalProperties: false/);
  });

  it("refuses a non-object root", () => {
    expect(() => toolSchema(z.array(z.string()) as never)).toThrow(/must be an object schema/);
  });
});

describe("canBeStrict", () => {
  it("says yes to the dungeon pass and no to the content pass", () => {
    // The content pass has 35 optional parameters — most of what a room may
    // hold is optional — against a limit of 24. It still gets a real schema;
    // it just does not get the API's guarantee on top.
    expect(canBeStrict(toolSchema(dungeonPassSchema))).toBe(true);
    expect(canBeStrict(toolSchema(contentPassSchema))).toBe(false);
  });

  it("counts optionals at every depth, not just the root", () => {
    const nested = z.object({
      a: z.object({
        b: z.object(Object.fromEntries(
          Array.from({ length: 30 }, (_, i) => [`f${i}`, z.string().optional()])
        )),
      }),
    });
    expect(canBeStrict(toolSchema(nested))).toBe(false);
  });

  it("says yes when everything is required", () => {
    expect(canBeStrict(toolSchema(z.object({ a: z.string(), b: z.number() })))).toBe(true);
  });
});

describe("fitStrict", () => {
  const tool = (schema: z.ZodType) => {
    const input_schema = toolSchema(schema);
    return { input_schema, ...(canBeStrict(input_schema) ? { strict: true as const } : {}) };
  };
  const strictness = (tools: { strict?: boolean }[]) => tools.map((t) => t.strict === true);

  /**
   * The 400 that found this: `commit_state` (15 optionals) and `roll` (11) each
   * pass `canBeStrict`, so both went out guaranteed — and the API compiles ONE
   * grammar per call, so it saw 26 against a limit of 24 and refused the whole
   * request. Every turn of the game offers both.
   */
  it("does not let two individually-strict tools bust the budget together", () => {
    const commit = tool(commitSchema);
    const roll = tool(rollBatchSchema);
    expect(strictness([commit, roll])).toEqual([true, true]);

    // Sent together, only the larger one keeps the guarantee.
    expect(strictness(fitStrict([roll, commit]))).toEqual([false, true]);
  });

  it("spends the budget on the biggest schema first, whatever the order", () => {
    const opts = (n: number) =>
      tool(z.object(Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`f${i}`, z.string().optional()])
      )));
    const big = opts(20);
    const small = opts(10);

    // 20 fits, 20 + 10 does not — and the answer does not depend on the order
    // the caller happened to list them in.
    expect(strictness(fitStrict([big, small]))).toEqual([true, false]);
    expect(strictness(fitStrict([small, big]))).toEqual([false, true]);

    // 20 + 4 is exactly the limit, so both are guaranteed.
    expect(strictness(fitStrict([opts(4), big]))).toEqual([true, true]);
  });

  it("leaves a tool alone when the whole set fits", () => {
    const tools = [tool(dungeonPassSchema), tool(z.object({ a: z.string() }))];
    expect(fitStrict(tools)).toEqual(tools);
  });

  it("drops strict rather than reshaping a tool", () => {
    const roll = tool(rollBatchSchema);
    const [fitted] = fitStrict([roll, tool(commitSchema)]);
    expect(fitted.input_schema).toEqual(roll.input_schema);
    expect("strict" in fitted).toBe(false);
  });

  it("never guarantees a tool that could not be guaranteed alone", () => {
    const content = tool(contentPassSchema);
    expect(strictness(fitStrict([content]))).toEqual([false]);
  });
});
