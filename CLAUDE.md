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
- **認証**：Firebase Auth（メール＋Apple Sign-In）。**サインイン必須**（Apple 5.1.1(v)）。サーバーは Firebase ID トークンを Web Crypto で検証（RS256・aud/iss/exp・`functions/_lib/auth.ts`）。
- **課金**：RevenueCat（IAP）。tier は **D1 `users.tier`（RevenueCat webhook が権威）**。Free ¥0(本1/AI月1) / Standard ¥300(本10/AI月10) / Pro ¥600(無制限・クラウド同期・AI月30) / Premium ¥980(＋「今日の復習」SRS・AI月100)。7日間トライアル。
- **AI問題生成**：**サーバー専用 `ANTHROPIC_API_KEY`**、Claude Haiku（`/api/sync/generate`）。クライアントに鍵なし。tier＋月次quotaはサーバーが原子的に強制。
- **データ同期**：全 `/api/sync/*` ルートは検証済 `uid` スコープ（IDOR なし）。R2 キーは `${uid}/...` 名前空間。clozes/bookmarks/reviews は LWW マージ。
- **検出エンジン**：WebView 内 pdf.js（`assets/engine.zip`、ソースは `engine-src/`）。RN↔WebView は JSON ブリッジ（二重 stringify でエスケープ）。
- **ドキュメント運用**：恒久的な知見・監査は `docs/research/<topic>.md`（リポジトリ正本）に置き、CLAUDE.md からはパス参照する（Claudeメモリは参照しない）。AGENTS.md の参照ドキュメントは常に稼働中 SDK（現 v54）に合わせる。
- ※ ローンチの**ライブ状態**（Build番号・審査状況・未pushコミット）は `../HANDOFF.md`（本リポジトリと同階層）が正。

---

## ⚠️ 未解決の課題

セキュリティ・ハードニング・バックログ（2026-06-13 監査、**Critical/High なし**。詳細は `docs/research/security-audit.md`）：

- [ ] **A (Medium)** Firebaseセッション（長命リフレッシュトークン）が AsyncStorage 平文 — `src/auth/firebase.ts:31`。SecureStore/Keychain アダプタへ。**最優先**。
- [ ] **E (Low)** WebViewハードニング — `src/engine/{Engine,Viewer}WebView.tsx`：`allowUniversalAccessFromFileURLs` 除去・`originWhitelist` 限定・`onShouldStartLoadWithRequest` 追加・onMessage で `nativeEvent.url` 検証。
- [ ] **B (Low)** `src/iap/entitlements.ts:33` が pro へフェイルオープン（サーバー強制済＝影響はローカルUIのみ）。
- [ ] **F (Low)** プロンプト注入ハードニング — `_ref-anki-sheet/functions/api/sync/generate.ts` の SYSTEM_PROMPT に「未信頼データ」宣言＋デリミタ。
- [ ] **C (Info)** webhook secret を定数時間比較に — `functions/api/webhook/revenuecat.ts:78`。
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

---

## 🔬 調査済み事項

- **セキュリティ審査（5観点）**：JWT検証堅牢・tierはサーバー権威・Anthropicキー秘匿・全同期uidスコープ・SQLパラメータ化・WebViewはローカル信頼エンジンのみ。
- **プロンプト注入**：system/userロール分離＋JSON出力検証＋quotaで contained（Low）。唯一の不足＝Finding F。
- **プラン強制**：AI生成・復習クラウド同期はサーバー権威（402/403）。「今日の復習」起動のみクライアントゲート（ローカル限定機能）。
- **依存・シークレット**：gitleaks クリーン（検出は公開前提キーのみ・`.env` は gitignore 済）。depcheck の typescript / expo-dev-client は誤検出（保持）。
- 参照：`docs/research/security-audit.md` / `docs/research/security-scan-tooling.md`。

---

## 📋 次のセッションでやること

1. **セキュリティ A**（Firebaseセッション → SecureStore/Keychain）に着手。
2. 1.0.0（Build 4）承認後 → **1.0.1（監査修正入り Build 8）を提出**（手順は HANDOFF.md）。
3. web backend（#11/#17）本番デプロイ＋未pushコミットの push。
4. Android トラック：Play登録・Google Sign-In・RevenueCat Android・ストア素材。

---

## 📝 セッション履歴

- **2026-06-13〜14**：ローンチ前監査19件修正・Build 8投入。セキュリティ審査（5観点・プロンプト注入・プラン強制・WebViewオリジン・トークン保管）実施＝Crit/High なし→バックログ A–F 化。依存/シークレットスキャン（npm audit / gitleaks / depcheck）。セッション管理ファイル（CLAUDE.md / tasks.md / `/checkpoint` / `/wrap-up`）整備。終盤に **AGENTS.md を v54 に修正**・監査を `docs/research/` へ正本化・メモリをポインタ化。
