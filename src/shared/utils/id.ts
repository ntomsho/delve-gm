/**
 * IDS
 *
 * Identity, not content: an entity's id says which thing it is and nothing
 * about what it is like, so it does not come from the seeded generator. Two
 * generations of one seed build the same world with different ids.
 */


/** Unique id. Not drawn from the seeded rng — identity, not content. */
export function makeId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
