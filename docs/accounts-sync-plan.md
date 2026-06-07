# アカウント ＋ web/iOS サブスク同期 — 実装計画

## 方針（確定）
- **ハイブリッド課金**: iOS = Apple IAP（15%）／ web = Stripe（~3.6%）。**RevenueCat で権利を同期**。
- **認証**: Firebase Auth（Sign in with Apple ＋ Google ＋ メール）。
- **同期キー**: Firebase UID を RevenueCat の App User ID に使う → 両プラットフォームで `Purchases.logIn(uid)`。
- データ（PDF・検出結果）は**端末ローカルのまま**（同期するのはサブスク権利だけ）。

## ⚠️ このフェーズから Apple Developer が必須
Sign in with Apple・IAP・実機の同期テストは **Expo Go では不可**。EAS dev build（＝Apple Developer $99/年）が要ります。メール認証だけは Expo Go でも確認可能。

## 前提セットアップ（あなた側）
1. **Apple Developer Program** 登録（$99/年）。
2. **Firebase プロジェクト**作成 → Authentication で Apple / Google / Email を有効化 → iOS・Web の config を取得（`EXPO_PUBLIC_FIREBASE_*` へ）。
3. **RevenueCat**:
   - iOS（Apple IAP）アプリ … 既存設定。
   - **Web Billing（Stripe）**を追加し、`premium` entitlement を**クロスプラットフォーム**に設定。
   - Stripe アカウント作成・連携。
4. **app.json**: iOS に Sign in with Apple を有効化（`ios.usesAppleSignIn: true`）。

## 実装（iOS / 私）
1. パッケージ: `firebase`, `@react-native-async-storage/async-storage`, `expo-apple-authentication`, （Google は `expo-auth-session`）。
2. `src/auth/firebase.ts`: 初期化（env config。未設定ならログイン機能を無効化＝Expo Goでも他機能は動く）。
3. `src/auth/account.ts`: Apple/Google/メールのサインイン、サインアウト、**アカウント削除**、`onAuthStateChanged → Purchases.logIn/logOut(uid)`。
4. **ログイン画面** ＋ 設定（ヘルプ・情報）に「アカウント」セクション（ログイン／ログアウト／削除）。
5. **ペイウォール**: 「Premium をお持ちの方はログイン」導線（※iOS内で外部=web課金へ誘導・リンクはしない）。
6. **プライバシーポリシー改定**（メール／認証ID、Firebase、アカウント削除条項）。

## 実装（web / 別リポ＝Cloudflare の anki-sheet）
1. 同じ Firebase プロジェクトでログイン。
2. **Stripe Checkout ＋ RevenueCat Web Billing** で `premium` を購入。
3. 同じ Firebase UID で `Purchases.logIn`。

## Apple 審査の注意（マルチプラットフォーム）
- web 購入分を iOS で解放するのは **3.1.3(b)** で OK。
- iOS アプリ内で**外部（web）課金へ誘導・リンクしない**（アンチステアリング 3.1.1）。
- **アプリ内アカウント削除**を必ず実装（5.1.1(v)）。

## テスト段取り
- メール認証: Expo Go で可。
- Sign in with Apple / IAP / 同期: EAS dev build（Apple Developer 必須）で。
