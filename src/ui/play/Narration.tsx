/**
 * The narration column — the conversation, and the primary medium.
 *
 * Not a chat app: no bubbles, no avatars. The referee's prose is the page; the
 * player's own words are set apart by a marker and a different ink, the way a
 * transcript distinguishes speakers without boxing them.
 *
 * A room arrival gets a real break — a rule, the room's number and name in
 * display type — because the brief is explicit that arriving somewhere should
 * feel like arriving somewhere, not like another paragraph in a log.
 */

import { useEffect, useRef } from "react";
import type { LogEntry } from "../../store/game.ts";

export interface Arrival {
  kind: "arrival";
  roomName: string;
  /** e.g. "ROOM 14 · DESCENT III" */
  label?: string;
  prose: string;
}

/**
 * The briefing, above the first room.
 *
 * `objective` is the goal as its own line. It is also inside the prose — the
 * Dungeon Pass is told to say it plainly there — but it is repeated here
 * because the one thing a player must be able to find again an hour in is what
 * they came for, and hunting for it in a paragraph they read once is not
 * finding it.
 */
export interface Opening {
  kind: "opening";
  dungeonName: string;
  objective: string;
  prose: string;
}

export type NarrationItem =
  | Opening
  | Arrival
  | { kind: "referee"; prose: string }
  | { kind: "player"; text: string }
  | { kind: "roll"; text: string };

/**
 * Turn the stored scrollback into something renderable.
 *
 * From `log`, not `transcript`: the transcript is what the referee is shown and
 * is cleared every time a turn closes. `roomName` has to be looked up because
 * the log stores an id — names are never writable, so the current one is always
 * the right one.
 */
export function toItems(
  log: LogEntry[],
  roomName: (id: string) => string,
  dungeon?: { name: string; objective: string }
): NarrationItem[] {
  return log.map((e) => {
    switch (e.kind) {
      case "opening":
        return {
          kind: "opening",
          dungeonName: dungeon?.name ?? "",
          objective: dungeon?.objective ?? "",
          prose: e.text,
        } as const;
      case "arrival":
        return { kind: "arrival", roomName: roomName(e.roomId ?? ""), prose: e.text } as const;
      case "player":
        return { kind: "player", text: e.text } as const;
      case "roll":
        return { kind: "roll", text: e.text } as const;
      default:
        return { kind: "referee", prose: e.text } as const;
    }
  });
}

function Prose({ children }: { children: string }) {
  // A measure that stays readable for an hour. Paragraphs split on blank lines
  // so the referee can pace its own prose.
  return (
    <>
      {children.split(/\n{2,}/).map((para, i) => (
        <p key={i} className="mb-4 max-w-[62ch] font-prose text-[16px] leading-[1.6] text-ink">
          {para}
        </p>
      ))}
    </>
  );
}

export function Narration({ items, busy }: { items: NarrationItem[]; busy?: boolean }) {
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, busy]);

  return (
    <div className="flex-1 overflow-y-auto px-8 py-6">
      {items.map((item, i) => {
        if (item.kind === "opening") {
          return (
            <section key={i} className="mb-8">
              {item.dungeonName && (
                <h1 className="mb-4 font-display text-[26px] font-bold leading-tight text-ink">
                  {item.dungeonName}
                </h1>
              )}
              <Prose>{item.prose}</Prose>
              {item.objective && (
                // The one line they will come back to. Kept legible from across
                // the room, because it is the answer to "why am I down here".
                <div className="mt-5 border-l-2 border-torch py-2 pl-3">
                  <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-torch-deep">
                    What you came for
                  </div>
                  <p className="mt-1.5 max-w-[52ch] font-prose text-[15px] leading-[1.55] text-ink">
                    {item.objective}
                  </p>
                </div>
              )}
            </section>
          );
        }

        if (item.kind === "arrival") {
          return (
            <section key={i} className="mb-6">
              {/* The break that makes an arrival an arrival. */}
              <div className="mb-3 mt-2 flex items-center gap-3">
                <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-graphite">
                  {item.label ?? "Arriving"}
                </span>
                <span className="h-px flex-1 bg-rule" />
              </div>
              <h2 className="mb-3 font-display text-[22px] font-bold leading-tight text-ink">
                {item.roomName}
              </h2>
              <Prose>{item.prose}</Prose>
            </section>
          );
        }

        if (item.kind === "roll") {
          // The dice, set as a record rather than as prose — it is the one
          // thing on the page the referee did not write.
          return (
            <p
              key={i}
              className="mb-4 font-mono text-[11px] uppercase tracking-[0.1em] text-graphite"
            >
              <span className="mr-2 select-none text-torch">◇</span>
              {item.text}
            </p>
          );
        }

        if (item.kind === "player") {
          return (
            <p
              key={i}
              className="mb-4 max-w-[62ch] font-prose text-[15px] leading-relaxed text-indigo"
            >
              <span className="mr-2 select-none font-mono text-graphite">&rsaquo;</span>
              {item.text}
            </p>
          );
        }

        return (
          <div key={i} className="mb-4">
            <Prose>{item.prose}</Prose>
          </div>
        );
      })}

      {/*
       * The wait. Narration is held back until the commit validates and
       * applies, so there is nothing to stream — an honest indeterminate
       * marker beats a fake one, and the player can see the game is working.
       */}
      {busy && (
        <div className="mb-4 h-px w-40 overflow-hidden bg-rule-faint" aria-label="Working">
          <div
            className="h-full w-1/3 bg-graphite"
            style={{ animation: "sweep 1.35s ease-in-out infinite" }}
          />
        </div>
      )}

      <div ref={end} />
    </div>
  );
}
