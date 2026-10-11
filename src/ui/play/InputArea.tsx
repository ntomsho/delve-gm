/**
 * THE INPUT AREA
 *
 * The most important thing in the brief: the game is always in exactly one
 * stage, and the area around the input must always say what the game wants.
 * A player should never wonder whether it is their move.
 *
 * Every stage is handled here — there is no default branch, and `Record<Stage,
 * …>` in the theme means adding a stage without deciding how it reads will not
 * compile. That is the point of routing it through one component.
 *
 * `roll_offered` carries the most weight. It shows the terms of the bet —
 * which ability, what edge — and never the difficulty. And it leaves the input
 * OPEN, because arguing instead of rolling is a legitimate move and the
 * interface should say so.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { STAGE_HINT, STAGE_NAME, STAGE_TONE } from "../theme.ts";
import { acceptsInput, isTerminal, type Stage, type RollSpec } from "../../runtime/types.ts";
import { ENDINGS, type Ending } from "./EndOfRun.tsx";

export interface InputAreaProps {
  stage: Stage;
  roll?: RollSpec;
  /** CLOSED turns — the tracker adds the one in progress, the end card does not */
  turns: number;
  /** kept across an error so a retry costs the player nothing */
  draft: string;
  onDraft(text: string): void;
  onSubmit(text: string): void;
  onRoll(): void;
  onRetry(): void;
  /** End the run without playing it out. */
  onAbandon(): void;
  /**
   * Bring the end-of-run screen back up.
   *
   * The overlay comes up on its own when the run ends and can be dismissed, so
   * this is the way back to it — the summary is the only place the loot and the
   * score are stated, and a player who dismissed it to look at the map must not
   * have lost them.
   */
  onShowSummary(): void;
}

/**
 * How tall the box is allowed to get before it starts scrolling instead.
 *
 * Six lines: enough for the longest action anyone actually types, short enough
 * that the narration above it is never squeezed off the screen. Measured from
 * the box's OWN line height rather than written in pixels, so it follows the
 * type scale — the fallback is `text-[15px] leading-relaxed`, which is what the
 * textarea is set in, for the case where there is nothing to measure.
 */
const MAX_LINES = 6;
const FALLBACK_LINE_HEIGHT = 15 * 1.625;

function maxHeight(el: HTMLTextAreaElement): number {
  const measured = Number.parseFloat(getComputedStyle(el).lineHeight);
  return MAX_LINES * (Number.isFinite(measured) && measured > 0 ? measured : FALLBACK_LINE_HEIGHT);
}

const EDGE_LABEL: Record<RollSpec["edge"], string> = {
  none: "",
  advantage: " · ADVANTAGE",
  disadvantage: " · DISADVANTAGE",
};

/** The terms of the bet. Never the DC — that is the referee's business. */
function RollOffer({ roll, onRoll }: { roll: RollSpec; onRoll(): void }) {
  return (
    <div className="mb-3 border-l-2 border-torch bg-torch-wash py-2 pl-3">
      <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-torch-deep">
        A roll is on the table
      </div>
      <p className="mt-1.5 font-prose text-[15px] text-ink">{roll.description}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
          {roll.ability} {roll.kind} · {roll.bonus >= 0 ? "+" : ""}
          {roll.bonus}
          {EDGE_LABEL[roll.edge]}
        </span>
        <button
          type="button"
          onClick={onRoll}
          className="bg-torch px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-paper transition-colors hover:bg-torch-deep active:bg-ink"
        >
          Roll
        </button>
      </div>
    </div>
  );
}

function Error({ onRetry }: { onRetry(): void }) {
  // The software talking, not the referee. Says what happened and what to do.
  return (
    <div className="mb-3 border-l-2 border-torch py-2 pl-3">
      <p className="font-mono text-[12px] text-ink">
        The referee didn&rsquo;t answer.
      </p>
      <p className="mt-1 font-mono text-[11px] text-graphite">
        Your action wasn&rsquo;t lost — it&rsquo;s still in the box below.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 border border-torch px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-torch transition-colors hover:bg-torch-wash active:bg-torch active:text-paper"
      >
        Try again
      </button>
    </div>
  );
}

/**
 * THE RUN IS OVER, and the summary is somewhere else.
 *
 * A terminal stage already closes the input area — `acceptsInput` sees to that —
 * but a game that has ended should look ended rather than merely muted, and this
 * is what is left in the strip where the box used to be.
 *
 * THE CARD THAT USED TO BE HERE IS NOW `EndOfRun.tsx`, over the whole page. It
 * grew a loot list, a score and a cause of death, and none of that fits under a
 * textarea — but the overlay is dismissable, so this has to be able to bring it
 * back. That is the whole of this component: a statement and a way back to it.
 */
function RunOver({ stage, turns, onShow }: { stage: Ending; turns: number; onShow(): void }) {
  return (
    <div
      className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-l-2 py-1.5 pl-3"
      style={{ borderColor: stage === "goal_met" ? "var(--color-torch)" : "var(--color-ink)" }}
      role="status"
    >
      <span
        className="font-mono text-[9px] uppercase tracking-[0.16em]"
        style={{
          color:
            stage === "goal_met" ? "var(--color-torch-deep)" : "var(--color-graphite)",
        }}
      >
        {ENDINGS[stage].heading}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-graphite">
        {turns} turn{turns === 1 ? "" : "s"}
      </span>
      <button
        type="button"
        onClick={onShow}
        className="font-mono text-[9px] uppercase tracking-[0.14em] text-torch underline-offset-4 transition-colors hover:underline active:text-torch-deep"
      >
        See the reckoning
      </button>
    </div>
  );
}


/**
 * WALK AWAY, from inside the run.
 *
 * The Characters screen has the same verb, and the two are for different
 * moments: that one is for a player who finds a character they cannot use, this
 * one is for a player who has decided, mid-dungeon, that they are done. Asking
 * them to close the tab and go looking for the row would be making them route
 * around the interface to do something the interface should offer.
 *
 * Deliberately quiet, and deliberately two presses. It is not a move in the
 * game and should not sit where moves sit.
 */
function Abandon({ onAbandon }: { onAbandon(): void }) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        className="font-mono text-[9px] uppercase tracking-[0.14em] text-pencil underline decoration-rule underline-offset-4 transition-colors hover:text-torch active:text-torch-deep"
      >
        Abandon run
      </button>
    );
  }

  return (
    <span className="flex items-baseline gap-3 font-mono text-[9px] uppercase tracking-[0.14em]">
      <span className="text-graphite">Leave this run for good?</span>
      {/* Both take a hover and a press like anything else pressable. They are
          two words in a sentence, so the state is the colour rather than a box —
          but a control that never changes under the cursor reads as prose. */}
      <button
        type="button"
        onClick={onAbandon}
        className="text-torch underline decoration-torch underline-offset-4 transition-colors hover:text-torch-deep active:text-ink"
      >
        Abandon
      </button>
      <button
        type="button"
        onClick={() => setAsking(false)}
        className="text-graphite underline decoration-rule underline-offset-4 transition-colors hover:text-ink active:text-ink"
      >
        Keep playing
      </button>
    </span>
  );
}

export function InputArea(props: InputAreaProps) {
  const { stage, roll, turns, draft, onDraft, onSubmit, onRoll, onRetry, onAbandon } = props;
  const open = acceptsInput(stage);
  const tone = STAGE_TONE[stage];
  const box = useRef<HTMLTextAreaElement>(null);

  // Keyboard-first: the player should never need the mouse on a normal turn,
  // so focus returns to the box the moment the game wants something.
  useEffect(() => {
    if (open) box.current?.focus();
  }, [open, stage]);

  // THE BOX GROWS WITH WHAT IS IN IT.
  //
  // A `rows={1}` textarea scrolls its own first line out of sight while a long
  // action is still being typed, which is the one moment a player most wants to
  // read back what they wrote.
  //
  // Sized off the CONTENT rather than off a key handler, because the draft
  // changes in four ways — typing, pasting, Escape clearing it, and the store
  // emptying it after a send — and only one of those is a keystroke. Measuring
  // needs `height: auto` first: `scrollHeight` on an element already stretched
  // to fit its text is the height it currently has, so it can grow and never
  // shrink.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    // Zero means nothing has been laid out — jsdom, or a box that is not on the
    // screen. Leaving the height alone is the only safe answer.
    if (el.scrollHeight === 0) return;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight(el))}px`;
  }, [draft, stage]);

  const send = () => {
    const text = draft.trim();
    if (text && open) onSubmit(text);
  };

  return (
    <div className="border-t px-8 py-4" style={{ borderColor: tone.rule }}>
      <div className="mb-2 flex items-baseline justify-between">
        <span
          className="font-mono text-[10px] uppercase tracking-[0.16em]"
          style={{ color: tone.label }}
        >
          {STAGE_NAME[stage]}
        </span>
        {/*
         * THE TURN IN PROGRESS, not the turns behind.
         *
         * `turnCount` is closed turns, so the number the player is living
         * through is one more — which is also the number `assemble.ts` puts in
         * front of the referee, and the two should never be off by one from each
         * other when a player is reading both.
         *
         * Gone at a terminal stage: the run has no turn in progress, and the
         * end-of-run card states the closed count a few lines below. Two
         * different numbers labelled "turn" on one screen would be worse than
         * no tracker at all.
         */}
        {!isTerminal(stage) && (
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-pencil">
            Turn {turns + 1}
          </span>
        )}
      </div>

      {stage === "roll_offered" && roll && <RollOffer roll={roll} onRoll={onRoll} />}
      {stage === "error" && <Error onRetry={onRetry} />}
      {(stage === "dead" ||
        stage === "escaped" ||
        stage === "goal_met" ||
        stage === "abandoned") && (
        <RunOver stage={stage} turns={turns} onShow={props.onShowSummary} />
      )}

      {/* The tabletop convention, and it is doing real work. */}
      {stage === "awaiting_action" && (
        <p className="mb-2 font-prose text-[15px] text-ink">What do you do?</p>
      )}

      <div
        className="flex items-start gap-2 border px-3 py-2"
        style={{
          borderColor: open ? "var(--color-ink)" : "var(--color-rule-faint)",
          background: open ? "var(--color-paper)" : "var(--color-desk)",
          opacity: open ? 1 : 0.55,
        }}
      >
        <span className="select-none pt-[1px] font-mono text-[14px] text-graphite">&rsaquo;</span>
        <textarea
          ref={box}
          value={draft}
          disabled={!open}
          rows={1}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
            if (e.key === "Escape") onDraft("");
          }}
          className="flex-1 resize-none overflow-y-auto bg-transparent font-prose text-[15px] leading-relaxed text-ink outline-none disabled:cursor-not-allowed"
          aria-label={STAGE_NAME[stage]}
        />
        {open && (
          <span
            className="mt-[3px] inline-block h-[15px] w-[7px] bg-ink"
            style={{ animation: "caret 1.05s step-end infinite" }}
            aria-hidden
          />
        )}
      </div>

      <div className="mt-1.5 flex items-baseline justify-between gap-4">
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-graphite">
          {STAGE_HINT[stage]}
        </span>
        {/*
         * The quiet corner: the way out of the run, and the keys.
         *
         * Abandon is offered for as long as the run is live, INCLUDING while the
         * referee is working. That is deliberate — a player sitting in front of a
         * `thinking` that is never going to finish is exactly who needs it, and
         * the server takes it whatever stage the row is standing in.
         */}
        <span className="flex items-baseline gap-5">
          {!isTerminal(stage) && <Abandon onAbandon={onAbandon} />}
          {open && (
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-pencil">
              ↵ send · ⇧↵ newline · ⎋ clear
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
