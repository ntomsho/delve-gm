/**
 * THE END OF THE RUN
 * ==================
 *
 * The one screen in the game that is allowed to take the whole page.
 *
 * Everything else here is a panel in a three-region layout that never
 * interrupts, because the player is in the middle of something. This is the
 * moment they are not: the delve is over, there is no next move, and the four
 * endings are the only four things this game is really about. So it comes up
 * over the top, and it is dismissable rather than modal — the map and the
 * scrollback are still the record of what just happened, and a player who wants
 * to read back through it should not have to leave the run to do so.
 *
 * WHAT IT SAYS, IN THE ORDER IT MATTERS:
 *
 *   the ending      which of the four, in prose
 *   the take        what they are carrying that they did not go down with,
 *                   and whether they keep it
 *   the score       what the delve was worth, per accomplishment
 *   the death       what the last turn looked like, when there was one
 *
 * ONE RULE ABOUT LOOT, SAID ONCE. Walking out alive is what makes the pack
 * yours. Whether the objective came with you decides which ending it was and
 * nothing else — an escape keeps every coin of what it found. See
 * `keepsWhatTheyFound`, which is where the rule is, and `commitTurn`, which is
 * what enforces it against the database.
 */

import { useEffect } from "react";
import type { RunTally } from "../../gameplay/tally/tally-pass.ts";
import { levelsOwed, XP_PER_LEVEL } from "../../rules/knave/level-up.ts";
import type { DeathReport, RunLoot } from "../../gameplay/mechanics/loot.ts";

export type Ending = "dead" | "escaped" | "goal_met" | "abandoned";

export const ENDINGS: Record<Ending, { heading: string; body: string; warm: boolean }> = {
  dead: {
    heading: "The run ends here",
    body: "Your hit points reached zero. You are still down there, and so is everything you were carrying.",
    warm: false,
  },
  /*
   * NOT A FAILURE, AND THE COPY HAS TO SAY SO.
   *
   * This used to read "with your life and nothing else", which was wrong twice
   * over: they keep the whole pack, and cutting your losses is a decision rather
   * than a defeat. An escape is the ending a careful player chooses, and the
   * screen should not sound disappointed in them for it.
   */
  escaped: {
    heading: "The run ends unfinished",
    body: "You climbed out into the open air alive, and everything in your pack is yours. The dungeon is still down there, and so is what you went in for.",
    warm: false,
  },
  goal_met: {
    heading: "The run ends well",
    body: "You have what you came for, and the way out is behind you.",
    warm: true,
  },
  abandoned: {
    heading: "The run is abandoned",
    body: "You left this one where it stood. Nothing that happened down here follows your character back up — no loot, no experience, and no mark on them. They are free to go somewhere else.",
    warm: false,
  },
};

export interface EndOfRunProps {
  stage: Ending;
  /** CLOSED turns — the run has no turn in progress to add */
  turns: number;
  /** what is in the pack that was not in it at the start */
  loot: RunLoot;
  /** true when this ending lets them keep it — see `keepsWhatTheyFound` */
  keeps: boolean;
  /**
   * What the delve was worth.
   *
   * Absent on a death and on an abandonment, neither of which is scored, and
   * absent for the few seconds between the ending landing and the scoring call
   * coming back. The screen renders without it and gains the section when it
   * arrives, rather than holding the whole ending back on a call that might
   * never return.
   */
  tally?: RunTally;
  /** the character's total, INCLUDING this run's award */
  xpTotal?: number;
  /**
   * What level they are as the run ends, so the screen can say a level is
   * waiting rather than only how far off the next one is. Optional beside
   * `xpTotal` and read only with it — one without the other answers nothing.
   */
  level?: number;
  /** the last turn, on a run that ended in death */
  death?: DeathReport;
  /** back to the map and the scrollback; the run stays exactly as it is */
  onDismiss(): void;
  /** back to the roster. Absent on a local run, which has no roster. */
  onLeave?: () => void;
}

export function EndOfRun({
  stage,
  turns,
  loot,
  keeps,
  tally,
  xpTotal,
  level,
  death,
  onDismiss,
  onLeave,
}: EndOfRunProps) {
  const { heading, body, warm } = ENDINGS[stage];

  // Escape dismisses, like every other thing in this game that covers the page.
  // Nothing here is destructive and nothing is unsaved, so there is no reason to
  // trap the player in it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      style={{ background: "rgba(34, 32, 28, 0.55)" }}
      role="dialog"
      aria-modal="true"
      aria-label={heading}
    >
      <div
        className="my-auto w-full max-w-[46rem] border-2 bg-paper px-5 py-5 sm:px-8 sm:py-7"
        style={{ borderColor: warm ? "var(--color-torch)" : "var(--color-ink)" }}
      >
        <div
          className="font-mono text-[10px] uppercase tracking-[0.18em]"
          style={{ color: warm ? "var(--color-torch-deep)" : "var(--color-graphite)" }}
        >
          {heading}
        </div>
        <p className="mt-2 max-w-[56ch] font-prose text-[16px] leading-[1.6] text-ink">{body}</p>

        {death && <Death death={death} />}
        <Take loot={loot} keeps={keeps} />
        <Worth stage={stage} tally={tally} xpTotal={xpTotal} level={level} />

        <div
          className="mt-6 flex flex-wrap items-center gap-4 border-t pt-3"
          style={{ borderColor: "var(--color-rule-faint)" }}
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-graphite">
            {turns} turn{turns === 1 ? "" : "s"}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onDismiss}
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-graphite underline-offset-4 transition-colors hover:text-ink hover:underline active:text-torch"
          >
            Look around
          </button>
          {/* Absent on a local run, which has no roster to go back to. */}
          {onLeave && (
            <button
              type="button"
              onClick={onLeave}
              className="border border-ink px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink transition-colors hover:bg-ink hover:text-paper active:bg-graphite active:text-paper"
            >
              Back to characters
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SECTIONS
// ---------------------------------------------------------------------------

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-5 border-t pt-3" style={{ borderColor: "var(--color-rule-faint)" }}>
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-graphite">{label}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

/**
 * WHAT THEY ARE CARRYING, and whether it is theirs.
 *
 * The same list either way. A player who died with four hundred copper of
 * reliquary in the pack should be told what it was — "you lost something" is a
 * worse ending than being shown the thing you lost, and the list is the only
 * place the run ever says what the take actually came to.
 */
function Take({ loot, keeps }: { loot: RunLoot; keeps: boolean }) {
  const empty = loot.found.length === 0 && loot.coin === 0;

  if (empty) {
    return (
      <Section label={keeps ? "What you carried out" : "What you were carrying"}>
        <p className="font-prose text-[14px] leading-[1.55] text-graphite">
          Nothing. You went down with what you had and came back with the same.
        </p>
      </Section>
    );
  }

  return (
    <Section label={keeps ? "What you carried out" : "What you were carrying"}>
      <ul className="space-y-0.5">
        {loot.found.map((l) => (
          <li
            key={l.id}
            className="flex items-baseline justify-between gap-3 font-prose text-[14px] leading-[1.55] text-ink"
          >
            <span className="min-w-0 flex-1">
              {l.name}
              {l.amount && <span className="text-graphite"> · {l.amount}</span>}
            </span>
            <Coin n={l.value} />
          </li>
        ))}
        {loot.coin > 0 && (
          <li className="flex items-baseline justify-between gap-3 font-prose text-[14px] leading-[1.55] text-ink">
            <span className="min-w-0 flex-1">Coin</span>
            <Coin n={loot.coin} />
          </li>
        )}
      </ul>

      <div
        className="mt-2 flex items-baseline justify-between gap-3 border-t pt-1.5"
        style={{ borderColor: "var(--color-rule-faint)" }}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-graphite">
          {keeps ? "Yours" : "Lost"}
        </span>
        <span
          className="font-mono text-[11px] tracking-[0.08em]"
          style={{ color: keeps ? "var(--color-torch-deep)" : "var(--color-graphite)" }}
        >
          {loot.total.toLocaleString()} cp
        </span>
      </div>

      {/* THE RULE, once, where it applies. */}
      {!keeps && (
        <p className="mt-2 max-w-[56ch] font-prose text-[13px] leading-[1.5] text-graphite">
          You keep what you find only if you come back up with it. None of this reaches your
          character sheet.
        </p>
      )}
    </Section>
  );
}

/**
 * WHAT THE DELVE WAS WORTH.
 *
 * Every line is an accomplishment: something killed, opened, found, solved, or
 * got past. Getting past a thing without fighting it is on this list and worth
 * the same as anything else — that is the whole point of rating risk rather than
 * counting bodies.
 *
 * The two unscored endings say why rather than showing an empty section. A blank
 * where a score should be reads as a bug; "a dead character earns nothing" reads
 * as a rule.
 */
function Worth({
  stage,
  tally,
  xpTotal,
  level,
}: {
  stage: Ending;
  tally?: RunTally;
  xpTotal?: number;
  level?: number;
}) {
  if (stage === "dead" || stage === "abandoned") {
    return (
      <Section label="What it was worth">
        <p className="font-prose text-[14px] leading-[1.55] text-graphite">
          {stage === "dead"
            ? "Nothing. Experience is what you carry back out, and you did not come back out."
            : "Nothing. A delve nobody finished is not scored."}
        </p>
      </Section>
    );
  }

  // The ending landed and the scoring call has not come back yet. Said plainly,
  // because the alternative is a screen that looks finished and is not.
  if (!tally) {
    return (
      <Section label="What it was worth">
        <p className="font-prose text-[14px] leading-[1.55] text-graphite">Being reckoned up…</p>
      </Section>
    );
  }

  if (tally.awards.length === 0) {
    return (
      <Section label="What it was worth">
        <p className="font-prose text-[14px] leading-[1.55] text-graphite">
          You got out without answering anything the place asked of you.
        </p>
      </Section>
    );
  }

  const total = xpTotal ?? tally.total;
  const toGo = XP_PER_LEVEL - (total % XP_PER_LEVEL);
  const owed = level === undefined ? 0 : levelsOwed(total, level);

  return (
    <Section label="What it was worth">
      <ul className="space-y-1">
        {tally.awards.map((a) => (
          <li
            key={a.challengeId}
            className="flex items-baseline justify-between gap-3 font-prose text-[14px] leading-[1.55] text-ink"
          >
            <span className="min-w-0 flex-1">{a.why}</span>
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-pencil">
              {a.risk}
            </span>
            <span className="w-[4.5rem] shrink-0 text-right font-mono text-[11px] tracking-[0.08em] text-graphite">
              {a.xp} xp
            </span>
          </li>
        ))}
      </ul>

      <div
        className="mt-2 flex items-baseline justify-between gap-3 border-t pt-1.5"
        style={{ borderColor: "var(--color-rule-faint)" }}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-graphite">
          Earned
        </span>
        <span
          className="font-mono text-[11px] tracking-[0.08em]"
          style={{ color: "var(--color-torch-deep)" }}
        >
          {tally.total.toLocaleString()} xp
        </span>
      </div>

      {/* The running total, and then either the distance or the news.
        *
        * LEVELLING IS BUILT NOW, and it is taken on the roster — which is where
        * this sentence sends them, because the level is not something this
        * screen can hand over. A run that crossed the track says so; one that
        * did not still gets the distance, which is a distance and not a promise.
        *
        * `owed` counts what the whole career has bought and not been paid,
        * so a player who has been sitting on an unclaimed level for three runs
        * is reminded rather than told about only the one they just earned. */}
      {xpTotal !== undefined && (
        <p
          className={`mt-1.5 font-mono text-[10px] uppercase tracking-[0.12em] ${
            owed > 0 ? "text-torch-deep" : "text-pencil"
          }`}
        >
          {total.toLocaleString()} xp in all ·{" "}
          {owed > 0
            ? `${owed === 1 ? "a level is" : `${owed} levels are`} waiting on the roster`
            : `${toGo.toLocaleString()} toward the next level`}
        </p>
      )}
    </Section>
  );
}

/**
 * THE LAST TURN.
 *
 * `killer` is an accusation and `present` is not — nothing in the entity model
 * marks a creature hostile, so what was standing there and what killed them are
 * two different claims and are rendered as two different sentences.
 */
function Death({ death }: { death: DeathReport }) {
  const others = death.present.filter((p) => p !== death.killer);

  return (
    <Section label="How it happened">
      <p className="max-w-[56ch] font-prose text-[14px] leading-[1.55] text-ink">
        You died in {death.where}, on turn {death.turn}
        {death.killer ? <>, fighting {death.killer}</> : null}.
        {death.lastAction && (
          <>
            {" "}
            The last thing you tried was <span className="text-graphite">“{death.lastAction}”</span>
            .
          </>
        )}
      </p>
      {others.length > 0 && (
        <p className="mt-1.5 max-w-[56ch] font-prose text-[13px] leading-[1.5] text-graphite">
          Also in the room: {others.join(", ")}.
        </p>
      )}
    </Section>
  );
}

/** Copper, or nothing at all for the things nobody would buy. */
function Coin({ n }: { n: number }) {
  return (
    <span className="shrink-0 font-mono text-[10px] tracking-[0.08em] text-graphite">
      {n > 0 ? `${n.toLocaleString()} cp` : "—"}
    </span>
  );
}
