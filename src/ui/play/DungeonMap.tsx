/**
 * The map. SVG, React-rendered, fog of war from what the player has seen.
 *
 * Under the block plan the drawing is a real floorplan: rooms are outlines with
 * walls, and a connector is not a line between two dots but a BREAK IN A WALL.
 * That changes what fog looks like, and for the better — an unvisited room is
 * drawn as nothing, so a door on the far wall of a room they have entered opens
 * onto blank paper. Which is exactly what a map drawn as you explore looks like,
 * rather than a compromise. Concealed ways are absent entirely; `mapView` has
 * already dropped them.
 *
 * The way out of the dungeon is the one door drawn differently: a stub running
 * out into open paper and stopping. Every other door joins two enclosed places;
 * that one goes off the map, and stepping through it ends the run.
 *
 * Shapes come from `Layout` as a discriminated union, so `pointLayout`'s circles
 * and the block plan's polygons render through the same component — which is
 * what the §7 boundary was for.
 */

import { useRef, useState } from "react";
import { color, font } from "../theme.ts";
import {
  pathMidpoint,
  type LayoutDoor,
  type Path,
  type Point,
  type Shape,
} from "../../runtime/layout.ts";
import type { MapConnectorView, MapFixtureView, MapView } from "../../store/selectors.ts";

/** How far a stub reaches toward a room nobody has seen. Point layout only. */
const STUB = 0.34;
/** How heavy a wall is drawn. Doors are outlined to match. */
const WALL = 1.4;
/**
 * How thick a door is across the wall.
 *
 * Wider than the wall stroke, so the door covers the line rather than sitting
 * on it — which is what makes it read as a way through and not as a mark drawn
 * over a solid wall.
 */
const DOOR = 3.5;
/** How far the way out reaches into the blank. */
const OUT = 15;

// ---------------------------------------------------------------------------
// SHAPES
// ---------------------------------------------------------------------------

/**
 * A room outline as one path, filled `evenodd` so an interior hole reads as
 * rock rather than floor. A room grown frontier-by-frontier can close a U on
 * itself, and filling that in would draw floor the player cannot stand on.
 */
function roomPath(shape: Shape): string {
  if (shape.kind === "circle") {
    const { at, r } = shape;
    return `M ${at.x - r} ${at.y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
  }
  const ring = (pts: Point[]) => `M ${pts.map((p) => `${p.x} ${p.y}`).join(" L ")} Z`;
  return [shape.points, ...(shape.holes ?? [])].map(ring).join(" ");
}

function ends(path: Path) {
  if (path.kind === "line") return { a: path.from, b: path.to };
  const pts = path.points;
  return { a: pts[0], b: pts[pts.length - 1] };
}

/**
 * The door itself: a rectangle lying along the wall, three quarters of its
 * length, a little thicker than the wall line.
 *
 * It stops short of the corners at either end on purpose. A door that ran the
 * full span would meet the perpendicular walls and read as a missing wall
 * rather than as a way through.
 */
function doorRect(door: LayoutDoor) {
  const half = door.length / 2;
  return door.wall === "v"
    ? { x: door.at.x - DOOR / 2, y: door.at.y - half, width: DOOR, height: door.length }
    : { x: door.at.x - half, y: door.at.y - DOOR / 2, width: door.length, height: DOOR };
}

/**
 * What is standing in the room, as plain dots on their own layer.
 *
 * MARKERS ARE DOTS FOR NOW — author's call, with a library of line art deferred.
 * The data is stored as cells and a kind rather than as a picture, so replacing
 * this function is the whole of that change; nothing has to be regenerated.
 *
 * One entity, however many cells: a colonnade is six dots that hover as "the
 * pillars", because that is what the player would point at. So the hit area is
 * per dot and the tooltip is per entity.
 *
 * Drawn in graphite rather than ink, so a room's contents sit UNDER its walls in
 * the eye's reading order. Torch is reserved for what the game wants the player
 * to reach for, and a bench is not that.
 */
function Fixture({
  f,
  onHover,
}: {
  f: MapFixtureView;
  onHover(e: React.MouseEvent, h: Omit<Hover, "x" | "y">): void;
}) {
  return (
    <g
      onMouseMove={(e) =>
        onHover(e, { title: f.name || "Something", body: f.composed, note: f.position })
      }
    >
      {f.at.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={f.r / 2}
          fill={color.graphite}
          // A dot is three units across and a cursor is not that accurate, so
          // the mark and the thing you can point at are drawn at two sizes.
          stroke="transparent"
          strokeWidth={f.r * 1.6}
        />
      ))}
    </g>
  );
}

/** A unit vector from the wall toward the far side. */
function outward(at: Point, through: Point): Point {
  const dx = through.x - at.x;
  const dy = through.y - at.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

// ---------------------------------------------------------------------------
// HOVER
// ---------------------------------------------------------------------------

interface Hover {
  title: string;
  body?: string;
  note?: string;
  /** in client coordinates — the tooltip is HTML over the SVG, not in it */
  x: number;
  y: number;
}

/**
 * The hover, as HTML rather than an SVG `<title>`.
 *
 * `composed` is a paragraph. A native tooltip renders it in the system font at
 * the system width after a half-second delay, which for the one piece of prose
 * the player most often wants to re-read is the wrong instrument.
 */
function Tooltip({ hover }: { hover: Hover }) {
  return (
    <div
      className="pointer-events-none absolute z-10 max-w-[260px] rounded-sm border px-2.5 py-2 shadow-sm"
      style={{
        left: hover.x + 14,
        top: hover.y + 14,
        background: color.paper,
        borderColor: color.rule,
      }}
    >
      <div
        className="text-[12px] font-bold leading-tight"
        style={{ fontFamily: font.display, color: color.ink }}
      >
        {hover.title}
      </div>
      {hover.note && (
        <div
          className="mt-0.5 text-[9px] uppercase tracking-[0.14em]"
          style={{ fontFamily: font.mono, color: color.torchDeep }}
        >
          {hover.note}
        </div>
      )}
      {hover.body && (
        <p
          className="mt-1.5 text-[12px] leading-snug"
          style={{ fontFamily: font.prose, color: color.graphite }}
        >
          {hover.body}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE MAP
// ---------------------------------------------------------------------------

export interface DungeonMapProps {
  map: MapView;
  className?: string;
  /**
   * A door in the room the player is standing in was clicked. Travel is
   * dispatched through the ordinary turn path, so it has to be confirmed
   * first — see `TravelConfirm`. Absent means the map is read-only.
   */
  onDoorClick?(connectorId: string): void;
  /** which connector ids may be clicked — the current room's ways out */
  travelable?: ReadonlySet<string>;
}

export function DungeonMap({ map, className, onDoorClick, travelable }: DungeonMapProps) {
  const rooms = new Map(map.rooms.map((r) => [r.id, r]));
  const [hover, setHover] = useState<Hover>();
  const [view, setView] = useState<{ x: number; y: number; k: number }>({ x: 0, y: 0, k: 1 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number }>(null);

  const { w, h } = map.bounds;
  // Pan is in map units, so a drag moves the paper the same distance under the
  // cursor whatever the zoom.
  const viewBox = `${-view.x} ${-view.y} ${w / view.k} ${h / view.k}`;

  const place = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = box.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const show = (e: React.MouseEvent, h: Omit<Hover, "x" | "y">) =>
    setHover({ ...h, ...place(e) });

  function onWheel(e: React.WheelEvent) {
    const k = Math.min(6, Math.max(1, view.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    setView((v) => ({ ...v, k }));
  }

  function onPointerDown(e: React.PointerEvent) {
    drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const r = box.current?.getBoundingClientRect();
    // Screen pixels back into map units, so the paper tracks the cursor.
    const scale = (w / view.k) / (r?.width || w);
    setView((v) => ({ ...v, x: d.ox + (e.clientX - d.x) * scale, y: d.oy + (e.clientY - d.y) * scale }));
  }

  const endDrag = () => {
    drag.current = null;
  };

  return (
    <div ref={box} className={`relative ${className ?? ""}`}>
      <svg
        viewBox={viewBox}
        className="h-full w-full touch-none select-none"
        role="img"
        aria-label="Map of the parts of the dungeon you have seen"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={() => {
          endDrag();
          setHover(undefined);
        }}
        onDoubleClick={() => setView({ x: 0, y: 0, k: 1 })}
      >
        {/* Rooms first, so doors and markers sit on top of the walls. */}
        {map.rooms.map((r) => {
          if (!r.known) return null; // fog: an unvisited room is blank paper
          return (
            <path
              key={r.id}
              d={roomPath(r.shape)}
              fillRule="evenodd"
              // A corridor is filled like anything else. It was tinted `panel`
              // to read as a passage, which against a `paper` ground made it
              // look unfilled — a hole in the map rather than a place. What a
              // corridor is comes across through its shape and its prose; the
              // flag stays on `LayoutRoom` for 6c.
              fill={color.paper}
              stroke={color.ink}
              strokeWidth={1.4}
              strokeLinejoin="round"
              onMouseMove={(e) =>
                show(e, {
                  title: r.name ?? "Somewhere",
                  body: r.composed,
                  note: r.current ? "you are here" : undefined,
                })
              }
            />
          );
        })}

        {/* Contents next: over the floor, under the doors and the marker. What
            reaches this list has already passed `mapView`'s four tests — it is
            in a room the player has seen, it is not concealed, and it has been
            described to them. Nothing here re-checks that, because a second
            filter is a second place for the rule to be wrong. */}
        {map.fixtures.map((f) => (
          <Fixture key={f.id} f={f} onHover={show} />
        ))}

        {map.connectors.map((c) =>
          c.door ? (
            <Door
              key={c.id}
              c={c}
              knownFrom={rooms.get(c.from)?.known === true}
              clickable={travelable?.has(c.id) === true && onDoorClick !== undefined}
              onPick={() => onDoorClick?.(c.id)}
              onHover={show}
            />
          ) : (
            <Link key={c.id} c={c} fromKnown={rooms.get(c.from)?.known === true} />
          )
        )}

        {/* Where the player is standing. */}
        {map.rooms
          .filter((r) => r.current && r.known)
          .map((r) => (
            <circle
              key={`${r.id}-you`}
              cx={r.centre.x}
              cy={r.centre.y}
              r={4}
              fill={color.torch}
              style={{ animation: "pulse 2.4s ease-in-out infinite" }}
            />
          ))}
      </svg>

      {hover && <Tooltip hover={hover} />}
    </div>
  );
}

/**
 * A door: a gap cut in the wall, with a jamb at each side.
 *
 * The wall is drawn twice, once by each room, so opening the doorway means
 * covering that stretch in the paper colour rather than not drawing it. A
 * blocked way keeps its wall and gets a bar across it — the player can see
 * there is a way and see that it is shut, which is the planning information
 * the room card is also giving them.
 */
function Door({
  c,
  knownFrom,
  clickable,
  onPick,
  onHover,
}: {
  c: MapConnectorView;
  knownFrom: boolean;
  clickable: boolean;
  onPick(): void;
  onHover(e: React.MouseEvent, h: Omit<Hover, "x" | "y">): void;
}) {
  if (!c.known) return null;
  const door = c.door!;
  const rect = doorRect(door);
  const n = outward(door.at, door.through);

  // The way out reaches into blank paper and stops. It is the only door on the
  // map with nothing on its far side, and it should look like it.
  const tail = c.surface
    ? { x: door.at.x + n.x * OUT, y: door.at.y + n.y * OUT }
    : undefined;

  return (
    <g
      onMouseMove={(e) =>
        onHover(e, {
          title: c.name || (c.surface ? "The way out" : "A way through"),
          body: c.composed,
          note: c.surface
            ? "out of the dungeon — stepping through ends the run"
            : c.blocked
              ? c.requirement
              : clickable
                ? "click to go through"
                : undefined,
        })
      }
      style={{ cursor: clickable ? "pointer" : "default" }}
      onClick={clickable ? onPick : undefined}
    >
      {/* The door: white, outlined at the same weight as the wall it interrupts,
          so it reads as a leaf set into the wall rather than as a gap. A blocked
          one takes the same outline in torch — the way is there and it is shut,
          which is the planning information the room card is also giving them. */}
      <rect
        {...rect}
        fill={color.door}
        stroke={c.blocked ? color.torch : color.ink}
        strokeWidth={WALL}
      />

      {tail && (
        <>
          <line
            x1={door.at.x}
            y1={door.at.y}
            x2={tail.x}
            y2={tail.y}
            stroke={color.torchDeep}
            strokeWidth={1.6}
            strokeDasharray="3 3"
          />
          <circle cx={tail.x} cy={tail.y} r={2.4} fill={color.torchDeep} />
        </>
      )}

      {/* A generous, invisible hit area. A doorway is ten units across and a
          cursor is not that accurate. */}
      {clickable && (
        <circle cx={door.at.x} cy={door.at.y} r={9} fill="transparent" />
      )}
    </g>
  );
}

/**
 * A connector with no walls to cut — `pointLayout`'s straight line between two
 * dots. Kept because the floorplan is still allowed to be missing: a saved run
 * from before the block plan existed comes back without one, and a dungeon with
 * no drawing is completely playable.
 */
function Link({ c, fromKnown }: { c: MapConnectorView; fromKnown: boolean }) {
  if (!c.known) return null;
  const { a, b } = ends(c.path);
  const [start, end] = fromKnown ? [a, b] : [b, a];
  const to = c.toUnknown
    ? { x: start.x + (end.x - start.x) * STUB, y: start.y + (end.y - start.y) * STUB }
    : end;

  return (
    <g>
      <line
        x1={start.x}
        y1={start.y}
        x2={to.x}
        y2={to.y}
        stroke={c.blocked ? color.torch : color.graphite}
        strokeWidth={c.interChunk ? 2.2 : 1.4}
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
}
