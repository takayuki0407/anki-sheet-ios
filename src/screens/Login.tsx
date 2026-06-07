// Login / sign-up. Sign in with Apple (native; works on a dev build / TestFlight, hidden
// in Expo Go where it's unavailable) + email/password (works in Expo Go once Firebase is
// configured). Logging in syncs the account's subscription entitlement to this device.
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import { useApp } from "../store/session";
import {
  appleAvailable,
  isAuthConfigured,
  signInWithApple,
  signInWithEmail,
  signUpWithEmail,
} from "../auth/account";
import { colors } from "../ui/theme";

export function Login() {
  const setView = useApp((s) => s.setView);
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [showApple, setShowApple] = useState(false);

  useEffect(() => {
    appleAvailable().then(setShowApple);
  }, []);

  const done = useCallback(() => setView({ name: "decks" }), [setView]);

  const onApple = useCallback(async () => {
    try {
      setBusy(true);
      await signInWithApple();
      done();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "ERR_REQUEST_CANCELED")
        Alert.alert("エラー", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [done]);

  const onEmail = useCallback(async () => {
    try {
      setBusy(true);
      if (mode === "in") await signInWithEmail(email, password);
      else await signUpWithEmail(email, password);
      done();
    } catch (e) {
      Alert.alert("エラー", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [mode, email, password, done]);

  return (
    <View style={styles.c}>
      <Pressable onPress={() => setView({ name: "decks" })} hitSlop={10}>
        <Text style={styles.back}>← 閉じる</Text>
      </Pressable>
      <View style={styles.body}>
        <Text style={styles.title}>ログイン</Text>
        <Text style={styles.lead}>
          ログインすると、ご利用中のサブスクリプションをこの端末に反映できます。
        </Text>

        {!isAuthConfigured ? (
          <Text style={styles.notice}>※ ログインは公開ビルドで有効になります（設定準備中）。</Text>
        ) : null}

        {showApple ? (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={12}
            style={styles.appleBtn}
            onPress={onApple}
          />
        ) : null}

        <Text style={styles.or}>{showApple ? "または メールで" : "メールでログイン"}</Text>
        <TextInput
          style={styles.input}
          placeholder="メールアドレス"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="パスワード"
          placeholderTextColor={colors.muted}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        <Pressable style={[styles.primary, busy && styles.disabled]} onPress={onEmail} disabled={busy}>
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryText}>{mode === "in" ? "ログイン" : "新規登録"}</Text>
          )}
        </Pressable>
        <Pressable onPress={() => setMode((m) => (m === "in" ? "up" : "in"))} hitSlop={8}>
          <Text style={styles.toggle}>
            {mode === "in" ? "アカウントを新規作成" : "既存のアカウントでログイン"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, padding: 20, backgroundColor: colors.bg },
  back: { color: colors.ocean, fontSize: 16 },
  body: { flex: 1, justifyContent: "center", gap: 12 },
  title: { fontSize: 26, fontWeight: "800", color: colors.text, textAlign: "center" },
  lead: { fontSize: 14, color: colors.textSub, textAlign: "center", lineHeight: 21, marginBottom: 8 },
  notice: { fontSize: 12, color: colors.warning, textAlign: "center" },
  appleBtn: { height: 50, marginVertical: 4 },
  or: { textAlign: "center", color: colors.muted, fontSize: 13, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: colors.surface,
    color: colors.text,
  },
  primary: { backgroundColor: colors.sand, paddingVertical: 14, borderRadius: 12, alignItems: "center", marginTop: 4 },
  disabled: { opacity: 0.6 },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  toggle: { color: colors.ocean, fontSize: 14, textAlign: "center", paddingVertical: 8 },
});
