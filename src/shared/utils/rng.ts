/**
 * SEEDED RANDOMNESS
 * =================
 *
 * Every random number in the game comes from a seed, so the same seed builds
 * the same dungeon and a replayed run rolls the same dice. The model never
 * generates a number (CLAUDE.md); this file is where they come from instead.
 *
 * `Rng` is the generator: mulberry32, a small fast 32-bit PRNG. Generation uses
 * it directly. Play uses `CountingRng`, below, which wraps it so a save can
 * record its position.
 */

/** Anything that yields a float in [0,1). `Rng` satisfies it, as does CountingRng. */
export interface RollRng {
  next(): number;
}

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private f: () => number;
  readonly seed: number;
  constructor(seed: number) {
    this.seed = seed;
    this.f = mulberry32(seed);
  }
  next(): number {
    return this.f();
  }
  /** 1..n inclusive */
  d(n: number): number {
    return Math.floor(this.f() * n) + 1;
  }
  /** inclusive range */
  range(lo: number, hi: number): number {
    return lo + Math.floor(this.f() * (hi - lo + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.f() * arr.length)];
  }
  /** n distinct picks */
  pickN<T>(arr: readonly T[], n: number): T[] {
    const pool = [...arr];
    const out: T[] = [];
    while (out.length < n && pool.length) {
      out.push(pool.splice(Math.floor(this.f() * pool.length), 1)[0]);
    }
    return out;
  }
  chance(p: number): boolean {
    return this.f() < p;
  }
  coin(): boolean {
    return this.f() < 0.5;
  }
}

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
