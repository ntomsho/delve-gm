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
import { MAP_TIP, ThingTooltip, useAnchor, useHover, type HoverCard } from "./hover.tsx";
import { roomVerb, thingVerb, wayVerb, type Verb } from "./verbs.ts";
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
/** How far zoom goes in. Out stops at the whole map. */
const MAX_K = 6;
/**
 * How far a press may wander, in screen pixels, and still be a tap.
 *
 * A finger is never perfectly still, and a tap that registered as a two-pixel
 * drag would select nothing — which on a touch screen is the only way to
 * inspect anything at all.
 */
const TAP_SLOP = 6;

type View = { x: number; y: number; k: number };

/**
 * A screen point in map units, through the svg's own fitting.
 *
 * The viewBox is letterboxed into the box (`xMidYMid meet`), so a box with a
 * different aspect from the drawing has blank bands on two sides — and a pinch
 * that ignored them would drift, the paper sliding out from under the fingers.
 */
function toMap(v: View, w: number, h: number, rect: DOMRect, px: number, py: number) {
  const vw = w / v.k;
  const vh = h / v.k;
  const s = Math.min(rect.width / vw, rect.height / vh);
  const ox = (rect.width - vw * s) / 2;
  const oy = (rect.height - vh * s) / 2;
  return { x: -v.x + (px - rect.left - ox) / s, y: -v.y + (py - rect.top - oy) / s };
}

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
 * WHAT A THING SAYS WHEN POINTED AT, and what a click on it offers — the map's
 * words, shared with the buttons on a room's plate so the two cannot drift.
 */
export function fixtureHover(f: MapFixtureView): [HoverCard, Verb] {
  return [{ title: f.name || "Something", note: f.position, body: f.composed }, thingVerb(f.name)];
}

/** See `fixtureHover`. `reachable`: a way out of the room the player is standing in. */
export function doorHover(c: MapConnectorView, reachable: boolean): [HoverCard, Verb] {
  return [
    {
      title: c.name || (c.surface ? "The way out" : "A way through"),
      note: c.surface
        ? "out of the dungeon — stepping through ends the run"
        : c.blocked
          ? c.requirement
          : undefined,
      body: c.composed,
    },
    wayVerb(c, reachable),
  ];
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
  const lit = useHover().lit === f.id;

  return (
    <g {...anchor(f.id, ...fixtureHover(f))}>
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
// THE HEADER
// ---------------------------------------------------------------------------

/**
 * What this place is called, and how much of it has been seen.
 *
 * The name is the Dungeon Pass's one piece of prose that names the whole
 * dungeon, and until now it was shown once above the opening and then scrolled
 * away for the rest of the run. The map is where a player looks to ask "where
 * am I", so it is where the answer to "where is this" belongs.
 *
 * The count is the only progress signal a dungeon crawl naturally has. It is
 * counted off `known` — the same field the fog is drawn from — so the number and
 * the drawing under it cannot disagree, and it counts every place on the plan,
 * corridors included, because those are rooms you walk into and read a
 * description of like any other.
 *
 * Not part of `DungeonMap`: that component takes a drawing and pans and zooms
 * it, and a header that scrolled out of frame with the paper would be a worse
 * header. They are siblings in the map cell instead.
 */
export function MapHeader({ name, map, compact = false }: { name: string; map: MapView; compact?: boolean }) {
  const explored = map.rooms.filter((r) => r.known).length;

  return (
    <header
      className={`flex shrink-0 items-baseline justify-between gap-3 ${compact ? "px-4 pb-2 pt-3.5" : "mb-2"}`}
    >
      {name && (
        <h2
          className={`truncate font-display font-bold leading-tight text-ink ${compact ? "text-[16px]" : "text-[14px]"}`}
        >
          {name}
        </h2>
      )}
      <span
        className={`shrink-0 font-mono uppercase tracking-[0.16em] text-graphite ${compact ? "text-[10px]" : "text-[9px]"}`}
      >
        {explored}/{map.rooms.length} explored
      </span>
    </header>
  );
}

// ---------------------------------------------------------------------------
// THE MAP
// ---------------------------------------------------------------------------

export interface DungeonMapProps {
  map: MapView;
  className?: string;
  /**
   * `+`, `−` and `FIT` over the top-right corner. For a screen with no wheel —
   * the phone layout asks for them; the desktop grid has a wheel and does not.
   */
  controls?: boolean;
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
export function DungeonMap({ map, className, controls = false }: DungeonMapProps) {
  const rooms = new Map(map.rooms.map((r) => [r.id, r]));
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  // The drag itself is a ref, because it changes on every pointer move and
  // nothing renders from it. Whether a drag is HAPPENING is state, because the
  // cursor renders from it — a grabbing hand for as long as the press is held.
  const [grabbing, setGrabbing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  /** every finger (or the one mouse) currently down, and where it is now */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /**
   * One press in progress. `moved` is whether it has gone past `TAP_SLOP` —
   * until it has, it is a tap in waiting, and it captures nothing.
   */
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  /** two fingers: the map point they started over, how far apart, at what zoom */
  const pinch = useRef<{ at: { x: number; y: number }; d: number; k: number } | null>(null);
  /** the click a finished drag or pinch is about to produce, which must select nothing */
  const swallow = useRef(false);
  const anchor = useAnchor(MAP_TIP);
  const { lit, touch, select } = useHover();

  const { w, h } = map.bounds;
  // Pan is in map units, so a drag moves the paper the same distance under the
  // cursor whatever the zoom.
  const viewBox = `${-view.x} ${-view.y} ${w / view.k} ${h / view.k}`;

  /**
   * Zoom by a factor, pulling `aim` (map units) part of the way to the middle.
   *
   * Kept on the paper. A zoom should never leave the drawing half out of frame;
   * a DRAG still may, because pushing the sheet aside is what a drag is for.
   * That is also what makes zooming all the way out land exactly on the whole
   * map rather than near it.
   */
  function zoom(by: number, aim?: { x: number; y: number }) {
    setView((v) => {
      const k = Math.min(MAX_K, Math.max(1, v.k * by));
      const seen = { w: w / v.k, h: h / v.k }; // the view as it stands
      const next = { w: w / k, h: h / k }; // the view it is becoming
      const centre = { x: -v.x + seen.w / 2, y: -v.y + seen.h / 2 };
      const to = aim ?? centre;
      const corner = (from: number, at: number, span: number, whole: number) =>
        Math.max(0, Math.min(whole - span, from + (at - from) * PULL - span / 2));

      return {
        k,
        x: -corner(centre.x, to.x, next.w, w),
        y: -corner(centre.y, to.y, next.h, h),
      };
    });
  }

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
    // With no laid-out box there is nothing to aim at — before the first
    // layout, and under jsdom — and the middle of the view stands in for it,
    // which makes the zoom centre-preserving.
    const aim =
      rect && rect.width > 0 && rect.height > 0
        ? {
            x: -view.x + ((e.clientX - rect.left) / rect.width) * (w / view.k),
            y: -view.y + ((e.clientY - rect.top) / rect.height) * (h / view.k),
          }
        : undefined;
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, aim);
  }

  /**
   * A PRESS IS A TAP UNTIL IT MOVES.
   *
   * Pointer capture used to start on the press, and while a pointer is captured
   * the browser sends the click that ends it to the CAPTURING element — the svg —
   * not to the marker under it. Now capture waits until the press has travelled
   * `TAP_SLOP`, and a press that never does is left alone to become the click it
   * was. That is the whole of tapping to inspect on a phone, and it should also
   * be *Markers answer a click* in the build plan.
   */
  function onPointerDown(e: React.PointerEvent) {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      // The second finger: whatever the first was doing, this is a pinch now.
      const rect = box.current?.getBoundingClientRect();
      const [a, b] = [...pointers.current.values()];
      drag.current = null;
      swallow.current = true;
      if (rect && rect.width > 0 && rect.height > 0) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        pinch.current = {
          at: toMap(view, w, h, rect, mid.x, mid.y),
          d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          k: view.k,
        };
      }
      return;
    }

    drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y, moved: false };
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = box.current?.getBoundingClientRect();

    const p = pinch.current;
    if (p && pointers.current.size >= 2 && rect && rect.width > 0 && rect.height > 0) {
      const [a, b] = [...pointers.current.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const k = Math.min(MAX_K, Math.max(1, p.k * (Math.hypot(a.x - b.x, a.y - b.y) / p.d)));
      // Keep the map point the fingers started over under where they are now:
      // where the midpoint falls at zero pan, less where it has to be.
      const at = toMap({ x: 0, y: 0, k }, w, h, rect, mid.x, mid.y);
      setView({ k, x: at.x - p.at.x, y: at.y - p.at.y });
      return;
    }

    const d = drag.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < TAP_SLOP) return;
      d.moved = true;
      setGrabbing(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    // Screen pixels back into map units, so the paper tracks the cursor.
    const scale = (w / view.k) / (rect?.width || w);
    setView((v) => ({ ...v, x: d.ox + (e.clientX - d.x) * scale, y: d.oy + (e.clientY - d.y) * scale }));
  }

  function endPointer(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (drag.current?.moved) swallow.current = true;
    if (pointers.current.size < 2) pinch.current = null;
    drag.current = null;
    setGrabbing(false);
  }

  /**
   * After a drag or a pinch, the release's click must not land on whatever
   * happens to be under the finger. Caught on the way down, before it reaches
   * anything, so neither a marker nor the pill's click-to-open ever hears it.
   */
  function onClickCapture(e: React.MouseEvent) {
    if (!swallow.current) return;
    swallow.current = false;
    e.stopPropagation();
    e.preventDefault();
  }

  /** A tap on empty paper puts down whatever was picked up. */
  function onClick(e: React.MouseEvent) {
    if (touch && !(e.target as Element).closest("[data-hover-id]")) select(undefined);
  }

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
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={endPointer}
        onClickCapture={onClickCapture}
        onClick={onClick}
        onDoubleClick={() => setView({ x: 0, y: 0, k: 1 })}
      >
        {/* Rooms first, so doors and markers sit on top of the walls. */}
        {map.rooms.map((r) => {
          // Fog: an unvisited room is blank paper. A MAPPED one is not blank —
          // a region key put it on the chart — but it is not a place the player
          // has been either, so it is drawn hollow: outlined and unfilled, the
          // way a surveyor's plan is against a room somebody has stood in.
          if (!r.known && !r.mapped) return null;
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
              fill={lit === r.id ? color.torchWash : r.mapped ? "none" : color.paper}
              stroke={color.ink}
              strokeWidth={1.4}
              strokeLinejoin="round"
              // Dashed, and dimmer: this is a room they have read about, not one
              // they have seen. `travel.ts` will still refuse to walk them into
              // it, and the drawing should not suggest otherwise.
              strokeDasharray={r.mapped ? "5 4" : undefined}
              opacity={r.mapped ? 0.65 : 1}
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

      {controls && (
        <div className="absolute right-2 top-2 flex flex-col gap-1">
          {[
            { label: "+", name: "Zoom in", go: () => zoom(1.3) },
            { label: "−", name: "Zoom out", go: () => zoom(1 / 1.3) },
            { label: "FIT", name: "Fit the whole map", go: () => setView({ x: 0, y: 0, k: 1 }) },
          ].map((b) => (
            <button
              key={b.label}
              type="button"
              aria-label={b.name}
              onClick={b.go}
              className={`flex h-10 w-10 items-center justify-center border border-rule bg-paper font-mono active:bg-torch-wash ${
                b.label === "FIT" ? "text-[9px] tracking-[0.1em] text-graphite" : "text-[16px] text-ink"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

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
  const { lit: litId, reachable } = useHover();
  const lit = litId === c.id;
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
    <g {...anchor(c.id, ...doorHover(c, reachable.has(c.id)))}>
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
