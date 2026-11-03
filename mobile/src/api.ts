/**
 * THE APP'S ANSWERS TO `api-client/config.ts`, the native twin of the web's
 * `src/ui/app/api-config.ts`. Imported for its effect by the root layout,
 * before any screen can sign in or fetch.
 *
 * What differs from the web, and why:
 *
 * - `baseUrl`. A web page asks its own origin for `/api/...`. An app has no
 *   origin, so it names the deployment.
 * - `storage`. The auth library keeps the session in `localStorage` on the
 *   web. React Native has no `localStorage`; AsyncStorage is its on-device
 *   key-value store, so the session survives the app being closed.
 * - `redirectTo`, the PKCE flow and `openAuthUrl`. See `viaGoogle` in
 *   `api-client/auth.ts`.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { configureApi } from "@delve/api-client/config.ts";

configureApi({
  baseUrl: process.env.EXPO_PUBLIC_API_URL ?? "https://delve-gm.vercel.app",
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  // `delve://auth` in a real build (the `scheme` in app.json). In Expo Go the app
  // has no scheme of its own, so this is an `exp://<your computer>:8081/--/auth`
  // URL instead. Both must be on Supabase's list of allowed redirect URLs.
  redirectTo: () => Linking.createURL("auth"),
  storage: AsyncStorage,
  flowType: "pkce",
  detectSessionInUrl: false,
  // A Chrome Custom Tab over the app. It closes itself when Google redirects to
  // `redirectTo`, and hands back the URL it was sent to.
  openAuthUrl: async (url, redirectTo) => {
    const result = await WebBrowser.openAuthSessionAsync(url, redirectTo);
    return result.type === "success" ? result.url : undefined;
  },
});
