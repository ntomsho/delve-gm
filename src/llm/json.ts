/**
 * Getting a validated object out of a model response.
 *
 * The generation passes ask for JSON through a forced tool call, which removes
 * the parsing problem entirely — the API hands back a parsed object. `extractJson`
 * is the fallback for the text path: it strips fences and locates the outermost
 * object, because a model that has been told "JSON only" still occasionally
 * says "Here you go:" first.
 */

import { z } from "zod";
import { formatIssues, issuesOf, type ValidationIssue } from "./schemas.ts";

// Explicit fields, not constructor parameter properties — see the note on
// LlmError: the CLI runs under plain `node`, which cannot strip those.
export class ResponseFormatError extends Error {
  readonly issues: ValidationIssue[];
  readonly raw: string | undefined;

  constructor(message: string, issues: ValidationIssue[] = [], raw?: string) {
    super(message);
    this.name = "ResponseFormatError";
    this.issues = issues;
    this.raw = raw;
  }

  /** The part worth appending to a retry prompt. */
  get feedback(): string {
    return this.issues.length
      ? `Your previous response failed validation:\n${formatIssues(this.issues)}\n\nReturn the corrected JSON.`
      : `Your previous response could not be parsed as JSON. Return JSON only, with no prose around it.`;
  }
}

/** Pull a JSON object out of prose that may fence it or preface it. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall through to brace matching.
  }

  const start = candidate.indexOf("{");
  if (start === -1) throw new ResponseFormatError("no JSON object in the response", [], text);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(candidate.slice(start, i + 1));
      } catch (e) {
        throw new ResponseFormatError(
          `malformed JSON: ${e instanceof Error ? e.message : String(e)}`,
          [],
          text
        );
      }
    }
  }
  throw new ResponseFormatError("unterminated JSON object in the response", [], text);
}

/** Validate an already-parsed value, raising something a retry can use. */
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ResponseFormatError(
    "response did not match the expected shape",
    issuesOf(result.error),
    JSON.stringify(value).slice(0, 2000)
  );
}

export function parseAndValidate<T>(schema: z.ZodType<T>, text: string): T {
  return validate(schema, extractJson(text));
}
