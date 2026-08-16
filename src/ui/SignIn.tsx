/**
 * THE DOOR
 * ========
 *
 * The first screen anyone sees, and for most visits the only one they will not
 * see again — the session survives a reload, so this appears once and then
 * stops appearing.
 *
 * It says three things and stops: what this is, that it is invite-only, and one
 * button. There is no tour, no feature list and no second call to action,
 * because a person who has arrived here has been sent a link by the author and
 * already knows what they came for.
 *
 * ONE PROVIDER, ON PURPOSE. Google is the whole of it, so there is no
 * provider grid to design, no "or" divider, and no password field implying a
 * credential this app has never held.
 */

import { useState } from "react";
import { color, font } from "./theme.ts";

interface Props {
  onSignIn: () => Promise<void>;
  /** Set when the invite check refused them — see `App.tsx`. */
  notice?: string;
}

export function SignIn({ onSignIn, notice }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function go() {
    setBusy(true);
    setError(undefined);
    try {
      await onSignIn();
      // No success branch: a successful call navigates away to Google. Reaching
      // the line after it means the redirect did not happen.
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not reach the sign-in service");
      setBusy(false);
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
          A Dungeon
        </h1>
        <p className="text-sm mb-8" style={{ fontFamily: font.prose, color: color.graphite }}>
          One character, one dungeon, one way out. A referee that has read the
          rules and will hold you to them.
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
          onClick={() => void go()}
          disabled={busy}
          className="w-full px-4 py-3 border transition-colors disabled:opacity-50"
          style={{
            fontFamily: font.mono,
            fontSize: "13px",
            letterSpacing: "0.06em",
            color: busy ? color.graphite : color.paper,
            background: busy ? color.panel : color.ink,
            borderColor: color.ink,
          }}
        >
          {busy ? "TAKING YOU TO GOOGLE…" : "SIGN IN WITH GOOGLE"}
        </button>

        {error && (
          <p className="text-xs mt-4" style={{ fontFamily: font.mono, color: color.torchDeep }}>
            {error}
          </p>
        )}

        <p
          className="text-xs mt-8 leading-relaxed"
          style={{ fontFamily: font.mono, color: color.ash }}
        >
          INVITE ONLY WHILE IT IS BEING BUILT. If your address has not been added
          you will be turned away at Google's screen rather than here.
        </p>
      </div>
    </div>
  );
}
