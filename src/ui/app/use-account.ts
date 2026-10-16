/**
 * WHO IS SIGNED IN, and whether we have found out yet.
 *
 * `undefined` account plus `!ready` is the moment before Supabase has read the
 * stored session — a real state and a short one, and rendering the sign-in
 * screen during it would flash a door at somebody who is already through it.
 *
 * AN OFFLINE RUN NEEDS NO ACCOUNT. `?offline` never touches the server, so
 * requiring Google to do interface work would be requiring a login to reach a
 * fixture. `ready` starts true there and the account stays undefined.
 */

import { useEffect, useState } from "react";
import { linkWasRefused, onAuthChange, signIn, signOut, type Account } from "../../api-client/auth.ts";
import { OFFLINE } from "./local-run.ts";

export function useAccount(): { account: Account | undefined; ready: boolean; signOut: () => void } {
  const [account, setAccount] = useState<Account>();
  const [ready, setReady] = useState(OFFLINE);

  /**
   * Follow the session.
   *
   * `onAuthStateChange` fires once with the stored session on subscribe, so this
   * covers both the first read and every later change — signing in, signing out,
   * and `authedFetch` clearing a session the server rejected. One listener, not
   * a read plus a listener that can disagree with it.
   */
  useEffect(() => {
    if (OFFLINE) return;
    // A guest tried to link a Google account that already has an account of its
    // own. Sign them in to that one: it is theirs, and it is what they asked for
    // by pressing a Google button. See `linkWasRefused`.
    if (linkWasRefused()) void signIn();
    return onAuthChange((who) => {
      setAccount(who);
      setReady(true);
    });
  }, []);

  return {
    account,
    ready,
    signOut: () => {
      // A guest has no way back in: signing out IS deleting, as far as they
      // can tell. Say so once rather than letting a habit cost a roster.
      if (
        account?.guest &&
        !window.confirm(
          "A guest account cannot be signed back into. Your characters will be lost. Sign out anyway?"
        )
      ) {
        return;
      }
      void signOut();
    },
  };
}
