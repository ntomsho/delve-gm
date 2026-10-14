/**
 * WHAT COMES BACK UP WITH THEM
 * ============================
 *
 * `carriedOut` is the one function that turns a run's character back into the
 * roster's character, and it is pure — everything around it needs a database and
 * lives in `ownership.dbtest.ts`, but this does not, and the two things it
 * decides are worth asserting where they can be run in a second.
 *
 * IT IS ONLY EVER CALLED ON A SURVIVAL. `commitTurn` guards it with
 * `ending === "escaped" || ending === "goal_met"`, which is what makes death and
 * abandonment forfeit both the gear and the experience without either of those
 * paths having to remember to. The guard is asserted over the database, in
 * `ownership.dbtest.ts`; what is asserted here is what happens once past it.
 */

import { describe, expect, it } from "vitest";
import { carriedOut } from "./repo.ts";
import { testCharacter } from "../../fixtures/offline.ts";

const hurt = () => ({
  ...structuredClone(testCharacter()),
  hp: { current: 2, max: 15 },
});

describe("carrying out", () => {
  // A character who surfaces at 2/15 can only die next time, which quietly turns
  // "escaped alive" into a delayed death. See the long note in `repo.ts` for
  // what would have to land beside this for wounds to carry.
  it("heals them to full", () => {
    expect(carriedOut(hurt()).hp).toEqual({ current: 15, max: 15 });
  });

  it("keeps everything in the pack", () => {
    const pc = hurt();
    expect(carriedOut(pc).inventory).toEqual(pc.inventory);
  });

  it("adds the run's experience to what they already had", () => {
    expect(carriedOut({ ...hurt(), xp: 1200 }, 300).xp).toBe(1500);
  });

  // Every character made before the tally existed has no `xp` at all, and zero
  // and "never scored a run" are the same thing for every purpose there is.
  it("treats a character who has never scored a run as starting from nothing", () => {
    expect(carriedOut(hurt(), 300).xp).toBe(300);
  });

  /*
   * NOTHING EARNED IS STILL A WRITE. A survivor whose tally has not come back —
   * or who got out having answered nothing the place asked — is written with
   * what they had, not left without the field. The alternative is a sheet whose
   * `xp` flickers between absent and present depending on how a run ended.
   */
  it("writes a zero rather than nothing when there was nothing to add", () => {
    expect(carriedOut(hurt()).xp).toBe(0);
    expect(carriedOut({ ...hurt(), xp: 900 }).xp).toBe(900);
  });
});
