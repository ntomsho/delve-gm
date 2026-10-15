/**
 * A ROOM'S PLATE, at its first arrival — the module booklet held up.
 *
 * The space is held at 3:2 from the moment the arrival is on the page, with a
 * faint pencil frame, so a plate landing a few seconds later fills it rather
 * than shoving the text being read. It closes only when there will be no plate.
 *
 * DRAWN AS INK, NOT SHOWN AS A PHOTOGRAPH. The server stores black on
 * transparent, and the page uses it as a mask over its own ink colour: the
 * lines are exactly the text's ink, the paper is the page's paper, and there is
 * no box edge. A click opens it full size.
 *
 * THE BUTTONS. A room's plate carries a button at each place the guide image
 * put a tag: every doorway and object the image model was told to draw. A door
 * is an arched doorway with an arrow for which way it leads on the map; a
 * feature carries its map mark, the same shape. Each is the same control as the map's
 * marker for that thing: the same hover card, the same question on a click, and
 * the same `lit` id, so pointing at a button lights the map and the room card
 * and pointing at either lights the button. A thing the map does not show yet
 * gets no button, so the plate is fogged exactly as the map is.
 *
 * THE FIGURES. The plate of the room they are standing in has its creatures
 * stood in it, each a sprite laid down in two coats: the page's paper where the
 * figure is, hiding the plate behind it, then the page's ink. Where each stands
 * is worked out from the run as it is now (`roomFigures`), so a creature slain
 * is gone at once. A plate they have walked out of keeps the figures it last
 * showed: the scrollback is a record of what was there.
 */

import { useEffect, useRef, useState } from "react";
import type { PlateAnswer, PlateSpot } from "../../runtime/plates.ts";
import type { SpriteAnswer } from "../../runtime/sprites.ts";
import { figureHeight, type PlateFigure } from "../../engine/index.ts";
import type { MapView } from "../../store/selectors.ts";
import type { FixtureShape } from "../../store/selectors.ts";
import { doorHover, fixtureHover, grows } from "./DungeonMap.tsx";
import { ARCH, ARROW_NORTH, headingTurn, shapePath, UTURN, WALKER, type Heading } from "./marks.ts";
import { color } from "../theme.ts";
import { PLATE_TIP, useAnchor, useHover, type HoverCard } from "./hover.tsx";
import type { Verb } from "./verbs.ts";

/** How long between asks while somebody else's request is drawing it. */
const PLATE_POLL_MS = 4000;
/** Asks before giving up on a pending plate: past the server's stale-claim timeout. */
const PLATE_POLL_TRIES = 50;

/**
 * A stored plate or cover laid down as ink: the page's ink colour, masked by
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

/**
 * The map's door, as a heading: from the door toward its far side, whichever
 * axis is longer, on the map's compass with north up.
 */
export function doorHeading(door: { at: { x: number; y: number }; through: { x: number; y: number } }): Heading {
  const dx = door.through.x - door.at.x;
  const dy = door.through.y - door.at.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "e" : "w";
  return dy >= 0 ? "s" : "n";
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
 * One button. Paper with a heavy ink rim, like the map's doors; the way out of
 * the dungeon in verdigris, its own colour, so it stands apart without looking
 * lit. Torch while it is lit — pointed at here, on the map or in the room card,
 * or picked on another tab — and a little bigger.
 */
function Spot({ spot, card, verb, look }: { spot: PlateSpot; card: HoverCard; verb: Verb; look: Look }) {
  const anchor = useAnchor(PLATE_TIP);
  const lit = useHover().lit === spot.id;
  const wayOut = look.kind === "door" && look.inside === "way-out";
  const fill = lit ? color.torch : wayOut ? color.verdigris : color.paper;
  const rim = lit ? color.torchDeep : color.ink;
  const ink = lit || wayOut ? color.paper : color.ink;
  const size = look.kind === "door" ? 30 : 22;
  return (
    // The hit area is wider than the mark, for the same reason the map's are: a
    // mark is small and a cursor is not that accurate.
    <span
      className="absolute flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
      style={{ left: `${spot.x * 100}%`, top: `${spot.y * 100}%` }}
      data-plate-spot={spot.id}
      {...(look.kind === "door" ? { "data-door": look.inside } : { "data-shape": look.shape })}
      {...(look.kind === "door" && look.heading ? { "data-heading": look.heading } : {})}
      {...(look.kind === "door" && look.inside === "came-from" ? { "data-came-from": "" } : {})}
      {...(lit ? { "data-lit": "" } : {})}
      {...anchor(spot.id, card, verb)}
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
            <path d={ARCH} fill={fill} stroke={rim} strokeWidth={2.4} strokeLinejoin="round" />
            <Inside look={look} ink={ink} />
          </>
        ) : (
          <path d={shapePath(look.shape, 12, 12, 8)} fill={fill} stroke={rim} strokeWidth={2.6} strokeLinejoin="round" />
        )}
      </svg>
    </span>
  );
}

/**
 * The plate's buttons, each looked up on the map: no entry there, no button.
 * `cameFrom` is the connector they walked in by, which carries the U-turn.
 */
function Spots({ spots, map, cameFrom }: { spots: PlateSpot[]; map: MapView; cameFrom?: string }) {
  const { reachable } = useHover();
  return (
    <>
      {spots.map((s, i) => {
        const c = map.connectors.find((x) => x.id === s.id && x.known);
        if (c) {
          const [card, verb] = doorHover(c, reachable.has(c.id));
          const look: Look = c.surface
            ? { kind: "door", inside: "way-out" }
            : c.id === cameFrom
              ? { kind: "door", inside: "came-from" }
              : c.door
                ? { kind: "door", inside: "arrow", heading: doorHeading(c.door) }
                : { kind: "door", inside: "none" };
          return <Spot key={i} spot={s} card={card} verb={verb} look={look} />;
        }
        const f = map.fixtures.find((x) => x.id === s.id);
        if (f) {
          const [card, verb] = fixtureHover(f);
          return <Spot key={i} spot={s} card={card} verb={verb} look={{ kind: "feature", shape: f.shape }} />;
        }
        return null;
      })}
    </>
  );
}

/**
 * Ask until there is an answer: again every `PLATE_POLL_MS` while somebody's
 * request is drawing it, and give up as none past `PLATE_POLL_TRIES`. A new
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
      if (got.status === "pending" && tries < PLATE_POLL_TRIES) {
        timer = setTimeout(() => void ask(tries + 1), PLATE_POLL_MS);
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
function Figure({ figure, sprite }: { figure: PlateFigure; sprite: (spriteId: string) => Promise<SpriteAnswer> }) {
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

/** Every figure, back to front as `plateFigures` ordered them. */
function Figures({ figures, sprite }: { figures: PlateFigure[]; sprite: (spriteId: string) => Promise<SpriteAnswer> }) {
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
 * `map` turns the plate's spots into buttons; without it, it is only a picture.
 * The caller passes it only for the room the player is standing in.
 */
export function Plate({
  id,
  subject,
  load,
  map,
  cameFrom,
  sprite,
  figures,
}: {
  id: string;
  subject: string;
  load: () => Promise<PlateAnswer>;
  map?: MapView;
  /** the connector they walked in by, marked with a U-turn */
  cameFrom?: string;
  /** a creature's sprite; with `figures`, the creatures are stood in the plate */
  sprite?: (spriteId: string) => Promise<SpriteAnswer>;
  /** who stands where now; passed only while the player is in this room */
  figures?: PlateFigure[];
}) {
  const answer = useAnswer<PlateAnswer>(id, load);
  const [open, setOpen] = useState(false);
  // The last figures this plate was given, kept once the player walks out.
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

  if (answer.status === "pending") {
    return (
      <div
        className="mb-4 flex aspect-[3/2] w-full max-w-[62ch] items-center justify-center border border-dashed border-rule-faint"
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
      <div className="relative mb-4 aspect-[3/2] w-full max-w-[62ch]">
        <button
          type="button"
          className="absolute inset-0 block cursor-zoom-in"
          style={inkStyle(answer.url)}
          onClick={() => setOpen(true)}
          aria-label={`A drawing of ${subject}. Open it full size.`}
        />
        {people}
        {map && answer.spots && <Spots spots={answer.spots} map={map} {...(cameFrom ? { cameFrom } : {})} />}
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
