import { useEffect, useState } from "react";
import { onAuthChange, type Account } from "@delve/api-client/auth.ts";

/**
 * Who is signed in, followed live: the same listener the web's
 * `ui/app/use-account.ts` uses, minus the web's URL handling. `ready` is false
 * until the stored session has been read from AsyncStorage, which on a phone
 * takes a moment, so the first screen can wait instead of flashing "sign in".
 */
export function useAccount(): { account: Account | undefined; ready: boolean } {
  const [account, setAccount] = useState<Account>();
  const [ready, setReady] = useState(false);
  useEffect(
    () =>
      onAuthChange((who) => {
        setAccount(who);
        setReady(true);
      }),
    []
  );
  return { account, ready };
}
