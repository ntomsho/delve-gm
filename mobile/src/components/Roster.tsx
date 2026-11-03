import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { signOut, type Account } from "@delve/api-client/auth.ts";
import { listRoster, type CharacterEntry } from "@delve/api-client/characters.ts";
import { PortraitThumb } from "./Portrait";
import { color, font } from "@/theme";

/**
 * The player's characters: the same `GET /api/characters` the web roster reads,
 * through the same `api-client/characters.ts`.
 *
 * A FlatList rather than an array mapped inside a ScrollView: it renders only
 * the rows on screen, and it comes with pull-to-refresh (`RefreshControl`),
 * which is how a phone reloads a list where a web page would be refreshed.
 */
export function Roster({ account }: { account: Account }) {
  const [entries, setEntries] = useState<CharacterEntry[]>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setEntries(await listRoster());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Text style={styles.title}>Characters</Text>
        <Pressable onPress={() => void signOut()} accessibilityRole="button" hitSlop={12}>
          <Text style={styles.signOut}>Sign out</Text>
        </Pressable>
      </View>
      <Text style={styles.who}>{account.email ?? account.name ?? "Signed in"}</Text>

      {error && <Text style={styles.error}>{error}</Text>}

      <FlatList
        data={entries ?? []}
        keyExtractor={(e) => e.sheet.id}
        renderItem={({ item }) => <Row entry={item} />}
        ItemSeparatorComponent={() => <View style={styles.rule} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        ListEmptyComponent={
          entries ? <Text style={styles.empty}>No characters yet. Make one on the web for now.</Text> : undefined
        }
      />
    </View>
  );
}

function Row({ entry }: { entry: CharacterEntry }) {
  const { sheet, record, activeRun } = entry;
  const runs = record.dead + record.abandoned + record.escaped + record.goalMet;
  return (
    <View style={styles.row}>
      {sheet.portrait ? <PortraitThumb portrait={sheet.portrait} size={64} /> : <View style={styles.noPortrait} />}
      <View style={styles.rowText}>
        <Text style={styles.name}>{sheet.name}</Text>
        <Text style={styles.detail}>
          Level {sheet.level} · {sheet.hp.current}/{sheet.hp.max} HP · {runs} {runs === 1 ? "run" : "runs"}
        </Text>
        {activeRun && <Text style={styles.inRun}>In {activeRun.dungeonName}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.paper, paddingHorizontal: 20 },
  header: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginTop: 16 },
  title: { fontFamily: font.prose, fontSize: 30, color: color.ink },
  signOut: { fontFamily: font.mono, fontSize: 13, color: color.graphite },
  who: { fontFamily: font.mono, fontSize: 12, color: color.pencil, marginBottom: 16 },
  error: { color: color.torch, marginBottom: 12 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 12 },
  noPortrait: { width: 64, height: 64, borderWidth: 1, borderColor: color.rule, backgroundColor: color.panel },
  rowText: { flex: 1, marginLeft: 14 },
  name: { fontFamily: font.prose, fontSize: 20, color: color.ink },
  detail: { fontFamily: font.mono, fontSize: 12, color: color.graphite, marginTop: 2 },
  inRun: { fontFamily: font.mono, fontSize: 12, color: color.torch, marginTop: 2 },
  rule: { height: 1, backgroundColor: color.rule },
  empty: { fontFamily: font.prose, fontSize: 16, color: color.graphite, marginTop: 24 },
});
