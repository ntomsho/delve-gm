// First, before any screen exists: give sign-in the crypto it needs, and tell
// the API client where it is running.
import "@/crypto";
import "@/api";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { color } from "@/theme";

/**
 * THE ROOT LAYOUT. Expo Router turns each file in `src/app/` into a screen,
 * and a `_layout.tsx` decides how the screens beside it are shown. A Stack is
 * a phone's usual push-and-go-back navigation, with Android's back gesture
 * built in. Phase 1 has one screen; the stack is there for the ones to come.
 */
export default function RootLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.paper } }} />
    </>
  );
}
