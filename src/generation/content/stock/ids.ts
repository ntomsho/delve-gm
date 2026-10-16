/**
 * MOBILE IDS.
 *
 * Mobile ids are derived from the stocking seed and a counter that resets at
 * the top of every stockDungeon() call, so stocking the same seed twice in one
 * process yields the same ids. A bare module-level counter did not: the second
 * run continued from wherever the first stopped, which quietly broke
 * same-seed-twice assertions and any snapshot of a payload carrying mob refs.
 */
let mobilePrefix = "mob";
let mobileCounter = 0;

export function resetMobileIds(seed: number): void {
  mobilePrefix = `mob_${(seed >>> 0).toString(36)}`;
  mobileCounter = 0;
}

export function mobileId(): string {
  return `${mobilePrefix}_${(++mobileCounter).toString(36)}`;
}
