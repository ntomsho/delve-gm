/**
 * THE PLAY SCREEN ON A PHONE: three tabs where the desktop has three columns.
 *
 *   Map         the map, and the room card under it
 *   Chat        the narration and the input — where a run is played
 *   Character   the sheet
 *
 * The layout is Claude Design's mobile handoff; see *Phones* in
 * docs/BUILD-PLAN.md. This component owns the shell — the top bar, the tab bar,
 * swiping between tabs, and the two badges that say a tab has something new —
 * and is handed the three bodies already built, so it never has to know what
 * a map or a turn is.
 *
 * ALL THREE BODIES STAY MOUNTED, the inactive two hidden but laid out. The
 * narration keeps its scroll position and goes on following the newest line
 * while the player is looking at the map, and the sheet keeps noticing a drop
 * in HP while it is out of sight — which is what lets its tab carry a badge.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { GameMenu } from "./GameMenu.tsx";
import { InspectSheet } from "./hover.tsx";
import { MARK_MS, hurt, useDrops } from "./CharacterPanel.tsx";
import { STAGE_NAME, STAGE_TONE } from "../shared/theme.ts";
import type { Stage } from "../../shared/types/turn.ts";
import type { CharacterView } from "../../gameplay/view/selectors.ts";

export type Tab = "map" | "chat" | "sheet";

/**
 * In order, left to right — which is also the order a swipe walks them in.
 * The grid takes any number, for the Illustrations tab the handoff reserves.
 */
export const TABS: { id: Tab; label: string }[] = [
  { id: "map", label: "Map" },
  { id: "chat", label: "Chat" },
  { id: "sheet", label: "Character" },
];

/**
 * WHAT COUNTS AS A SWIPE.
 *
 * Far enough that a drag to scroll a long paragraph, wobbling a little sideways,
 * is not one; mostly sideways, so a diagonal flick through the narration is a
 * scroll; and quick, so a slow sideways drag while selecting text is neither.
 */
const SWIPE_MIN_PX = 60;
const SWIPE_RATIO = 1.5;
const SWIPE_MAX_MS = 600;

/**
 * The step a swipe takes from `from`, or `from` itself at either end.
 *
 * NO WRAPPING: swiping left on the last tab does nothing. With three tabs a
 * wrap would put Map one swipe to the right of Character, and a player who
 * overshoots should feel the wall rather than land somewhere unexpected.
 */
export function swipeTo(from: Tab, dx: number): Tab {
  const i = TABS.findIndex((t) => t.id === from);
  // Finger moving left pulls the next tab in from the right.
  const j = Math.min(TABS.length - 1, Math.max(0, i + (dx < 0 ? 1 : -1)));
  return TABS[j].id;
}

/**
 * The visual viewport, where there is one.
 *
 * `100dvh` follows the address bar but not the soft keyboard on iOS, which
 * pans the whole page up under it instead — and the input row, at the bottom,
 * is the one thing that must never be hidden. Sized to the visual viewport, the
 * shell shrinks to what is left above the keyboard and the input rides on top.
 */
function useVisualViewport(): { top: number; height: number } | undefined {
  const [vv, setVv] = useState<{ top: number; height: number }>();
  useEffect(() => {
    const v = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!v) return;
    const update = () => setVv({ top: v.offsetTop, height: v.height });
    update();
    v.addEventListener("resize", update);
    v.addEventListener("scroll", update);
    return () => {
      v.removeEventListener("resize", update);
      v.removeEventListener("scroll", update);
    };
  }, []);
  return vv;
}

export interface PhonePlayProps {
  stage: Stage;
  /** the game is working: a model call, a roll in flight */
  busy: boolean;
  /** how many lines the narration has, for the unread dot */
  narrated: number;
  /** how many rooms the player has stood in, for the map's dot */
  explored: number;
  pc: CharacterView;
  tab: Tab;
  onTab(tab: Tab): void;
  onMainMenu?: () => void;
  map: ReactNode;
  chat: ReactNode;
  sheet: ReactNode;
}

export function PhonePlay({ stage, busy, narrated, explored, pc, tab, onTab, onMainMenu, map, chat, sheet }: PhonePlayProps) {
  const tone = STAGE_TONE[stage];
  const vv = useVisualViewport();

  /**
   * UNREAD: narration has arrived since the player last had Chat open.
   *
   * A count rather than a flag, so it is derived and cannot stick: whatever was
   * on the page when they were last there is `seen`, and the dot is anything
   * past it. Starts at everything, so a resumed run is not all unread.
   */
  const [seen, setSeen] = useState(narrated);
  useEffect(() => {
    if (tab === "chat") setSeen(narrated);
  }, [tab, narrated]);
  const unread = tab !== "chat" && narrated > seen;

  /**
   * THE MAP'S BADGE: the player stepped into a room they had never stood in.
   * Kept the same way as the chat's — a count, caught up while the map is open.
   */
  const [mapSeen, setMapSeen] = useState(explored);
  useEffect(() => {
    if (tab === "map") setMapSeen(explored);
  }, [tab, explored]);
  const newRoom = tab !== "map" && explored > mapSeen;

  /**
   * THE SHEET'S BADGE: anything on the sheet changed out of sight — hit points
   * either way, an item gained, lost or worn, a condition, a stat.
   *
   * The whole view as a string is the cheapest honest "changed": a new run
   * object with the same character in it compares equal, and nothing has to
   * list which fields count. Caught up while the sheet is open, so a change made
   * in front of the player never badges.
   */
  const sheetSig = JSON.stringify(pc);
  const [sheetSeen, setSheetSeen] = useState(sheetSig);
  useEffect(() => {
    if (tab === "sheet") setSheetSeen(sheetSig);
  }, [tab, sheetSig]);
  const sheetNews = tab !== "sheet" && sheetSig !== sheetSeen;

  // The HP chip's flash, which says a drop happened whichever tab is open.
  const drops = useDrops(pc);

  /**
   * SWIPE, ANYWHERE ON THE SCREEN, to the tab on that side.
   *
   * Except where a finger already means something sideways: on the map, a drag
   * pans the paper, and in the text box a drag moves the caret or selects. Those
   * mark themselves `data-no-swipe` (the map) or are fields. A second finger
   * makes it a pinch, never a swipe.
   */
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null);
  function onTouchStart(e: React.TouchEvent) {
    const target = e.target as Element;
    if (e.touches.length > 1 || target.closest("[data-no-swipe], textarea, input")) {
      touchStart.current = null;
      return;
    }
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;
    if (Date.now() - start.t > SWIPE_MAX_MS) return;
    const next = swipeTo(tab, dx);
    if (next !== tab) onTab(next);
  }

  const panel = (id: Tab) =>
    `absolute inset-0 ${tab === id ? "" : "pointer-events-none invisible"}`;

  return (
    <main
      className={`fixed inset-x-0 flex flex-col bg-paper text-ink ${vv ? "" : "top-0 h-dvh"}`}
      style={vv ? { top: vv.top, height: vv.height } : undefined}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={() => (touchStart.current = null)}
    >
      {/* THE TOP BAR: the way out, what the game wants, and how hurt you are. */}
      <header className="grid h-[52px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-rule bg-paper px-4">
        <div className="min-w-0">{onMainMenu && <GameMenu onMainMenu={onMainMenu} busy={busy} compact />}</div>
        <span
          className="truncate text-center font-mono text-[10px] uppercase tracking-[0.16em]"
          style={{ color: tone.label }}
        >
          {STAGE_NAME[stage]}
        </span>
        <div className="flex justify-end">
          <button
            type="button"
            key={drops.hp?.key}
            onClick={() => onTab("sheet")}
            aria-label={`Hit points ${pc.hp.current} of ${pc.hp.max} — open the character sheet`}
            className="flex h-9 items-baseline gap-1 whitespace-nowrap border border-rule px-2.5 pt-[7px]"
            style={drops.hp ? { animation: `flash ${MARK_MS}ms ease-out` } : undefined}
          >
            <span className="font-mono text-[9px] text-graphite">HP</span>
            <span
              className="font-display text-[17px] font-bold leading-none"
              style={{ color: hurt(pc) ? "var(--color-torch-deep)" : "var(--color-ink)" }}
            >
              {pc.hp.current}
            </span>
            <span className="font-mono text-[11px] text-graphite">/ {pc.hp.max}</span>
          </button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <section className={`${panel("map")} overflow-y-auto`} aria-hidden={tab !== "map"} aria-label="Map">
          {map}
        </section>
        <section className={`${panel("chat")} flex flex-col`} aria-hidden={tab !== "chat"} aria-label="Chat">
          {chat}
        </section>
        <section className={`${panel("sheet")} overflow-y-auto bg-panel`} aria-hidden={tab !== "sheet"} aria-label="Character">
          {sheet}
        </section>

        {/* Over whichever tab raised it — and the provider puts it down when
            the tab changes, so in practice that is always the map. Pressing its
            verb sends a turn, and the turn is read in Chat. */}
        <InspectSheet
          className="absolute inset-x-0 bottom-0 z-10 max-h-[75%] overflow-y-auto"
          onActed={() => onTab("chat")}
        />
      </div>

      <nav
        role="tablist"
        aria-label="Play"
        className="flex shrink-0 border-t border-rule bg-paper pb-[env(safe-area-inset-bottom)]"
      >
        {TABS.map((t) => {
          const active = tab === t.id;
          // Chat wears the stage's colour whether or not it is open, so a roll
          // waiting on the player shows on the tab bar from the map.
          const ink = t.id === "chat" ? tone.label : active ? "var(--color-ink)" : "var(--color-graphite)";
          const dot = (t.id === "chat" && unread) || (t.id === "map" && newRoom) || (t.id === "sheet" && sheetNews);
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-tab={t.id}
              onClick={() => onTab(t.id)}
              className="tab relative h-14 min-w-0 basis-0 font-mono uppercase tracking-[0.14em]"
              style={{
                flexGrow: active ? 1.8 : 1,
                fontSize: active ? 14 : 11,
                color: ink,
                fontWeight: active ? 700 : 400,
              }}
            >
              {/* The rule across the top of the open tab. Grows from the
                  middle as the tab does, so the two read as one movement. */}
              <span
                aria-hidden
                className="tab-rule absolute inset-x-0 top-0 h-[2px]"
                style={{ background: ink, transform: `scaleX(${active ? 1 : 0})` }}
              />
              <span className="relative inline-block max-w-full truncate px-2 align-middle">
                {t.label}
                {dot && (
                  <span
                    data-unread
                    aria-label="new"
                    className="absolute right-0 top-0 h-[7px] w-[7px] rounded-full bg-torch"
                  />
                )}
              </span>
              {/* The game is working. The same sweep as under the narration,
                  so it reads as the same news from wherever the player is. */}
              {t.id === "chat" && busy && (
                <span
                  aria-label="Working"
                  className="absolute inset-x-4 bottom-2.5 h-[2px] overflow-hidden"
                  style={{ background: "var(--color-rule-faint)" }}
                >
                  <span
                    className="block h-full w-1/3"
                    style={{ background: ink, animation: "sweep 1.35s ease-in-out infinite" }}
                  />
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </main>
  );
}
