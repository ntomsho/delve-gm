/**
 * CHARACTER PORTRAITS: drawing one, or sending the player's own.
 *
 * The browser half of `src/server/routes/portraits.ts`. It decides nothing:
 * the server counts the day's drawings, and a refusal arrives in its words,
 * with the allowance after it so the button can say what is left.
 */

import type { PlayerCharacter, Portrait } from "../rules/knave/character.ts";
import { authedFetch } from "./auth.ts";
import { fetchAllowance, type Allowance } from "./allowance.ts";

/** A refusal, in the server's own sentence, and the allowance when it sent one. */
export class PortraitError extends Error {
  readonly allowance: Allowance | undefined;
  constructor(message: string, allowance?: Allowance) {
    super(message);
    this.allowance = allowance;
  }
}

async function answer<T>(res: Response, what: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; allowance?: Allowance };
  if (!res.ok) throw new PortraitError(body.error ?? `could not ${what} (${res.status})`, body.allowance);
  return body as T;
}

/** What character creation needs for portraits. A prop, so tests hand it a fake. */
export interface PortraitService {
  allowance(): Promise<Allowance>;
  /** About 20 s. One of the day's drawings. */
  draw(pc: PlayerCharacter): Promise<{ portrait: Portrait; allowance: Allowance }>;
  /** Free, and not counted. */
  upload(file: File): Promise<{ portrait: Portrait }>;
}

export const portraitService: PortraitService = {
  allowance: fetchAllowance,
  async draw(pc) {
    return answer(
      await authedFetch("/api/portraits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pc),
      }),
      "draw the portrait"
    );
  },
  async upload(file) {
    const form = new FormData();
    form.set("image", file);
    return answer(await authedFetch("/api/portraits/upload", { method: "POST", body: form }), "upload the picture");
  },
};
