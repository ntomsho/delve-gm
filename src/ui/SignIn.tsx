/**
 * THE DOOR
 * ========
 *
 * The first screen anyone sees, and for most visits the only one they will not
 * see again — the session survives a reload, so this appears once and then
 * stops appearing.
 *
 * It says what this is and offers two ways in. A guest is the one-click door —
 * a portfolio piece has to open without an account — and Google is the one
 * that keeps your characters and gives more runs a day. There is no tour and no
 * feature list.
 *
 * ONE PROVIDER, ON PURPOSE. Google is the only identity, so there is no
 * provider grid to design and no password field implying a credential this app
 * has never held.
 */

import { useRef, useState } from "react";
import { color, font } from "./theme.ts";
import { captchaToken } from "./turnstile.ts";

interface Props {
  onSignIn: () => Promise<void>;
  /** Play without an account. Handed the Turnstile token when there is one. */
  onGuest: (captchaToken?: string) => Promise<void>;
  /** Shown above the buttons — see `App.tsx`. */
  notice?: string;
}

export function SignIn({ onSignIn, onGuest, notice }: Props) {
  const [busy, setBusy] = useState<"google" | "guest">();
  const [error, setError] = useState<string>();
  /** Where the bot check draws itself, on the rare visit it needs to. */
  const check = useRef<HTMLDivElement>(null);

  async function google() {
    setBusy("google");
    setError(undefined);
    try {
      await onSignIn();
      // No success branch: a successful call navigates away to Google. Reaching
      // the line after it means the redirect did not happen.
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not reach the sign-in service");
      setBusy(undefined);
    }
  }

  async function guest() {
    setBusy("guest");
    setError(undefined);
    try {
      await onGuest(check.current ? await captchaToken(check.current) : undefined);
      // Success is the auth listener in `App` swapping this screen out.
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not start a guest session");
      setBusy(undefined);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-8"
      style={{ background: color.desk }}
    >
      <div
        className="w-full max-w-md px-10 py-12 border"
        style={{ background: color.paper, borderColor: color.rule }}
      >
        <h1
          className="text-3xl mb-2"
          style={{ fontFamily: font.display, color: color.ink, letterSpacing: "-0.02em" }}
        >
          AI Dungeon
        </h1>
        <p className="text-sm mb-8" style={{ fontFamily: font.prose, color: color.graphite }}>
          An online platform to generate dynamic procedural dungeons and run
          through them with an AI-powered dungeonmaster.
        </p>

        {notice && (
          <p
            className="text-xs mb-6 px-3 py-2 border"
            style={{
              fontFamily: font.mono,
              color: color.torchDeep,
              background: color.torchWash,
              borderColor: color.torch,
            }}
          >
            {notice}
          </p>
        )}

        <button
          type="button"
          onClick={() => void google()}
          disabled={busy !== undefined}
          // THE COLOURS ARE CLASSES AND THE TYPE IS NOT. An inline `background`
          // outranks every class including `:hover`, so a button styled that way
          // cannot have a hover state at all — which is exactly what this one
          // did not have. The tokens are the same either way; `index.css`
          // declares them for Tailwind and `theme.ts` for the SVG.
          className="w-full border border-ink bg-ink px-4 py-3 text-paper transition-colors hover:bg-graphite active:bg-graphite disabled:bg-panel disabled:text-graphite disabled:opacity-50"
          style={{
            fontFamily: font.mono,
            fontSize: "13px",
            letterSpacing: "0.06em",
          }}
        >
          {busy === "google" ? "TAKING YOU TO GOOGLE…" : "SIGN IN WITH GOOGLE"}
        </button>

        <button
          type="button"
          onClick={() => void guest()}
          disabled={busy !== undefined}
          className="mt-3 w-full border border-ink bg-paper px-4 py-3 text-ink transition-colors hover:bg-desk active:bg-desk disabled:text-graphite disabled:opacity-50"
          style={{
            fontFamily: font.mono,
            fontSize: "13px",
            letterSpacing: "0.06em",
          }}
        >
          {busy === "guest" ? "OPENING THE DOOR…" : "PLAY AS A GUEST"}
        </button>

        <div ref={check} className="mt-3 empty:hidden" />

        {error && (
          <p className="text-xs mt-4" style={{ fontFamily: font.mono, color: color.torchDeep }}>
            {error}
          </p>
        )}

        <p
          className="text-xs mt-8 leading-relaxed"
          style={{ fontFamily: font.mono, color: color.ash }}
        >
          A GUEST GETS ONE RUN A DAY, AN ACCOUNT GETS THREE. Sign in with Google
          later and a guest keeps their characters.
        </p>
      </div>
    </div>
  );
}
