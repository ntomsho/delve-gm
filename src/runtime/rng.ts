/**
 * THE RUN RNG
 *
 * Play-time randomness draws from a stream separate from generation, so
 * re-rolling a character cannot shift the dungeon and replaying a run cannot
 * reshape it.
 *
 * `Rng` keeps its state in a private field and exposes no way to read or
 * restore it, so a save can't snapshot mid-stream. What a save *can* record is
 * the seed and how many numbers have been drawn — replaying those draws lands
 * on exactly the same point. Draws are cheap (a few multiplies each), so
 * fast-forwarding thousands of them on load costs nothing measurable.
 *
 * A wrapper rather than a subclass: `Rng`'s own methods reach for its private
 * generator directly, so overriding `next()` would not catch them. Everything
 * that needs seeded randomness at runtime takes the `RollRng` interface —
 * `{ next(): number }` — which both satisfy.
 */

import { Rng } from "../engine/index.ts";
import type { RollRng } from "../engine/index.ts";

export class CountingRng implements RollRng {
  readonly seed: number;
  private inner: Rng;
  private count = 0;

  constructor(seed: number, draws = 0) {
    this.seed = seed;
    this.inner = new Rng(seed);
    this.fastForward(draws);
  }

  /** How many numbers have been drawn. Persist this alongside the seed. */
  get draws(): number {
    return this.count;
  }

  next(): number {
    this.count++;
    return this.inner.next();
  }

  /** Replay `n` draws to reach a saved position. */
  fastForward(n: number): void {
    for (let i = 0; i < n; i++) this.next();
  }

  /** Restore from a persisted `{ seed, draws }` pair. */
  static resume(seed: number, draws: number): CountingRng {
    return new CountingRng(seed, draws);
  }
}
