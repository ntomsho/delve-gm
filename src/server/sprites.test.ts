/**
 * CREATURE SPRITES — the cut-out, and the claim and cache, against an
 * in-memory table and a fake model. No database, no network, no spend.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { spriteKeyOf } from "../engine/index.ts";
import { generateOffline } from "../runtime/__fixtures__/offline.ts";
import { spriteSubject } from "../runtime/sprites.ts";
import type { PlateRow } from "./repo.ts";
import type { PlateStore } from "./plates.ts";
import { cutOut, SPRITE_STORE_H, spriteMasksPng } from "./sprite-image.ts";
import { serveSprite, spriteKey, type SpriteWork } from "./sprites.ts";

/**
 * A figure on white: a thick black ring (its outline, with paper inside), and a
 * speck off to one side that the cut-out should drop.
 */
const drawing = () =>
  sharp({ create: { width: 300, height: 450, channels: 3, background: "#ffffff" } })
    .composite([
      {
        input: Buffer.from(
          '<svg width="300" height="450">' +
            '<rect x="100" y="60" width="100" height="300" fill="none" stroke="#000" stroke-width="8"/>' +
            '<rect x="20" y="20" width="4" height="4" fill="#000"/>' +
            "</svg>"
        ),
      },
    ])
    .png()
    .toBuffer();

describe("cutOut", () => {
  it("keeps the paper inside the outline, drops the background and the speck", async () => {
    const c = await cutOut(await drawing());
    // Trimmed to the ring, stroke included.
    expect(c.w).toBeGreaterThanOrEqual(100);
    expect(c.w).toBeLessThanOrEqual(112);
    expect(c.h).toBeGreaterThanOrEqual(300);
    expect(c.h).toBeLessThanOrEqual(312);
    const mid = Math.floor(c.h / 2) * c.w + Math.floor(c.w / 2);
    expect(c.body[mid]).toBe(1); // paper inside: part of the figure
    expect(c.ink[mid]).toBe(0); // and not ink
    expect(c.ink[Math.floor(c.h / 2) * c.w + 1]).toBe(1); // the outline is ink
  });
});

describe("spriteMasksPng", () => {
  it("body and ink side by side, each half the width, no taller than the stored height", async () => {
    const png = await spriteMasksPng(await cutOut(await drawing()));
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width % 2).toBe(0);
    expect(info.height).toBeLessThanOrEqual(SPRITE_STORE_H);
    const half = info.width / 2;
    const alpha = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    const cy = Math.floor(info.height / 2);
    const cx = Math.floor(half / 2);
    expect(alpha(cx, cy)).toBe(255); // body: the paper inside is solid
    expect(alpha(half + cx, cy)).toBe(0); // ink: nothing drawn there
  });
});

function memoryStore() {
  const rows = new Map<string, PlateRow>();
  const words = new Map<string, string>();
  const store: PlateStore = {
    async getPlate(key) {
      const r = rows.get(key);
      return r && { ...r, ageMs: 0 };
    },
    async claimPlate(key, _model, opts) {
      const r = rows.get(key);
      if (!r) {
        rows.set(key, { key, status: "pending", path: null, attempts: 1, ageMs: 0 });
        return true;
      }
      if (r.status !== "failed" || r.attempts >= opts.maxAttempts) return false;
      rows.set(key, { ...r, status: "pending", attempts: r.attempts + 1 });
      return true;
    },
    async finishPlate(key, path) {
      rows.set(key, { ...rows.get(key)!, status: "ready", path });
    },
    async failPlate(key) {
      rows.set(key, { ...rows.get(key)!, status: "failed" });
    },
    async getPlateWords(key) {
      return words.get(key);
    },
    async savePlateWords(key, value) {
      if (!words.has(key)) words.set(key, value);
      return words.get(key)!;
    },
  };
  return { store, rows, words };
}

function fakeWork(opts: { fail?: boolean } = {}) {
  const calls = { look: 0, draw: 0, prompts: [] as string[], uploads: [] as string[] };
  const work: SpriteWork = {
    references: 9,
    async look() {
      calls.look++;
      return { look: "A stooped figure in a grey robe.", size: "large" };
    },
    async draw(prompt) {
      calls.draw++;
      calls.prompts.push(prompt);
      if (opts.fail) throw new Error("the model said no");
      return drawing();
    },
    async upload(path) {
      calls.uploads.push(path);
    },
    urlOf: (path) => `https://cdn.example/plates/${path}`,
  };
  return { work, calls };
}

const d = generateOffline(4201, 1);
const creature = d.entities.creatures[0];
const id = spriteKeyOf(creature);
const theme = d.pass.theme;

describe("serveSprite", () => {
  it("draws once, with the look in the prompt, then serves the stored sprite and its size", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork();
    const first = await serveSprite(d.entities, theme, id, work, m.store);
    expect(first).toEqual({ status: "ready", url: expect.stringMatching(/^https:\/\/cdn\.example\/plates\/[0-9a-f]{64}\.png$/), size: "large" });
    expect(calls.prompts[0]).toContain("A stooped figure in a grey robe.");
    expect(calls.prompts[0]).toContain("The 9 images are style references only");

    const again = await serveSprite(d.entities, theme, id, work, m.store);
    expect(again).toEqual(first);
    expect(calls).toMatchObject({ look: 1, draw: 1 });
    expect(calls.uploads).toHaveLength(1);
  });

  it("is keyed by what it is drawn from, so another run of the dungeon finds it", () => {
    const s = spriteSubject(d.entities, id)!;
    // Another run starts from its own copy of the dungeon's entities (`newRun`).
    const another = structuredClone(d.entities);
    expect(spriteKey(spriteSubject(another, id)!, theme, 9)).toBe(spriteKey(s, theme, 9));
    expect(spriteKey(s, theme, 8)).not.toBe(spriteKey(s, theme, 9));
  });

  it("a failed drawing is no sprite, and the look is kept for the retry", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork({ fail: true });
    expect(await serveSprite(d.entities, theme, id, work, m.store)).toEqual({ status: "none" });
    expect(await serveSprite(d.entities, theme, id, work, m.store)).toEqual({ status: "none" });
    expect(calls.look).toBe(1);
    expect(calls.draw).toBe(2);
  });

  it("a key no creature carries is none, and nothing is drawn", async () => {
    const m = memoryStore();
    const { work, calls } = fakeWork();
    expect(await serveSprite(d.entities, theme, "no-such-kind", work, m.store)).toEqual({ status: "none" });
    expect(calls.draw).toBe(0);
  });
});
