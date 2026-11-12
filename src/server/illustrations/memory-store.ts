/**
 * The `assets` table and `plate_words` in memory, with the claim rules
 * `claimAsset` and `failAsset` have in SQL. For tests: no database.
 */

import type { AssetRef, AssetRow } from "../db/repo.ts";
import type { IllustrationStore } from "./serve.ts";

export function memoryStore() {
  const rows = new Map<string, Omit<AssetRow, "ageMs"> & { at: number }>();
  const words = new Map<string, string>();
  let clock = 0;
  const id = (r: AssetRef) => `${r.artRoot}|${r.kind}|${r.subject}`;
  const store: IllustrationStore = {
    async getAsset(ref) {
      const r = rows.get(id(ref));
      return r && { status: r.status, path: r.path, draws: r.draws, attempts: r.attempts, meta: r.meta, ageMs: clock - r.at };
    },
    async claimAsset(ref, _model, opts) {
      const r = rows.get(id(ref));
      if (!r) {
        rows.set(id(ref), { status: "pending", path: null, draws: 0, attempts: 1, meta: {}, at: clock });
        return true;
      }
      const redraw = r.status === "redraw";
      const retry = r.status === "failed" && r.attempts < opts.maxAttempts;
      const stale = r.status === "pending" && clock - r.at > opts.staleMs;
      if (!redraw && !retry && !stale) return false;
      rows.set(id(ref), { ...r, status: "pending", attempts: redraw ? 1 : r.attempts + 1, at: clock });
      return true;
    },
    async finishAsset(ref, path, meta) {
      const r = rows.get(id(ref))!;
      rows.set(id(ref), { ...r, status: "ready", path, meta, draws: r.draws + 1, at: clock });
    },
    async failAsset(ref) {
      const r = rows.get(id(ref))!;
      rows.set(id(ref), { ...r, status: r.path ? "ready" : "failed", at: clock });
    },
    async getIllustrationWords(key) {
      return words.get(key);
    },
    async saveIllustrationWords(key, value) {
      if (!words.has(key)) words.set(key, value);
      return words.get(key)!;
    },
  };
  /** What `npm run redraw` does to one drawn row. */
  const markForRedraw = (ref: AssetRef) => {
    const r = rows.get(id(ref))!;
    rows.set(id(ref), { ...r, status: "redraw" });
  };
  const row = (ref: AssetRef) => rows.get(id(ref));
  return { store, row, markForRedraw, tick: (ms: number) => (clock += ms) };
}
