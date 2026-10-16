/**
 * THE LIBRARY — worlds other people wrote.
 *
 * The screen that makes duplicating reachable: `POST /api/dungeons/:id/duplicate`
 * and a way to walk into a world you already
 * own, but the only id a player could name was one of their own — so nothing was
 * actually shared. This is the shelf.
 *
 * IT NEVER HOLDS A `doc`. What the server sends is a `DungeonSummary` — name,
 * objective, size, level — and that is the whole cross-owner vocabulary. The
 * document is every answer in the world, and a browse screen that could read one
 * would be a walkthrough for a dungeon nobody had walked. Choosing takes a COPY;
 * the copy is what the run is played in.
 *
 * NO MAKER IS NAMED, and that is not an oversight. The only name this project
 * holds for an account is the email address it signed in with, and a shelf that
 * printed it would be a way to enumerate the invite list. A world is offered on
 * what it is.
 *
 * THE CHARACTER COMES WITH THE PLAYER. This screen is reached from a specific
 * person on the roster and the card's button says their name, because the choice
 * being made is not "add this to my library" — it is "send Testy down this one",
 * and the next thing that happens is the dungeon.
 *
 * ── LOADING IN BATCHES, AND WHY THERE ARE TWO TRIGGERS ─────────────────────
 * The sentinel at the foot of the grid is a real button and always has been.
 * An `IntersectionObserver` presses it early when the player scrolls near it,
 * which is the lazy half — but an observer is a convenience that can fail to
 * fire (no layout, a browser that does not have one, a container that never
 * scrolls) and a shelf that then has no way to show its next batch is a shelf
 * with rows nobody can reach. So the button is the floor and the observer is
 * the polish, rather than the button being a fallback that has to be detected
 * into existence.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../create/shared.tsx";
import type { DungeonSummary, LibraryPage } from "../../api-client/dungeons.ts";
import { Ink } from "../play/Illustration.tsx";
import type { PlayerCharacter } from "../../rules/knave/character.ts";

const LABEL = "font-mono text-[9px] tracking-[0.16em] text-graphite uppercase";

/**
 * When a world was written, as something a person reads.
 *
 * Days rather than a date for anything recent, because "3 days ago" is what the
 * shelf is sorted by and a date makes the reader do the subtraction. Beyond a
 * fortnight the date is the more useful fact again.
 */
function written(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 14) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * One world on the shelf.
 *
 * The objective carries the card. Two dungeons of one size and level are told
 * apart by nothing else, and it is the only line here written by the pass that
 * wrote the world — everything around it is a number about it.
 */
function Card({
  dungeon,
  character,
  busy,
  onChoose,
}: {
  dungeon: DungeonSummary;
  character: PlayerCharacter;
  /** This card is the one being taken a copy of. */
  busy: boolean;
  onChoose: () => void;
}) {
  return (
    <li className="flex flex-col border border-rule bg-paper p-5">
      {dungeon.cover && (
        <Ink url={dungeon.cover} className="mb-4 aspect-[3/2] w-full" label={`${dungeon.name}, from outside`} />
      )}
      <div className={LABEL}>{written(dungeon.createdAt)}</div>

      <h2 className="mt-2 font-prose text-[21px] font-semibold leading-tight text-ink">
        {dungeon.name}
      </h2>

      <p className="mt-2 min-h-[3.4em] font-prose text-[14px] leading-snug text-graphite">
        {dungeon.objective || "No objective was written down."}
      </p>

      <div className="mt-3 flex flex-wrap gap-x-4 font-mono text-[11px] text-graphite">
        <span>SIZE {dungeon.size}</span>
        <span>LEVEL {dungeon.level}</span>
        <span>{dungeon.size * 6} ROOMS</span>
      </div>

      {/* Pushed to the bottom, so cards of unequal prose still line their
          buttons up — a grid of controls at six different heights reads as six
          unrelated things. */}
      <div className="mt-auto pt-4">
        <Button
          tone="secondary"
          disabled={busy}
          onClick={onChoose}
          className="w-full px-4 py-2.5 text-[12px]"
        >
          {busy ? "Taking a copy…" : `Send ${character.name} down`}
        </Button>
      </div>
    </li>
  );
}

export function Library({
  character,
  load,
  onChoose,
  onBack,
}: {
  /** Whoever the player pressed the button beside. Named on every card. */
  character: PlayerCharacter;
  /**
   * How to fetch a batch — INJECTED rather than imported, so this screen can be
   * rendered against a list without a server, an account or a Supabase client.
   * The same arrangement `remote-session.ts` makes for its `fetch`, for the same
   * reason.
   */
  load: (cursor?: string) => Promise<LibraryPage>;
  /**
   * Take a copy of this world and go down it. Returns when it has failed —
   * on success the screen it is on is gone, so there is nothing to resolve to.
   */
  onChoose: (dungeon: DungeonSummary) => Promise<void>;
  onBack: () => void;
}) {
  const [dungeons, setDungeons] = useState<DungeonSummary[]>([]);
  const [cursor, setCursor] = useState<string>();
  /** Nothing has been read yet — a real state, and not the same as an empty shelf. */
  const [opening, setOpening] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  /** Which card is being copied, so its own button says so and the rest wait. */
  const [taking, setTaking] = useState<string>();

  /**
   * The next batch, and the guards are the whole of the correctness here.
   *
   * `more` is read from a ref rather than from state because the observer below
   * holds this function across renders: a closure over the state value would ask
   * for the same page forever. The ref is what both triggers agree on.
   */
  const more = useRef<{ cursor?: string; end: boolean; busy: boolean }>({
    end: false,
    busy: false,
  });

  const next = useCallback(async () => {
    if (more.current.end || more.current.busy) return;
    more.current.busy = true;
    setLoading(true);
    setError(undefined);
    try {
      const page = await load(more.current.cursor);
      // Appended rather than replaced: this is a shelf being read down, and a
      // batch that replaced the last would be a screen that scrolls nowhere.
      setDungeons((held) => [...held, ...page.dungeons]);
      more.current.cursor = page.cursor;
      more.current.end = page.cursor === undefined;
      setCursor(page.cursor);
    } catch (e) {
      // The batches already read stay on the screen. A failure to fetch MORE is
      // not a reason to take away what the player is looking at, and the button
      // below is still there to try again with.
      setError(e instanceof Error ? e.message : String(e));
      more.current.end = false;
    } finally {
      more.current.busy = false;
      setLoading(false);
      setOpening(false);
    }
  }, [load]);

  // The first batch, once. `next` is stable for a stable `load`.
  useEffect(() => {
    void next();
  }, [next]);

  /**
   * Press the button early when the player scrolls near it.
   *
   * THE NODE IS STATE AND NOT A REF, and that is the whole of what makes this
   * work. The foot of the shelf does not exist on the render this effect first
   * runs on — the screen is still showing *Reading the shelf…* — and `next` is
   * stable, so an effect keyed on a ref would run once against `null` and never
   * again. Nothing would ever observe anything, in a browser as much as in a
   * test. A callback ref re-renders when the node arrives and departs, so the
   * effect is keyed on the node actually being there.
   *
   * Guarded on the constructor existing besides: jsdom has none, and neither
   * does any environment without layout. The button below works regardless,
   * which is why this is allowed to simply not happen.
   */
  const [foot, setFoot] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!foot || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void next();
      },
      // A screen ahead, so the next batch is usually already there by the time
      // the player reaches the bottom of this one.
      { rootMargin: "600px" }
    );
    observer.observe(foot);
    return () => observer.disconnect();
  }, [foot, next]);

  async function choose(dungeon: DungeonSummary) {
    if (taking) return;
    setTaking(dungeon.id);
    setError(undefined);
    try {
      await onChoose(dungeon);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // On success this screen has already been replaced; on failure the card
      // has to become pressable again.
      setTaking(undefined);
    }
  }

  return (
    <main className="min-h-screen bg-desk text-ink">
      <div className="mx-auto w-full max-w-[1100px] px-10 pb-20 pt-16">
        <header>
          <button
            type="button"
            onClick={onBack}
            className="mb-6 font-mono text-[10px] uppercase tracking-[0.14em] text-graphite transition-colors hover:text-ink active:text-torch"
          >
            ← Characters
          </button>
          <h1 className="font-prose text-[46px] font-semibold leading-none text-ink">
            Worlds other people wrote
          </h1>
          <p className={`${LABEL} mt-3`}>
            Choosing one takes a copy of your own · {character.name} goes down it
          </p>
          <div className="mt-5 h-0.5 bg-ink" />
        </header>

        {error && (
          <p
            className="mt-6 border-l-2 border-torch py-2 pl-3 font-mono text-[12px] text-torch-deep"
            role="status"
          >
            {error}
          </p>
        )}

        {opening ? (
          <p className="mt-10 font-prose text-[15px] italic text-pencil">Reading the shelf…</p>
        ) : dungeons.length === 0 ? (
          <div className="px-0 pb-14 pt-20 text-center">
            <p className="mx-auto max-w-[38ch] font-prose text-[26px] italic leading-snug text-graphite">
              Nobody else has finished a world yet. Roll one of your own — it will
              be on this shelf for everybody else.
            </p>
          </div>
        ) : (
          <>
            <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {dungeons.map((d) => (
                <Card
                  key={d.id}
                  dungeon={d}
                  character={character}
                  busy={taking === d.id}
                  onChoose={() => void choose(d)}
                />
              ))}
            </ul>

            {/* The foot of the shelf. The observer above watches this node; the
                button in it is what actually asks. */}
            <div ref={setFoot} className="mt-10 flex justify-center">
              {cursor ? (
                <Button
                  tone="ghost"
                  disabled={loading}
                  onClick={() => void next()}
                  className="px-7 py-3 text-[13px]"
                >
                  {loading ? "Reading…" : "More"}
                </Button>
              ) : (
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-pencil">
                  That is the whole shelf
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
