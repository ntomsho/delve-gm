/**
 * ROOM PLATES — the pixels
 * ========================
 *
 * Everything a plate needs done to an image, with sharp: the guide drawn to a
 * PNG, and the model's picture thresholded to 1-bit. Shared by the server and
 * the spike script (`src/dev/cli-illustrate.ts`) so both make the same image.
 *
 * Node only: sharp is native.
 */

import sharp from "sharp";
import { plateSketchSvg } from "../../illustrations/sketch.ts";
import type { RoomPlate } from "../../illustrations/room-illustration.ts";

/** A plate's size, the image model's 3:2 landscape. */
export const PLATE_W = 1536;
export const PLATE_H = 1024;

/** Where a 1-bit pixel turns black. Below the middle so light hatching survives. */
export const PLATE_THRESHOLD = 150;

/**
 * The guide at the plate's full size. Drawn at the width its line weights
 * were set for and scaled up as a vector, so walls, dashes and tags all grow
 * together; drawn at full width instead, they come out hairline.
 */
export function guidePng(p: RoomPlate, marks: boolean): Promise<Buffer> {
  const drawnAt = 480;
  return sharp(Buffer.from(plateSketchSvg(p, { marks, width: drawnAt })), { density: (72 * PLATE_W) / drawnAt })
    .resize(PLATE_W, PLATE_H)
    .png()
    .toBuffer();
}

/** Black ink on white paper, two colours: what the contact sheet shows. */
export function oneBitPng(image: Buffer): Promise<Buffer> {
  return sharp(image)
    .flatten({ background: "#ffffff" })
    .greyscale()
    .threshold(PLATE_THRESHOLD)
    .png({ palette: true, colours: 2 })
    .toBuffer();
}

/**
 * Black ink on NOTHING: what the page gets. The paper is transparent, so the
 * page lays the plate down as a mask over its own ink colour and the picture's
 * white is the page's paper — no box edge, and the lines are exactly the
 * text's ink. Same threshold as `oneBitPng`, so the two are the same drawing.
 */
export async function inkPng(image: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(image)
    .flatten({ background: "#ffffff" })
    .greyscale()
    .threshold(PLATE_THRESHOLD)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const rgba = Buffer.alloc(n * 4);
  // RGB stays 0 (black); alpha is the ink.
  for (let i = 0; i < n; i++) rgba[i * 4 + 3] = data[i * info.channels] < 128 ? 255 : 0;
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
