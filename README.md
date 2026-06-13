# Kiokumate (iOS) — `anki-sheet-ios`

赤シート暗記アプリ **Kiokumate** の iOS アプリ（Expo / React Native）。
色付きの答えが印刷された学習 PDF を取り込み、端末内で答えを検出して赤シートのようにマスク、タップで表示/非表示、AI で問題生成。
バックエンドは web リポジトリ **`anki-sheet`**（Cloudflare Pages Functions）と共有。

本番は**サインイン必須**（メール/パスワード or Sign in with Apple）。未ログインでは Login 画面に固定される（`App.tsx` の forced sign-in wall）。サインイン後は学習機能（取り込み・読書・演習）はローカル SQLite でオフラインでも動作し、ネットワークが要るのは **AI生成・クラウド同期・購入復元**。

## 外部サービスと役割 / External services

| サービス | 役割（iOS から見た） |
|---|---|
| **Firebase Authentication** — `anki-sheet-b73b0` | サインイン（メール/パスワード＋Sign in with Apple）。取得した ID トークンをバックエンド呼び出しに付与。**認証のみ・データ保存はしない**。 |
| **RevenueCat（SDK）** | アプリ内課金/サブスク。entitlements `standard`/`pro`/`premium`。購入は StoreKit 経由、tier 反映は RevenueCat webhook → 共有バックエンド。 |
| **Cloudflare Pages Functions**（`anki-sheet` repo の `functions/`） | 共有バックエンド `/api/*`。本レジストリ・進捗・SRS 同期（D1）、PDF クラウド同期（R2）、AI 問題生成の中継。`src/sync/api.ts` の `SYNC_BASE` が指す。 |
| **Anthropic Claude API** | AI 問題生成（Claude Haiku 4.5）。アプリは直接叩かず**バックエンド経由**（APIキーはサーバ専用）。 |
| **Apple App Store Connect / StoreKit** | 配信＋アプリ内課金処理。 |
| **Expo EAS** | クラウドビルド／提出（`eas build` / `eas submit`、`eas.json`）。 |

## 開発・ビルド
```sh
npx expo start                              # ローカル開発
npx tsc --noEmit                            # 型チェック
eas build  -p ios --profile production      # 本番ビルド
eas submit -p ios --latest                  # App Store Connect へ提出
```

> ⚠ Expo はバージョンで API が変わります。コードを書く前に versioned docs を確認（`AGENTS.md` 参照）。
> 設定の要点: `app.json`（version/bundleId/`usesAppleSignIn`/projectId）、`src/config.ts`（公開URL/サポート連絡先）、`src/sync/api.ts`（`SYNC_BASE`）。
