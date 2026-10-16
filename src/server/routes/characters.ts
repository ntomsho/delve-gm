/**
 * CHARACTERS: the roster, and saving or deleting a sheet. A character still
 * down in a run can be neither edited nor deleted from up here.
 */

import type { Hono } from "hono";
import { currentUser, type AuthEnv } from "../auth.ts";
import type { PlayerCharacter } from "../../rules/knave/character.ts";
import * as repo from "../db/repo.ts";

export function characterRoutes(app: Hono<AuthEnv>): void {
  /**
   * The roster: who the player has, what has happened to them, and where they
   * are. Was `PlayerCharacter[]`; a sheet alone can no longer answer the
   * question the screen asks, which is whether this person can be sent anywhere.
   */
  app.get("/api/characters", async (c) => c.json(await repo.listRoster(currentUser(c).id)));

  /**
   * Save a sheet — a new character, or one that has been to the market.
   *
   * EDITING SOMEBODY WHO IS STILL DOWN THERE IS REFUSED, the same way deleting
   * them is and for a neighbouring reason. A run plays from its own copy of the
   * sheet and writes what survives back when it ends, so a write from up here
   * would either be overwritten without warning or overwrite the run's own
   * result. The shop is the only caller that can reach this with an existing
   * character and it does not offer the button to anyone in a run; this is the
   * rule rather than the manners.
   */
  app.post("/api/characters", async (c) => {
    const user = currentUser(c);
    const pc = (await c.req.json()) as PlayerCharacter;
    const active = await repo.activeRunFor(pc.id, user.id);
    if (active) {
      return c.json(
        { error: "that character is in a run — what they are carrying is the run's now", runId: active.id },
        409
      );
    }
    return c.json(await repo.saveCharacter(pc, user.id));
  });

  /**
   * Deleting somebody who is still down there is refused.
   *
   * The foreign key is `on delete set null`, so this would otherwise succeed and
   * leave an active run belonging to nobody: a save file with no way to reach it
   * and no way to end it, holding a lock against a character that no longer
   * exists. Abandon first — that is what the verb is for.
   */
  app.delete("/api/characters/:id", async (c) => {
    const user = currentUser(c);
    const id = c.req.param("id");
    const active = await repo.activeRunFor(id, user.id);
    if (active) {
      // JSON rather than an `HTTPException`, and for the same reason the stale
      // and busy refusals below are: Hono renders a thrown exception as a plain
      // text body, and this message is one the interface has to put in front of
      // the player. `runId` is there so it can offer the run rather than only
      // mention it.
      return c.json(
        { error: "that character is in a run — abandon it first", runId: active.id },
        409
      );
    }
    return c.json({ deleted: await repo.deleteCharacter(id, user.id) });
  });
}
