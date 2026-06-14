# タスク管理

最終更新：2026-06-14

---

## 🔥 次のセッションで着手（優先順）

- [ ] **web 本番デプロイ（最優先・未完）**：F/C＋#11/#17＋法務文言を反映。**※ `npm run build`＋`npx wrangler pages deploy dist --project-name=anki-sheet` は web リポジトリ `../_ref-anki-sheet` で実行**（前回 iOS repo で叩き "Missing script: build"）。後に RC webhook 200／AI生成 をスポットチェック。
- [ ] **1.0.1 提出**：1.0.0（Build 4）承認後、Build 9（1.0.1・監査+A・TF検証済）を `eas submit`（手順は HANDOFF.md）。
- [ ] **監査 E 実機検証（1.0.2）**：WebViewハードニング（`56882e1`）を次 iOS ビルドに同梱→取り込み/閲覧の回帰確認。OKなら universal-access 除去（同一オリジン配置改修）も検討。

---

## 🚧 進行中

- [ ] Android トラック準備（Play未登録・14日クローズドテスト要・Google Sign-In・RevenueCat Android）。

---

## ✅ 完了

- [x] ローンチ前監査 19件修正（2026-06-13）
- [x] セキュリティ審査 5観点＝Critical/High なし（2026-06-13）
- [x] 依存・シークレットスキャン（npm audit / gitleaks / depcheck）（2026-06-13）
- [x] セッション管理ファイル整備（CLAUDE.md / tasks.md / /checkpoint / /wrap-up）（2026-06-14）
- [x] 追加セキュリティ調査：プロンプト注入／プラン強制（今日の復習）／WebViewオリジン／トークン保管（2026-06-14）
- [x] AGENTS.md 参照SDK修正（v56→v54）・監査を docs/research/ に正本化・Claudeメモリをポインタ化（2026-06-14）
- [x] セキュリティ A 実装：Firebaseセッション → SecureStore/Keychain アダプタ（`secureStorage.ts`・要実機検証）（2026-06-14）
- [x] **A 実機検証完了（TF #1-3合格）**（2026-06-14）
- [x] **1.0.1=Build 9（監査+A・Option1）を EAS ビルド＋TF提出**（2026-06-14）
- [x] **監査 F・C 実装**（プロンプト注入／webhook定数時間・web `6ba20b3`/`f3a4b19`）（2026-06-14）
- [x] **監査 E 部分実装**（nav guard/origin検証/originWhitelist・iOS `56882e1`・要実機検証1.0.2）（2026-06-14）
- [x] **監査 B 許容判断**（fail-open は本番到達不可・コード変更なし）（2026-06-14）

---

## 🗂️ バックログ（優先度低・将来対応）

- [ ] セキュリティ E（WebViewハードニング・**部分実装済 `56882e1`**＝1.0.2 で要実機検証／universal-access 除去は同一オリジン配置改修が前提）　※**F・C 実装済→デプロイ待ち・B 許容クローズ・D 見送り**
- [ ] Firebase Web API キーを GCP で制限（iOSバンドルID＋Identity Toolkit のみ）
- [ ] Expo SDK 昇格（`npm audit` 14 moderate を解消）

---

## 📌 判断待ち・保留

- [ ] セキュリティ D（証明書ピンニング）：運用リスク大につき**見送り推奨**
- [ ] 「今日の復習」クライアントゲート：ローカル限定機能ゆえ**許容推奨**（サーバー完全強制は不可）
