/**
 * The map. SVG, React-rendered, fog of war from what the player has seen.
 *
 * An unvisited room is drawn as nothing at all. A way out of a visited room
 * into the dark is drawn as a STUB — a short line that stops in open space —
 * because the player knows a passage leads off there without knowing where it
 * goes. Concealed ways are absent entirely; `mapView` has already dropped them.
 *
 * Shapes come from `Layout` as a discriminated union, so a later geometry pass
 * that emits real room outlines replaces `pointLayout` and leaves this alone.
 */

import { color } from "../theme.ts";
import { pathMidpoint, shapeCenter, type Path, type Shape } from "../../runtime/layout.ts";
import type { MapView } from "../../store/selectors.ts";

/** How far a stub reaches toward a room nobody has seen. */
const STUB = 0.34;

function shapePath(shape: Shape): React.ReactNode {
  if (shape.kind === "circle") {
    return <circle cx={shape.at.x} cy={shape.at.y} r={shape.r} />;
  }
  return <polygon points={shape.points.map((p) => `${p.x},${p.y}`).join(" ")} />;
}

function ends(path: Path) {
  if (path.kind === "line") return { a: path.from, b: path.to };
  const pts = path.points;
  return { a: pts[0], b: pts[pts.length - 1] };
}

export function DungeonMap({ map, className }: { map: MapView; className?: string }) {
  const rooms = new Map(map.rooms.map((r) => [r.id, r]));

  return (
    <svg
      viewBox={`0 0 ${map.bounds.w} ${map.bounds.h}`}
      className={className}
      role="img"
      aria-label="Map of the parts of the dungeon you have seen"
    >
      {map.connectors.map((c) => {
        if (!c.known) return null; // neither end seen — not on the map at all
        const { a, b } = ends(c.path);
        const fromKnown = rooms.get(c.from)?.known === true;

        // A stub runs from the room the player HAS seen toward the one they
        // have not, and stops short.
        const [start, end] = fromKnown ? [a, b] : [b, a];
        const to = c.toUnknown
          ? { x: start.x + (end.x - start.x) * STUB, y: start.y + (end.y - start.y) * STUB }
          : end;

        return (
          <g key={c.id}>
            <line
              x1={start.x}
              y1={start.y}
              x2={to.x}
              y2={to.y}
              stroke={c.blocked ? color.torch : color.graphite}
              strokeWidth={c.interChunk ? 2.2 : 1.4}
              // A blocked way is drawn broken; an inferred one fades out by
              // being thinner and stopping in open space.
              strokeDasharray={c.blocked ? "4 3" : undefined}
              opacity={c.toUnknown ? 0.5 : 1}
            />
            {c.blocked && !c.toUnknown && (
              <circle
                cx={pathMidpoint(c.path).x}
                cy={pathMidpoint(c.path).y}
                r={2.6}
                fill={color.torch}
              >
                <title>{c.requirement}</title>
              </circle>
            )}
          </g>
        );
      })}

      {map.rooms.map((r) => {
        if (!r.known) return null; // fog: an unvisited room is blank space
        return (
          <g key={r.id} fill={r.current ? color.ink : color.paper} stroke={color.ink} strokeWidth={1.4}>
            {shapePath(r.shape)}
            {r.name && <title>{r.name}</title>}
          </g>
        );
      })}

      {/* Where the player is standing. */}
      {map.rooms
        .filter((r) => r.current && r.known)
        .map((r) => {
          const at = shapeCenter(r.shape);
          return (
            <circle
              key={`${r.id}-you`}
              cx={at.x}
              cy={at.y}
              r={5}
              fill={color.torch}
              style={{ animation: "pulse 2.4s ease-in-out infinite" }}
            />
          );
        })}
    </svg>
  );
}
