import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { signIn } from "@delve/api-client/auth.ts";
import { color, font } from "@/theme";

/**
 * Google only, for now. Playing as a guest needs the Turnstile captcha, which
 * is a script on a web page and has no native form. That waits for phase 4.
 */
export function SignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const press = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await signIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.page}>
      <Text style={styles.title}>Delve GM</Text>
      <Text style={styles.tagline}>A solo dungeon crawl</Text>
      <Pressable
        onPress={press}
        disabled={busy}
        accessibilityRole="button"
        // A Pressable hands its own state to its style function. This is how a
        // button looks pressed when there is no CSS `:active` to lean on.
        style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonPressed]}
      >
        <Text style={styles.buttonText}>{busy ? "Waiting for Google…" : "Sign in with Google"}</Text>
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, backgroundColor: color.paper },
  title: { fontFamily: font.prose, fontSize: 40, color: color.ink },
  tagline: { fontFamily: font.prose, fontSize: 18, color: color.graphite, marginTop: 4, marginBottom: 40 },
  button: { backgroundColor: color.torch, paddingVertical: 14, paddingHorizontal: 28 },
  buttonPressed: { opacity: 0.7 },
  buttonText: { fontFamily: font.mono, fontSize: 15, color: color.paper },
  error: { marginTop: 20, color: color.torch, textAlign: "center" },
});
