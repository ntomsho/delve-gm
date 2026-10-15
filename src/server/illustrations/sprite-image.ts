/**
 * CREATURE SPRITES — the pixels
 * =============================
 *
 * The image model draws one figure on white. Code cuts it out — no paid
 * background remover, no model transparency:
 *
 *   1. threshold to 1-bit, at the illustrations' own threshold;
 *   2. close small gaps in the outline (dilate, then erode), so step 3 cannot
 *      leak through a gap into the figure;
 *   3. flood the white from the image's border: that is the background;
 *   4. keep the largest piece of what is left: the figure, specks dropped.
 *
 * The paper INSIDE the outline stays: it is what hides the illustration behind the
 * figure. So a sprite is two masks, stored side by side in one PNG, each half
 * the width — the BODY on the left, the INK on the right — both black with the
 * mask in alpha, the way an illustration is stored. The page lays the body down in its
 * paper colour and the ink over it in its ink colour.
 *
 * STORED SMALL, SHRUNK SMOOTHLY. Figures stand 50–400 px tall on the page.
 * Shrinking a 1536 px drawing to that and forcing it back to pure black and
 * white clumped the hatching of small figures into dark patches, which read as
 * shading nobody drew. So the masks are stored at `SPRITE_STORE_H`, with ink
 * kept wherever a stored pixel is at least `SPRITE_INK_COVERAGE` ink, and the
 * page's own smooth scaling does the rest.
 *
 * Node only: sharp is native.
 */

import sharp from "sharp";
import { ILLUSTRATION_THRESHOLD } from "./image.ts";

/** The stored sprite's height, in pixels: about what a near figure is on a full-size illustration. */
export const SPRITE_STORE_H = 512;
/** How much of a stored pixel must be ink for it to be ink, out of 255: lines a third of a pixel wide survive. */
export const SPRITE_INK_COVERAGE = 64;
/** Pixels of closing before the flood fill. */
const CLOSE_PX = 3;

/** A figure cut out of its drawing, at the drawing's size. */
export interface Cutout {
  w: number;
  h: number;
  /** 1 where the figure is, paper or ink */
  body: Uint8Array;
  /** 1 where the figure's ink is */
  ink: Uint8Array;
}

/** Max (dilate) or min (erode) over a square of radius r, as two one-dimensional passes. */
function morph(src: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  const pass = (a: Uint8Array, horizontal: boolean) => {
    const b = new Uint8Array(a.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? x + k : x;
          const yy = horizontal ? y : y + k;
          const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : a[yy * w + xx];
          if (dilate ? s : !s) {
            v = dilate ? 1 : 0;
            break;
          }
        }
        b[y * w + x] = v;
      }
    }
    return b;
  };
  return pass(pass(src, true), false);
}

/** Cut the figure out of a drawing on white, trimmed to the figure. */
export async function cutOut(image: Buffer): Promise<Cutout> {
  const { data, info } = await sharp(image)
    .flatten({ background: "#ffffff" })
    .greyscale()
    .threshold(ILLUSTRATION_THRESHOLD)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const n = w * h;
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) ink[i] = data[i * info.channels] < 128 ? 1 : 0;
  const closed = morph(morph(ink, w, h, CLOSE_PX, true), w, h, CLOSE_PX, false);

  // Flood the outside from every border pixel.
  const outside = new Uint8Array(n);
  const stack: number[] = [];
  const seed = (i: number) => {
    if (!closed[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < n - w) seed(i + w);
  }

  // The largest connected piece of what is left is the figure.
  const label = new Int32Array(n);
  let best = 0;
  let bestSize = 0;
  let next = 0;
  for (let start = 0; start < n; start++) {
    if (outside[start] || label[start]) continue;
    next++;
    let size = 0;
    label[start] = next;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j >= 0 && j < n && !outside[j] && !label[j]) {
          label[j] = next;
          stack.push(j);
        }
      }
    }
    if (size > bestSize) {
      best = next;
      bestSize = size;
    }
  }
  if (!best) throw new Error("no figure in the drawing");

  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < n; i++) {
    if (label[i] !== best) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const body = new Uint8Array(cw * ch);
  const inkOut = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = (y + y0) * w + (x + x0);
      if (label[i] === best) {
        body[y * cw + x] = 1;
        inkOut[y * cw + x] = ink[i];
      }
    }
  }
  return { w: cw, h: ch, body, ink: inkOut };
}

/** A mask shrunk smoothly to w × h: 0–255, how much of each new pixel was set. */
async function shrink(mask: Uint8Array, from: { w: number; h: number }, w: number, h: number): Promise<(i: number) => number> {
  const grey = Buffer.alloc(mask.length);
  for (let i = 0; i < mask.length; i++) grey[i] = mask[i] ? 255 : 0;
  const { data, info } = await sharp(grey, { raw: { width: from.w, height: from.h, channels: 1 } })
    .resize(w, h, { kernel: "cubic" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // sharp may hand back more channels than it was given.
  return (i) => data[i * info.channels];
}

/**
 * The stored sprite: body and ink masks side by side, at `SPRITE_STORE_H`.
 * Each half is `w` wide; the page reads the figure's shape off the halves.
 */
export async function spriteMasksPng(c: Cutout): Promise<Buffer> {
  const h = Math.min(SPRITE_STORE_H, c.h);
  const w = Math.max(1, Math.round((c.w / c.h) * h));
  const [inkAt, bodyAt] = await Promise.all([shrink(c.ink, c, w, h), shrink(c.body, c, w, h)]);
  const rgba = Buffer.alloc(w * 2 * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const isInk = inkAt(i) >= SPRITE_INK_COVERAGE;
      // Body: the paper under the ink as well, so a line at the edge has paper behind it.
      rgba[(y * w * 2 + x) * 4 + 3] = isInk || bodyAt(i) >= 128 ? 255 : 0;
      rgba[(y * w * 2 + w + x) * 4 + 3] = isInk ? 255 : 0;
    }
  }
  return sharp(rgba, { raw: { width: w * 2, height: h, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
}
