/**
 * THE SUITE THAT NEEDS A DATABASE
 * ===============================
 *
 * Separate from `vite.config.ts`'s two projects, and explicitly invoked
 * (`npm run test:db`), for one reason: it cannot run without `DATABASE_URL`, and
 * a test that skips itself when a secret is missing is a test that lies. The
 * project's own rule — CODING-PLAN §2.13, "a guard clause that skips is a test
 * that lies" — is why this is a third config rather than a third project with a
 * `describe.skipIf` in it. `npm test` does not know these exist; running them is
 * a decision.
 *
 * They run against the REAL database, inside transactions that are always rolled
 * back — the same method §7.6 used to verify the Phase 10a statements by hand.
 * Nothing they write survives.
 *
 *   npm run test:db
 */

import { defineConfig } from "vite";

export default defineConfig({
  test: {
    name: "db",
    environment: "node",
    include: ["src/**/*.dbtest.ts"],
    // One at a time. They share a database and each wraps itself in a
    // transaction; parallel files would deadlock on the same rows.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
