/**
 * THE PLAYER'S ROLL, DRAWN.
 *
 * The dice reach the screen before the referee has written a word about them —
 * `/roll` and `/resolve` are two requests for exactly this — so the player
 * watches their own die land and reads success or failure while the prose is
 * still being written, rather than learning the result from it.
 *
 * Two sizes. LIVE is the newest roll while it is being resolved: a d20 that
 * tumbles for under a second and settles on the die that counted, then the sum
 * and the verdict. SETTLED is every roll once its prose has landed: the same
 * facts on one line in the scrollback, with a small die in place of the old ◇.
 *
 * WHAT IT NEVER SHOWS: the difficulty. `outcome.spec.dc` is right there and is
 * the one number the player does not get — the same rule the roll offer keeps
 * (see `RollOffer` in InputArea.tsx). Success or failure is the answer; how far
 * off it was is not theirs to see.
 *
 * THE TUMBLE IS NOT RANDOM. The faces it flickers through are a fixed sequence:
 * nothing on this screen may look like it is choosing a number, and a
 * `Math.random` here would be the one place in the app that did. It only plays
 * when the roll is live, so a reload or a resumed run shows the die settled.
 */

import { useEffect, useState } from "react";
import type { RolledOutcome } from "../../shared/types/turn.ts";

/** Faces shown while the die is in the air, in order. Decoration only. */
const TUMBLE = [7, 14, 3, 19, 11, 6, 17, 2, 12, 9, 15, 4];
const FRAME_MS = 75;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/** A d20 seen face-on: the hexagon outline and the triangle on its front face. */
export function D20({ face, size, dim, bold }: { face: number | string; size: number; dim?: boolean; bold?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden
      className="shrink-0"
      style={{ opacity: dim ? 0.35 : 1 }}
    >
      <polygon
        points="20,2 36,11 36,29 20,38 4,29 4,11"
        fill="var(--color-paper)"
        stroke="var(--color-ink)"
        strokeWidth={bold ? 2 : 1.25}
        strokeLinejoin="round"
      />
      <polygon
        points="20,8 31,27 9,27"
        fill="none"
        stroke="var(--color-rule)"
        strokeWidth={1}
        strokeLinejoin="round"
      />
      <text
        x="20"
        y="22"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="var(--font-mono, ui-monospace, monospace)"
        fontWeight={bold ? 700 : 500}
        fontSize={String(face).length > 1 ? 11 : 13}
        fill="var(--color-ink)"
      >
        {face}
      </text>
    </svg>
  );
}

/**
 * Any other die — a damage die. A plain rounded square, so it can never be
 * mistaken for the d20 that decided whether it was rolled at all.
 */
export function Die({ face, size, bold }: { face: number | string; size: number; bold?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden className="shrink-0">
      <rect
        x="5"
        y="5"
        width="30"
        height="30"
        rx="6"
        fill="var(--color-paper)"
        stroke="var(--color-torch-deep)"
        strokeWidth={bold ? 2 : 1.25}
      />
      <text
        x="20"
        y="21"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="var(--font-mono, ui-monospace, monospace)"
        fontWeight={bold ? 700 : 500}
        fontSize={String(face).length > 1 ? 12 : 14}
        fill="var(--color-ink)"
      >
        {face}
      </text>
    </svg>
  );
}

/** Damage-die faces while they tumble — fixed, like the d20's. */
const DAMAGE_TUMBLE = [3, 1, 5, 2, 6, 4, 2, 5];

function label(o: RolledOutcome): string {
  const edge =
    o.spec.edge === "advantage" ? " · advantage" : o.spec.edge === "disadvantage" ? " · disadvantage" : "";
  return `${o.spec.ability.toUpperCase()} ${o.spec.kind}${edge}`;
}

function sum(o: RolledOutcome): string {
  const sign = o.spec.bonus >= 0 ? "+" : "−";
  return `${o.kept} ${sign}${Math.abs(o.spec.bonus)} = ${o.total}`;
}

function Verdict({ o, large, damageShown = true }: { o: RolledOutcome; large: boolean; damageShown?: boolean }) {
  const special = o.nat20 ? "Critical" : o.nat1 ? "Fumble" : undefined;
  return (
    <span className="flex items-baseline gap-2">
      <span
        className={`font-mono font-bold uppercase tracking-[0.16em] ${large ? "text-[12px]" : "text-[10px]"}`}
        style={{ color: o.success ? "var(--color-torch-deep)" : "var(--color-ink)" }}
      >
        {o.success ? "Success" : "Failure"}
      </span>
      {special && (
        <span className={`font-mono uppercase tracking-[0.14em] text-graphite ${large ? "text-[10px]" : "text-[9px]"}`}>
          {special}
        </span>
      )}
      {o.damage && damageShown && (
        <span className={`font-mono uppercase tracking-[0.12em] text-graphite ${large ? "text-[10px]" : "text-[9px]"}`}>
          {o.damage.expr} → {o.damage.total} damage
        </span>
      )}
    </span>
  );
}

export function DiceRoll({ outcome: o, live }: { outcome: RolledOutcome; live: boolean }) {
  // TWO THROWS ON A HIT: the d20 lands, and only then do the damage dice go up
  // — the order it happens at a table, and the order that makes the second
  // throw mean something. Tumbling only when live, and never for a player who
  // has asked for less motion. Started fresh per mount.
  const end = TUMBLE.length + (o.damage ? DAMAGE_TUMBLE.length : 0);
  const [frame, setFrame] = useState(() => (live && !prefersReducedMotion() ? 0 : end));
  const settled = frame >= TUMBLE.length;
  const damageSettled = frame >= end;

  useEffect(() => {
    if (frame >= end) return;
    const t = setInterval(() => setFrame((f) => f + 1), FRAME_MS);
    return () => clearInterval(t);
  }, [frame >= end, end]);

  // Under advantage or disadvantage two dice are thrown and one counts. If they
  // match, either is "the other", which is the point.
  const dropped = o.rolled.length > 1 ? (o.rolled[0] === o.kept ? o.rolled[1] : o.rolled[0]) : undefined;

  if (!live) {
    return (
      <p className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
        <D20 face={o.kept} size={20} bold />
        <span>{label(o)}</span>
        <span className="text-ink">{sum(o)}</span>
        <Verdict o={o} large={false} />
        {o.damage && o.damage.rolls.map((r, k) => <Die key={k} face={r} size={18} bold />)}
      </p>
    );
  }

  return (
    <div className="mb-5 flex items-center gap-4 border-l-2 py-2 pl-4" style={{ borderColor: "var(--color-torch)" }} role="status">
      <span className="flex items-center gap-2">
        <span className="inline-block" style={settled ? undefined : { animation: "tumble 0.3s linear infinite" }}>
          <D20 face={settled ? o.kept : TUMBLE[frame]!} size={48} bold={settled} />
        </span>
        {/* The other die under advantage or disadvantage, dimmed once it is
            clear it is not the one that counted. */}
        {settled && dropped !== undefined && <D20 face={dropped} size={30} dim />}
      </span>
      <span className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">{label(o)}</span>
        {settled ? (
          <>
            <span className="font-mono text-[15px] text-ink">{sum(o)}</span>
            <Verdict o={o} large damageShown={false} />
          </>
        ) : (
          <span className="font-mono text-[15px] text-pencil">…</span>
        )}
      </span>
      {/* THE DAMAGE, thrown after the hit. One die per die rolled, so a
          critical's extra die is visibly an extra die. */}
      {settled && o.damage && (
        <span className="flex items-center gap-1.5 border-l pl-4" style={{ borderColor: "var(--color-rule)" }}>
          {o.damage.rolls.map((r, k) => (
            <span
              key={k}
              className="inline-block"
              style={damageSettled ? undefined : { animation: "tumble 0.3s linear infinite" }}
            >
              <Die face={damageSettled ? r : DAMAGE_TUMBLE[(frame + k) % DAMAGE_TUMBLE.length]!} size={34} bold={damageSettled} />
            </span>
          ))}
          <span className="ml-1 font-mono text-[15px] font-bold text-torch-deep">
            {damageSettled ? `${o.damage.total} damage` : "…"}
          </span>
        </span>
      )}
    </div>
  );
}
