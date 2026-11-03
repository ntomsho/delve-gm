/**
 * WHERE THE CLIENT IS RUNNING, SAID ONCE BY THE SHELL THAT RUNS IT
 * ================================================================
 *
 * The API client serves two shells: the web page (`src/ui/`) and the Android
 * app (`mobile/`). They differ in exactly the things below, so the client asks
 * for them here instead of reading `window` or `import.meta.env` itself.
 * Neither exists in React Native, and a module that touches either at import
 * time takes the whole app down before its first screen.
 *
 * Each shell calls `configureApi` once, before anything signs in or fetches:
 * the web in `ui/app/api-config.ts`, the app in `mobile/src/api.ts`.
 */

import type { SupportedStorage } from "@supabase/auth-js";

export interface ApiConfig {
  /**
   * Put in front of every `/api/...` path. Empty on the web, where the page and
   * the API share an origin. The app has no origin of its own, so it names the
   * deployment.
   */
  baseUrl: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  /** Where Google sends the player back to after sign-in. */
  redirectTo: () => string;
  /**
   * How the Supabase session is kept between launches. Absent means the auth
   * library's own default, `localStorage`, which only a browser has.
   */
  storage?: SupportedStorage;
  /**
   * `implicit` on the web: Google's answer comes back in the page's URL
   * fragment and the library reads it from there. `pkce` in the app: the
   * answer is a one-time code, swapped for a session by `exchangeCodeForSession`.
   */
  flowType: "implicit" | "pkce";
  /** Whether the library should look for a session in the page's URL on start. Web only. */
  detectSessionInUrl: boolean;
  /**
   * Opens Google's sign-in page and resolves with the URL it came back to, or
   * `undefined` if the player closed it.
   *
   * Absent on the web, where signing in navigates the whole page away and the
   * answer arrives when it loads again. In the app the page opens in a browser
   * sheet over the app, and the app goes on running underneath, waiting for
   * this promise.
   */
  openAuthUrl?: (url: string, redirectTo: string) => Promise<string | undefined>;
}

let current: ApiConfig | undefined;

export function configureApi(config: ApiConfig): void {
  current = config;
}

export function apiConfig(): ApiConfig {
  if (!current) {
    throw new Error("The API client is not configured: the shell must call configureApi before signing in or fetching.");
  }
  return current;
}

/** A path on our API, made absolute when the shell has no origin of its own. */
export function apiUrl(path: string): string {
  return `${apiConfig().baseUrl}${path}`;
}
