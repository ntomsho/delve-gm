import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canBeStrict, toolSchema } from "./tool-schema.ts";
import { contentPassSchema, dungeonPassSchema } from "./schemas.ts";

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
