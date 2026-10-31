/**
 * PORTRAITS: a picture of a character, drawn or uploaded, on the last step of
 * creation. See `src/server/illustrations/portraits.ts`.
 *
 * The character need not be saved yet: the drawing is made from the sheet the
 * player is looking at, and the sheet that is saved later carries the
 * portrait's id, which `POST /api/characters` checks is this account's.
 */

import type { Hono } from "hono";
import { currentUser, type AuthEnv } from "../auth.ts";
import type { PlayerCharacter } from "../../rules/knave/character.ts";
import { allowanceOf, hasPortraitLeft, portraitRefusal } from "../allowance.ts";
import { closed } from "../spend.ts";
import { drawPortrait, PortraitRefused, UPLOAD_MAX_BYTES, uploadPortrait } from "../illustrations/portraits.ts";
import { spriteWorker } from "./illustrations.ts";

const NOT_SET_UP = "Portraits are not set up on this server.";

export function portraitRoutes(app: Hono<AuthEnv>): void {
  /**
   * Draw the character in the body. One of the day's portraits
   * (`GUEST_PORTRAITS_PER_DAY`, `MEMBER_PORTRAITS_PER_DAY`), and about 20 s.
   * Answers the portrait and the allowance after it, so the button can say
   * how many are left without asking again.
   */
  app.post("/api/portraits", async (c) => {
    const user = currentUser(c);
    const pc = (await c.req.json().catch(() => undefined)) as PlayerCharacter | undefined;
    if (!pc?.traits || !Array.isArray(pc.inventory) || typeof pc.equipped !== "object") {
      return c.json({ error: "a portrait is drawn from a character sheet" }, 400);
    }
    const allowance = await allowanceOf(user);
    if (allowance.closed) throw closed();
    if (!hasPortraitLeft(allowance)) return c.json({ error: portraitRefusal(allowance), allowance }, 429);
    const work = spriteWorker();
    if (!work) return c.json({ error: NOT_SET_UP }, 503);
    try {
      const portrait = await drawPortrait(pc, user.id, allowance.portraitsLimit, work);
      return c.json({ portrait, allowance: await allowanceOf(user) });
    } catch (e) {
      if (e instanceof PortraitRefused) return c.json({ error: e.message, allowance: await allowanceOf(user) }, e.status);
      throw e;
    }
  });

  /**
   * The player's own picture, as multipart form data under `image`. Free and
   * not counted: nothing is paid for.
   */
  app.post("/api/portraits/upload", async (c) => {
    const user = currentUser(c);
    // Refused on the header before the body is read, when the header says.
    if (Number(c.req.header("content-length") ?? 0) > UPLOAD_MAX_BYTES + 64 * 1024) {
      return c.json({ error: `That picture is over ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.` }, 413);
    }
    const form = await c.req.parseBody().catch(() => undefined);
    const file = form?.image;
    if (!(file instanceof File)) return c.json({ error: "no picture came with that" }, 400);
    const work = spriteWorker();
    if (!work) return c.json({ error: NOT_SET_UP }, 503);
    try {
      const portrait = await uploadPortrait(Buffer.from(await file.arrayBuffer()), user.id, work);
      return c.json({ portrait });
    } catch (e) {
      if (e instanceof PortraitRefused) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
}
