/**
 * A ROOM'S ILLUSTRATION, at its first arrival — the module booklet held up.
 *
 * The space is held at 3:2 from the moment the arrival is on the page, with a
 * faint pencil frame, so an illustration landing a few seconds later fills it rather
 * than shoving the text being read. It closes only when there will be no illustration.
 *
 * DRAWN AS INK, NOT SHOWN AS A PHOTOGRAPH. The server stores black on
 * transparent, and the page uses it as a mask over its own ink colour: the
 * lines are exactly the text's ink, the paper is the page's paper, and there is
 * no box edge. A click opens it full size.
 *
 * THE BUTTONS. A room's illustration carries a button at each place the guide image
 * put a tag: every doorway and object the image model was told to draw. A door
 * is an arched doorway with an arrow for which way it leads on the map; a
 * feature carries its map mark, the same shape. Each is the same control as the map's
 * marker for that thing: the same hover card, the same question on a click, and
 * the same `lit` id, so pointing at a button lights the map and the room card
 * and pointing at either lights the button. A thing the map does not show yet
 * gets no button, so the illustration is fogged exactly as the map is.
 *
 * A door or object out of the picture keeps its button, saying which way to
 * go: at the corner to go round, with a bent arrow; dashed, where it stands
 * behind a wall; or in a rail inside the edge it is off, chevron pointing out.
 *
 * THE FIGURES. The illustration of the room they are standing in has its creatures
 * stood in it, each a sprite laid down in two coats: the page's paper where the
 * figure is, hiding the illustration behind it, then the page's ink. Where each stands
 * is worked out from the run as it is now (`roomFigures`), so a creature slain
 * is gone at once. An illustration they have walked out of keeps the figures it last
 * showed: the scrollback is a record of what was there.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { IllustrationAnswer, IllustrationSpot } from "../../illustrations/room-illustration.ts";
import type { SpriteAnswer } from "../../illustrations/sprites.ts";
import type { Shape } from "../../generation/floorplan/map-layout.ts";
import { figureHeight, type IllustrationFigure } from "../../illustrations/figures.ts";
import type { HotspotEdge } from "../../illustrations/hotspots.ts";
import type { MapView } from "../../gameplay/view/selectors.ts";
import type { FixtureShape } from "../../gameplay/view/selectors.ts";
import { doorHover, fixtureHover, grows } from "./DungeonMap.tsx";
import { ARCH, ARROW_NORTH, headingTurn, shapePath, UTURN, WALKER, type Heading } from "./marks.ts";
import { color } from "../shared/theme.ts";
import { ILLUSTRATION_TIP, useAnchor, useHover, type HoverCard } from "./hover.tsx";
import type { Verb } from "./verbs.ts";

/** How long between asks while somebody else's request is drawing it. */
const ILLUSTRATION_POLL_MS = 4000;
/** Asks before giving up on a pending illustration: past the server's stale-claim timeout. */
const ILLUSTRATION_POLL_TRIES = 50;

/**
 * A stored illustration or cover laid down as ink: the page's ink colour, masked by
 * the picture. No box, no paper of its own. `className` sets the size.
 */
export function Ink({ url, className = "", label }: { url: string; className?: string; label?: string }) {
  return <div className={className} style={inkStyle(url)} {...(label ? { role: "img", "aria-label": label } : {})} />;
}

function inkStyle(url: string) {
  return {
    backgroundColor: "var(--color-ink)",
    maskImage: `url("${url}")`,
    WebkitMaskImage: `url("${url}")`,
    maskSize: "contain",
    WebkitMaskSize: "contain",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskPosition: "center",
  };
}

type Pt = { x: number; y: number };

/** Inside a polygon ring, by crossings. */
function inRing(ring: Pt[], p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function inShape(shape: Shape, p: Pt): boolean {
  if (shape.kind === "circle") return Math.hypot(p.x - shape.at.x, p.y - shape.at.y) < shape.r;
  return inRing(shape.points, p) && !(shape.holes ?? []).some((h) => inRing(h, p));
}

const FLIPPED: Record<Heading, Heading> = { n: "s", s: "n", e: "w", w: "e" };

/**
 * The map's door, as a heading on the map's compass with north up: the way it
 * LEADS from `room`, the room the illustration shows.
 *
 * `through` is the middle of the cell on one side of the door — the side the
 * floor plan happened to list second, which is the player's own room as often
 * as not. So the heading is read from the door toward it, whichever axis is
 * longer, and turned round when that cell is inside `room`: a south door in a
 * room listed second pointed north, back into the room (2026-10-15).
 */
export function doorHeading(door: { at: Pt; through: Pt }, room?: Shape): Heading {
  const dx = door.through.x - door.at.x;
  const dy = door.through.y - door.at.y;
  const toward: Heading = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "e" : "w") : dy >= 0 ? "s" : "n";
  return room && inShape(room, door.through) ? FLIPPED[toward] : toward;
}

/**
 * What a button looks like. A door is an arched doorway with what is inside it
 * saying which door: an arrow for the way it leads, the U-turn for the way they
 * came in, somebody walking out for the way out of the dungeon. A feature is
 * its map mark, the same shape. A door with no wall to read a heading off (a
 * dungeon drawn without a block plan) gets no arrow.
 */
type Look =
  | { kind: "door"; inside: "arrow" | "came-from" | "way-out" | "none"; heading?: Heading }
  | { kind: "feature"; shape: FixtureShape };

/** A white halo and a soft shadow, following the shape: holds on hatching and on bare paper. */
const HALO = "drop-shadow(0 0 1.2px #fff) drop-shadow(0 0 1.2px #fff) drop-shadow(0 1px 2px rgb(34 32 28 / 0.4))";

/** The glyph inside an arch, in the arch's 24 x 24 box. */
function Inside({ look, ink }: { look: Extract<Look, { kind: "door" }>; ink: string }) {
  const line = { fill: "none", stroke: ink, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (look.inside === "came-from") return <g {...line}>{UTURN.map((d) => <path key={d} d={d} />)}</g>;
  if (look.inside === "way-out") {
    return (
      <g {...line} strokeWidth={1.7}>
        <circle {...WALKER.head} fill={ink} stroke="none" />
        {WALKER.strokes.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    );
  }
  if (look.inside === "arrow" && look.heading) {
    return (
      <g {...line} transform={`rotate(${headingTurn(look.heading)} 12 15)`}>
        {ARROW_NORTH.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    );
  }
  return null;
}

/**
 * What a button carries for a thing out of the picture: a dashed rim where it
 * would be behind a wall, a bent arrow for the corner to go round, a chevron
 * pointing off the edge it is beyond.
 */
type Hint = { kind: "dashed" } | { kind: "turn"; turn: "left" | "right" } | { kind: "edge"; edge: HotspotEdge };

/** A bent arrow turning right, in a 12 x 12 box: up, then round to the right. */
const TURN_RIGHT = ["M3 11 V6 A2 2 0 0 1 5 4 H10", "M7.5 1.5 L10 4 L7.5 6.5"];
/** A chevron pointing left, in a 12 x 12 box. Turned for the other edges. */
const CHEVRON_LEFT = "M7.5 2 L3.5 6 L7.5 10";
const CHEVRON_TURN: Record<HotspotEdge, number> = { left: 0, right: 180, bottom: 270 };
/** Where the chevron sits in the button's hit area: on the side toward its edge. */
const CHEVRON_AT: Record<HotspotEdge, string> = {
  left: "left-0 top-1/2 -translate-x-1/3 -translate-y-1/2",
  right: "right-0 top-1/2 translate-x-1/3 -translate-y-1/2",
  bottom: "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/3",
};

/** The hint's own mark, beside the button's shape. A dashed rim is on the shape itself. */
function HintMark({ hint }: { hint: Hint }) {
  if (hint.kind === "dashed") return null;
  const line = { fill: "none", stroke: color.ink, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const turn = hint.kind === "turn";
  return (
    <svg
      viewBox="0 0 12 12"
      width={14}
      height={14}
      aria-hidden
      className={`pointer-events-none absolute ${turn ? "-top-0.5 right-0" : CHEVRON_AT[hint.edge]}`}
      style={{ filter: HALO, overflow: "visible", ...(turn && hint.turn === "left" ? { transform: "scaleX(-1)" } : {}) }}
    >
      {turn ? (
        <g {...line}>
          {TURN_RIGHT.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      ) : (
        <path d={CHEVRON_LEFT} {...line} strokeWidth={2.4} transform={`rotate(${CHEVRON_TURN[hint.edge]} 6 6)`} />
      )}
    </svg>
  );
}

/**
 * One button. Paper with a heavy ink rim, like the map's doors; the way out of
 * the dungeon in verdigris, its own colour, so it stands apart without looking
 * lit. Torch while it is lit — pointed at here, on the map or in the room card,
 * or picked on another tab — and a little bigger.
 *
 * With `at`, it stands at that point of the illustration; without, it is one of a row
 * or a rail, and the row places it.
 */
function Spot({ id, at, card, verb, look, hint }: { id: string; at?: Pt; card: HoverCard; verb: Verb; look: Look; hint?: Hint }) {
  const anchor = useAnchor(ILLUSTRATION_TIP);
  const lit = useHover().lit === id;
  const wayOut = look.kind === "door" && look.inside === "way-out";
  const fill = lit ? color.torch : wayOut ? color.verdigris : color.paper;
  const rim = lit ? color.torchDeep : color.ink;
  const ink = lit || wayOut ? color.paper : color.ink;
  const size = look.kind === "door" ? 30 : 22;
  const dash = hint?.kind === "dashed" ? { strokeDasharray: "3 2.2" } : {};
  return (
    // The hit area is wider than the mark, for the same reason the map's are: a
    // mark is small and a cursor is not that accurate.
    <span
      className={`pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center ${
        at ? "absolute -translate-x-1/2 -translate-y-1/2" : "relative"
      }`}
      style={at ? { left: `${at.x * 100}%`, top: `${at.y * 100}%` } : undefined}
      data-illustration-spot={id}
      {...(look.kind === "door" ? { "data-door": look.inside } : { "data-shape": look.shape })}
      {...(look.kind === "door" && look.heading ? { "data-heading": look.heading } : {})}
      {...(look.kind === "door" && look.inside === "came-from" ? { "data-came-from": "" } : {})}
      {...(hint ? { "data-hint": hint.kind } : {})}
      {...(hint?.kind === "turn" ? { "data-turn": hint.turn } : {})}
      {...(lit ? { "data-lit": "" } : {})}
      {...anchor(id, card, verb)}
    >
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        aria-hidden
        style={{ filter: HALO, overflow: "visible", ...grows(lit, 1.25) }}
      >
        {look.kind === "door" ? (
          <>
            <path d={ARCH} fill={fill} stroke={rim} strokeWidth={2.4} strokeLinejoin="round" {...dash} />
            <Inside look={look} ink={ink} />
          </>
        ) : (
          <path d={shapePath(look.shape, 12, 12, 8)} fill={fill} stroke={rim} strokeWidth={2.6} strokeLinejoin="round" {...dash} />
        )}
      </svg>
      {hint && <HintMark hint={hint} />}
    </span>
  );
}

/** Where each rail of off-picture buttons runs, inside its edge of the illustration. */
const RAIL: Record<HotspotEdge, string> = {
  left: "inset-y-0 left-0 flex-col pl-1",
  right: "inset-y-0 right-0 flex-col pr-1",
  bottom: "inset-x-0 bottom-0 flex-row pb-1",
};

/**
 * The illustration's buttons, each looked up on the map: no entry there, no button.
 * `cameFrom` is the connector they walked in by, which carries the U-turn.
 *
 * A thing in the picture has its button on it. One out of the picture has the
 * same button, saying which way to go:
 * - round a corner in the picture: at the corner, with a bent arrow. Several
 *   round the same corner stand in a row there.
 * - walled off where it stands: there, with a dashed rim.
 * - off the picture: in a rail inside that edge, chevron pointing out, in the
 *   order of `along`. A rail rather than exact places, so two things off the
 *   same side never sit on each other however small the illustration is.
 */
function Spots({ spots, map, roomId, cameFrom }: { spots: IllustrationSpot[]; map: MapView; roomId: string; cameFrom?: string }) {
  const { reachable } = useHover();
  const room = map.rooms.find((r) => r.id === roomId)?.shape;
  const what = (id: string): { card: HoverCard; verb: Verb; look: Look } | undefined => {
    const c = map.connectors.find((x) => x.id === id && x.known);
    if (c) {
      const [card, verb] = doorHover(c, reachable.has(c.id));
      const look: Look = c.surface
        ? { kind: "door", inside: "way-out" }
        : c.id === cameFrom
          ? { kind: "door", inside: "came-from" }
          : c.door
            ? { kind: "door", inside: "arrow", heading: doorHeading(c.door, room) }
            : { kind: "door", inside: "none" };
      return { card, verb, look };
    }
    const f = map.fixtures.find((x) => x.id === id);
    if (!f) return undefined;
    const [card, verb] = fixtureHover(f);
    return { card, verb, look: { kind: "feature", shape: f.shape } };
  };

  const placed: ReactNode[] = [];
  const corners = new Map<string, { at: Pt; items: ReactNode[] }>();
  const rails: Record<HotspotEdge, { along: number; id: string; node: ReactNode }[]> = { left: [], right: [], bottom: [] };
  spots.forEach((s, i) => {
    const w = what(s.id);
    if (!w) return;
    // A server from before out-of-shot buttons sends `{ id, x, y }` and no `how`:
    // every spot it sent was in the picture. The page and the API are deployed
    // and restarted separately, so the page has to take either.
    const how = (s as { how?: string }).how ?? "shown";
    if (how === "shown" && "x" in s) placed.push(<Spot key={i} id={s.id} at={s} {...w} />);
    else if (s.how === "behind-wall") placed.push(<Spot key={i} id={s.id} at={s} {...w} hint={{ kind: "dashed" }} />);
    else if (s.how === "around") {
      const k = `${s.x},${s.y}`;
      const corner = corners.get(k) ?? { at: s, items: [] };
      corner.items.push(<Spot key={i} id={s.id} {...w} hint={{ kind: "turn", turn: s.turn }} />);
      corners.set(k, corner);
    } else if (s.how === "edge" && s.edge in rails) {
      rails[s.edge].push({ along: s.along, id: s.id, node: <Spot key={i} id={s.id} {...w} hint={{ kind: "edge", edge: s.edge }} /> });
    }
    // Anything else is a kind this page does not know: no button, rather than a crash.
  });

  return (
    <>
      {placed}
      {[...corners].map(([k, c]) => (
        <div
          key={k}
          className="pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${c.at.x * 100}%`, top: `${c.at.y * 100}%` }}
          data-corner=""
        >
          {c.items}
        </div>
      ))}
      {(Object.keys(rails) as HotspotEdge[]).map(
        (edge) =>
          rails[edge].length > 0 && (
            <div key={edge} className={`pointer-events-none absolute flex items-center justify-center gap-1 ${RAIL[edge]}`} data-rail={edge}>
              {rails[edge].sort((a, b) => a.along - b.along || a.id.localeCompare(b.id)).map((r) => r.node)}
            </div>
          )
      )}
    </>
  );
}

/**
 * Ask until there is an answer: again every `ILLUSTRATION_POLL_MS` while somebody's
 * request is drawing it, and give up as none past `ILLUSTRATION_POLL_TRIES`. A new
 * `id` restarts the asking. Read through a ref, so a parent that hands over a
 * new function every render does not restart it.
 */
function useAnswer<T extends { status: string }>(id: string, load: () => Promise<T>): T | { status: "pending" } {
  const [answer, setAnswer] = useState<T | { status: "pending" }>({ status: "pending" });
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setAnswer({ status: "pending" });
    const ask = async (tries: number) => {
      const got = await loadRef.current().catch(() => ({ status: "none" }) as T);
      if (!live) return;
      if (got.status === "pending" && tries < ILLUSTRATION_POLL_TRIES) {
        timer = setTimeout(() => void ask(tries + 1), ILLUSTRATION_POLL_MS);
        return;
      }
      setAnswer(got.status === "pending" ? ({ status: "none" } as T) : got);
    };
    void ask(1);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  return answer;
}

/** One coat of a sprite: the page's paper or ink, masked by one half of the stored image. */
function coat(url: string, fill: string, half: "body" | "ink") {
  const position = half === "body" ? "0% 0%" : "100% 0%";
  return {
    backgroundColor: fill,
    maskImage: `url("${url}")`,
    WebkitMaskImage: `url("${url}")`,
    maskSize: "200% 100%",
    WebkitMaskSize: "200% 100%",
    maskPosition: position,
    WebkitMaskPosition: position,
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
  };
}

/**
 * One creature, feet at its point. Laid down only once its sprite is drawn and
 * its shape known; until then the room shows without it, as it did before.
 */
function Figure({ figure, sprite }: { figure: IllustrationFigure; sprite: (spriteId: string) => Promise<SpriteAnswer> }) {
  const answer = useAnswer(figure.sprite, () => sprite(figure.sprite));
  // Width over height of one half of the stored image: the figure's own shape.
  const [aspect, setAspect] = useState<number>();
  const url = answer.status === "ready" ? answer.url : undefined;
  useEffect(() => {
    if (!url) return;
    let live = true;
    const img = new Image();
    img.onload = () => live && img.naturalHeight > 0 && setAspect(img.naturalWidth / 2 / img.naturalHeight);
    img.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  if (answer.status !== "ready" || !aspect) return null;
  const tall = figureHeight(figure, answer.size);
  return (
    <div
      className="pointer-events-none absolute"
      data-figure={figure.sprite}
      style={{
        left: `${figure.x * 100}%`,
        top: `${figure.y * 100}%`,
        height: `${tall * 100}%`,
        aspectRatio: String(aspect),
        transform: `translate(-50%, -100%)${figure.flop ? " scaleX(-1)" : ""}`,
      }}
    >
      <div className="absolute inset-0" style={coat(answer.url, "var(--color-paper)", "body")} />
      <div className="absolute inset-0" style={coat(answer.url, "var(--color-ink)", "ink")} />
    </div>
  );
}

/** Every figure, back to front as `illustrationFigures` ordered them. */
function Figures({ figures, sprite }: { figures: IllustrationFigure[]; sprite: (spriteId: string) => Promise<SpriteAnswer> }) {
  return (
    <>
      {figures.map((f, i) => (
        <Figure key={`${i}:${f.sprite}`} figure={f} sprite={sprite} />
      ))}
    </>
  );
}

/**
 * `id` names what is being drawn — a room, or the dungeon's cover — and a new
 * one restarts the asking. `subject` is said to a screen reader: "A drawing of …".
 * `map` turns the illustration's spots into buttons; without it, it is only a picture.
 * The caller passes it only for the room the player is standing in.
 */
export function Illustration({
  id,
  subject,
  load,
  map,
  cameFrom,
  sprite,
  figures,
  fill = false,
}: {
  id: string;
  subject: string;
  load: () => Promise<IllustrationAnswer>;
  map?: MapView;
  /** the connector they walked in by, marked with a U-turn */
  cameFrom?: string;
  /** a creature's sprite; with `figures`, the creatures are stood in the illustration */
  sprite?: (spriteId: string) => Promise<SpriteAnswer>;
  /** who stands where now; passed only while the player is in this room */
  figures?: IllustrationFigure[];
  /**
   * As large as the box it is in allows, at 3:2, rather than the prose's
   * width. The box must be a size container (`[container-type:size]`).
   */
  fill?: boolean;
}) {
  const answer = useAnswer<IllustrationAnswer>(id, load);
  const [open, setOpen] = useState(false);
  // The last figures this illustration was given, kept once the player walks out.
  const [shown, setShown] = useState(figures);
  useEffect(() => {
    if (figures) setShown(figures);
  }, [figures]);
  const people = sprite && shown?.length ? <Figures figures={shown} sprite={sprite} /> : null;

  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  if (answer.status === "none") return null;

  // Filling, the frame is the largest 3:2 that fits the container both ways.
  const frame = fill ? "mx-auto aspect-[3/2]" : "mb-4 aspect-[3/2] w-full max-w-[62ch]";
  const frameStyle = fill ? { width: "min(100cqw, 150cqh)" } : undefined;

  if (answer.status === "pending") {
    return (
      <div
        className={`${frame} flex items-center justify-center border border-dashed border-rule-faint`}
        style={frameStyle}
        role="img"
        aria-label={`A drawing of ${subject}, still being drawn`}
      >
        {/* Says the space is waiting on something, not empty for good. */}
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-rule border-t-graphite" />
      </div>
    );
  }

  return (
    <>
      {/* The dots sit beside the picture, not in it: a button inside a button
          is not allowed, and a click on a dot must not open the full size. */}
      <div className={`relative ${frame}`} style={frameStyle}>
        <button
          type="button"
          className="absolute inset-0 block cursor-zoom-in"
          style={inkStyle(answer.url)}
          onClick={() => setOpen(true)}
          aria-label={`A drawing of ${subject}. Open it full size.`}
        />
        {people}
        {map && answer.spots && <Spots spots={answer.spots} map={map} roomId={id} {...(cameFrom ? { cameFrom } : {})} />}
      </div>
      {open && (
        <div
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-paper p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-label={`A drawing of ${subject}`}
        >
          {/* Kept at exactly 3:2, so the figures, placed as fractions of the frame, stay on the drawing. */}
          <div className="relative aspect-[3/2]" style={{ width: "min(100%, 1536px, calc((100vh - 2rem) * 1.5))" }}>
            <div className="absolute inset-0" style={inkStyle(answer.url)} />
            {people}
          </div>
        </div>
      )}
    </>
  );
}
