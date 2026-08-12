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
import { MAP_TIP, ThingTooltip, useAnchor, useHover } from "./hover.tsx";
import { roomVerb, thingVerb, wayVerb } from "./verbs.ts";
import { color } from "../theme.ts";
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
/** How much of the way toward the cursor one wheel click takes the view. */
const PULL = 0.5;

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
 * to reach for, and a bench is not that — EXCEPT while the player is pointing at
 * its row in the room card, which is the one moment the game does want them to
 * find it. All six dots light at once, because the six dots are one thing.
 */
function Fixture({ f }: { f: MapFixtureView }) {
  const anchor = useAnchor(MAP_TIP);
  const lit = useHover().hovered === f.id;

  return (
    <g
      {...anchor(
        f.id,
        { title: f.name || "Something", note: f.position, body: f.composed },
        thingVerb(f.name)
      )}
    >
      {f.at.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={lit ? f.r * 0.85 : f.r / 2}
          fill={lit ? color.torch : color.graphite}
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
// THE MAP
// ---------------------------------------------------------------------------

export interface DungeonMapProps {
  map: MapView;
  className?: string;
}

/**
 * WHAT A CLICK DOES lives in `verbs.ts` and `hover.tsx`, not here.
 *
 * Every drawn thing carries the one question it offers, and the pill that raises
 * it is mounted once by `PlayScreen` for both panels. The map used to own a
 * travel callback and the set of doors it applied to; both are now facts about
 * the game that the hover context carries, so this component takes a drawing and
 * nothing else.
 */
export function DungeonMap({ map, className }: DungeonMapProps) {
  const rooms = new Map(map.rooms.map((r) => [r.id, r]));
  const [view, setView] = useState<{ x: number; y: number; k: number }>({ x: 0, y: 0, k: 1 });
  // The drag itself is a ref, because it changes on every pointer move and
  // nothing renders from it. Whether a drag is HAPPENING is state, because the
  // cursor renders from it — a grabbing hand for as long as the press is held.
  const [grabbing, setGrabbing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number }>(null);
  const anchor = useAnchor(MAP_TIP);
  const { hovered } = useHover();

  const { w, h } = map.bounds;
  // Pan is in map units, so a drag moves the paper the same distance under the
  // cursor whatever the zoom.
  const viewBox = `${-view.x} ${-view.y} ${w / view.k} ${h / view.k}`;

  /**
   * A wheel zooms, and moves what you are pointing at toward the middle.
   *
   * It used to leave the view's top-left corner pinned, so zooming in walked
   * off toward the corner and whatever you were looking at slid out of frame.
   * The cursor is the only statement of intent available here — you point at
   * the room you want a closer look at — so each step takes the view half the
   * way from where it is centred to what is under the pointer. Half rather than
   * all of it: one wheel click should not throw the map across the panel, and
   * two or three clicks put the room in the middle, which is what was asked for.
   */
  function onWheel(e: React.WheelEvent) {
    const rect = box.current?.getBoundingClientRect();
    const { clientX, clientY, deltaY } = e;

    setView((v) => {
      const k = Math.min(6, Math.max(1, v.k * (deltaY < 0 ? 1.15 : 1 / 1.15)));
      const seen = { w: w / v.k, h: h / v.k }; // the view as it stands
      const next = { w: w / k, h: h / k }; // the view it is becoming
      const centre = { x: -v.x + seen.w / 2, y: -v.y + seen.h / 2 };

      // The cursor in map units. With no laid-out box there is nothing to aim
      // at — before the first layout, and under jsdom — and the middle of the
      // view stands in for it, which makes the zoom centre-preserving.
      const aim =
        rect && rect.width > 0 && rect.height > 0
          ? {
              x: -v.x + ((clientX - rect.left) / rect.width) * seen.w,
              y: -v.y + ((clientY - rect.top) / rect.height) * seen.h,
            }
          : centre;

      // Kept on the paper. A zoom should never leave the drawing half out of
      // frame; a DRAG still may, because pushing the sheet aside is what a drag
      // is for. That is also what makes zooming all the way out land exactly on
      // the whole map rather than near it.
      const corner = (from: number, to: number, span: number, whole: number) =>
        Math.max(0, Math.min(whole - span, from + (to - from) * PULL - span / 2));

      return {
        k,
        x: -corner(centre.x, aim.x, next.w, w),
        y: -corner(centre.y, aim.y, next.h, h),
      };
    });
  }

  function onPointerDown(e: React.PointerEvent) {
    drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
    setGrabbing(true);
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
    setGrabbing(false);
  };

  return (
    // The map is paper you push around, so it says so at rest and while it is
    // being pushed. `data-dragging` is what lets the drag beat the markers'
    // pointer — see the two rules in `index.css`.
    <div
      ref={box}
      data-dragging={grabbing ? "" : undefined}
      className={`relative ${grabbing ? "cursor-grabbing" : "cursor-grab"} ${className ?? ""}`}
    >
      <svg
        viewBox={viewBox}
        className="h-full w-full touch-none select-none"
        role="img"
        aria-label="Map of the parts of the dungeon you have seen"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
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
              //
              // A wash rather than a fill while it is being pointed at: the
              // room is the biggest thing on the map and turning it torch would
              // drown out every marker standing in it.
              fill={hovered === r.id ? color.torchWash : color.paper}
              stroke={color.ink}
              strokeWidth={1.4}
              strokeLinejoin="round"
              {...anchor(
                r.id,
                {
                  title: r.name ?? "Somewhere",
                  note: r.current ? "you are here" : undefined,
                  body: r.composed,
                },
                roomVerb(r)
              )}
            />
          );
        })}

        {/* Contents next: over the floor, under the doors and the marker. What
            reaches this list has already passed `mapView`'s four tests — it is
            in a room the player has seen, it is not concealed, and it has been
            described to them. Nothing here re-checks that, because a second
            filter is a second place for the rule to be wrong. */}
        {map.fixtures.map((f) => (
          <Fixture key={f.id} f={f} />
        ))}

        {map.connectors.map((c) =>
          c.door ? (
            <Door key={c.id} c={c} />
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

      {/* Portalled to the document, so it is not clipped by this box nor
          overpainted by the panel below it. See `hover.tsx`. */}
      <ThingTooltip id={MAP_TIP} float />
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
function Door({ c }: { c: MapConnectorView }) {
  const anchor = useAnchor(MAP_TIP);
  const { hovered, reachable } = useHover();
  const lit = hovered === c.id;
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
    // No cursor and no click handler of its own. Every door has a hover card and
    // so takes the pointer from `[data-hover-id]`, and what a click offers is on
    // the element as an attribute — see `ActionPill`.
    <g
      {...anchor(
        c.id,
        {
          title: c.name || (c.surface ? "The way out" : "A way through"),
          note: c.surface
            ? "out of the dungeon — stepping through ends the run"
            : c.blocked
              ? c.requirement
              : undefined,
          body: c.composed,
        },
        wayVerb(c, reachable.has(c.id))
      )}
    >
      {/* The door: white, outlined at the same weight as the wall it interrupts,
          so it reads as a leaf set into the wall rather than as a gap. A blocked
          one takes the same outline in torch — the way is there and it is shut,
          which is the planning information the room card is also giving them. */}
      <rect
        {...rect}
        fill={color.door}
        stroke={c.blocked || lit ? color.torch : color.ink}
        // Heavier while pointed at, since a door is already outlined in torch
        // when it is blocked and colour alone would say nothing new there.
        strokeWidth={lit ? WALL * 2 : WALL}
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
          cursor is not that accurate. On every door now, not only the ones that
          travel: a door across the map still hovers and still offers Examine. */}
      <circle cx={door.at.x} cy={door.at.y} r={9} fill="transparent" />
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
