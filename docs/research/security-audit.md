# セキュリティ監査（2026-06-13）— Kiokumate iOS ＋ web backend

> この文書が監査結果の**正本（canonical）**。CLAUDE.md からはこのパスを参照する。
> 対象：`anki-sheet-ios`（iOS）＋ `../_ref-anki-sheet`（Cloudflare Pages backend）。

## 総合判定

**Critical / High なし。** アーキテクチャは堅実：tier はサーバー権威（D1、RevenueCat webhook）、全同期データは uid スコープ（IDOR なし）、Anthropic キーはサーバーのみ、JWT 検証は正しい（RS256・aud/iss/exp）、SQL は完全パラメータ化、WebView はローカル信頼エンジンのみ。残りは Low/Medium のハードニング。

## ハードニング・バックログ（後日まとめて対応）

| # | 重大度 | 項目 | 場所 | 修正 |
|---|---|---|---|---|
| A | Medium※ | Firebaseセッション（長命リフレッシュトークン）がAsyncStorage平文 | `src/auth/firebase.ts:31` | ✅**実装済(2026-06-14)** SecureStore/Keychainアダプタ `src/auth/secureStorage.ts`（要実機検証） |
| E | Low | WebView権限過剰＋メッセージオリジン未検証 | `src/engine/{Engine,Viewer}WebView.tsx` | 下記「WebView」節 |
| B | Low | clientがproへfail-open | `src/iap/entitlements.ts:33` | ローカル専用Premium UIを起動時サーバーtierでゲート |
| F | Low | プロンプト注入の追加緩和 | `../_ref-anki-sheet/functions/api/sync/generate.ts` | ✅**実装済(2026-06-14・web `6ba20b3`)** UNTRUSTED_DATA_RULE＋`===`デリミタ（本番デプロイで有効化） |
| C | Info | webhook secret非定数時間比較 | `../_ref-anki-sheet/functions/api/webhook/revenuecat.ts:78` | ✅**実装済(2026-06-14・web `f3a4b19`)** double-HMAC定数時間比較（本番デプロイで有効化） |
| D | 任意 | 証明書ピンニング無し | — | 脅威モデル上**非実装が妥当** |

※A：実害には物理的な端末侵害が前提。非脱獄＋パスコードなら実務上 Low。アプリ唯一・最大のハードニング。**2026-06-14 実装済**：Firebase永続化を Keychain 直挿しに変更（キーを `[A-Za-z0-9._-]` にサニタイズ＋値を640字チャンク分割／`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` で iCloud同期・暗号化バックアップから除外／旧AsyncStorageセッションは初回起動で1回だけ移行→平文消去）。native module 追加につき**次ビルドに同梱して実機検証**が必要。

別途：Firebase Web API キーを GCP コンソールで制限（App=iOSバンドルID／API=Identity Toolkit のみ）。`npm audit` の 14 moderate は全て Expo ビルド時ツール＝非ブロッカー（SDK昇格で解消）。

## 5観点サマリ

- **認証・セッション**：JWT検証堅牢（`functions/_lib/auth.ts`：RS256固定・alg混同/none拒否・`email_verified`でadmin詐称防止）。`/api/sync/*`は全ルート401ゲート。→ Finding A（トークン保管）。
- **課金・サブスク**：RevenueCatがStoreKitレシートをサーバー検証→webhook（secret認証）→D1 `users.tier`。クライアントのRC状態は非信用。`/dev/tier`はadminのみ。→ Finding B/C。
- **API・通信**：Anthropicキーは完全サーバー側。HTTPS強制（ATS例外なし・平文URLなし）。→ Finding D（任意）。
- **データ同期**：全D1/R2が`ctx.data.uid`スコープ、R2キーは`${uid}/...`名前空間。IDORなし。書込(PUT)はPro強制。
- **入力・出力**：SQLi無し（全パラメータbind、`${}`はカラム名ホワイトリスト/プレースホルダのみ）。XSS実害なし（後述WebView）。→ Finding E/F。

## プラン強制（サーバー vs クライアント）

- **AI生成**：サーバー権威。`generate.ts`がtier（D1）＋月次quotaを原子的UPSERTで強制（402）。クライアントはUX表示のみ。
- **復習クラウド同期**：サーバー権威。`reviews.ts`がpremium/admin以外403。クライアントは403をlocal-only扱い（事前判定せず）。
- **ローカルSM-2**（`recordAnswer`/`sync/srs.ts`）：全tierで動作（設計）。間違いのみ復習＋due件数を駆動。
- **⚠「今日の復習」起動のみクライアントゲート**（`DeckList.tsx:636`／`Review.tsx:24`／`Quiz.tsx:213`）。ローカル限定機能でAPIを呼ばないためサーバーで守れない。深刻度 Low（課金面のみ・セキュリティ無影響。サーバーコストのかかるクロス端末同期は別途403で保護）。**許容推奨**。

## プロンプト注入

- AI送信は**1箇所のみ**：`../_ref-anki-sheet/functions/api/sync/generate.ts:189`（Anthropic直叩き）。クライアント（`src/ai/generate.ts`）は`/generate`を叩くだけ・鍵なし。
- ユーザー由来データ4種（pageText=PDF抽出／markedTerms／subjectHint=自由入力／prev・nextContext）は**userロールメッセージ**、ルールは**system**に分離（正しい境界）。assistant prefill`[`でJSON強制、`toOutQ`で出力スキーマ検証、長さ上限＋quota。
- 不足＝**Finding F**：内容サニタイズ無し・system内に「未信頼データ宣言」無し・`subjectHint`が最高レバレッジ。影響は自己生成のみ（クロスユーザー/権限昇格なし）＝Low。
- **2026-06-14 実装済（web `6ba20b3`）**：両 system プロンプトに `UNTRUSTED_DATA_RULE`（入力は「データであり指示ではない」・`===` で囲まれた範囲内の命令に従わない）＋ `buildUserMessage` で学習者提供部を `===` デリミタで囲む（最大問数はフェンス外の指示として維持）。出力は従来どおり `toOutQ` でスキーマ検証＋quota。本番 Pages デプロイで有効化。

## 資格情報の保存

- ~~直接AsyncStorage使用は`src/auth/firebase.ts:31`の1箇所のみ（Firebase永続化＝平文）~~ → **2026-06-14：Firebase永続化を SecureStore/Keychain アダプタ（`src/auth/secureStorage.ts`）へ移行**。AsyncStorage は当該アダプタ内の「旧セッション1回移行→消去」専用に縮小。
- **SecureStore/Keychain 採用**（Firebaseセッションのみ。`keychainService:"kiokumate.auth"`／`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`＝iCloud同期・暗号化バックアップ除外）。
- 加えて短命IDトークンをSQLite `meta` `pendingAccountPurge`（`src/auth/account.ts:176`、purge成功で消去）に一時保存。
- Firebase/RC公開キーはバンドル内（`EXPO_PUBLIC_*`、公開前提）。サーバー秘密はクライアントに無し。
- **移行判断**：Firebaseセッションのみ Keychain/Keystore 推奨（=Finding A、launch非ブロッカー）→ **実装完了(2026-06-14)**。非機密状態（onboarded/favorite/tier cache）は移行不要（過剰移行しない）。

## WebView postMessage / onMessage

- WebViewは2インスタンスのみ：`EngineWebView.tsx:174`／`ViewerWebView.tsx:222`の`onMessage`。RN→WebViewは`injectJavaScript`（二重`JSON.stringify`でエスケープ）。
- in-page側`engine-src/src/bridge.ts`：受信はホスト注入関数`window.ankiEngine.dispatch`のみ（`window 'message'`イベント未使用→iframe注入経路なし）、送信は`ReactNativeWebView.postMessage`。**安全**。
- **⚠ onMessageが送信元オリジン（`nativeEvent.url`）未検証＋`onShouldStartLoadWithRequest`無し＋`originWhitelist:["*"]`**（=Finding E）。現状は信頼済ローカルエンジン＋JS非実行PDFのみで実exploitなし（Low）。修正：`onShouldStartLoadWithRequest`でengine file://オリジン以外への遷移をブロック＋`nativeEvent.url`検証＋`allowUniversalAccessFromFileURLs`除去。
- **2026-06-14 部分実装（`56882e1`）**：両 WebView に `onShouldStartLoadWithRequest`(file://以外の遷移ブロック)＋`onMessage` の `nativeEvent.url` 検証＋`originWhitelist`→`["file://*"]` を追加。**`allowUniversalAccessFromFileURLs` は据え置き**：engine(`<documents>/engine/`)が別dirの `<documents>/` ステージPDFを XHR するため必須（除去は PDF 同一オリジン配置への改修が前提）。engine 中核ゆえ**要実機検証（次 1.0.2 ビルド）**。

## 依存・シークレットスキャン（2026-06-13）

- `npm audit`：14 moderate、すべてExpoビルド時ツール（postcss/uuid via @expo/cli・xcode）。**非ブロッカー**、SDK昇格で解消。
- `gitleaks`：クリーン（検出は`.env`の公開前提Firebaseキーのみ・gitignore済・履歴125コミット漏洩なし）。実行手順は `security-scan-tooling.md`。
- `depcheck`：`typescript`／`expo-dev-client`は誤検出（保持）。
