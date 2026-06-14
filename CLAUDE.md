# Kiokumate（キオクメイト）- Claude Code コンテキスト

@AGENTS.md

---

## ⚙️ セッション管理ルール（必読・毎回従うこと）

### セッション開始時
1. このファイル（CLAUDE.md）を読み、前回セッションの状態を把握する
2. `docs/tasks.md` を確認し、未完了タスクと今回の作業範囲を把握する
3. 関連する調査ファイル（`docs/research/`）が存在する場合は読み込む
4. 「前回の続きから始めます。現在の状態：[サマリー]」と日本語で報告する

### セッション中
- **重要な設計・方針を決定したとき**：その場で CLAUDE.md の該当セクションを更新する
- **バグ・脆弱性を発見したとき**：「未解決の課題」セクションに即座に追記する
- **調査が完了したとき**：`docs/research/[トピック].md` に結果を保存する
- **コンテキストが重くなってきたと感じたら**：`/compact` を提案する

### セッション終了時
ユーザーが「終わり」「セッション終了」「/wrap-up」と言ったら、以下を実行する：
1. CLAUDE.md を更新（決定事項・解決済み課題・次回タスク）
2. `docs/tasks.md` を更新（完了チェック・次回優先順位）
3. 更新サマリーを日本語で表示する

---

## 🏗️ アーキテクチャ・設計決定事項

- **アプリ**：Kiokumate（キオクメイト）— PDF教材を赤シートで暗記する iOS アプリ。運営：TK Dev Lab（tkdevlab.com）。本番API：`https://kiokumate.tkdevlab.com`。
- **スタック**：Expo SDK 54 / React Native 0.81.5。EAS Build/Submit（`appVersionSource: remote` ＋ `autoIncrement`）。ナビゲーションは自前の単一スタック（zustand `useApp`）。
- **バックエンド**：Cloudflare Pages Functions ＋ D1（`anki-sheet-db`）＋ R2（`anki-sheet-pdfs`）。別リポジトリ `../_ref-anki-sheet`（本リポジトリと同階層）。
- **認証**：Firebase Auth（メール＋Apple Sign-In）。**サインイン必須**（Apple 5.1.1(v)）。サーバーは Firebase ID トークンを Web Crypto で検証（RS256・aud/iss/exp・`functions/_lib/auth.ts`）。**セッション永続化はクライアント側で iOS Keychain**（`src/auth/secureStorage.ts`／expo-secure-store。AsyncStorage平文ではない。キーサニタイズ＋値チャンク分割でラップ）。
- **課金**：RevenueCat（IAP）。tier は **D1 `users.tier`（RevenueCat webhook が権威）**。Free ¥0(本1/AI月1) / Standard ¥300(本10/AI月10) / Pro ¥600(無制限・クラウド同期・AI月30) / Premium ¥980(＋「今日の復習」SRS・AI月100)。7日間トライアル。
- **AI問題生成**：**サーバー専用 `ANTHROPIC_API_KEY`**、Claude Haiku（`/api/sync/generate`）。クライアントに鍵なし。tier＋月次quotaはサーバーが原子的に強制。
- **データ同期**：全 `/api/sync/*` ルートは検証済 `uid` スコープ（IDOR なし）。R2 キーは `${uid}/...` 名前空間。clozes/bookmarks/reviews は LWW マージ。
- **検出エンジン**：WebView 内 pdf.js（`assets/engine.zip`、ソースは `engine-src/`）。RN↔WebView は JSON ブリッジ（二重 stringify でエスケープ）。
- **ドキュメント運用**：恒久的な知見・監査は `docs/research/<topic>.md`（リポジトリ正本）に置き、CLAUDE.md からはパス参照する（Claudeメモリは参照しない）。AGENTS.md の参照ドキュメントは常に稼働中 SDK（現 v54）に合わせる。
- ※ ローンチの**ライブ状態**（Build番号・審査状況・未pushコミット）は `../HANDOFF.md`（本リポジトリと同階層）が正。

---

## ⚠️ 未解決の課題

セキュリティ・ハードニング・バックログ（2026-06-13 監査、**Critical/High なし**。詳細は `docs/research/security-audit.md`）：

- [ ] **E (Low・部分実装済 2026-06-14 `56882e1`)** WebViewハードニング — `src/engine/{Engine,Viewer}WebView.tsx`：✅`onShouldStartLoadWithRequest`(file://以外の遷移ブロック)・✅onMessage で `nativeEvent.url` 検証・✅`originWhitelist`→`["file://*"]`。⏸️`allowUniversalAccessFromFileURLs` は engine が別dirのステージPDFを XHR するため必須＝据え置き（除去は同一オリジン配置への改修前提）。**要実機検証（1.0.2 同梱・取り込み/閲覧の回帰確認）。app.json を 1.0.2 にバンプ済（`fde9d46`・未push）→ 次 `eas build` で焼成して実機検証**。
- [ ] **D (任意・見送り推奨)** 証明書ピンニング（運用リスク＞便益）。
- [ ] Firebase Web API キーを GCP コンソールで制限（App=iOSバンドルID／API=Identity Toolkit のみ）。
- [ ] 「今日の復習」はクライアントのみゲート（Low・ローカル限定機能ゆえの設計・**許容推奨**）。
- [ ] `npm audit` 14 moderate（全て Expo ビルドツール＝非ブロッカー、SDK昇格時に解消）。

---

## ✅ 解決済みの課題

- [x] ローンチ前監査 第1〜3弾：データ消失・認可・整合・課金返金・WebView復旧 等 **19件すべて修正**（git履歴：`dc97e8f` / `817be62` / `c25b64d`、#2 は revert）。
- [x] セキュリティ審査5観点（認証/課金/通信/同期/入出力）＝**Critical/High なし**を確認（2026-06-13）。
- [x] **AGENTS.md の参照SDK不整合を修正**：v56 → **v54**（稼働中 Expo SDK に一致。`package.json` で裏取り）（2026-06-14）。
- [x] **ドキュメント正本化**：セキュリティ監査を `docs/research/` の実ファイルに集約、CLAUDE.md を実パス参照に統一（Claudeメモリ参照のデッドリンク解消）、Windows絶対パスを相対化、メモリはポインタ化（2026-06-14）。
- [x] **セキュリティ A（最優先ハードニング）実装（2026-06-14）**：Firebase セッション永続化を AsyncStorage平文 → **SecureStore/Keychain アダプタ**（新設 `src/auth/secureStorage.ts`、`firebase.ts:31` 差し替え、`expo-secure-store ~15.0.8`＋app.json plugin）。キーサニタイズ＋値640字チャンク分割＋旧セッション1回移行→平文消去。`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`（iCloud/暗号化バックアップ除外）。`tsc` 通過。**Build 9(1.0.1) に同梱 → TestFlight 実機検証完了（#1旧セッション移行／#2再起動でログイン維持／#3サインアウトでKeychain消去＝全合格・2026-06-14）。1.0.0 承認後に 1.0.1 提出可**。
- [x] **セキュリティ F・C 実装（2026-06-14）**：F＝AI生成プロンプトに未信頼データ宣言＋`generate.ts` の `===` デリミタ（web `6ba20b3`）／C＝webhook secret を double-HMAC 定数時間比較（`revenuecat.ts`・web `f3a4b19`）。`tsc -p tsconfig.json` 通過。**本番 Pages デプロイで有効化**（#11/#17 と同梱）。
- [x] **セキュリティ B（fail-open）＝許容（コード変更なし・2026-06-14）**：`effectiveTier`(`entitlements.ts:33`) の pro fail-open は **本番到達不可**＝`purchases.ts` が configured build で fail-closed（初回fetch失敗時 billingActive=true・tier=free でロック・`purchases.ts:80`）。`billingActive=false` は placeholder鍵/Expo Go 限定（dev用）。effectiveTier はローカルUI専用でサーバーが実cap強制。D・「今日の復習」と同じ許容。

---

## 🔬 調査済み事項

- **セキュリティ審査（5観点）**：JWT検証堅牢・tierはサーバー権威・Anthropicキー秘匿・全同期uidスコープ・SQLパラメータ化・WebViewはローカル信頼エンジンのみ。
- **プロンプト注入**：system/userロール分離＋JSON出力検証＋quotaで contained（Low）。唯一の不足＝Finding F。
- **プラン強制**：AI生成・復習クラウド同期はサーバー権威（402/403）。「今日の復習」起動のみクライアントゲート（ローカル限定機能）。
- **依存・シークレット**：gitleaks クリーン（検出は公開前提キーのみ・`.env` は gitignore 済）。depcheck の typescript / expo-dev-client は誤検出（保持）。
- **トークン保管（Finding A 実装根拠）**：iOS Keychain 制約2点＝キーは `[A-Za-z0-9._-]` のみ（Firebaseの `:` 不可→サニタイズ）／値 ~2048B 超で拒否されうる（認証blobは超え得る→640字チャンク＋manifest）。自作AESは不採用（expo-crypto に AES 無し）、ファーストパーティ `expo-secure-store` のみで完結。
- **fail-open（B）の文脈**：`effectiveTier` の pro fail-open は本番到達不可＝`purchases.ts` が configured build で fail-closed（初回fetch失敗→billingActive=true/tier=free でロック・`purchases.ts:80`）。`billingActive=false` は placeholder鍵/Expo Go 限定。→ B 許容。
- **engine の PDF 読込（E の制約）**：engine は `<documents>/engine/`、ステージPDFは `<documents>/`（別dir＝file://クロスオリジン）、全呼び出しが `{url}`（base64未使用）。engine が親dirの PDF を XHR するため `allowUniversalAccessFromFileURLs` 必須＝E では据え置き（除去は同一オリジン配置改修が前提）。
- 参照：`docs/research/security-audit.md` / `docs/research/security-scan-tooling.md`。

---

## 📋 次のセッションでやること

1. ✅**web 本番デプロイ（完了 2026-06-14・production）**：F/C＋#11/#17＋法務文言を本番反映。`../_ref-anki-sheet` で `npm run build`＋`npx wrangler pages deploy dist --project-name=anki-sheet`。スポットチェック通過（health200/sync401/webhook未署名401/sample.pdf200/法務200/ComingSoonハッシュ一致）。**残＝RC実署名webhook200／AI生成のアプリ側確認（外部からは検証不可）**。
2. **1.0.1 提出（1.0.0 審査待ち＝ブロック中）**：1.0.0（Build 4）承認後、Build 9（1.0.1・監査+A・TF検証済・ASCアップ済）を ASC で版作成→Build 9選択→審査提出（バイナリはTFにあり再 eas submit 不要・手順は HANDOFF.md）。
3. **監査 E 実機検証（1.0.2）**：app.json を 1.0.2 にバンプ済（`fde9d46`・未push）。次 `eas build` で焼成→取り込み/閲覧の回帰確認。コードは両WebView検証済。OKなら universal-access 除去（同一オリジン配置改修）も検討。
4. Android トラック：Play登録・Google Sign-In・RevenueCat Android・ストア素材。

---

## 📝 セッション履歴

- **2026-06-13〜14**：ローンチ前監査19件修正・Build 8投入。セキュリティ審査（5観点・プロンプト注入・プラン強制・WebViewオリジン・トークン保管）実施＝Crit/High なし→バックログ A–F 化。依存/シークレットスキャン（npm audit / gitleaks / depcheck）。セッション管理ファイル（CLAUDE.md / tasks.md / `/checkpoint` / `/wrap-up`）整備。終盤に **AGENTS.md を v54 に修正**・監査を `docs/research/` へ正本化・メモリをポインタ化。
- **2026-06-14（本セッション）**：6/14文書を git 正本化（`d415a6d`）。**セキュリティ A 実装**＝Firebaseセッションを SecureStore/Keychain アダプタ化（`src/auth/secureStorage.ts` 新設・`firebase.ts` 差し替え・`expo-secure-store ~15.0.8`＋app.json plugin）、`tsc`＋チャンクロジック検証9/9・要実機検証（`47b4450`）。監査正本／CLAUDE.md／tasks を更新、`../HANDOFF.md` を現状（iOS HEAD・未push8件・A状況）へ同期。iOS main は origin より **8コミット先行＝未push**。
- **2026-06-14（夕）**：A 実機検証完了（TF #1-3合格）→ **1.0.1=Build 9（監査+A・Option1）を EAS ビルド＋TF提出**。監査 Low 一巡＝**F**(プロンプト注入・web `6ba20b3`)・**C**(webhook定数時間・web `f3a4b19`)実装、**E**(WebViewハードニング・部分・iOS `56882e1`・要実機検証1.0.2)、**B**(fail-open)は本番到達不可で許容。iOS/web 両 repo push 済み・**web デプロイは次回**（`../_ref-anki-sheet` で実行）。
