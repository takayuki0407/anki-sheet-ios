// Admin-only dev tool (mirrors the web DevTierSwitch): switch the signed-in account's SERVER tier
// (which drives the account-wide cap / forced-trim downgrade / AI quota / cloud sync) WITHOUT a live
// subscription, to exercise plan behavior. The backend rejects non-admins (verified token), so this
// is only UI visibility. It also mirrors the new tier into the LOCAL entitlement so the in-app plan
// display + paywall match. Placed in Info AND on the forced-trim screen (to escape an over-limit
// state by switching back up). Shown ONLY to the admin email — non-admin accounts never see it
// (a __DEV__ bypass used to show it to any signed-in account in dev builds; the server rejected
// their taps with 403, but the visible panel was confusing).
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useAccount } from "../auth/account";
import { useApp } from "../store/session";
import { useEntitlements, type Tier } from "../iap/entitlements";
import { setDevTier, type AccountTier } from "../sync/api";
import { colors } from "../ui/theme";

const ADMIN_EMAIL = "zabieru.0407@gmail.com";
const SEVEN_MONTHS_MS = 210 * 24 * 60 * 60 * 1000;

/** Server tier -> local entitlement (there is no "admin" locally; map it to pro = unlimited display). */
const localOf = (t: AccountTier): Tier => (t === "admin" ? "pro" : t);

export function DevTierSwitch() {
  const user = useAccount((s) => s.user);
  const setView = useApp((s) => s.setView);
  const bumpDecks = useApp((s) => s.bumpDecks);
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  if (!isAdmin) return null;

  const apply = async (tier: AccountTier, downgradedAt?: number | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await setDevTier(tier, downgradedAt);
      // Mirror into the local entitlement so the plan display / paywall match the new server tier.
      useEntitlements.getState().set({ tier: localOf(tier), billingActive: true, ready: true });
      bumpDecks(); // re-trigger the gate's listBooks (trim_required) + the bookshelf cloud refresh
      setView({ name: "decks" });
    } catch (e) {
      Alert.alert("プラン切替に失敗しました", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const TierBtn = ({ label, tier }: { label: string; tier: AccountTier }) => (
    <Pressable style={[styles.btn, busy && styles.disabled]} disabled={busy} onPress={() => void apply(tier)}>
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>🛠 開発者ツール（管理者のみ）— プラン切替（テスト用）</Text>
      <View style={styles.row}>
        <TierBtn label="Free" tier="free" />
        <TierBtn label="Standard" tier="standard" />
        <TierBtn label="Pro" tier="pro" />
        <TierBtn label="Premium" tier="premium" />
        <TierBtn label="管理者に戻す" tier="admin" />
      </View>
      <Pressable
        style={[styles.ghost, busy && styles.disabled]}
        disabled={busy}
        onPress={() => void apply("standard", Date.now() - SEVEN_MONTHS_MS)}
      >
        <Text style={styles.ghostText}>Standard＋降格を7ヶ月前に（リテンション検証用）</Text>
      </Pressable>
      {busy ? <ActivityIndicator color={colors.sand} /> : null}
      <Text style={styles.note}>切替後に本棚へ戻ります。テスト専用で、管理者アカウントの実 tier を変更します。</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginTop: 12,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 8,
  },
  title: { fontSize: 12, fontWeight: "700", color: colors.textSub, textAlign: "center" },
  row: { flexDirection: "row", justifyContent: "center", gap: 6, flexWrap: "wrap" },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  btnText: { color: colors.text, fontSize: 12, fontWeight: "600" },
  ghost: { paddingVertical: 6, alignItems: "center" },
  ghostText: { color: colors.ocean, fontSize: 12 },
  disabled: { opacity: 0.5 },
  note: { color: colors.muted, fontSize: 10, textAlign: "center", lineHeight: 14 },
});
