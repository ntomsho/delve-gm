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
 * THE BUTTONS. A room's plate carries a white dot at each place the guide image
 * put a tag — every doorway and object the image model was told to draw — and
 * each dot is the same control as the map's marker for that thing: the same
 * hover card, the same question on a click, and the same `lit` id, so pointing
 * at a dot lights the map and the room card and pointing at either lights the
 * dot. A thing the map does not show yet gets no dot, so the plate is fogged
 * exactly as the map is.
 */

import { useEffect, useRef, useState } from "react";
import type { PlateAnswer, PlateSpot } from "../../illustrations/room-illustration.ts";
import type { MapView } from "../../gameplay/view/selectors.ts";
import { doorHover, fixtureHover } from "./DungeonMap.tsx";
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

/** The way they came in by: a turn back the way they came, drawn inside its dot. */
function UTurn() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 14V7a4 4 0 0 0-8 0v1" />
      <path d="M1 6l2 2.5L5.5 6" />
    </svg>
  );
}

/**
 * One dot. White like the map's doors; the way out of the dungeon in the map's
 * torch. A heavy ink rim and a white halo round it, so it holds against any
 * part of the drawing, dark hatching or bare paper.
 */
function Spot({
  spot,
  card,
  verb,
  surface,
  cameFrom,
}: {
  spot: PlateSpot;
  card: HoverCard;
  verb: Verb;
  surface: boolean;
  cameFrom: boolean;
}) {
  const anchor = useAnchor(PLATE_TIP);
  const lit = useHover().lit === spot.id;
  const size = cameFrom ? (lit ? "h-7 w-7" : "h-6 w-6") : lit ? "h-[22px] w-[22px]" : "h-[18px] w-[18px]";
  return (
    // The hit area is wider than the dot, for the same reason the map's are: a
    // dot is small and a cursor is not that accurate.
    <span
      className="absolute flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
      style={{ left: `${spot.x * 100}%`, top: `${spot.y * 100}%` }}
      data-plate-spot={spot.id}
      {...(cameFrom ? { "data-came-from": "" } : {})}
      {...anchor(spot.id, card, verb)}
    >
      <span
        className={`flex items-center justify-center rounded-full border-[3px] transition-all ${size} ${
          lit
            ? "border-torch-deep bg-torch text-paper"
            : surface
              ? "border-ink bg-torch-deep text-paper"
              : "border-ink bg-paper text-ink"
        }`}
        style={{ boxShadow: "0 0 0 2px rgb(255 255 255 / 0.85), 0 1px 4px rgb(34 32 28 / 0.35)" }}
      >
        {cameFrom && <UTurn />}
      </span>
    </span>
  );
}

/**
 * The plate's dots, each looked up on the map: no entry there, no dot.
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
          return <Spot key={i} spot={s} card={card} verb={verb} surface={c.surface} cameFrom={c.id === cameFrom} />;
        }
        const f = map.fixtures.find((x) => x.id === s.id);
        if (f) {
          const [card, verb] = fixtureHover(f);
          return <Spot key={i} spot={s} card={card} verb={verb} surface={false} cameFrom={false} />;
        }
        return null;
      })}
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
}: {
  id: string;
  subject: string;
  load: () => Promise<PlateAnswer>;
  map?: MapView;
  /** the connector they walked in by, marked with a U-turn */
  cameFrom?: string;
}) {
  const [answer, setAnswer] = useState<PlateAnswer>({ status: "pending" });
  const [open, setOpen] = useState(false);
  // Read through a ref so a parent that hands over a new function every render
  // does not restart the asking.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async (tries: number) => {
      const got = await loadRef.current().catch((): PlateAnswer => ({ status: "none" }));
      if (!live) return;
      if (got.status === "pending" && tries < PLATE_POLL_TRIES) {
        timer = setTimeout(() => void ask(tries + 1), PLATE_POLL_MS);
        return;
      }
      setAnswer(got.status === "pending" ? { status: "none" } : got);
    };
    void ask(1);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

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
        {map && answer.spots && <Spots spots={answer.spots} map={map} {...(cameFrom ? { cameFrom } : {})} />}
      </div>
      {open && (
        <div
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-paper p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-label={`A drawing of ${subject}`}
        >
          <div className="aspect-[3/2] w-full max-w-[1536px]" style={{ ...inkStyle(answer.url), maxHeight: "100%" }} />
        </div>
      )}
    </>
  );
}
