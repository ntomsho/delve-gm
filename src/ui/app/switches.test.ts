/**
 * The dev switches.
 *
 * Small enough to look obvious and important enough to be wrong once already:
 * `?offline=1` used to leave the referee real, so a page loaded for interface
 * work called the model on room entry and spent tokens nobody had asked to
 * spend. The whole reason `readSwitches` is a function of a string is so that
 * this file can exist.
 */

import { describe, expect, it } from "vitest";
import { readSwitches } from "./switches.ts";

describe("what the URL asks for", () => {
  it("takes nothing at all as the front of the app, with a real dungeon", () => {
    const s = readSwitches("");
    expect(s.bypass).toBe(false);
    expect(s.offline).toBe(false);
    expect(s.stub).toBe(false);
    expect(s.pinnedSeed).toBe(false);
    // The defaults the bypass path falls back on.
    expect(s).toMatchObject({ seed: 1005, size: 2, level: 1 });
  });

  it("means offline by BOTH halves: no generation calls and no turn calls", () => {
    const s = readSwitches("?offline=1");
    expect(s.offline).toBe(true);
    // THE BUG. A fixture dungeon and a real referee is not offline — room entry
    // reaches the model before the player has typed anything.
    expect(s.stub).toBe(true);
    expect(s.bypass).toBe(true);
  });

  it("lets the real referee be asked back for, on a fixture dungeon", () => {
    // The one combination that wants the network without wanting to pay to
    // generate: working on the turn loop against a dungeon that costs nothing.
    const s = readSwitches("?offline=1&stub=0");
    expect(s.offline).toBe(true);
    expect(s.stub).toBe(false);
  });

  it("stubs the referee on a real dungeon when only that is asked for", () => {
    const s = readSwitches("?stub=1");
    expect(s.stub).toBe(true);
    expect(s.offline).toBe(false);
  });

  it("reads the dungeon it was pointed at, and remembers it was pointed", () => {
    const s = readSwitches("?seed=15341&size=3&level=2");
    expect(s).toMatchObject({ seed: 15341, size: 3, level: 2, pinnedSeed: true });
    expect(s.bypass).toBe(true);
  });

  it("counts any switch at all as a reason to skip the front", () => {
    for (const q of ["?seed=1", "?size=1", "?level=1", "?offline=1", "?stub=1"]) {
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
