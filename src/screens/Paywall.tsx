// Paywall — RevenueCat offering with a 7-day free trial on Premium. Shown as a hard gate (`locked`)
// when there's no active subscription, and also reachable to upgrade. Each plan card embeds its own
// 月額/年額 purchase buttons: packages are matched by the RC custom-package identifier and prices
// come from StoreKit (so they follow the device's storefront currency); the static JPY fallback is
// shown disabled until the offering loads. Standard = up to STANDARD_DECK_LIMIT books, Pro/Premium =
// unlimited. An admin-only tier switcher exercises the gates without a live purchase.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { PurchasesPackage } from "react-native-purchases";
import { useApp } from "../store/session";
import { STANDARD_DECK_LIMIT } from "../iap/entitlements";
import { getCurrentOffering, purchase, restore } from "../iap/purchases";
import { useAccount } from "../auth/account";
import { DevTierSwitch } from "../components/DevTierSwitch";
import { PRIVACY_URL, TERMS_URL } from "../config";
import { colors } from "../ui/theme";

/** Plan cards wired to the offering's custom package identifiers (standard_monthly … premium_yearly). */
const PLANS = [
  {
    key: "standard",
    name: "Standard",
    desc: `本を ${STANDARD_DECK_LIMIT} 冊まで取り込み・AI問題生成 月10回`,
    monthlyId: "standard_monthly",
    yearlyId: "standard_yearly",
    monthlyFallback: "¥300",
    yearlyFallback: "¥3,000",
    highlight: false,
    trial: false,
  },
  {
    key: "pro",
    name: "Pro",
    desc: "本を無制限に取り込み・クラウドストレージ5GB・全ての端末/プラットフォームで進捗同期・AI問題生成 月30回",
    monthlyId: "pro_monthly",
    yearlyId: "pro_yearly",
    monthlyFallback: "¥600",
    yearlyFallback: "¥6,000",
    highlight: false,
    trial: false,
  },
  {
    key: "premium",
    name: "Premium",
    desc: "Proの全機能＋AI問題生成 月100回・「今日の復習」（間違えやすい問題を最適なタイミングで再出題）",
    monthlyId: "premium_monthly",
    yearlyId: "premium_yearly",
    monthlyFallback: "¥980",
    yearlyFallback: "¥9,800",
    highlight: true,
    trial: true,
  },
];

function BuyButton({
  label,
  pkg,
  fallback,
  highlight,
  busy,
  onBuy,
}: {
  label: string;
  pkg: PurchasesPackage | undefined;
  fallback: string;
  highlight: boolean;
  busy: boolean;
  onBuy: (pkg: PurchasesPackage) => void;
}) {
  const disabled = busy || !pkg;
  return (
    <Pressable
      style={[styles.buy, highlight && styles.buyHl, disabled && styles.disabled]}
      disabled={disabled}
      onPress={() => pkg && onBuy(pkg)}
    >
      <Text style={[styles.buyLabel, highlight && styles.buyTextHl]}>{label}</Text>
      <Text style={[styles.buyPrice, highlight && styles.buyTextHl]}>
        {pkg?.product.priceString ?? fallback}
      </Text>
    </Pressable>
  );
}

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

  const byId = useMemo(() => new Map((packages ?? []).map((p) => [p.identifier, p])), [packages]);

  // Subscriptions are account-bound (the server keys AI quota / sync / caps on the Firebase uid,
  // via the RevenueCat webhook). Purchasing anonymously would only unlock the server at the NEXT
  // billing event — so both purchase and restore require login first.
  const requireUser = useCallback((): string | null => {
    if (user) return user.uid;
    Alert.alert(
      "アカウント登録が必要です",
      "サブスクリプションはアカウントに紐付きます（AI生成枠・クラウド同期・機種変更時の引き継ぎのため）。先に無料のアカウント登録／ログインをお願いします。",
      [
        { text: "登録・ログインへ", onPress: () => setView({ name: "login" }) },
        { text: "キャンセル", style: "cancel" },
      ],
    );
    return null;
  }, [user, setView]);

  const buy = useCallback(
    async (pkg: PurchasesPackage) => {
      const uid = requireUser();
      if (!uid) return;
      try {
        setBusy(true);
        const tier = await purchase(pkg, uid);
        if (tier !== "free") setView({ name: "decks" });
      } catch (e) {
        Alert.alert("購入エラー", e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [setView, requireUser],
  );

  const onRestore = useCallback(async () => {
    const uid = requireUser();
    if (!uid) return;
    try {
      setBusy(true);
      const tier = await restore(uid);
      Alert.alert(tier !== "free" ? "復元しました" : "復元できる購入が見つかりません");
      if (tier !== "free") setView({ name: "decks" });
    } catch (e) {
      Alert.alert("復元エラー", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [setView, requireUser]);

  return (
    <View style={styles.c}>
      {locked ? null : (
        <Pressable onPress={() => setView({ name: "decks" })} hitSlop={10}>
          <Text style={styles.back}>← 閉じる</Text>
        </Pressable>
      )}
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Kiokumate を始める</Text>
        <Text style={styles.lead}>無料で1冊から。Premiumは初回7日間無料・いつでも解約できます。</Text>
        {locked && user ? (
          <Text style={styles.accountNote}>
            ログイン中: {user.email ?? "Apple ID"}（有効なサブスクリプションは見つかりませんでした）
          </Text>
        ) : null}
        <Pressable onPress={() => setView({ name: "login" })} hitSlop={6}>
          <Text style={styles.loginLink}>アカウントをお持ちの方はログイン</Text>
        </Pressable>

        <View style={styles.plans}>
          {PLANS.map((p) => (
            <View key={p.key} style={[styles.plan, p.highlight && styles.planPro]}>
              <View style={styles.planHead}>
                <Text style={styles.planName}>{p.name}</Text>
                {p.trial ? <Text style={styles.trialBadge}>初回7日間無料</Text> : null}
              </View>
              <Text style={styles.planDesc}>{p.desc}</Text>
              <View style={styles.buyRow}>
                <BuyButton
                  label="月額"
                  pkg={byId.get(p.monthlyId)}
                  fallback={p.monthlyFallback}
                  highlight={p.highlight}
                  busy={busy}
                  onBuy={buy}
                />
                <BuyButton
                  label="年額・2ヶ月分お得"
                  pkg={byId.get(p.yearlyId)}
                  fallback={p.yearlyFallback}
                  highlight={p.highlight}
                  busy={busy}
                  onBuy={buy}
                />
              </View>
            </View>
          ))}
        </View>

        {packages === null ? (
          <ActivityIndicator color={colors.sand} />
        ) : packages.length === 0 ? (
          <View style={styles.reloadBox}>
            <Text style={styles.muted}>
              商品を読み込めませんでした。通信状況をご確認ください（設定直後は数分かかることがあります）。
            </Text>
            <Pressable onPress={load} hitSlop={8}>
              <Text style={styles.restore}>再読み込み</Text>
            </Pressable>
          </View>
        ) : null}

        <Pressable onPress={onRestore} disabled={busy} hitSlop={8}>
          <Text style={styles.restore}>購入を復元</Text>
        </Pressable>

        <Text style={styles.disclosure}>
          Premiumには初回のみ7日間の無料トライアルが付きます。トライアル終了時、解約しない限りPremiumの
          料金が自動で請求されます。サブスクリプションは、現在の期間終了の24時間前までに自動更新をオフに
          しない限り自動更新されます。更新の管理・解約はiOSの「設定」→ Apple ID →「サブスクリプション」
          から行えます。
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
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, padding: 20 },
  back: { color: colors.ocean, fontSize: 16, marginBottom: 4 },
  body: { flexGrow: 1, justifyContent: "center", gap: 12, paddingVertical: 8 },
  title: { fontSize: 26, fontWeight: "800", color: colors.sand, textAlign: "center" },
  lead: { fontSize: 15, color: colors.text, textAlign: "center", lineHeight: 22 },
  loginLink: { color: colors.ocean, fontSize: 14, textAlign: "center" },
  accountNote: { color: colors.textSub, fontSize: 12, textAlign: "center" },
  helpLink: { color: colors.ocean, fontSize: 13, textAlign: "center", paddingVertical: 6 },
  reloadBox: { gap: 8 },
  plans: { gap: 10, marginVertical: 4 },
  plan: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    backgroundColor: colors.surface,
    gap: 6,
  },
  planPro: { borderColor: colors.sand, borderWidth: 2 },
  planHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  planName: { fontSize: 16, fontWeight: "800", color: colors.text },
  trialBadge: {
    fontSize: 11,
    fontWeight: "800",
    color: "#fff",
    backgroundColor: colors.sand,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  planDesc: { fontSize: 12, color: colors.textSub, lineHeight: 18 },
  buyRow: { flexDirection: "row", gap: 8, marginTop: 2 },
  buy: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.sand,
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: "center",
    gap: 1,
    backgroundColor: colors.bg,
  },
  buyHl: { backgroundColor: colors.sand, borderColor: colors.sand },
  buyLabel: { fontSize: 11, fontWeight: "700", color: colors.sand },
  buyPrice: { fontSize: 15, fontWeight: "800", color: colors.sand },
  buyTextHl: { color: "#fff" },
  disabled: { opacity: 0.6 },
  muted: { color: colors.muted, fontSize: 13, textAlign: "center" },
  restore: { color: colors.ocean, fontSize: 15, textAlign: "center", paddingVertical: 8 },
  disclosure: { color: colors.textSub, fontSize: 11, lineHeight: 16, textAlign: "center", marginTop: 8 },
  legalRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, marginTop: 4 },
  legalLink: { color: colors.ocean, fontSize: 12 },
  legalSep: { color: colors.muted, fontSize: 12 },
});
