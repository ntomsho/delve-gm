/**
 * CLOUDFLARE TURNSTILE, FOR GUEST SIGN-IN
 * =======================================
 *
 * A guest account costs one click, which is the point — and also what lets a
 * script mint them by the thousand. Turnstile is the check on that, and almost
 * nobody sees it: `interaction-only` shows a widget only to a visitor it is
 * unsure about.
 *
 * OFF UNLESS `VITE_TURNSTILE_SITE_KEY` IS SET. Supabase does the checking
 * (Authentication → Attack Protection → captcha, with the secret key), so the
 * two settings go on together: a site key here with captcha off in Supabase
 * sends a token nobody reads, and captcha on in Supabase without a site key
 * here refuses every guest.
 *
 * The site key is public by design, like the Supabase publishable key.
 */

interface TurnstileApi {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string;
      appearance?: "always" | "execute" | "interaction-only";
      callback: (token: string) => void;
      "error-callback"?: () => void;
    }
  ): string;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let loading: Promise<TurnstileApi> | undefined;

function load(): Promise<TurnstileApi> {
  return (loading ??= new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = SCRIPT;
    tag.async = true;
    tag.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not load"));
    tag.onerror = () => {
      loading = undefined;
      reject(new Error("could not reach the bot check"));
    };
    document.head.appendChild(tag);
  }));
}

/**
 * A Turnstile token, or `undefined` when Turnstile is not configured.
 *
 * `host` is where the widget appears if it needs to — in the sign-in card, next
 * to the button that asked, rather than floating somewhere on the page.
 */
export async function captchaToken(host: HTMLElement): Promise<string | undefined> {
  // Read per call rather than at import, so a test can set it with `vi.stubEnv`.
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
  if (!siteKey) return undefined;
  const api = await load();
  return new Promise((resolve, reject) => {
    const id = api.render(host, {
      sitekey: siteKey,
      appearance: "interaction-only",
      callback: (token) => {
        api.remove(id);
        resolve(token);
      },
      "error-callback": () => {
        api.remove(id);
        reject(new Error("the bot check failed — try again"));
      },
    });
  });
}
