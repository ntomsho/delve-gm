/**
 * SMALL FORMATTERS shared by the screen and the game master's prompt, so a
 * bonus reads the same in both.
 */

/** A bonus with its sign, the way a sheet writes one: "+2", "+0", "-1". */
export const signed = (n: number): string => `${n >= 0 ? "+" : ""}${n}`;
