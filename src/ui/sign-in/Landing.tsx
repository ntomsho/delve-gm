/**
 * THE DOOR
 * ========
 *
 * The first screen anyone sees, and for most visits the only one they will not
 * see again — the session survives a reload, so this appears once and then
 * stops appearing.
 *
 * A landing page, because for most visitors this is the portfolio piece's
 * front cover: what the game is, what makes it different, how a room gets
 * drawn, how a turn goes, and pictures from real runs. Two ways in, offered throughout: a guest is the
 * one-click door, and "Log in" is Google, the one identity, for a returning
 * player.
 *
 * THE PICTURES ARE LIVE: rooms and covers players have drawn in recent runs
 * (`GET /api/illustrations/recent`), shuffled on each visit, with the creatures
 * generation put in a room standing in it as the game stands them. With none —
 * a fresh database, or the API down — the illustration style references stand
 * in (`assets/illustration-refs/`), labelled as examples rather than as runs.
 *
 * THE TORCH. The wall behind the hero is dim, and a second copy of it is lit
 * through a circle that follows the pointer, or wanders on its own until the
 * pointer arrives. Its position is two CSS variables written straight onto the
 * header, not React state: sixty renders a second of the whole page would be
 * the price of the effect otherwise.
 */

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { recentIllustrations, type ShowcaseIllustration } from "../../api-client/showcase.ts";
import { Ink, StandingFigure } from "../shared/ink.tsx";
import { captchaToken } from "./turnstile.ts";
import barracks from "../../../assets/illustration-refs/I7.png";
import floodedNave from "../../../assets/illustration-refs/I8.png";
import overgrownTemple from "../../../assets/illustration-refs/I9.png";
import forgeCave from "../../../assets/illustration-refs/I10.png";

interface Props {
  onSignIn: () => Promise<void>;
  /** Play without an account. Handed the Turnstile token when there is one. */
  onGuest: (captchaToken?: string) => Promise<void>;
  /** Shown above the buttons — see `App.tsx`. */
  notice?: string;
}

/**
 * A picture on the page: one from a run, laid down as ink, or a style
 * reference — an ordinary greyscale image, not a mask — standing in for them.
 */
type Picture = ShowcaseIllustration & { reference?: true };

/** The style references, for when no run has drawn anything to show. */
const REFERENCES: Picture[] = [
  { kind: "room", url: barracks, roomTitle: "Barracks", dungeonTitle: "", figures: [], reference: true },
  { kind: "room", url: floodedNave, roomTitle: "Flooded nave", dungeonTitle: "", figures: [], reference: true },
  { kind: "room", url: overgrownTemple, roomTitle: "Overgrown temple", dungeonTitle: "", figures: [], reference: true },
  { kind: "room", url: forgeCave, roomTitle: "Forge cave", dungeonTitle: "", figures: [], reference: true },
];

const SOURCE_URL = "https://github.com/ntomsho/delve-gm";

/** The torch's radius on the lit wall, and the warm glow's, in px. */
const TORCH_PX = 260;
const GLOW_PX = 320;

const DIFFERENT = [
  {
    title: "No two dungeons alike.",
    body: "Every dungeon starts from a set of random rolls: a place, its builders, its current residents, and the thing you came for. The AI writes a dungeon around that combination, never around a stock “goblin cave.”",
  },
  {
    title: "Stocked to be played.",
    body: "Monsters have weaknesses you can discover. Locked doors have keys somewhere you can reach. Treasure waits behind danger and in forgotten corners. Every obstacle has more than one way past, and the dungeon rewards whoever finds them.",
  },
  {
    title: "The game master sees the whole dungeon.",
    body: "It knows every room before you enter the first one, so things connect. The note in the library points to the vault. The guards are posted where the valuables are. The dangers are placed where it makes sense for the dungeon.",
  },
  {
    title: "It remembers what happened.",
    body: "Every room and creature keeps track of what you’ve done to it: the guard you bribed, the door you broke, the fire you left burning. Come back later and the dungeon remembers too, like a game master keeping careful notes.",
  },
];

const STEPS = [
  { title: "Say what you do.", body: "In your own words. There’s no menu of moves. If it’s possible, you can try it." },
  {
    title: "The game master reads the situation.",
    body: "It knows the room, who’s in it, and everything that’s happened so far, and it judges what your action risks.",
  },
  {
    title: "Talk it through.",
    body: "Ask questions, look closer, get more information before you commit. Make your case for why your plan deserves advantage, just like at a real table.",
  },
  { title: "When there’s danger, you roll.", body: "You’re told what’s at stake before the dice come out." },
  { title: "The dungeon responds.", body: "The outcome plays out, and the dungeon remembers it." },
];

/** The stages of `public/how-a-room-is-drawn.gif`, in the order it plays them. */
const DRAWN = [
  {
    title: "Layout.",
    body: "The dungeon is laid out on a five-foot grid before you arrive. Every room, door and feature has its place.",
  },
  {
    title: "Wireframe.",
    body: "A camera searches the room for the view that shows the most of it, and draws that view as line work: walls, doors, and where each thing goes.",
  },
  {
    title: "Illustration.",
    body: "An image model draws over the wireframe in the style of classic adventure modules, so the door on the map is the door in the picture.",
  },
  {
    title: "Creatures.",
    body: "Each creature is drawn once and stood in the room through the same camera, on the floor and at the right size.",
  },
];

const EYEBROW = "font-mono text-[11px] uppercase tracking-[0.2em]";
const H2 = "font-display font-bold text-[30px] leading-[1.08] [text-wrap:balance] md:text-[clamp(30px,3.4vw,42px)]";
const GUTTER = "px-5 md:px-[clamp(20px,4vw,48px)]";
const SECTION = `mx-auto box-border max-w-[1200px] ${GUTTER} pt-7 pb-14 sm:py-24`;

/** Fisher–Yates, on a copy. The page's own shuffle: which pictures show is not the game's business. */
function shuffled<T>(xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function Landing({ onSignIn, onGuest, notice }: Props) {
  const [pictures, setPictures] = useState<Picture[]>([]);
  /** Which control is waiting: Google, or the guest button with this name. */
  const [busy, setBusy] = useState<string>();
  /** The last failure, and which control it belongs beside. */
  const [error, setError] = useState<{ at: string; message: string }>();

  useEffect(() => {
    let live = true;
    void recentIllustrations().then((got) => live && setPictures(shuffled(got.length ? got : REFERENCES)));
    return () => {
      live = false;
    };
  }, []);

  async function google() {
    setBusy("google");
    setError(undefined);
    try {
      await onSignIn();
      // No success branch: a successful call navigates away to Google. Reaching
      // the line after it means the redirect did not happen.
    } catch (e) {
      setError({ at: "google", message: e instanceof Error ? e.message : "could not reach the sign-in service" });
      setBusy(undefined);
    }
  }

  async function guest(at: string, check: HTMLElement | null) {
    setBusy(at);
    setError(undefined);
    try {
      await onGuest(check ? await captchaToken(check) : undefined);
      // Success is the auth listener in `App` swapping this screen out.
    } catch (e) {
      setError({ at, message: e instanceof Error ? e.message : "could not start a guest session" });
      setBusy(undefined);
    }
  }

  const door = { busy, error, guest };
  const rooms = pictures.filter((p) => p.kind === "room");
  // The gallery leads with rooms that have somebody standing in them.
  const gallery = [...rooms.filter((r) => r.figures.length), ...rooms.filter((r) => !r.figures.length)].slice(0, 4);
  const washes = rooms.length ? [rooms[1 % rooms.length], rooms[2 % rooms.length]] : [];

  return (
    <div className="relative w-full overflow-x-clip bg-paper text-ink" style={{ fontFamily: "var(--font-prose)" }}>
      <Nav onLogIn={() => void google()} loggingIn={busy === "google"} door={door} />
      <Hero pictures={pictures} notice={notice} onLogIn={() => void google()} door={door} />
      <Different wash={washes[0]} />
      <Drawn />
      <Turn wash={washes[1]} />
      {gallery.length > 0 && <Gallery rooms={gallery} />}
      <Closing door={door} />
    </div>
  );
}

interface Door {
  busy?: string;
  error?: { at: string; message: string };
  guest: (at: string, check: HTMLElement | null) => Promise<void>;
}

/**
 * Play as a guest. Each one carries its own place for the bot check to draw
 * itself, on the rare visit it needs to, so the check appears beside the
 * button that asked rather than somewhere off the screen.
 */
function GuestButton({ at, door, label = "Play as a guest", size = "large" }: { at: string; door: Door; label?: string; size?: "large" | "small" }) {
  const check = useRef<HTMLDivElement>(null);
  const waiting = door.busy === at;
  const shape =
    size === "large"
      ? "h-[54px] w-full px-7 text-[15px] shadow-[3px_3px_0_var(--color-ink)] active:translate-x-[3px] active:translate-y-[3px] sm:w-auto"
      : "h-[38px] px-3 text-[12px] shadow-[2px_2px_0_var(--color-ink)] active:translate-x-[2px] active:translate-y-[2px] sm:h-10 sm:px-[18px]";
  return (
    <span className={size === "large" ? "flex w-full flex-col gap-2 sm:w-auto" : "relative flex flex-col"}>
      <button
        type="button"
        onClick={() => void door.guest(at, check.current)}
        disabled={door.busy !== undefined}
        className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap border border-ink bg-torch font-display font-bold uppercase tracking-[0.1em] text-paper transition-colors hover:bg-torch-deep active:shadow-none disabled:opacity-60 ${shape}`}
      >
        {waiting ? "Opening the door…" : label}
      </button>
      <span ref={check} className={size === "large" ? "empty:hidden" : "absolute right-0 top-full mt-2 empty:hidden"} />
      {door.error?.at === at && <Failure message={door.error.message} />}
    </span>
  );
}

function Failure({ message }: { message: string }) {
  return <span className="font-mono text-xs text-torch-deep">{message}</span>;
}

function Nav({ onLogIn, loggingIn, door }: { onLogIn: () => void; loggingIn: boolean; door: Door }) {
  return (
    <nav
      className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-rule bg-paper py-3 sm:py-[22px]"
      style={{ paddingInline: "max(clamp(20px,4vw,48px), calc((100% - 1200px) / 2 + clamp(20px,4vw,48px)))" }}
    >
      <img src="/logo-wordmark.svg" alt="Delve GM" className="block h-[22px] w-auto sm:h-[30px]" />
      <div className="flex items-center gap-3 sm:gap-5">
        <LogIn onLogIn={onLogIn} loggingIn={loggingIn} className="h-10 px-1 text-[11px] tracking-[0.16em]" />
        <span className="sm:hidden">
          <GuestButton at="nav" door={door} label="Play" size="small" />
        </span>
        <span className="hidden sm:inline">
          <GuestButton at="nav-wide" door={door} size="small" />
        </span>
      </div>
    </nav>
  );
}

/** "Log in" is Google: the one identity, for a returning player. */
function LogIn({ onLogIn, loggingIn, className = "" }: { onLogIn: () => void; loggingIn: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onLogIn}
      disabled={loggingIn}
      className={`inline-flex shrink-0 items-center whitespace-nowrap font-mono uppercase text-ink underline decoration-rule underline-offset-[5px] hover:text-torch hover:decoration-torch disabled:opacity-60 ${className}`}
    >
      {loggingIn ? "Taking you to Google…" : "Log in"}
    </button>
  );
}

function Hero({
  pictures,
  notice,
  onLogIn,
  door,
}: {
  pictures: Picture[];
  notice?: string;
  onLogIn: () => void;
  door: Door;
}) {
  const header = useRef<HTMLElement>(null);
  /** Once the pointer has moved the torch, it stays where the pointer left it. */
  const held = useRef(false);

  // The torch wanders on its own until a pointer takes it. Not with reduced motion.
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const t0 = performance.now();
    let frame = requestAnimationFrame(function tick(t) {
      if (!held.current) {
        const s = (t - t0) / 1000;
        place(0.6 + 0.28 * Math.sin(s * 0.35), 0.5 + 0.28 * Math.sin(s * 0.53 + 1));
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  function place(x: number, y: number) {
    header.current?.style.setProperty("--tx", `${(x * 100).toFixed(1)}%`);
    header.current?.style.setProperty("--ty", `${(y * 100).toFixed(1)}%`);
  }

  function follow(e: PointerEvent<HTMLElement>) {
    // A touch is a tap, not a light being carried: the torch keeps wandering.
    if (e.pointerType === "touch") return;
    held.current = true;
    const r = e.currentTarget.getBoundingClientRect();
    place((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }

  const torch = `radial-gradient(circle ${TORCH_PX}px at var(--tx) var(--ty), #000 0%, rgba(0,0,0,0.7) 45%, transparent 100%)`;
  const glow = `radial-gradient(circle ${GLOW_PX}px at var(--tx) var(--ty), rgb(180 82 30 / 0.10) 0%, rgb(180 82 30 / 0) 70%)`;

  return (
    <header
      ref={header}
      onPointerMove={follow}
      className="relative box-border flex min-h-[600px] cursor-crosshair items-center justify-center overflow-hidden sm:min-h-[780px]"
      style={{ ["--tx" as string]: "62%", ["--ty" as string]: "48%" }}
    >
      {pictures.length > 0 && (
        <>
          <div className="absolute inset-0 overflow-hidden opacity-[0.13] mix-blend-multiply" aria-hidden>
            <Wall pictures={pictures} />
          </div>
          <div
            className="absolute inset-0 overflow-hidden mix-blend-multiply"
            style={{ maskImage: torch, WebkitMaskImage: torch }}
            aria-hidden
          >
            <Wall pictures={pictures} />
          </div>
          <div className="pointer-events-none absolute inset-0 mix-blend-multiply" style={{ background: glow }} />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[120px] bg-gradient-to-b from-paper/0 to-paper" />
        </>
      )}

      <div className="relative mx-4 box-border max-w-[640px] cursor-auto border border-ink bg-paper px-[22px] pb-[26px] pt-7 shadow-[5px_5px_0_var(--color-ink)] sm:mx-5 sm:px-[clamp(24px,4vw,52px)] sm:pb-10 sm:pt-11">
        <div className={`${EYEBROW} text-torch-deep`}>A solo dungeon crawl</div>
        <h1 className="mt-3.5 font-display text-[36px] font-bold leading-[1.02] tracking-[-0.01em] [text-wrap:balance] sm:text-[clamp(38px,5vw,58px)]">
          The smarter AI game master.
        </h1>
        <p className="mt-[18px] text-[17px] leading-[1.55] [text-wrap:pretty] sm:text-[19px]">
          Each dungeon in Delve GM is built from scratch: who made it, who lives there now, and what they want. It’s
          stocked with dangers, secrets and treasure meant to be played through. Then an AI game master runs it for
          you. Make a character, say what you do in your own words, and find out what’s down there.
        </p>

        {notice && (
          <p className="mt-6 border border-torch bg-torch-wash px-3 py-2 font-mono text-xs text-torch-deep">{notice}</p>
        )}

        <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3.5">
          <GuestButton at="hero" door={door} />
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-graphite">No account needed</span>
        </div>
        <p className="mt-[18px] border-t border-rule-faint pt-3.5 font-mono text-[11px] uppercase tracking-[0.12em] text-graphite">
          Returning Delver?{" "}
          <LogIn onLogIn={onLogIn} loggingIn={door.busy === "google"} className="tracking-[0.12em]" />
        </p>
        {door.error?.at === "google" && <Failure message={door.error.message} />}
      </div>

      {pictures.length > 0 && (
        <div className="pointer-events-none absolute bottom-[22px] right-[clamp(20px,4vw,48px)] hidden font-mono text-[10px] uppercase tracking-[0.14em] text-graphite sm:block">
          {pictures.some((p) => !p.reference) ? "Rooms from recent runs" : "Example rooms"}
        </div>
      )}
    </header>
  );
}

/** How many pictures a wall column holds before it is doubled, so one loop is taller than the screen. */
const WALL_MIN = 8;
/** Seconds for the first wall column to drift through one loop; each column after it takes `WALL_STEP_S` longer, so they never move in step. */
const WALL_LOOP_S = 140;
const WALL_STEP_S = 34;

/**
 * Columns of pictures drifting up and down, each its list twice over so the
 * loop is seamless. Two columns on a phone, four wider.
 */
function Wall({ pictures }: { pictures: Picture[] }) {
  return (
    <div className="grid h-full grid-cols-2 items-start gap-4 px-4 sm:grid-cols-4">
      {[0, 1, 2, 3].map((i) => {
        const turned = [...pictures.slice(i % pictures.length), ...pictures.slice(0, i % pictures.length)];
        let list = turned;
        while (list.length < WALL_MIN) list = [...list, ...turned];
        return (
          <div
            key={i}
            className={`flex-col gap-4 ${i >= 2 ? "hidden sm:flex" : "flex"}`}
            style={{ animation: `drift ${WALL_LOOP_S + i * WALL_STEP_S}s linear infinite`, animationDirection: i % 2 ? "reverse" : "normal" }}
          >
            {[...list, ...list].map((p, j) => (
              <div key={j} className="aspect-[3/2] w-full border border-rule bg-paper">
                <Art picture={p} className="h-full w-full" />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A picture washed in behind a section's text on a wide screen, faded into the
 * section's ground on the side the text is on.
 */
function Wash({ picture, side, ground }: { picture: Picture; side: "left" | "right"; ground: string }) {
  const toward = side === "left" ? "270deg" : "90deg";
  const fade =
    side === "left"
      ? `linear-gradient(${toward}, ${ground} 0%, ${ground} 46%, color-mix(in srgb, ${ground} 60%, transparent) 58%, transparent 72%)`
      : `linear-gradient(${toward}, ${ground} 0%, ${ground} 40%, color-mix(in srgb, ${ground} 55%, transparent) 54%, transparent 70%)`;
  return (
    <div className="hidden md:block" aria-hidden>
      <Art
        picture={picture}
        fit="cover"
        className={`absolute top-0 h-full opacity-60 ${side === "left" ? "left-0 w-[52%]" : "right-0 w-[58%]"}`}
      />
      <div className="absolute inset-0" style={{ background: fade }} />
    </div>
  );
}

function Different({ wash }: { wash?: Picture }) {
  return (
    <section className="relative border-t border-rule">
      {wash && <Wash picture={wash} side="left" ground="var(--color-paper)" />}
      <div className={`relative grid gap-12 ${SECTION} ${wash ? "md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]" : ""}`}>
        {wash && <div className="hidden md:block" />}
        <div>
          <div className={`${EYEBROW} text-graphite`}>What makes it different</div>
          <h2 className={`mt-3 max-w-[22ch] ${H2}`}>Not a story made up on the spot. A dungeon with a design.</h2>
          <p className="mt-[18px] max-w-[60ch] text-lg leading-[1.6] [text-wrap:pretty]">
            Most AI adventures improvise one reply at a time, so nothing connects and nothing lasts. Delve GM designs
            the whole dungeon first. Its game master runs it the way a person would at the table, with the whole
            picture in mind.
          </p>
          <div className="mt-10 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-px border border-rule bg-rule">
            {DIFFERENT.map((p, i) => (
              <div key={p.title} className="bg-paper px-[22px] pb-[26px] pt-6">
                <div className="font-mono text-[11px] tracking-[0.16em] text-torch">{String(i + 1).padStart(2, "0")}</div>
                <h3 className="mt-2.5 font-display text-[19px] font-bold leading-[1.25]">{p.title}</h3>
                <p className="mt-2.5 text-base leading-[1.55] text-graphite [text-wrap:pretty]">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Turn({ wash }: { wash?: Picture }) {
  return (
    <section className="relative border-y border-rule bg-panel">
      {wash && <Wash picture={wash} side="right" ground="var(--color-panel)" />}
      <div className={`relative ${SECTION}`}>
        <div className={`${EYEBROW} text-graphite`}>How a turn works</div>
        <h2 className={`mt-3 max-w-[24ch] ${H2}`}>Say what you do. The game master runs with it.</h2>
        <div className="mt-11 grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-start gap-12">
          <Steps steps={STEPS} />
          <SampleTurn />
        </div>
      </div>
    </section>
  );
}

function Steps({ steps }: { steps: { title: string; body: string }[] }) {
  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {steps.map((s, i) => (
        <li key={s.title} className="grid grid-cols-[44px_1fr] gap-4 border-t border-rule py-5">
          <span className="font-display text-[28px] font-bold leading-none text-torch">{i + 1}</span>
          <span className="flex flex-col gap-1.5">
            <span className="font-display text-lg font-bold leading-[1.3]">{s.title}</span>
            <span className="text-base leading-[1.55] text-graphite [text-wrap:pretty]">{s.body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * How a room gets drawn: one real room, from the grid to the creatures in it.
 * A fixed recording, not a live run — `public/how-a-room-is-drawn.gif`, which
 * the README shows too. Reduced motion gets its last frame as a still.
 */
function Drawn() {
  return (
    <section className="relative border-t border-rule">
      <div className={SECTION}>
        <div className={`${EYEBROW} text-graphite`}>How a room gets drawn</div>
        <h2 className={`mt-3 max-w-[24ch] ${H2}`}>Every picture is drawn from the dungeon itself.</h2>
        <div className="mt-11 grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-start gap-12">
          <figure className="m-0 border border-ink bg-paper shadow-[4px_4px_0_var(--color-ink)]">
            <div className="flex items-center justify-between border-b border-rule px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">
              <span>Stilton’s Chamber</span>
              <span>The Frozen Chancel</span>
            </div>
            <picture>
              <source srcSet="/how-a-room-is-drawn.png" media="(prefers-reduced-motion: reduce)" />
              <img
                src="/how-a-room-is-drawn.gif"
                alt="A dungeon's floor plan drawn on a grid, zooming in on one room and the camera's view of it, then the same view as a wireframe, the finished illustration, and the creatures standing in it"
                width={960}
                height={640}
                loading="lazy"
                className="block aspect-[3/2] h-auto w-full"
              />
            </picture>
          </figure>
          <Steps steps={DRAWN} />
        </div>
      </div>
    </section>
  );
}

/** One turn, in the play screen's own type. */
function SampleTurn() {
  return (
    <figure className="m-0 border border-ink bg-paper shadow-[4px_4px_0_var(--color-ink)]">
      <div className="flex items-center justify-between border-b border-rule px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">
        <span>The Drowned Reliquary</span>
        <span>Turn 6</span>
      </div>
      <div className="px-[22px] pb-2 pt-[22px]">
        <p className="mb-4 flex gap-2 text-base leading-[1.55] text-indigo">
          <span className="font-mono text-graphite">›</span>
          <span>I put my shoulder into the door.</span>
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-graphite">
          <svg width="24" height="24" viewBox="0 0 40 40" aria-hidden>
            <polygon
              points="20,2 36,11 36,29 20,38 4,29 4,11"
              fill="var(--color-paper)"
              stroke="var(--color-ink)"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <text
              x="20"
              y="22"
              textAnchor="middle"
              dominantBaseline="middle"
              fontFamily="JetBrains Mono, monospace"
              fontWeight="700"
              fontSize="13"
              fill="var(--color-ink)"
            >
              14
            </text>
          </svg>
          <span>STR save</span>
          <span className="text-ink">14 +2 = 16</span>
          <span className="font-bold tracking-[0.16em] text-torch-deep">Success</span>
        </div>
        <p className="mb-4 text-base leading-[1.6] [text-wrap:pretty]">
          The door gives with a wet crack and you stumble into a low vaulted chapel, ankle-deep in still water. At the
          north end two figures in sodden grey kneel with their foreheads to the stone. Their lips are moving.
        </p>
      </div>
      <figcaption className="border-t border-dashed border-rule px-4 py-3 font-mono text-[11px] leading-[1.7] text-graphite">
        <span className="text-torch-deep">Remembered</span> west door broken · acolytes have seen you
      </figcaption>
    </figure>
  );
}

function Gallery({ rooms }: { rooms: Picture[] }) {
  const live = rooms.some((r) => !r.reference);
  return (
    <section className="relative">
      <div className={SECTION}>
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div>
            {live ? (
              <div className={`${EYEBROW} flex items-center gap-2.5 text-torch-deep`}>
                <span className="h-[7px] w-[7px] rounded-full bg-torch-deep" style={{ animation: "live-dot 2s ease-in-out infinite" }} />
                Latest from runs
              </div>
            ) : (
              <div className={`${EYEBROW} text-graphite`}>Example rooms</div>
            )}
            <h2 className={`mt-3 max-w-[22ch] ${H2}`}>Every room, illustrated.</h2>
          </div>
          <p className="m-0 max-w-[46ch] text-base leading-[1.6] text-graphite [text-wrap:pretty]">
            As you explore, each room is drawn in the style of classic RPG adventure modules, accurate to the
            dungeon’s own layout, with the creatures you’ve found there standing in the scene.
          </p>
        </div>
        <div className="mt-10 grid grid-cols-2 gap-3.5 sm:gap-6">
          {rooms.map((r) => (
            <figure key={r.url} className="m-0 flex flex-col gap-2.5">
              <Framed picture={r} />
              <figcaption className="flex flex-col justify-between gap-x-3 gap-y-1 font-mono text-[10px] uppercase leading-[1.4] tracking-[0.14em] sm:flex-row">
                <span className="text-ink">{r.roomTitle}</span>
                {r.dungeonTitle && <span className="text-ash">{r.dungeonTitle}</span>}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

/** A room at 3:2 with its creatures stood in it, placed as fractions of the frame. */
function Framed({ picture }: { picture: Picture }) {
  return (
    <div className="relative aspect-[3/2] overflow-hidden border border-rule bg-paper">
      <Art picture={picture} className="absolute inset-0 h-full w-full" label={`A drawing of ${picture.roomTitle ?? picture.dungeonTitle}`} />
      {picture.figures.map((f, i) => (
        <StandingFigure key={`${i}:${f.sprite}`} figure={f} url={f.url} size={f.size} />
      ))}
    </div>
  );
}

/**
 * A picture from a run as ink, masked in the page's own colour; a style
 * reference as an ordinary image, multiplied onto the paper so its white is the page's.
 */
function Art({ picture, className, fit = "contain", label }: { picture: Picture; className: string; fit?: "contain" | "cover"; label?: string }) {
  if (!picture.reference) return <Ink url={picture.url} className={className} fit={fit} {...(label ? { label } : {})} />;
  return (
    <img
      src={picture.url}
      alt={label ?? ""}
      className={`${className} mix-blend-multiply ${fit === "cover" ? "object-cover" : "object-contain"}`}
    />
  );
}

function Closing({ door }: { door: Door }) {
  return (
    <section className="border-t-2 border-ink">
      <div className={`mx-auto box-border flex max-w-[1200px] flex-wrap items-center justify-between gap-6 py-16 ${GUTTER}`}>
        <h2 className="m-0 font-display text-[clamp(26px,3vw,36px)] font-bold leading-[1.1]">Make a character. Start your Delve.</h2>
        <GuestButton at="closing" door={door} />
      </div>
      <footer className="border-t border-rule">
        <div
          className={`mx-auto box-border flex max-w-[1200px] flex-wrap justify-between gap-x-8 gap-y-3 pb-8 pt-[22px] font-mono text-[10px] uppercase tracking-[0.12em] text-ash ${GUTTER}`}
        >
          <span>
            Built by Nick Tomsho · <FooterLink href={SOURCE_URL}>Source on GitHub</FooterLink>
          </span>
          {/* Google's consent screen requires the home page to link here. A
              plain file in `public/`, so it needs no account and no app to load. */}
          <FooterLink href="/privacy.html">Privacy policy</FooterLink>
        </div>
      </footer>
    </section>
  );
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="text-graphite underline underline-offset-4 hover:text-torch">
      {children}
    </a>
  );
}
