import type { RoomPlate } from "../../illustrations/room-illustration.ts";

const INK = "#22201C";
const TORCH = "#B4521E";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The page's buttons as SVG marks over a plate W x H: what the final image
 * would carry. Solid: shown. Orange: the way in. Dashed: behind a wall. A
 * curved arrow: the corner to go round. Edge arrows: off the frame.
 *
 * Dev only — the real page will draw its own controls from the same
 * `hotspots`. Shared by the plate-views and illustrate contact sheets.
 */
export function hotspotMarks(p: RoomPlate, W: number, H: number): string {
  const name = (id: string) =>
    [...p.exits, p.entry, ...p.features].find((x) => x.id === id)?.name || "the way in";
  const short = (t: string) => esc(t.length > 16 ? t.slice(0, 15) + "…" : t);
  const label = (x: number, y: number, t: string, colour = INK) =>
    `<text x="${x}" y="${y}" font-family="sans-serif" font-size="10" fill="${colour}" stroke="#fff" stroke-width="3" paint-order="stroke" text-anchor="middle">${short(t)}</text>`;
  const marks: string[] = [];
  const edges: Record<string, number> = { left: 0, right: 0, bottom: 0 };
  for (const h of p.hotspots) {
    const colour = h.role === "entry" ? TORCH : "#1E5BB4";
    const title = h.role === "entry" ? `in: ${name(h.id)}` : name(h.id);
    if (h.status === "shown") {
      for (const q of h.points) {
        const x = q.x * W, y = q.y * H;
        marks.push(`<circle cx="${x}" cy="${y}" r="8" fill="${colour}" fill-opacity="0.85"/>`, label(x, y - 12, title, colour));
      }
      continue;
    }
    for (const q of h.points) {
      const x = q.x * W, y = q.y * H;
      marks.push(`<circle cx="${x}" cy="${y}" r="8" fill="none" stroke="${colour}" stroke-width="1.6" stroke-dasharray="3 2"/>`, label(x, y - 12, title, colour));
    }
    if (h.around) {
      const x = h.around.x * W, y = h.around.y * H;
      marks.push(
        `<circle cx="${x}" cy="${y}" r="11" fill="#fff" stroke="${colour}" stroke-width="1.6"/>`,
        `<text x="${x}" y="${y + 6}" font-family="sans-serif" font-size="17" font-weight="700" fill="${colour}" text-anchor="middle">${h.around.turn === "left" ? "↰" : "↱"}</text>`,
        label(x, y + 24, title, colour)
      );
    }
    if (h.edge) {
      const n = edges[h.edge]++;
      if (h.edge === "bottom") {
        const x = W / 2 + (n - 0.5) * 90 + 45, y = H - 8;
        marks.push(`<polygon points="${x - 9},${y - 10} ${x + 9},${y - 10} ${x},${y}" fill="${colour}"/>`, label(x, y - 14, title, colour));
      } else {
        const x = h.edge === "left" ? 4 : W - 4, y = H / 2 + n * 34 - 20;
        const back = h.edge === "left" ? x + 10 : x - 10;
        marks.push(
          `<polygon points="${x},${y} ${back},${y - 9} ${back},${y + 9}" fill="${colour}"/>`,
          label(h.edge === "left" ? x + 48 : x - 48, y + 4, title, colour)
        );
      }
    }
  }
  return marks.join("\n");
}

