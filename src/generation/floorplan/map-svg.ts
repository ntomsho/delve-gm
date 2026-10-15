/**
 * A `Layout` as a standalone SVG string, for looking at outside the app.
 *
 * This exists so the drawing you iterate on is the drawing that ships. It
 * consumes the same `Layout` the map component does, so anything wrong with
 * the geometry — a room enclosing the wrong floor, a door off its wall, the
 * way out drawn into another room — is wrong in both, and the shell command is
 * where that gets noticed.
 *
 * It does NOT share styling with `DungeonMap.tsx`, and should not try to: one
 * is line art for a hundred maps at a glance, the other is a panel in a game
 * with fog and hover on it. Geometry is the part that can be wrong.
 *
 * Framework-free, so `cli-generate.ts` can call it under plain node.
 */

import type { Layout, LayoutDoor, Shape } from "./map-layout.ts";
import type { Point } from "../../shared/utils/grid.ts";

// Mirrors `ui/shared/theme.ts`, which this cannot import: that module is the UI's and
// pulls in React types, while this has to run under plain node for the CLI.
const INK = "#22201C";
const PAPER = "#F6F2E8";
/** the ground the dungeon is cut out of — must not match any room fill */
const DESK = "#EDE7DA";
const DOOR_FILL = "#FFFFFF";
const TORCH = "#B4521E";
/** how heavy a wall is drawn; doors are outlined to match */
const WALL = 1.4;
/** how thick a door is across the wall, a little more than the wall stroke */
const DOOR = 3.5;

function outline(shape: Shape): string {
  if (shape.kind === "circle") {
    const { at, r } = shape;
    return `M ${at.x - r} ${at.y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
  }
  const ring = (pts: Point[]) => `M ${pts.map((p) => `${p.x} ${p.y}`).join(" L ")} Z`;
  return [shape.points, ...(shape.holes ?? [])].map(ring).join(" ");
}

/** The door as a rectangle lying along its wall, stopping short of the corners. */
function doorRect(door: LayoutDoor): string {
  const half = door.length / 2;
  const r =
    door.wall === "v"
      ? { x: door.at.x - DOOR / 2, y: door.at.y - half, w: DOOR, h: door.length }
      : { x: door.at.x - half, y: door.at.y - DOOR / 2, w: door.length, h: DOOR };
  return `x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"`;
}

/** A unit vector from the wall toward the far side. */
function outward(door: LayoutDoor): Point {
  const dx = door.through.x - door.at.x;
  const dy = door.through.y - door.at.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

export function layoutSvg(layout: Layout): string {
  const { w, h } = layout.bounds;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
    `<rect width="${w}" height="${h}" fill="${DESK}"/>`,
  ];

  // Every room takes the same fill, corridors included. Tinting a passage to
  // set it apart made it match the ground it is cut out of, which read as a
  // hole in the map rather than as a place.
  for (const room of layout.rooms) {
    out.push(
      `<path d="${outline(room.shape)}" fill-rule="evenodd" fill="${PAPER}" ` +
        `stroke="${INK}" stroke-width="${WALL}" stroke-linejoin="round"/>`
    );
  }

  // White, outlined at the wall's own weight, so a door reads as a leaf set
  // into the wall rather than as a gap left in it.
  for (const c of layout.connectors) {
    if (!c.door) continue;
    out.push(
      `<rect ${doorRect(c.door)} fill="${DOOR_FILL}" stroke="${INK}" stroke-width="${WALL}"/>`
    );
  }

  // Fixtures: plain dots on the floor. Ink rather than torch — they are part of
  // the drawing, not something the game wants the player to reach for. They
  // never collide with a doorway, because placement refuses door cells.
  for (const f of layout.fixtures) {
    for (const p of f.at) {
      out.push(`<circle cx="${p.x}" cy="${p.y}" r="${f.r / 2}" fill="${INK}"/>`);
    }
  }

  // The way out, reaching into blank ground and stopping.
  if (layout.surface) {
    const door = layout.surface.door;
    const n = outward(door);
    const tail = { x: door.at.x + n.x * 15, y: door.at.y + n.y * 15 };
    out.push(
      `<rect ${doorRect(door)} fill="${DOOR_FILL}" stroke="${INK}" stroke-width="${WALL}"/>`,
      `<line x1="${door.at.x}" y1="${door.at.y}" x2="${tail.x}" y2="${tail.y}" stroke="${TORCH}" stroke-width="1.6" stroke-dasharray="3 3"/>`,
      `<circle cx="${tail.x}" cy="${tail.y}" r="2.4" fill="${TORCH}"/>`
    );
  }

  out.push("</svg>");
  return out.join("\n");
}
