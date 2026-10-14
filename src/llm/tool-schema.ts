/**
 * ZOD -> TOOL INPUT SCHEMA
 *
 * The tool's `input_schema` is what actually shapes a forced tool call. Handing
 * the API a permissive `{ type: "object", additionalProperties: true }` and
 * relying on the prompt to describe the shape does not work: the model has to
 * guess the parameter names, and it guesses differently each time. Observed on
 * one seed, same prompt, two attempts — `{ region_data: … }` once, `{ rooms: … }`
 * the next, and `{}` in the failure that started this. The prompt describes the
 * *content*; the schema declares the *shape*, and only one of them is machine
 * enforced.
 *
 * So the schema goes on the wire, generated from the zod schema that validates
 * the response, which also means the two cannot drift apart.
 *
 * Structured outputs rejects a few JSON Schema keywords that zod emits happily.
 * They are stripped here and still enforced by zod on the way back in — the
 * same split the official SDKs make.
 */

import { z } from "zod";

/** Keywords structured outputs does not accept. Zod still checks them locally. */
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
    // Strict mode allows `additionalProperties` only as `false`. Zod emits a
    // schema object there for a `z.record(...)`, which the API rejects with a
    // 400 rather than ignoring — so no open-ended maps in a response schema.
    if (k === "additionalProperties" && v !== false) {
      throw new Error(
        "a response schema cannot contain an open-ended record: " +
          "structured outputs requires additionalProperties: false. " +
          "Name the keys explicitly instead."
      );
    }
    out[k] = strip(v);
  }
  // Every object level needs it, and zod omits it where nothing is optional.
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
 * Strict mode compiles the schema into a grammar, and refuses to do so past 24
 * optional parameters — the content pass has 35, because most of what a room
 * can hold is optional (not every room has a hazard, a goal, an elite).
 *
 * Which is a limit on the guarantee, not on the schema: an accurate
 * `input_schema` is what stops the model guessing at parameter names, and that
 * works with or without strict. Where the schema is small enough, strict adds
 * a hard guarantee on top; where it is not, zod is still validating every
 * response and a bad one still costs only a retry.
 *
 * THE BUDGET IS PER REQUEST, NOT PER TOOL. The grammar is compiled for the call,
 * so every strict schema on the table spends from the same 24 — `commit_state`
 * (15) and `roll` (11) each fit alone and 400 the moment they are offered
 * together. `fitStrict` is where that is settled; `canBeStrict` answers only for
 * a tool that goes out on its own.
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

/** Whether this schema is simple enough for the API to guarantee it, alone. */
export function canBeStrict(schema: ToolSchema): boolean {
  return countOptional(schema) <= STRICT_OPTIONAL_LIMIT;
}

/** The `strict` flag is decided per request, so this is all a tool has to carry. */
interface Strictable {
  input_schema: ToolSchema;
  strict?: boolean;
}

/**
 * Spend the request's strict budget across the tools going out together.
 *
 * Only compiled schemas count against it — the content pass has been sending an
 * unguaranteed 35-optional tool since Phase 1 — so this drops `strict` rather
 * than touching any schema. The tool keeps its real shape either way, and zod
 * still checks whatever comes back.
 *
 * Biggest first, so the guarantee lands where the model has the most to get
 * wrong. On the runtime's pair that is `commit_state`, which writes state; a
 * malformed `roll` costs one more exchange and nothing else.
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
 * A tool `input_schema` for a zod object schema.
 *
 * Emits `required` and `additionalProperties: false` throughout, which is what
 * `strict: true` demands — with it the API guarantees the tool input validates
 * against this shape, so zod's job narrows to catching what the JSON Schema
 * subset cannot express.
 */
export function toolSchema(schema: z.ZodType): ToolSchema {
  const json = strip(z.toJSONSchema(schema, { target: "draft-2020-12" })) as Record<string, unknown>;

  if (json.type !== "object" || typeof json.properties !== "object") {
    throw new Error("a tool input schema must be an object schema");
  }
  // `additionalProperties: false` at every level is a strict-mode requirement,
  // and zod omits it on the root when there is nothing optional to exclude.
  return { ...json, type: "object", additionalProperties: false } as ToolSchema;
}
