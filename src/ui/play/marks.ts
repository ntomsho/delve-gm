/**
 * THE SHAPES OF THINGS ON THE MAP AND THE PLATE, as SVG path data.
 *
 * A feature's marker is a shape rather than a dot so the player can match the
 * mark on the map to the button on the room's plate at a glance: the same
 * shape, drawn by the same function, in both places. Which shape a feature gets
 * is `MapFixtureView.shape`, assigned in `mapView` by the feature's order in
 * the data. See `FIXTURE_SHAPES`.
 *
 * No React: every function returns a path string centred on (cx, cy), sized so
 * the shape just fits a circle of radius r. A star at the same r as a circle
 * covers less ink, so the shapes are visually close in weight, not equal in area.
 */

import type { FixtureShape } from "../../store/selectors.ts";

const f = (n: number) => +n.toFixed(2);

/** A regular polygon, first point straight up (or `turn` radians round from it). */
function polygon(cx: number, cy: number, r: number, sides: number, turn = 0): string {
  const pts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const a = turn + (i * 2 * Math.PI) / sides - Math.PI / 2;
    pts.push(`${f(cx + r * Math.cos(a))} ${f(cy + r * Math.sin(a))}`);
  }
  return `M ${pts.join(" L ")} Z`;
}

/** The path for a feature's marker. */
export function shapePath(shape: FixtureShape, cx: number, cy: number, r: number): string {
  switch (shape) {
    case "circle":
      return `M ${f(cx - r)} ${f(cy)} a ${f(r)} ${f(r)} 0 1 0 ${f(r * 2)} 0 a ${f(r)} ${f(r)} 0 1 0 ${f(-r * 2)} 0 Z`;
    case "diamond":
      return polygon(cx, cy, r, 4);
    case "triangle":
      // Dropped a little, so its weight sits on the point it marks rather than above it.
      return polygon(cx, cy + r * 0.18, r * 1.1, 3);
    case "square": {
      const s = r * 0.82;
      return `M ${f(cx - s)} ${f(cy - s)} H ${f(cx + s)} V ${f(cy + s)} H ${f(cx - s)} Z`;
    }
    case "star": {
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const a = (i * Math.PI) / 5 - Math.PI / 2;
        const rr = i % 2 === 0 ? r * 1.1 : r * 0.48;
        pts.push(`${f(cx + rr * Math.cos(a))} ${f(cy + rr * Math.sin(a))}`);
      }
      return `M ${pts.join(" L ")} Z`;
    }
    case "hexagon":
      return polygon(cx, cy, r, 6, Math.PI / 6);
  }
}

// ---------------------------------------------------------------------------
// THE PLATE'S DOOR BUTTON, in a 24 x 24 box
// ---------------------------------------------------------------------------

/** An arched doorway: the button every door on a plate is drawn as. */
export const ARCH = "M5 22 V10.5 A7 7 0 0 1 19 10.5 V22 Z";

/** Which way a door leads out of the room, on the map's compass: north is up. */
export type Heading = "n" | "s" | "e" | "w";

/** An arrow pointing north, inside the arch. Turned for the other headings. */
export const ARROW_NORTH = ["M12 19.5 V10", "M8.5 13.5 L12 10 L15.5 13.5"];

/** The way they came in by: a turn back the way they came, inside the arch. */
export const UTURN = ["M14.5 19.5 V13.5 A3 3 0 0 0 8.5 13.5 V15", "M6.5 13.5 L8.5 16 L10.5 13.5"];

/** The way out of the dungeon: somebody walking out through the arch. */
export const WALKER = {
  head: { cx: 12.6, cy: 9.6, r: 1.7 },
  strokes: [
    "M12.2 12.2 L11.2 16.4", // the body, leaning into the stride
    "M11.2 16.4 L13.6 19.8", // the leading leg
    "M11.2 16.4 L8.8 19.6", // the trailing leg
    "M12 13.2 L14.6 15", // the leading arm
    "M12 13.2 L9.6 14.4", // the trailing arm
  ],
};

/** The rotation that turns `ARROW_NORTH` to point at `h`, about the arch's middle. */
export function headingTurn(h: Heading): number {
  return { n: 0, e: 90, s: 180, w: 270 }[h];
}
