# タスク管理

最終更新：2026-06-14

---

## 🔥 次のセッションで着手（優先順）

- [ ] **セキュリティ A 実機検証**（実装済・`47b4450`）：次ビルドで「初回起動の旧セッション移行→再起動でログイン維持／サインアウトで Keychain 消去」を TestFlight 確認。
- [ ] **1.0.1 ビルド方針**：A を既存 Build 8（監査修正入り）に同梱して再ビルドするか、Build 8 はそのまま出し A を 1.0.2 へ回すか（HANDOFF.md ⑤）。
- [ ] **1.0.1 提出**：1.0.0（Build 4）承認後、`app.json` 1.0.1 にして提出（手順は HANDOFF.md）。
- [ ] **web backend デプロイ**：#11/#17 を本番反映＋未pushコミットを push。

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

---

## 🗂️ バックログ（優先度低・将来対応）

- [ ] セキュリティ E（WebViewハードニング）／B（fail-open）　※**F（プロンプト注入）・C（webhook定数時間比較）は 2026-06-14 実装済（web `6ba20b3`/`f3a4b19`）→ 本番デプロイで有効化**
- [ ] Firebase Web API キーを GCP で制限（iOSバンドルID＋Identity Toolkit のみ）
- [ ] Expo SDK 昇格（`npm audit` 14 moderate を解消）

---

## 📌 判断待ち・保留

- [ ] セキュリティ D（証明書ピンニング）：運用リスク大につき**見送り推奨**
- [ ] 「今日の復習」クライアントゲート：ローカル限定機能ゆえ**許容推奨**（サーバー完全強制は不可）
