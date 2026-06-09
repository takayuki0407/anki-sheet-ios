// 情報・ヘルプ — usage help, color-tuning tips, plan/subscription management, support
// (contact + rate), and legal/about (privacy, terms, version, OSS licenses).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as StoreReview from "expo-store-review";
import { useApp } from "../store/session";
import { FREE_DECK_LIMIT, STANDARD_DECK_LIMIT, effectiveTier, useEntitlements } from "../iap/entitlements";
import { DevTierSwitch } from "../components/DevTierSwitch";
import { deckCountTotal } from "../db/repo";
import { clearAllLocalData } from "../db/backup";
import { restore } from "../iap/purchases";
import { deleteAccount, signOut, useAccount } from "../auth/account";
import { applyDeviceNameToLocalBooks } from "../sync/deck";
import { getDeviceName, loadDeviceName, setDeviceName } from "../sync/device";
import {
  APP_STORE_ID,
  APP_VERSION,
  MANAGE_SUBSCRIPTIONS_URL,
  PRIVACY_URL,
  SUPPORT_EMAIL,
  TERMS_URL,
} from "../config";
import { colors } from "../ui/theme";

const LICENSES = [
  "pdf.js — Apache License 2.0 (© Mozilla)",
  "React Native, Expo — MIT",
  "react-native-webview — MIT",
  "react-native-purchases (RevenueCat) — MIT",
  "zustand, fflate — MIT",
].join("\n");

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({
  label,
  value,
  onPress,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress} disabled={!onPress}>
      <Text style={styles.rowLabel}>{label}</Text>
      {value !== undefined ? (
        <Text style={styles.rowValue}>{value}</Text>
      ) : onPress ? (
        <Text style={styles.chevron}>›</Text>
      ) : null}
    </Pressable>
  );
}

function Help({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable style={styles.help} onPress={() => setOpen((v) => !v)}>
      <View style={styles.helpHead}>
        <Text style={styles.helpQ}>{q}</Text>
        <Text style={styles.chevron}>{open ? "−" : "＋"}</Text>
      </View>
      {open ? <Text style={styles.helpA}>{a}</Text> : null}
    </Pressable>
  );
}

export function Info() {
  const setView = useApp((s) => s.setView);
  const tier = useEntitlements((s) => s.tier);
  const billingActive = useEntitlements((s) => s.billingActive);
  const eff = effectiveTier({ tier, billingActive });
  const user = useAccount((s) => s.user);
  const [deckCount, setDeckCount] = useState<number | null>(null);
  const [showLicenses, setShowLicenses] = useState(false);
  const [deviceName, setDeviceNameInput] = useState("");
  const [devSaving, setDevSaving] = useState(false);

  useEffect(() => {
    deckCountTotal().then(setDeckCount);
    void loadDeviceName().then(() => setDeviceNameInput(getDeviceName()));
  }, []);

  const onSaveDeviceName = useCallback(async () => {
    setDevSaving(true);
    try {
      await setDeviceName(deviceName);
      await applyDeviceNameToLocalBooks(); // re-stamp this device's cloud books with the new name
      Alert.alert("保存しました", "この端末の名前を更新しました。");
    } catch (e) {
      Alert.alert("エラー", e instanceof Error ? e.message : String(e));
    } finally {
      setDevSaving(false);
    }
  }, [deviceName]);

  const contact = useCallback(() => {
    const subject = encodeURIComponent("Kiokumate お問い合わせ");
    const body = encodeURIComponent(
      `\n\n────────\nApp: Kiokumate ${APP_VERSION}\niOS: ${String(Platform.Version)}\n（不具合の場合は、再現手順とPDFの種類を書いていただけると助かります）`,
    );
    Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`).catch(() =>
      Alert.alert("メールを開けません", SUPPORT_EMAIL),
    );
  }, []);

  const rate = useCallback(async () => {
    try {
      if (await StoreReview.hasAction()) {
        await StoreReview.requestReview();
        return;
      }
    } catch {
      /* fall through */
    }
    if (APP_STORE_ID) Linking.openURL(`https://apps.apple.com/app/id${APP_STORE_ID}?action=write-review`);
    else Alert.alert("ありがとうございます", "App Storeでの公開後にレビューできます。");
  }, []);

  const doRestore = useCallback(async () => {
    try {
      const tier = await restore();
      Alert.alert(tier !== "free" ? "復元しました" : "復元できる購入が見つかりません");
    } catch (e) {
      Alert.alert("エラー", e instanceof Error ? e.message : String(e));
    }
  }, []);

  const onSignOut = useCallback(() => {
    Alert.alert(
      "ログアウト",
      "ログアウトしてもこの端末の本は保持されますが、サインインするまで開けなくなります。",
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "ログアウト",
          onPress: async () => {
            try {
              await signOut(); // keep local data; the sign-in gate locks it until re-login
              setView({ name: "decks" });
            } catch (e) {
              Alert.alert("エラー", e instanceof Error ? e.message : String(e));
            }
          },
        },
      ],
    );
  }, [setView]);

  const onDeleteAccount = useCallback(() => {
    Alert.alert(
      "アカウントを削除",
      "アカウントと、クラウドに保存されたPDF・進捗をすべて削除します。この端末内のデータもすべて削除されます。この操作は取り消せません。",
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "削除",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteAccount();
              await clearAllLocalData(); // also wipe this device's library
              setView({ name: "decks" }); // back to the (now empty) bookshelf, signed out
              Alert.alert("削除しました", "アカウントとデータをすべて削除しました。");
            } catch (e) {
              const code = (e as { code?: string }).code;
              Alert.alert(
                "エラー",
                code === "auth/requires-recent-login"
                  ? "セキュリティのため、もう一度ログインしてから削除してください。"
                  : e instanceof Error
                    ? e.message
                    : String(e),
              );
            }
          },
        },
      ],
    );
  }, [setView]);

  return (
    <View style={styles.c}>
      <View style={styles.top}>
        <Pressable onPress={() => setView({ name: "decks" })} hitSlop={10}>
          <Text style={styles.back}>← 本棚</Text>
        </Pressable>
        <Text style={styles.title}>情報・ヘルプ</Text>
        <View style={{ width: 48 }} />
      </View>

      <ScrollView contentContainerStyle={styles.pad}>
        <Section title="使い方">
          <Help
            q="Kiokumate（キオクメイト）とは？"
            a="色付きの答え（赤やマゼンタ）が印刷されたPDFを取り込むと、答えの部分を自動で検出して隠せます。タップで答えを確認しながら暗記でき、隠し方は『赤マスク』（答えを個別に隠す）と『赤シート』（半透明のシートをスライド）から選べます。PDFの解析は端末内で完結します（解析のために送信されることはありません）。クラウド同期（Pro）を使う場合のみ、ご自身の端末間で共有するためにPDFがアカウントに保存されます。"
          />
          <Help
            q="PDFの取り込み方"
            a="本棚の「＋ 取り込む」からPDFを選び、答えの色（赤／マゼンタ／橙／青）を選んで検出します。検出には少し時間がかかります（中止可）。"
          />
          <Help
            q="検出がうまくいかない時"
            a="ビューア右上の⚙設定で、答えの色プリセットや詳細（色相・許容幅・彩度の下限・見出し除外）を調整して『このPDFを再検出』してください。1ページのプレビューで結果を確認しながら調整できます。"
          />
          <Help
            q="ビューアの操作"
            a="答えをタップで表示／もう一度タップで再び隠す。隠し方は『赤マスク』（答えを個別に隠す）と『赤シート』（縦読みで半透明シートをスライド）から選べます。2本指のピンチで拡大・縮小、倍率の数字をタップで100%に戻す。『縦読み／横読み』で読み方、『目次』でしおりの追加・移動ができます。"
          />
          <Help
            q="AI問題生成とデータの扱い"
            a="本の「問題」からAIで正誤問題（○×）を作れます。この機能だけは、選んだページの本文と暗記語句を当アプリのサーバー経由でAI（Anthropic）に送信して生成します（初回に同意確認があります）。赤シート・色の検出など他の機能は、これまでどおり端末内だけで完結します。生成した問題はご自身のアカウント内に保存され、ほかのユーザーへ共有・配布されません。プラン別に月間の生成ページ数の上限があります。"
          />
        </Section>

        <Section title="プラン">
          <Row
            label="現在のプラン"
            value={
              eff === "premium"
                ? "Premium（無制限）"
                : eff === "pro"
                  ? "Pro（無制限）"
                  : eff === "standard"
                    ? `Standard（本 ${deckCount ?? "…"} / ${STANDARD_DECK_LIMIT} 冊）`
                    : `Free（本 ${deckCount ?? "…"} / ${FREE_DECK_LIMIT} 冊）`
            }
          />
          <Row
            label="AI ○×問題の生成"
            value={
              eff === "premium"
                ? "月200ページ"
                : eff === "pro"
                  ? "月30ページ"
                  : eff === "standard"
                    ? "月10ページ"
                    : "月1ページ"
            }
          />
          {eff !== "pro" && eff !== "premium" ? (
            <Row label="プランをアップグレード" onPress={() => setView({ name: "paywall" })} />
          ) : null}
          <Row
            label="サブスクリプションを管理"
            onPress={() => Linking.openURL(MANAGE_SUBSCRIPTIONS_URL)}
          />
          <Row label="購入を復元" onPress={doRestore} />
          <DevTierSwitch />
        </Section>

        <Section title="アカウント">
          {user ? (
            <>
              <Row label="ログイン中" value={user.email ?? "Apple ID でログイン"} />
              <View style={styles.deviceField}>
                <Text style={styles.deviceLabel}>この端末の名前</Text>
                <View style={styles.deviceRow}>
                  <TextInput
                    style={styles.deviceInput}
                    value={deviceName}
                    onChangeText={setDeviceNameInput}
                    placeholder="例：Takayuki の iPhone"
                    placeholderTextColor={colors.muted}
                    autoCapitalize="none"
                  />
                  <Pressable
                    style={styles.deviceSave}
                    disabled={devSaving}
                    onPress={() => void onSaveDeviceName()}
                  >
                    <Text style={styles.deviceSaveText}>{devSaving ? "保存中…" : "保存"}</Text>
                  </Pressable>
                </View>
                <Text style={styles.deviceHint}>
                  クラウドの本一覧に表示される名前です。iOSは端末名を自動取得できないため自由に設定できます。
                </Text>
              </View>
              <Row label="ログアウト" onPress={onSignOut} />
              <Row label="アカウントを削除" onPress={onDeleteAccount} />
            </>
          ) : (
            <Row label="ログイン / 新規登録" onPress={() => setView({ name: "login" })} />
          )}
        </Section>

        <Section title="サポート">
          <Row label="お問い合わせ" onPress={contact} />
          <Row label="レビューを書く" onPress={rate} />
        </Section>

        <Section title="情報">
          <Row label="プライバシーポリシー" onPress={() => Linking.openURL(PRIVACY_URL)} />
          <Row label="利用規約" onPress={() => Linking.openURL(TERMS_URL)} />
          <Row label="バージョン" value={APP_VERSION} />
          <Row label="オープンソースライセンス" onPress={() => setShowLicenses((v) => !v)} />
          {showLicenses ? <Text style={styles.licenses}>{LICENSES}</Text> : null}
        </Section>

        {__DEV__ ? (
          <Section title="開発">
            <Row label="ペイウォール (dev)" onPress={() => setView({ name: "paywall" })} />
            <Row label="エンジン検証 (M0)" onPress={() => setView({ name: "engineTest" })} />
          </Section>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: colors.bg },
  top: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  back: { color: colors.ocean, fontSize: 16, width: 60 },
  title: { fontSize: 17, fontWeight: "700", color: colors.text },
  pad: { paddingHorizontal: 16, paddingBottom: 40 },
  section: { marginTop: 18 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: colors.textSub, marginBottom: 6, marginLeft: 4 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLabel: { fontSize: 15, color: colors.text },
  rowValue: { fontSize: 14, color: colors.textSub },
  chevron: { fontSize: 18, color: colors.muted },
  help: { paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  helpHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  helpQ: { fontSize: 15, color: colors.text, fontWeight: "600", flex: 1 },
  helpA: { fontSize: 13, color: colors.textSub, lineHeight: 20, marginTop: 8 },
  licenses: { fontSize: 12, color: colors.textSub, lineHeight: 20, padding: 14 },
  deviceField: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  deviceLabel: { fontSize: 15, color: colors.text, marginBottom: 8 },
  deviceRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  deviceInput: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  deviceSave: { backgroundColor: colors.sand, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 9 },
  deviceSaveText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  deviceHint: { fontSize: 12, color: colors.muted, lineHeight: 17, marginTop: 8 },
});
