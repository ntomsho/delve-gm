import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Roster } from "@/components/Roster";
import { SignIn } from "@/components/SignIn";
import { useAccount } from "@/use-account";
import { color } from "@/theme";

/**
 * `/`, the first screen: the roster when signed in, the sign-in button when
 * not. SafeAreaView keeps both clear of the status bar and the gesture bar,
 * which the phone draws over the app.
 */
export default function Home() {
  const { account, ready } = useAccount();
  return (
    <SafeAreaView style={styles.page}>
      {!ready ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.ink} />
        </View>
      ) : account ? (
        <Roster account={account} />
      ) : (
        <SignIn />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.paper },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
