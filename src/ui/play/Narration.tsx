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
import { D20, Die, DiceRoll } from "./DiceRoll.tsx";
import type { LogEntry } from "../../store/game.ts";
import type { RolledOutcome } from "../../runtime/types.ts";
import { isLoss, type Effect, type FoeRoll } from "../../runtime/effects.ts";

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
  /** `outcome` is absent on rolls logged before it was kept; those stay text */
  | { kind: "roll"; text: string; outcome?: RolledOutcome }
  | { kind: "effects"; effects: Effect[] }
  | { kind: "foe"; foe: FoeRoll[] };

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
      case "effects":
        return { kind: "effects", effects: e.effects ?? [] } as const;
      case "foe":
        return { kind: "foe", foe: e.foe ?? [] } as const;
      case "roll":
        return { kind: "roll", text: e.text, ...(e.outcome ? { outcome: e.outcome } : {}) } as const;
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

/**
 * THE DICE THAT HURT THEM — a creature's attack, a fall — above the prose that
 * tells it. The d20 that was thrown, hit or miss, and the damage dice; never
 * the number it had to beat, which would be the player's own armour handed back
 * as a target. Which rolls reach here is `foeRolls`' decision.
 */
function FoeRolls({ rolls }: { rolls: FoeRoll[] }) {
  if (rolls.length === 0) return null;
  return (
    <ul className="mb-3 space-y-1.5" aria-label="Rolls against you">
      {rolls.map((r, i) => (
        <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
          {r.d20 && <D20 face={r.d20.kept} size={20} bold={r.d20.success} />}
          <span>{r.label}</span>
          {r.d20 && <span className="text-ink">{r.d20.total}</span>}
          {r.d20 && (
            <span
              className="font-bold tracking-[0.16em]"
              style={{ color: r.d20.success ? "var(--color-torch-deep)" : "var(--color-graphite)" }}
            >
              {r.d20.success ? "Hit" : "Miss"}
              {r.d20.nat20 ? " · critical" : ""}
            </span>
          )}
          {r.damage && (
            <>
              {r.damage.rolls.map((face, k) => (
                <Die key={k} face={face} size={18} bold />
              ))}
              <span className="font-bold text-torch-deep">{r.damage.total} damage</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * WHAT THE TURN COST, set apart from the prose.
 *
 * Prose can carry "your left arm burns" in the middle of a sentence about the
 * room and the player reads straight past it. This cannot be read past: hit
 * points with the arithmetic, and every item damaged, destroyed, lost or knocked
 * off, each as its own mark. Losses in torch, gains quiet — a found bottle
 * should be noticed, not compete with a wound. See `effects.ts` for where it
 * comes from.
 */
function EffectsLine({ effects }: { effects: Effect[] }) {
  if (effects.length === 0) return null;
  const hurt = effects.some(isLoss);
  return (
    <ul
      className="mb-4 flex max-w-[62ch] flex-wrap gap-x-2 gap-y-1.5 border-l-2 py-1 pl-3"
      style={{ borderColor: hurt ? "var(--color-torch)" : "var(--color-rule)" }}
      aria-label="What this turn did to you"
    >
      {effects.map((e, i) => (
        <li
          key={i}
          className="border px-2 py-[2px] font-mono text-[11px] uppercase tracking-[0.08em]"
          style={
            isLoss(e)
              ? { borderColor: "var(--color-torch)", color: "var(--color-torch-deep)", background: "var(--color-torch-wash)" }
              : { borderColor: "var(--color-rule)", color: "var(--color-graphite)" }
          }
        >
          {effectText(e)}
        </li>
      ))}
    </ul>
  );
}

function effectText(e: Effect): string {
  switch (e.kind) {
    case "hp": {
      const d = e.to - e.from;
      const sign = d > 0 ? "+" : "−";
      return e.to <= 0 ? `${sign}${Math.abs(d)} HP · ${e.from} → 0 · dead` : `${sign}${Math.abs(d)} HP · ${e.from} → ${e.to}`;
    }
    case "damaged":
      return e.to <= 0 ? `${e.name} broken` : `${e.name} damaged · ${e.to}/${e.of}`;
    case "destroyed":
      return `${e.name} destroyed`;
    case "lost":
      return `Lost: ${e.name}`;
    case "gained":
      return `Gained: ${e.name}`;
    case "unequipped":
      return `${e.name} came off`;
    case "used":
      return `${e.name} · ${e.from} → ${e.to}`;
  }
}

export function Narration({
  items,
  busy,
  resolving,
}: {
  items: NarrationItem[];
  busy?: boolean;
  /**
   * The newest roll is being written up. If it is also the newest item, it is
   * drawn live — the die tumbling and landing — while the prose is awaited.
   */
  resolving?: boolean;
}) {
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

        if (item.kind === "foe") {
          return <FoeRolls key={i} rolls={item.foe} />;
        }

        if (item.kind === "effects") {
          return <EffectsLine key={i} effects={item.effects} />;
        }

        if (item.kind === "roll" && item.outcome) {
          return <DiceRoll key={i} outcome={item.outcome} live={!!resolving && i === items.length - 1} />;
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
