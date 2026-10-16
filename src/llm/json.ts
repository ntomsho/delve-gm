/**
 * Getting a validated object out of a model response.
 *
 * Every structured answer comes back through a forced tool call, which removes
 * the parsing problem entirely: the API hands back a parsed object, and this
 * file checks it against a schema.
 */

import { z } from "zod";
import { formatIssues, issuesOf, type ValidationIssue } from "./validation.ts";

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

/**
 * An error, said usefully.
 *
 * "response did not match the expected shape" is what a `ResponseFormatError`
 * says on its own, and on a screen it is worth nothing: it names no pass, no
 * chunk, and no field. The issues are right there on the error, so the first
 * few of them go into the message — enough to tell a prompt problem from a bad
 * roll of the dice without opening anything.
 */
export function describeFailure(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (!(e instanceof ResponseFormatError) || e.issues.length === 0) return message;

  const shown = e.issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`);
  const rest = e.issues.length - shown.length;
  return `${message} — ${shown.join("; ")}${rest > 0 ? `, and ${rest} more` : ""}`;
}
