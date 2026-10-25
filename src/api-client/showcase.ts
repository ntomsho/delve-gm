/**
 * THE LANDING PAGE'S PICTURES: rooms and covers drawn in recent runs.
 *
 * The one call made before anyone signs in, so it is a plain fetch with no
 * session. A failure is no pictures, never an error: the page reads without them.
 */

import type { ShowcaseIllustration } from "../illustrations/showcase.ts";

export type { ShowcaseFigure, ShowcaseIllustration } from "../illustrations/showcase.ts";

/** How long the page waits before going on without pictures. */
const SHOWCASE_TIMEOUT_MS = 8000;

export async function recentIllustrations(): Promise<ShowcaseIllustration[]> {
  try {
    const res = await fetch("/api/illustrations/recent", { signal: AbortSignal.timeout(SHOWCASE_TIMEOUT_MS) });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    return Array.isArray(body) ? (body as ShowcaseIllustration[]) : [];
  } catch {
    return [];
  }
}
