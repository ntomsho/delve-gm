/**
 * THE GRID
 *
 * The floorplan is drawn on a grid of five-foot cells, and the map, the
 * illustrations and the fixtures all address it the same way. These are the
 * shapes and keys they share.
 */

export interface Point {
  x: number;
  y: number;
}

/** A cell as a Set or Map key: "x,y". */
export const xyKey = (x: number, y: number): string => `${x},${y}`;

/** `xyKey` for a point. */
export const cellKey = (p: Point): string => xyKey(p.x, p.y);

/** Two graph indices as one key, the same whichever way round they are given. */
export const pairKey = (a: number, b: number): string => `${Math.min(a, b)}-${Math.max(a, b)}`;
