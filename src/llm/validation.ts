/**
 * VALIDATION ISSUES, in the one shape every check reports.
 *
 * A zod failure and an omission the code spotted on its own both become a list
 * of `{ path, message }`, which is what goes back to the model on a retry and
 * into the journal.
 */

import type { z } from "zod";

export type ValidationIssue = { path: string; message: string };

export function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({
    path: i.path.join(".") || "(root)",
    message: i.message,
  }));
}

/** Validation errors, formatted for feeding back to the model on retry. */
export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}
