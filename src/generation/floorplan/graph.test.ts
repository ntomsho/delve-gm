import { describe, expect, it } from "vitest";
import { generateBlueprint } from "./graph.ts";

// ===========================================================================
// GRAPH VALIDITY  (the graph's own validator, across a seed spread)
// ===========================================================================

describe("graph generation", () => {
  const chunkCounts = [1, 2, 3, 4, 5];
  const seeds = ["1001", "1002", "1003", "1004", "1005", "7919", "42"];

  it.each(chunkCounts)("produces a valid graph at %i chunk(s) across seeds", (chunks) => {
    for (const seed of seeds) {
      const { dungeon } = generateBlueprint(seed, { chunks }, true);
      expect(dungeon.valid, `seed ${seed} / ${chunks} chunks: ${dungeon.failures.join("; ")}`).toBe(true);
      expect(dungeon.rooms).toHaveLength(chunks * 6);
    }
  });
});
