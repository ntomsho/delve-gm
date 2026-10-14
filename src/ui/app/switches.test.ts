/**
 * The dev switches. `readSwitches` is a function of a string so that this file
 * can exist.
 */

import { describe, expect, it } from "vitest";
import { readSwitches } from "./switches.ts";

describe("what the URL asks for", () => {
  it("takes nothing at all as the front of the app, with a real dungeon", () => {
    const s = readSwitches("");
    expect(s.bypass).toBe(false);
    expect(s.offline).toBe(false);
    expect(s.pinnedSeed).toBe(false);
    // The defaults the bypass path falls back on.
    expect(s).toMatchObject({ seed: 1005, size: 2, level: 1 });
  });

  it("reads offline, which skips the front", () => {
    const s = readSwitches("?offline=1");
    expect(s.offline).toBe(true);
    expect(s.bypass).toBe(true);
  });

  it("reads the dungeon it was pointed at, and remembers it was pointed", () => {
    const s = readSwitches("?seed=15341&size=3&level=2");
    expect(s).toMatchObject({ seed: 15341, size: 3, level: 2, pinnedSeed: true });
    expect(s.bypass).toBe(true);
  });

  it("counts any switch at all as a reason to skip the front", () => {
    for (const q of ["?seed=1", "?size=1", "?level=1", "?offline=1"]) {
      expect(readSwitches(q).bypass).toBe(true);
    }
    // Something else entirely is not one of ours.
    expect(readSwitches("?debug=1").bypass).toBe(false);
  });

  // The preview is not a run, so it must not start one behind itself.
  it("reads the end-of-run preview without counting it as a run switch", () => {
    const s = readSwitches("?endings");
    expect(s.endings).toBe(true);
    expect(s.bypass).toBe(false);
    expect(readSwitches("").endings).toBe(false);
  });
});
