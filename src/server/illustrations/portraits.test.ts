/**
 * CHARACTER PORTRAITS — the head-and-shoulders crop, the claim, the upload and
 * the check on save, against an in-memory table and a fake model. No database,
 * no network, no spend.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { testCharacter } from "../../fixtures/offline.ts";
import type { PortraitRow } from "../db/repo.ts";
import { inkPng } from "./image.ts";
import {
  drawPortrait,
  headAndShoulders,
  PORTRAIT_THUMB_PX,
  portraitFor,
  PortraitRefused,
  UPLOAD_MAX_BYTES,
  uploadPortrait,
  type PortraitStore,
  type PortraitWork,
} from "./portraits.ts";

/** A stick of a figure on white: a round head at (`x`, 100–160) on a long body below it. */
const figure = (x = 300) =>
  sharp({ create: { width: 600, height: 900, channels: 3, background: "#ffffff" } })
    .composite([
      {
        input: Buffer.from(
          '<svg width="600" height="900">' +
            `<circle cx="${x}" cy="130" r="30" fill="#000"/>` +
            `<rect x="${x - 60}" y="170" width="120" height="630" fill="#000"/>` +
            "</svg>"
        ),
      },
    ])
    .png()
    .toBuffer();

async function alphaAt(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { info, at: (x: number, y: number) => data[(y * info.width + x) * info.channels + 3] };
}

describe("headAndShoulders", () => {
  it("a square thumbnail with the head at the top, centred", async () => {
    const thumb = await headAndShoulders(await inkPng(await figure()));
    const { info, at } = await alphaAt(thumb);
    expect([info.width, info.height]).toEqual([PORTRAIT_THUMB_PX, PORTRAIT_THUMB_PX]);
    const mid = PORTRAIT_THUMB_PX / 2;
    // The head is near the top, in the middle; the corners above the shoulders are paper.
    expect(at(mid, Math.round(PORTRAIT_THUMB_PX * 0.2))).toBe(255);
    expect(at(4, 4)).toBe(0);
    expect(at(PORTRAIT_THUMB_PX - 4, 4)).toBe(0);
    // The body comes in below.
    expect(at(mid, PORTRAIT_THUMB_PX - 4)).toBe(255);
  });

  it("a figure at the page's edge is padded with paper rather than refused", async () => {
    const thumb = await headAndShoulders(await inkPng(await figure(40)));
    const { info, at } = await alphaAt(thumb);
    expect(info.width).toBe(PORTRAIT_THUMB_PX);
    expect(at(2, Math.round(PORTRAIT_THUMB_PX * 0.5))).toBe(0);
  });

  it("refuses a drawing with nothing in it", async () => {
    const blank = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#fff" } }).png().toBuffer();
    await expect(headAndShoulders(await inkPng(blank))).rejects.toThrow(/no figure/);
  });
});

/** The table in memory: a claim is refused at `limit` live drawings. */
function memoryStore() {
  const rows = new Map<string, { owner: string; source: "drawn" | "uploaded"; status: string; path?: string; thumb?: string; error?: string }>();
  const store: PortraitStore = {
    async claimPortrait(id, owner, limit) {
      const live = [...rows.values()].filter((r) => r.owner === owner && r.source === "drawn" && r.status !== "failed");
      if (limit !== null && live.length >= limit) return false;
      rows.set(id, { owner, source: "drawn", status: "pending" });
      return true;
    },
    async finishPortrait(id, path, thumb) {
      Object.assign(rows.get(id)!, { status: "ready", path, thumb });
    },
    async failPortrait(id, error) {
      Object.assign(rows.get(id)!, { status: "failed", error });
    },
    async insertUploadedPortrait(id, owner, path, thumb) {
      rows.set(id, { owner, source: "uploaded", status: "ready", path, thumb });
    },
  };
  return { rows, store };
}

function fakeWork(draw: () => Promise<Buffer> = figure) {
  const uploads: { path: string; type: string }[] = [];
  const prompts: string[] = [];
  const work: PortraitWork = {
    references: 9,
    async draw(prompt, task) {
      expect(task).toBe("portrait");
      prompts.push(prompt);
      return draw();
    },
    async upload(path, _png, type = "image/png") {
      uploads.push({ path, type });
    },
    urlOf: (path) => `https://cdn.test/${path}`,
  };
  return { work, uploads, prompts };
}

describe("drawPortrait", () => {
  it("draws from the sheet, stores the figure and its thumbnail, and marks it ready", async () => {
    const { rows, store } = memoryStore();
    const { work, uploads, prompts } = fakeWork();
    const p = await drawPortrait(testCharacter(), "me", 3, work, store, "id-1");
    expect(p).toEqual({
      id: "id-1",
      url: "https://cdn.test/portraits/id-1.png",
      thumbUrl: "https://cdn.test/portraits/id-1-thumb.png",
      source: "drawn",
    });
    expect(uploads.map((u) => u.path).sort()).toEqual(["portraits/id-1-thumb.png", "portraits/id-1.png"]);
    expect(rows.get("id-1")?.status).toBe("ready");
    expect(prompts[0]).toContain("Wiry");
  });

  it("is refused past the day's limit, before anything is drawn", async () => {
    const { store } = memoryStore();
    const { work, prompts } = fakeWork();
    await drawPortrait(testCharacter(), "guest", 1, work, store, "a");
    const second = drawPortrait(testCharacter(), "guest", 1, work, store, "b");
    await expect(second).rejects.toMatchObject({ status: 429 });
    expect(prompts).toHaveLength(1);
  });

  it("a failed drawing is marked failed and does not use up the day", async () => {
    const { rows, store } = memoryStore();
    const broken = fakeWork(() => Promise.reject(new Error("blank image")));
    await expect(drawPortrait(testCharacter(), "guest", 1, broken.work, store, "a")).rejects.toBeInstanceOf(PortraitRefused);
    expect(rows.get("a")).toMatchObject({ status: "failed", error: "blank image" });
    const { work } = fakeWork();
    await expect(drawPortrait(testCharacter(), "guest", 1, work, store, "b")).resolves.toMatchObject({ id: "b" });
  });
});

describe("uploadPortrait", () => {
  it("rewrites a picture as WebP, whole and as a square thumbnail, and counts nothing", async () => {
    const { rows, store } = memoryStore();
    const { work, uploads } = fakeWork();
    const photo = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: "#a07050" } }).jpeg().toBuffer();
    const p = await uploadPortrait(photo, "me", work, store, "up");
    expect(p).toMatchObject({ source: "uploaded", url: "https://cdn.test/portraits/up.webp" });
    expect(uploads).toEqual(
      expect.arrayContaining([
        { path: "portraits/up.webp", type: "image/webp" },
        { path: "portraits/up-thumb.webp", type: "image/webp" },
      ])
    );
    expect(rows.get("up")).toMatchObject({ source: "uploaded", status: "ready" });
  });

  it("refuses what is not a picture, and what is too big", async () => {
    const { store } = memoryStore();
    const { work } = fakeWork();
    await expect(uploadPortrait(Buffer.from("<script>no</script>"), "me", work, store)).rejects.toMatchObject({ status: 400 });
    await expect(uploadPortrait(Buffer.alloc(UPLOAD_MAX_BYTES + 1), "me", work, store)).rejects.toMatchObject({ status: 413 });
  });
});

describe("portraitFor", () => {
  const ready: PortraitRow = { id: "p1", source: "drawn", status: "ready", path: "portraits/p1.png", thumbPath: "portraits/p1-thumb.png" };
  const urlOf = (path: string) => `https://cdn.test/${path}`;

  it("takes the database's word for the URLs, not the sheet's", async () => {
    const claimed = { id: "p1", url: "https://elsewhere/x.png", thumbUrl: "https://elsewhere/y.png", source: "uploaded" as const };
    expect(await portraitFor(claimed, "me", urlOf, async () => ready)).toEqual({
      id: "p1",
      url: "https://cdn.test/portraits/p1.png",
      thumbUrl: "https://cdn.test/portraits/p1-thumb.png",
      source: "drawn",
    });
  });

  it("drops a portrait that is not this account's, or not finished", async () => {
    const claimed = { id: "p1", url: "", thumbUrl: "", source: "drawn" as const };
    expect(await portraitFor(claimed, "me", urlOf, async () => undefined)).toBeUndefined();
    expect(await portraitFor(claimed, "me", urlOf, async () => ({ ...ready, status: "pending" }))).toBeUndefined();
    expect(await portraitFor(undefined, "me", urlOf, async () => ready)).toBeUndefined();
  });
});
