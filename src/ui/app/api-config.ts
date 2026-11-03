/**
 * THE WEB PAGE'S ANSWERS TO `api-client/config.ts`.
 *
 * Same origin as the API, so no base URL; Supabase's keys from Vite's build-time
 * env; and Google sends the player back to this page, where the auth library
 * finds the session in the URL fragment (the implicit flow). Imported for its
 * effect, first thing, by `main.tsx`.
 */

import { configureApi } from "../../api-client/config.ts";

configureApi({
  baseUrl: "",
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  redirectTo: () => window.location.origin,
  flowType: "implicit",
  detectSessionInUrl: true,
});
