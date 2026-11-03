/**
 * A CHARACTER'S PORTRAIT, the native twin of `src/ui/shared/portrait.tsx`.
 *
 * A drawn portrait is black ink on a transparent background. The web lays it
 * down with a CSS mask in the page's ink colour, and React Native has no CSS
 * masks. It doesn't need one: `tintColor` on an Image repaints every opaque
 * pixel in a single colour and leaves transparent ones alone, which is exactly
 * what the mask does for ink on transparent. An uploaded portrait is the
 * player's own photo and is shown untouched.
 */

import { Image, StyleSheet, View } from "react-native";
import type { Portrait } from "@delve/rules/knave/character.ts";
import { color } from "@/theme";

export function PortraitThumb({ portrait, size }: { portrait: Portrait; size: number }) {
  const drawn = portrait.source === "drawn";
  return (
    <View style={[styles.frame, { width: size, height: size }]}>
      <Image
        source={{ uri: portrait.thumbUrl }}
        // Android reads this aloud in TalkBack.
        accessibilityLabel="Portrait, head and shoulders"
        resizeMode="cover"
        style={[StyleSheet.absoluteFill, drawn && { tintColor: color.ink }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: "hidden",
    borderWidth: 1,
    borderColor: color.rule,
    backgroundColor: color.paper,
  },
});
