// Paywall — RevenueCat offering with a 7-day free trial. Shown as a hard gate (`locked`) when
// there's no active subscription, and also reachable to upgrade. Standard = up to
// STANDARD_DECK_LIMIT books, Pro = unlimited. A DEV-only tier switcher exercises the gates
// before RevenueCat is wired up.
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type { PurchasesPackage } from "react-native-purchases";
import { useApp } from "../store/session";
import { STANDARD_DECK_LIMIT } from "../iap/entitlements";
import { getCurrentOffering, purchase, restore } from "../iap/purchases";
import { useAccount } from "../auth/account";
import { DevTierSwitch } from "../components/DevTierSwitch";
import { PRIVACY_URL, TERMS_URL } from "../config";
import { colors } from "../ui/theme";

export function Paywall({ locked = false }: { locked?: boolean }) {
  const setView = useApp((s) => s.setView);
  const user = useAccount((s) => s.user);
  const [packages, setPackages] = useState<PurchasesPackage[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setPackages(null);
    getCurrentOffering()
      .then((o) => setPackages(o?.availablePackages ?? []))
      .catch(() => setPackages([]));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const buy = useCallback(
    async (pkg: PurchasesPackage) => {
      try {
        setBusy(true);
        const tier = await purchase(pkg);
        if (tier !== "free") setView({ name: "decks" });
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
      const tier = await restore();
      Alert.alert(tier !== "free" ? "復元しました" : "復元できる購入が見つかりません");
      if (tier !== "free") setView({ name: "decks" });
    } catch (e) {
      Alert.alert("復元エラー", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [setView]);

  return (
    <View style={styles.c}>
      {locked ? (
        <View style={{ height: 8 }} />
      ) : (
        <Pressable onPress={() => setView({ name: "decks" })} hitSlop={10}>
          <Text style={styles.back}>← 閉じる</Text>
        </Pressable>
      )}
      <View style={styles.body}>
        <Text style={styles.title}>Kiokumate を始める</Text>
        <Text style={styles.lead}>まず7日間は無料。いつでも解約できます。</Text>
        {locked && user ? (
          <Text style={styles.accountNote}>
            ログイン中: {user.email ?? "Apple ID"}（有効なサブスクリプションは見つかりませんでした）
          </Text>
        ) : null}
        <Pressable onPress={() => setView({ name: "login" })} hitSlop={6}>
          <Text style={styles.loginLink}>アカウントをお持ちの方はログイン</Text>
        </Pressable>

        <View style={styles.plans}>
          <View style={styles.plan}>
            <Text style={styles.planName}>Standard</Text>
            <Text style={styles.planPrice}>¥300/月 ・ ¥2,500/年</Text>
            <Text style={styles.planDesc}>本を {STANDARD_DECK_LIMIT} 冊まで取り込み</Text>
          </View>
          <View style={[styles.plan, styles.planPro]}>
            <Text style={styles.planName}>Pro</Text>
            <Text style={styles.planPrice}>¥600/月 ・ ¥5,000/年</Text>
            <Text style={styles.planDesc}>本を無制限に取り込み＋クラウドストレージ5GB・全ての端末/プラットフォームで進捗同期</Text>
          </View>
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
          <View style={styles.reloadBox}>
            <Text style={styles.muted}>
              商品を読み込めませんでした。通信状況をご確認ください（設定直後は数分かかることがあります）。
            </Text>
            <Pressable onPress={load} hitSlop={8}>
              <Text style={styles.restore}>再読み込み</Text>
            </Pressable>
          </View>
        )}

        <Pressable onPress={onRestore} disabled={busy} hitSlop={8}>
          <Text style={styles.restore}>購入を復元</Text>
        </Pressable>

        <Text style={styles.disclosure}>
          7日間の無料トライアル付き。トライアル終了時、解約しない限り選択したプランの料金が自動で請求
          されます。サブスクリプションは、現在の期間終了の24時間前までに自動更新をオフにしない限り自動
          更新されます。更新の管理・解約はiOSの「設定」→ Apple ID →「サブスクリプション」から行えます。
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

        {locked ? (
          <Pressable onPress={() => setView({ name: "info" })} hitSlop={8}>
            <Text style={styles.helpLink}>ヘルプ・お問い合わせ・アカウント</Text>
          </Pressable>
        ) : null}

        <DevTierSwitch />
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
  loginLink: { color: colors.ocean, fontSize: 14, textAlign: "center" },
  accountNote: { color: colors.textSub, fontSize: 12, textAlign: "center" },
  helpLink: { color: colors.ocean, fontSize: 13, textAlign: "center", paddingVertical: 6 },
  reloadBox: { gap: 8 },
  plans: { flexDirection: "row", gap: 10, marginVertical: 4 },
  plan: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    backgroundColor: colors.surface,
    gap: 4,
  },
  planPro: { borderColor: colors.sand },
  planName: { fontSize: 15, fontWeight: "800", color: colors.text },
  planPrice: { fontSize: 13, fontWeight: "700", color: colors.sand },
  planDesc: { fontSize: 12, color: colors.textSub, lineHeight: 18 },
  cta: { backgroundColor: colors.sand, paddingVertical: 16, borderRadius: 14, alignItems: "center" },
  disabled: { opacity: 0.6 },
  ctaText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 13, textAlign: "center" },
  restore: { color: colors.ocean, fontSize: 15, textAlign: "center", paddingVertical: 8 },
  disclosure: { color: colors.textSub, fontSize: 11, lineHeight: 16, textAlign: "center", marginTop: 8 },
  legalRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, marginTop: 4 },
  legalLink: { color: colors.ocean, fontSize: 12 },
  legalSep: { color: colors.muted, fontSize: 12 },
});
