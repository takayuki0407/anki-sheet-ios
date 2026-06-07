// Paywall — shows the RevenueCat current offering and handles purchase / restore. The
// free-tier gate (FREE_DECK_LIMIT books) routes here when exceeded. A DEV-only local
// unlock lets the 3-deck gate be exercised before RevenueCat products are configured.
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type { PurchasesPackage } from "react-native-purchases";
import { useApp } from "../store/session";
import { FREE_DECK_LIMIT, useEntitlements } from "../iap/entitlements";
import { getCurrentOffering, purchase, restore } from "../iap/purchases";
import { PRIVACY_URL, TERMS_URL } from "../config";
import { colors } from "../ui/theme";

export function Paywall() {
  const setView = useApp((s) => s.setView);
  const setPremium = useEntitlements((s) => s.setPremium);
  const [packages, setPackages] = useState<PurchasesPackage[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getCurrentOffering()
      .then((o) => setPackages(o?.availablePackages ?? []))
      .catch(() => setPackages([]));
  }, []);

  const buy = useCallback(
    async (pkg: PurchasesPackage) => {
      try {
        setBusy(true);
        if (await purchase(pkg)) setView({ name: "import" });
      } catch (e) {
        Alert.alert("購入エラー", e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [setView],
  );

  const onRestore = useCallback(async () => {
    try {
      setBusy(true);
      const ok = await restore();
      Alert.alert(ok ? "復元しました" : "復元できる購入が見つかりません");
      if (ok) setView({ name: "decks" });
    } catch (e) {
      Alert.alert("復元エラー", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [setView]);

  return (
    <View style={styles.c}>
      <Pressable onPress={() => setView({ name: "decks" })} hitSlop={10}>
        <Text style={styles.back}>← 閉じる</Text>
      </Pressable>
      <View style={styles.body}>
        <Text style={styles.title}>Anki-sheet Premium</Text>
        <Text style={styles.lead}>
          無料プランは本を {FREE_DECK_LIMIT} 冊まで。Premium で冊数無制限＋全機能を解放。
        </Text>
        <View style={styles.features}>
          <Text style={styles.feature}>・本（PDF）を無制限に取り込み</Text>
          <Text style={styles.feature}>・色チューニング / 再検出</Text>
          <Text style={styles.feature}>・全データのバックアップ</Text>
        </View>

        {packages === null ? (
          <ActivityIndicator color={colors.sand} />
        ) : packages.length > 0 ? (
          packages.map((pkg) => (
            <Pressable
              key={pkg.identifier}
              style={[styles.cta, busy && styles.disabled]}
              disabled={busy}
              onPress={() => buy(pkg)}
            >
              <Text style={styles.ctaText}>
                {pkg.product.title} — {pkg.product.priceString}
              </Text>
            </Pressable>
          ))
        ) : (
          <Text style={styles.muted}>
            商品を読み込めませんでした。RevenueCat とApp Store Connect の設定後に表示されます。
          </Text>
        )}

        <Pressable onPress={onRestore} disabled={busy} hitSlop={8}>
          <Text style={styles.restore}>購入を復元</Text>
        </Pressable>

        <Text style={styles.disclosure}>
          お支払いは購入確定時にApp Storeアカウントへ請求されます。サブスクリプションは、現在の期間
          終了の24時間前までに自動更新をオフにしない限り自動更新され、同額が請求されます。更新の管理・
          解約はiOSの「設定」→ Apple ID →「サブスクリプション」からいつでも行えます。
        </Text>
        <View style={styles.legalRow}>
          <Pressable onPress={() => Linking.openURL(TERMS_URL)} hitSlop={6}>
            <Text style={styles.legalLink}>利用規約</Text>
          </Pressable>
          <Text style={styles.legalSep}>・</Text>
          <Pressable onPress={() => Linking.openURL(PRIVACY_URL)} hitSlop={6}>
            <Text style={styles.legalLink}>プライバシーポリシー</Text>
          </Pressable>
        </View>

        {__DEV__ ? (
          <Pressable
            style={styles.devUnlock}
            onPress={() => {
              setPremium(true);
              setView({ name: "import" });
            }}
          >
            <Text style={styles.devUnlockText}>[DEV] ローカルでPremiumを解放</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, padding: 20 },
  back: { color: colors.ocean, fontSize: 16 },
  body: { flex: 1, justifyContent: "center", gap: 14 },
  title: { fontSize: 26, fontWeight: "800", color: colors.sand, textAlign: "center" },
  lead: { fontSize: 15, color: colors.text, textAlign: "center", lineHeight: 22 },
  features: { gap: 6, alignSelf: "center", marginBottom: 4 },
  feature: { fontSize: 14, color: colors.textSub },
  cta: { backgroundColor: colors.sand, paddingVertical: 16, borderRadius: 14, alignItems: "center" },
  disabled: { opacity: 0.6 },
  ctaText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 13, textAlign: "center" },
  restore: { color: colors.ocean, fontSize: 15, textAlign: "center", paddingVertical: 8 },
  disclosure: { color: colors.textSub, fontSize: 11, lineHeight: 16, textAlign: "center", marginTop: 8 },
  legalRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, marginTop: 4 },
  legalLink: { color: colors.ocean, fontSize: 12 },
  legalSep: { color: colors.muted, fontSize: 12 },
  devUnlock: { paddingVertical: 10, alignItems: "center" },
  devUnlockText: { color: colors.muted, fontSize: 12 },
});
