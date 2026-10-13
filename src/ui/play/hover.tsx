/**
 * WHAT THE CURSOR IS ON, AND WHAT A CLICK OFFERS.
 *
 * Three jobs that turn out to be one, which is why they live in the same file:
 *
 *   THE CARD    the name, where it stands, and the paragraph the player read.
 *   THE LINK    the room card row and the map marker light up together, so the
 *               player can see WHERE THE GAME THINKS A THING IS rather than
 *               having to argue with the prose about it.
 *   THE PILL    a click raises one question above the thing — "Go Through?" —
 *               and answering it sends a sentence. `verbs.ts` owns which
 *               question; this file owns raising it and getting the answer back.
 *
 * The second is the reason the first had to move out of `DungeonMap`. A tooltip
 * that belongs to the map can only be raised by the map; once the room card
 * raises the same card for the same thing, the content and the highlight are a
 * property of the ENTITY, not of the panel that happens to be drawing it.
 *
 * WHY react-tooltip. The hand-rolled tooltip this replaces was an absolutely
 * positioned div inside the map's own box, and the room card panel is a later
 * grid sibling with a background — so anything the tooltip spilled downward was
 * painted over. `portalRoot={document.body}` is the whole of the fix: the card
 * is a child of the document, positioned against the anchor, and no ancestor of
 * the map can clip or overpaint it.
 *
 * THE ANCHOR CARRIES ITS OWN CONTENT, in `data-hover-*` and `data-verb-*`
 * attributes read back off `activeAnchor`. No registry, no lookup, no shared data
 * source between the two panels — which is what lets the map and the card each
 * mount their own tooltip and still be rendered on their own in a test.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Tooltip, type TooltipRefProps } from "react-tooltip";
import { color, font } from "../theme.ts";
import type { Verb } from "./verbs.ts";

/**
 * The two mounts.
 *
 * The map's follows the cursor, because a marker is a dot and the thing being
 * pointed at is wherever the pointer is. The card's is anchored to the row,
 * because a list of rows is read by moving down it and a card chasing the
 * pointer down that list is restless.
 */
export const MAP_TIP = "dungeon-map-hover";
export const CARD_TIP = "dungeon-card-hover";

/**
 * The pill's mount, and there is only one of it for both panels.
 *
 * It finds its anchors by `data-verb` rather than by this id, because
 * `data-tooltip-id` is a single attribute and the hover card already owns it on
 * every one of these elements. See `ActionPill`.
 */
export const VERB_TIP = "dungeon-verb";

/** The three lines of a hover, in the order they are read. */
export interface HoverCard {
  /** what it is called */
  title: string;
  /** where it stands, or what is true of the way through — small, torch, mono */
  note?: string;
  /** the paragraph the player has already read about it */
  body?: string;
}

/**
 * WHAT A TAP PICKED, on a screen with no hover.
 *
 * The card and the verb are captured at the tap rather than read back off the
 * element later, because the sheet that shows them is not anchored to anything —
 * it sits at the bottom of the screen, and the thing tapped may have scrolled or
 * panned away by the time the player reads it.
 *
 * The verb is kept even while the game is not acting. Whether it may be PRESSED
 * is asked again at render, so a sheet opened during a model call turns into a
 * button the moment the referee is done, instead of having to be tapped again.
 */
export interface Selection {
  id: string;
  card: HoverCard;
  verb?: Verb;
}

interface HoverState {
  /**
   * The id of the thing under the cursor — an entity id, a connector id or a
   * room id. One field rather than a tagged union: these are uuids, they cannot
   * collide, and both sides of the link key off the same id by construction.
   */
  hovered?: string;
  setHovered(id?: string): void;
  /**
   * TOUCH: there is no hover, so a tap selects instead. The cards and the pill
   * are not mounted; `InspectSheet` shows the selection. See `src/ui/media.ts`.
   */
  touch: boolean;
  /** what a tap picked. Always undefined with a mouse. */
  selection?: Selection;
  select: Dispatch<SetStateAction<Selection | undefined>>;
  /**
   * THE ONE ID BOTH PANELS LIGHT: what the cursor is on with a mouse, what was
   * tapped with a finger. Every highlight reads this and not `hovered`, so the
   * map and the room card cannot disagree about which of the two is in charge.
   */
  lit?: string;
  /**
   * The game will take an action right now. False through a model call, a roll
   * and an ended run, and then NOTHING carries a verb — a pill that opens onto a
   * closed input is a button that does nothing, which is worse than no button.
   */
  acting: boolean;
  /**
   * Connector ids that are ways out of the room the player is standing in.
   *
   * Whether a way can be walked is a fact about the game, not about the panel
   * drawing it, so it lives here rather than as a prop on both panels — the same
   * argument the file header makes for hover content.
   */
  reachable: ReadonlySet<string>;
  /** Send a sentence as the player's action. */
  act(sentence: string): void;
}

/**
 * Absent by default, and deliberately a working no-op rather than a throw.
 *
 * `DungeonMap` and `RoomCard` are each rendered on their own in tests and each
 * has to work there. Without a provider the tooltips still open; the cross-panel
 * highlight goes quiet and nothing offers a verb, which is exactly what "there
 * is no game around me" should mean.
 */
const Ctx = createContext<HoverState>({
  setHovered: () => {},
  touch: false,
  select: () => {},
  acting: false,
  reachable: new Set(),
  act: () => {},
});

export function useHover(): HoverState {
  return useContext(Ctx);
}

export interface HoverProviderProps {
  children: ReactNode;
  /** see `HoverState.acting` */
  acting?: boolean;
  /** see `HoverState.reachable` */
  reachable?: ReadonlySet<string>;
  /** what a answered pill sends. Absent means the panels are read-only. */
  onAct?(sentence: string): void;
  /** see `HoverState.touch` */
  touch?: boolean;
  /**
   * The selection belongs to whatever this names, and goes when it changes —
   * `PlayScreen` passes the open tab, so a sheet does not follow the player onto
   * a tab where the thing it describes is not drawn.
   */
  scope?: unknown;
}

/** Wraps the panels that should light each other up. `PlayScreen` is the only caller. */
export function HoverProvider({ children, acting, reachable, onAct, touch = false, scope }: HoverProviderProps) {
  const [hovered, setHovered] = useState<string>();
  const [selection, select] = useState<Selection>();
  useEffect(() => select(undefined), [scope, touch]);

  const value = useMemo(
    () => ({
      hovered,
      setHovered,
      touch,
      selection,
      select,
      lit: touch ? selection?.id : hovered,
      // A provider given no way to send cannot offer to send, whatever the stage
      // says. One test rather than two for every caller to remember.
      acting: acting === true && onAct !== undefined,
      reachable: reachable ?? new Set<string>(),
      act: onAct ?? (() => {}),
    }),
    [hovered, selection, touch, acting, reachable, onAct]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * What has to go on an element for it to be hoverable.
 *
 * Spread onto the element, which is an SVG `<g>` on the map and an `<li>` in the
 * card — the same props either way, because the tooltip does not care and the
 * highlight must not.
 */
export interface AnchorProps {
  "data-tooltip-id": string;
  "data-hover-id": string;
  "data-hover-title": string;
  "data-hover-note"?: string;
  "data-hover-body"?: string;
  /** the question a click raises. Absent means a click does nothing. */
  "data-verb"?: string;
  /** what answering it sends */
  "data-verb-text"?: string;
  /** with a mouse */
  onMouseEnter?(): void;
  onMouseLeave?(): void;
  /** with a finger: a tap selects, and the same tap again puts it down */
  onClick?(): void;
  role?: "button";
}

/**
 * `const anchor = useAnchor(MAP_TIP)`, then `<g {...anchor(id, card, verb)}>`.
 *
 * A hook returning a factory rather than a hook per anchor, because the number
 * of things in a room is not known at render time and hooks may not be called
 * in a loop.
 *
 * The verb is dropped when the game will not take an action, so the gate is in
 * one place and no caller can forget it: no attribute, no anchor, no pill.
 */
export function useAnchor(tip: string) {
  const { setHovered, acting, touch, select } = useHover();
  return (id: string, card: HoverCard, verb?: Verb): AnchorProps => {
    const data = {
      "data-tooltip-id": tip,
      "data-hover-id": id,
      "data-hover-title": card.title,
      "data-hover-note": card.note,
      "data-hover-body": card.body,
      "data-verb": acting ? verb?.label : undefined,
      "data-verb-text": acting ? verb?.sentence : undefined,
    };
    if (touch) {
      return {
        ...data,
        role: "button",
        onClick: () => select((s) => (s?.id === id ? undefined : { id, card, ...(verb ? { verb } : {}) })),
      };
    }
    return {
      ...data,
      onMouseEnter: () => setHovered(id),
      onMouseLeave: () => setHovered(undefined),
    };
  };
}

/**
 * HOW MUCH OF A DESCRIPTION A HOVER SHOWS: about one paragraph.
 *
 * Measured over five recorded runs before it was chosen. A room's `composed`
 * runs to a median of 947 characters and as far as 1878, in three paragraphs or
 * so; a thing standing in one runs to 235. A card carrying all of a room is a
 * wall of text hanging off the cursor, and the full prose is a scroll away in
 * the narration, which is where it is meant to be read.
 *
 * 320 leaves a thing's description whole nearly always and gives a room its
 * opening paragraph — enough to recognise the place by, which is what the
 * player is hovering to do.
 */
const BODY_LIMIT = 320;

/**
 * The opening of a description, with an ellipsis standing for the rest.
 *
 * Cuts at the best boundary it can reach: a paragraph break, then the last
 * sentence to end within the limit, then the last word. The ellipsis follows a
 * space where the text stopped somewhere it was going to stop anyway, and is
 * set tight against the word where the sentence was cut off mid-breath — which
 * is the ordinary typographic distinction between "more follows" and
 * "interrupted".
 */
export function oneParagraph(text: string, limit = BODY_LIMIT): string {
  const whole = text.trim();
  const first = whole.split(/\n\s*\n/)[0].trim();

  if (first.length <= limit) {
    // Nothing dropped at all, or a first paragraph that stands on its own.
    return first.length === whole.length ? first : `${first} …`;
  }

  const head = first.slice(0, limit);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  // Only if it lands somewhere worth stopping. A sentence end in the first few
  // words would throw away most of the paragraph to gain a tidy full stop.
  if (sentence >= limit / 2) return `${first.slice(0, sentence + 1)} …`;

  const word = head.lastIndexOf(" ");
  // The dangling comma or dash of a clause that is not going to arrive.
  return `${head.slice(0, word > 0 ? word : limit).replace(/[,;:—-]$/, "")}…`;
}

/** Reads the three lines back off whichever element the cursor is on. */
function Card({ anchor }: { anchor: Element | null }) {
  const read = (k: string) => anchor?.getAttribute(`data-hover-${k}`) ?? undefined;
  const title = read("title");
  // Nothing to say means no card at all: react-tooltip renders no node when the
  // render prop returns null, so an anchor with no title cannot open an empty box.
  if (title === undefined || title === "") return null;

  const note = read("note");
  const body = read("body");

  return (
    <>
      <div
        className="text-[12px] font-bold leading-tight"
        style={{ fontFamily: font.display, color: color.ink }}
      >
        {title}
      </div>
      {note && (
        <div
          className="mt-0.5 text-[9px] uppercase tracking-[0.14em]"
          style={{ fontFamily: font.mono, color: color.torchDeep }}
        >
          {note}
        </div>
      )}
      {body && (
        <p
          className="mt-1.5 text-[12px] leading-snug"
          style={{ fontFamily: font.prose, color: color.graphite }}
        >
          {oneParagraph(body)}
        </p>
      )}
    </>
  );
}

/**
 * One mount. Paper, a hairline rule, and none of react-tooltip's own dark
 * chrome — the inline style wins over its injected base sheet, which is left
 * injected because the CORE half of it is what positions the thing.
 */
export function ThingTooltip({ id, float = false }: { id: string; float?: boolean }) {
  // Nothing hovers on a touch screen, and a card that opened on a tap would
  // fight the sheet for the same job. See `InspectSheet`.
  if (useHover().touch) return null;
  return (
    <Tooltip
      id={id}
      float={float}
      // Following the cursor, the card sits down and to the right of it, where
      // the hand-rolled one sat. Anchored, it comes off the left edge of the
      // row — the room card is the rightmost panel of the pair and a card to
      // its right would be off the sheet.
      place={float ? "bottom-start" : "left"}
      offset={float ? 14 : 10}
      noArrow
      opacity={1}
      positionStrategy="fixed"
      // Through the prop, not `style`: react-tooltip writes `border` into the
      // positioned style itself, so an inline one is overwritten the moment
      // floating-ui reports where the card goes.
      border={`1px solid ${color.rule}`}
      // THE FIX. Out of the panel, into the document — see the file header.
      // Guarded because `screens.test.ts` renders these components through
      // `renderToStaticMarkup`, where there is no document at all.
      portalRoot={typeof document === "undefined" ? null : document.body}
      style={{
        maxWidth: 280,
        padding: "8px 10px",
        borderRadius: 2,
        background: color.paper,
        boxShadow: "0 2px 8px rgb(34 32 28 / 0.10)",
        zIndex: 50,
      }}
      render={({ activeAnchor }) => <Card anchor={activeAnchor} />}
    />
  );
}

// ---------------------------------------------------------------------------
// THE PILL
// ---------------------------------------------------------------------------

/**
 * The question, as the one thing you can press.
 *
 * Reads its two attributes back off the anchor, the same way the hover card
 * reads its three. Either one missing means no pill: an anchor the game has
 * nothing to offer on cannot open an empty box, because react-tooltip renders no
 * node at all when the render prop returns null.
 */
function Pill({
  anchor,
  onPick,
}: {
  anchor: Element | null;
  onPick(sentence: string): void;
}) {
  const label = anchor?.getAttribute("data-verb") ?? "";
  const sentence = anchor?.getAttribute("data-verb-text") ?? "";
  if (label === "" || sentence === "") return null;

  return (
    <button
      type="button"
      // The sentence is not shown, but it is on the element that sends it — so a
      // player who wants to know what a click will say can find out, and a test
      // can assert the button and the sentence are the same thing.
      data-sends={sentence}
      onClick={() => onPick(sentence)}
      // Torch on the press, because this press is the one that becomes a turn.
      className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors hover:bg-graphite active:bg-torch"
      style={{ color: color.paper }}
    >
      {label}
    </button>
  );
}

/**
 * ONE MOUNT FOR BOTH PANELS, and the only place a click becomes a turn.
 *
 * Three things it gets from react-tooltip rather than building:
 *
 *   POSITION      "above the thing" on a map that pans and zooms otherwise means
 *                 converting map units to screen pixels through the live
 *                 transform — and jsdom reports every box as zero, so it could
 *                 not be tested. floating-ui measures the anchor whatever the
 *                 transform is.
 *   NO CLIPPING   `portalRoot`, for the reason in the file header. A pill above
 *                 the first row of the room card would otherwise be painted over
 *                 by the panel.
 *   CLICK AWAY    `openOnClick` turns on `clickOutsideAnchor` by default, so a
 *                 click anywhere else closes the pill and does nothing. That is
 *                 the whole of "clicking elsewhere cancels" — no handler.
 *
 * `anchorSelect` rather than the id, because `data-tooltip-id` is a single
 * attribute and the hover card already holds it on every one of these elements.
 *
 * CLOSED THROUGH THE REF, because a click INSIDE a tooltip is not a click
 * outside it — answering the question cannot dismiss the pill by itself. The
 * imperative `close()` rather than the controlled `isOpen`/`setIsOpen` pair: both
 * work, but controlling it puts our own state between react-tooltip's open timer
 * and its show timer, which doubles the delay before the card is really up. The
 * hover cards do not pay that and neither should this.
 */
export function ActionPill() {
  const { act, touch } = useHover();
  const tip = useRef<TooltipRefProps>(null);

  if (touch) return null;
  return (
    <Tooltip
      ref={tip}
      id={VERB_TIP}
      anchorSelect="[data-verb]"
      openOnClick
      // The pill is pressed, not read past. Without this react-tooltip closes it
      // as soon as the cursor crosses the gap toward it.
      clickable
      place="top"
      offset={8}
      noArrow
      opacity={1}
      positionStrategy="fixed"
      border={`1px solid ${color.ink}`}
      portalRoot={typeof document === "undefined" ? null : document.body}
      // Ink rather than the hover card's paper, and no padding of its own: the
      // button IS the pill. A dark chip reads as something to press next to a
      // pale card that is only there to be read.
      style={{
        padding: 0,
        borderRadius: 2,
        background: color.ink,
        boxShadow: "0 2px 8px rgb(34 32 28 / 0.18)",
        // Over the hover card, which is at 50 — the two can overlap, and the one
        // you can press should be the one on top.
        zIndex: 60,
      }}
      render={({ activeAnchor }) => (
        <Pill
          anchor={activeAnchor}
          onPick={(sentence) => {
            tip.current?.close();
            act(sentence);
          }}
        />
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// THE SHEET
// ---------------------------------------------------------------------------

/**
 * THE CARD AND THE PILL, FOR A FINGER.
 *
 * A touch screen has no hover to raise the card on and no cursor to float the
 * pill beside, so both become one sheet across the bottom of the screen: the
 * same three lines `Card` reads, and the same verb `Pill` offers, as a button
 * wide enough to hit. Tap the thing again, tap ×, or tap empty paper to put it
 * down; tap something else and the sheet changes to that.
 *
 * Positioned by the caller, which knows whether it is sitting above a tab bar or
 * at the foot of the whole screen.
 */
export function InspectSheet({ className, onActed }: { className?: string; onActed?(): void }) {
  const { selection, select, acting, act } = useHover();
  if (!selection) return null;
  const { card, verb } = selection;

  return (
    <div
      role="dialog"
      aria-label={card.title}
      className={`border-t border-ink bg-paper px-4 pb-4 pt-3.5 ${className ?? ""}`}
      style={{
        boxShadow: "0 -6px 20px rgba(34,32,28,0.12)",
        animation: "sheet-in 180ms ease-out",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 pt-1.5">
          <div className="font-display text-[17px] font-bold leading-tight text-ink">{card.title}</div>
          {card.note && (
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-torch-deep">
              {card.note}
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={() => select(undefined)}
          className="-mr-3 -mt-1.5 flex h-11 w-11 shrink-0 items-center justify-center font-mono text-[18px] text-graphite active:text-ink"
        >
          ×
        </button>
      </div>

      {card.body && (
        <p className="mt-2 font-prose text-[15px] leading-[1.5] text-graphite">{oneParagraph(card.body)}</p>
      )}

      {verb && (
        <div className="mt-3">
          {acting ? (
            <button
              type="button"
              data-sends={verb.sentence}
              onClick={() => {
                select(undefined);
                act(verb.sentence);
                onActed?.();
              }}
              className="h-12 w-full border border-ink bg-ink font-mono text-[12px] uppercase tracking-[0.14em] text-paper active:border-torch active:bg-torch"
            >
              {verb.label}
            </button>
          ) : (
            <div className="flex h-12 items-center justify-center font-mono text-[10px] uppercase tracking-[0.14em] text-pencil">
              Wait for the referee to act
            </div>
          )}
          <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.12em] text-pencil">
            Sends: &ldquo;{verb.sentence}&rdquo;
          </div>
        </div>
      )}
    </div>
  );
}
