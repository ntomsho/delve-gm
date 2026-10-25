/**
 * Converts a zod schema into a tool's `input_schema`, and decides which tools
 * can use strict mode.
 *
 * The `input_schema` is what tells the model the shape of a tool call. Sending
 * a loose schema (`{ type: "object", additionalProperties: true }`) and
 * describing the shape in the prompt doesn't work: the model has to guess the
 * field names, and guesses differently each time. On one seed, with the same
 * prompt, two attempts came back as `{ region_data: … }` and `{ rooms: … }`,
 * and a third as `{}`. The prompt describes what to write; the schema defines
 * the shape, and only the schema is enforced.
 *
 * So the real schema is sent, generated from the zod schema that validates
 * the response. Because both come from the same zod schema, they can't drift
 * apart.
 *
 * The API's structured outputs reject some JSON Schema keywords that zod
 * produces. They are removed here, and zod still checks them when the
 * response comes back.
 */

import { z } from "zod";

/** JSON Schema keywords the API rejects. Zod still checks these rules on the response. */
const UNSUPPORTED = new Set([
  "minLength", "maxLength", "pattern",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minItems", "maxItems", "uniqueItems",
  "minProperties", "maxProperties",
  "$schema",
]);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED.has(k)) continue;
    // Strict mode only allows `additionalProperties: false`. For a
    // `z.record(...)`, zod writes a schema there instead, and the API rejects
    // the request with a 400. So response schemas can't use open-ended maps.
    if (k === "additionalProperties" && v !== false) {
      throw new Error(
        "a response schema cannot contain an open-ended record: " +
          "structured outputs requires additionalProperties: false. " +
          "Name the keys explicitly instead."
      );
    }
    out[k] = strip(v);
  }
  // Every object needs `additionalProperties: false`, and zod sometimes leaves it out.
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

export interface ToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

/**
 * The most optional fields strict mode accepts. Strict mode compiles the
 * schema into a grammar and refuses to if there are more than 24 optional
 * fields. The content pass has 35, because most of what a room can contain is
 * optional (not every room has a hazard, the goal or an elite).
 *
 * Going over the limit only loses strict mode's guarantee. The schema is
 * still sent, and it still tells the model the field names. Without strict
 * mode, zod still validates every response, and a bad one costs a retry.
 *
 * The limit applies to the whole request, not to each tool: all the strict
 * tools in one request share the same 24. `commit_state` (15) and `roll` (11)
 * each fit alone, but sending both as strict gets a 400. `fitStrict` handles
 * that; `canBeStrict` only answers for a tool sent on its own.
 */
const STRICT_OPTIONAL_LIMIT = 24;

function countOptional(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((n, x) => n + countOptional(x), 0);
  if (node === null || typeof node !== "object") return 0;

  const o = node as Record<string, unknown>;
  let n = 0;
  if (o.type === "object" && o.properties && typeof o.properties === "object") {
    const required = new Set(Array.isArray(o.required) ? (o.required as string[]) : []);
    n += Object.keys(o.properties as object).filter((k) => !required.has(k)).length;
  }
  for (const v of Object.values(o)) n += countOptional(v);
  return n;
}

/** Whether this schema is within strict mode's limit when it is the only tool in the request. */
export function canBeStrict(schema: ToolSchema): boolean {
  return countOptional(schema) <= STRICT_OPTIONAL_LIMIT;
}

/** The parts of a tool `fitStrict` needs: its schema and its `strict` flag. */
interface Strictable {
  input_schema: ToolSchema;
  strict?: boolean;
}

/**
 * Decides which tools in one request get strict mode, keeping the total
 * optional fields within the limit.
 *
 * Only strict tools count towards the limit, so a tool that doesn't fit just
 * loses its `strict` flag; its schema is unchanged and zod still checks its
 * results.
 *
 * Tools with the most optional fields are given strict mode first, because
 * they are the easiest for the model to get wrong. In gameplay that is
 * `commit_state`, which changes the game's state; a malformed `roll` call
 * only costs one more exchange.
 */
export function fitStrict<T extends Strictable>(tools: T[]): T[] {
  const guaranteed = new Set<number>();
  let spent = 0;

  const byCost = tools
    .map((t, i) => ({ i, cost: countOptional(t.input_schema) }))
    .sort((a, b) => b.cost - a.cost || a.i - b.i);

  for (const { i, cost } of byCost) {
    if (spent + cost > STRICT_OPTIONAL_LIMIT) continue;
    spent += cost;
    guaranteed.add(i);
  }

  return tools.map((tool, i) => {
    if (guaranteed.has(i)) return tool.strict === true ? tool : { ...tool, strict: true };
    if (tool.strict === undefined) return tool;
    const { strict: _dropped, ...rest } = tool;
    return rest as T;
  });
}

/**
 * Builds a tool `input_schema` from a zod object schema.
 *
 * Every object gets `required` and `additionalProperties: false`, as strict
 * mode requires. With strict mode the API guarantees the tool input matches
 * this schema, so zod only has to catch the rules this schema can't express
 * (the keywords stripped above).
 */
export function toolSchema(schema: z.ZodType): ToolSchema {
  const json = strip(z.toJSONSchema(schema, { target: "draft-2020-12" })) as Record<string, unknown>;

  if (json.type !== "object" || typeof json.properties !== "object") {
    throw new Error("a tool input schema must be an object schema");
  }
  // Strict mode needs `additionalProperties: false` on every object, including
  // the root, where zod may leave it out.
  return { ...json, type: "object", additionalProperties: false } as ToolSchema;
}
