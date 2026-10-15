/**
 * ROOM ILLUSTRATIONS — the claim, the cache and the failure path, against an
 * in-memory table and a fake model. No database, no network, no spend.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { generateOffline } from "../../fixtures/offline.ts";
import { coverDescription, illustrationEntries, illustrationTags, roomIllustration } from "../../illustrations/room-illustration.ts";
import type { IllustrationRow } from "../db/repo.ts";
import { inkPng } from "./image.ts";
import {
  coverKey,
  ILLUSTRATION_CLAIM_STALE_MS,
  ILLUSTRATION_MAX_ATTEMPTS,
  illustrationKey,
  serveCover,
  serveIllustration,
  type IllustrationStore,
  type IllustrationWork,
} from "./serve.ts";

const d = generateOffline(1005, 1);
const roomId = d.graph.rooms.map((r) => r.entityId).find((id) => illustrationEntries(d, id).length > 0)!;
const entryId = illustrationEntries(d, roomId)[0];

function memoryStore() {
  const rows = new Map<string, IllustrationRow & { at: number }>();
  const words = new Map<string, string>();
  let clock = 0;
  const store: IllustrationStore = {
    async getIllustration(key) {
      const r = rows.get(key);
      return r && { ...r, ageMs: clock - r.at };
    },
    async claimIllustration(key, _model, opts) {
      const r = rows.get(key);
      if (!r) {
        rows.set(key, { key, status: "pending", path: null, attempts: 1, ageMs: 0, at: clock });
        return true;
      }
      const retry = r.status === "failed" && r.attempts < opts.maxAttempts;
      const stale = r.status === "pending" && clock - r.at > opts.staleMs;
      if (!retry && !stale) return false;
      rows.set(key, { ...r, status: "pending", attempts: r.attempts + 1, at: clock });
      return true;
    },
    async finishIllustration(key, path) {
      rows.set(key, { ...rows.get(key)!, status: "ready", path, at: clock });
    },
    async failIllustration(key) {
      rows.set(key, { ...rows.get(key)!, status: "failed", at: clock });
    },
    async getIllustrationWords(key) {
      return words.get(key);
    },
    async saveIllustrationWords(key, value) {
      if (!words.has(key)) words.set(key, value);
      return words.get(key)!;
    },
  };
  return { store, rows, words, tick: (ms: number) => (clock += ms) };
}

const picture = () =>
  sharp({ create: { width: 30, height: 20, channels: 3, background: "#ffffff" } })
    .composite([{ input: Buffer.from('<svg width="30" height="20"><rect x="5" y="5" width="10" height="10"/></svg>') }])
    .png()
    .toBuffer();

function fakeWork(opts: { fail?: boolean } = {}) {
  const calls = { setting: 0, visual: 0, draw: 0, scenes: [] as string[], prompts: [] as string[], uploads: [] as string[] };
  const work: IllustrationWork = {
    references: 4,
    async setting() {
      calls.setting++;
      return "Dressed grey stone, dim.";
    },
    async visual() {
      calls.visual++;
      return { room: "A plain stone room.", looks: {} };
    },
    async draw(prompt) {
      calls.draw++;
      calls.prompts.push(prompt);
      if (opts.fail) throw new Error("the model said no");
      return picture();
    },
    async scene(description) {
      calls.scenes.push(description);
      return "A ruined tower on a bare hill.";
    },
    async drawScene(prompt) {
      calls.draw++;
      calls.prompts.push(prompt);
      if (opts.fail) throw new Error("the model said no");
      return picture();
    },
    async upload(path) {
      calls.uploads.push(path);
    },
    urlOf: (path) => `https://cdn.example/illustrations/${path}`,
  };
  return { work, calls };
}

describe("serveIllustration", () => {
  it("draws once, then serves the stored illustration to every later ask", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork();
    const first = await serveIllustration(d, roomId, entryId, work, m.store);
    expect(first.status).toBe("ready");
    const again = await serveIllustration(d, roomId, entryId, work, m.store);
    expect(again).toEqual(first);
    expect(calls.draw).toBe(1);
    expect(calls.uploads).toEqual([`${illustrationKey(roomIllustration(d, roomId, entryId)!, d.pass.theme, 4)}.png`]);
    expect(calls.prompts[0]).toContain("Dressed grey stone, dim.");
    expect(calls.prompts[0]).toContain("4 images are style references");
  });

  it("carries a button at each of the guide's tags, and one for every door and object out of the picture", async () => {
    const m = memoryStore();
    const { work } = fakeWork();
    const got = await serveIllustration(d, roomId, entryId, work, m.store);
    const spots = got.status === "ready" ? got.spots ?? [] : [];
    const p = roomIllustration(d, roomId, entryId)!;
    const tags = illustrationTags(p);
    const tagged = p.hotspots.filter((h) => h.status === "shown" && tags.has(h.id));
    expect(spots.filter((s) => s.how === "shown")).toEqual(
      tagged.flatMap((h) => h.points.map((q) => ({ id: h.id, how: "shown", x: q.x, y: q.y })))
    );
    expect(tagged.length).toBeGreaterThan(0);
    const objects = new Set([...p.exits, p.entry].map((x) => x.id));
    p.features.forEach((f) => f.presence === "object" && objects.add(f.id));
    const unseen = p.hotspots.filter((h) => h.status !== "shown" && objects.has(h.id));
    expect(spots.filter((s) => s.how !== "shown").map((s) => s.id).sort()).toEqual(unseen.map((h) => h.id).sort());
  });

  it("asks for the setting line once per dungeon", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork();
    for (const id of d.graph.rooms.map((r) => r.entityId)) {
      const via = illustrationEntries(d, id)[0];
      if (via) await serveIllustration(d, id, via, work, m.store);
    }
    expect(calls.visual).toBeGreaterThan(1);
    expect(calls.setting).toBe(1);
  });

  it("answers pending while another request holds a fresh claim, and takes over a stale one", async () => {
    const m = memoryStore();
    const key = illustrationKey(roomIllustration(d, roomId, entryId)!, d.pass.theme, 4);
    await m.store.claimIllustration(key, "x", { staleMs: ILLUSTRATION_CLAIM_STALE_MS, maxAttempts: ILLUSTRATION_MAX_ATTEMPTS });
    const { work, calls } = fakeWork();
    expect(await serveIllustration(d, roomId, entryId, work, m.store)).toEqual({ status: "pending" });
    m.tick(ILLUSTRATION_CLAIM_STALE_MS + 1);
    expect((await serveIllustration(d, roomId, entryId, work, m.store)).status).toBe("ready");
    expect(calls.draw).toBe(1);
  });

  it("is a missing picture on failure, retried until the attempts run out", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork({ fail: true });
    for (let i = 0; i < ILLUSTRATION_MAX_ATTEMPTS + 2; i++) {
      expect(await serveIllustration(d, roomId, entryId, work, m.store)).toEqual({ status: "none" });
    }
    expect(calls.draw).toBe(ILLUSTRATION_MAX_ATTEMPTS);
  });

  it("keys by what the illustration is drawn from: a copy of the dungeon finds the same key", () => {
    const p = roomIllustration(d, roomId, entryId)!;
    expect(illustrationKey(p, d.pass.theme, 4)).toBe(illustrationKey(roomIllustration(structuredClone(d), roomId, entryId)!, d.pass.theme, 4));
    expect(illustrationKey(p, d.pass.theme, 4)).not.toBe(illustrationKey(p, d.pass.theme + " Wet.", 4));
    expect(illustrationKey(p, d.pass.theme, 4)).not.toBe(illustrationKey(p, d.pass.theme, 3));
  });
});

describe("serveCover", () => {
  it("is drawn from the opening and the way in, once", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork();
    const key = coverKey(d)!;
    const first = await serveCover(d, key, work, m.store);
    expect(first).toEqual({ status: "ready", url: `https://cdn.example/illustrations/${key}.png` });
    expect(await serveCover(d, key, work, m.store)).toEqual(first);
    expect(calls.draw).toBe(1);
    expect(calls.scenes[0]).toContain(d.pass.openingProse);
    expect(calls.scenes[0]).toMatch(/THE WAY IN: .+/);
    expect(calls.prompts[0]).toContain("A ruined tower on a bare hill.");
  });

  it("describes the surface way into the first room", () => {
    const way = d.entities.connectors.find((c) => c.endpointB === null && c.endpointA === d.stocked.entranceRoomId)!;
    expect(coverDescription(d)).toContain(`THE WAY IN: ${way.name}.`);
  });

  it("keys a copy of the dungeon the same, and another dungeon differently", () => {
    expect(coverKey(structuredClone(d))).toBe(coverKey(d));
    expect(coverKey(generateOffline(42, 1))).not.toBe(coverKey(d));
  });
});

describe("inkPng", () => {
  it("keeps the ink black and opaque and makes the paper transparent", async () => {
    const { data, info } = await sharp(await inkPng(await picture())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
    expect(px(10, 10)).toEqual([0, 0, 0, 255]);
    expect(px(1, 1)[3]).toBe(0);
  });
});
