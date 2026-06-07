# Anki-sheet iOS — ビルド / 公開ガイド（Windows・Mac不要）

「赤シート暗記」アプリの iOS 版（Expo / React Native）。PDFのレンダリングと色検出は
WebView 内の pdf.js エンジン（`engine-src` をビルドした `assets/engine.zip`）で行い、
ストレージは expo-sqlite + ファイル、課金は RevenueCat（サブスク）。

## アーキテクチャ

```
anki-sheet-ios/
  App.tsx                  ルート（エンジン常駐 + zustandビュー切替 + 課金init）
  src/screens/             本棚 / 取り込み / ビューア / 設定 / ペイウォール / エンジン検証
  src/engine/              WebViewホスト・ブリッジ・展開・ビューアホスト
  src/db/                  expo-sqlite スキーマ・repo・PDFファイル・バックアップ
  src/iap/                 RevenueCat 連携 + 無料枠ゲート（3冊）
  engine-src/              WebViewエンジンの元コード（Vite）。pdf.js + 検出 + ビューア
  assets/engine.zip        ビルド済みエンジン（engine-src/dist を zip 化）※コミット対象
```

エンジンと RN は **page coordinates（PDFポイント, top-left）** を共有。検出も表示も同じ
pdf.js 座標系で完結するため座標合わせ不要。pdf.js の worker は `file://` から直接ロード
できない（WKWebView の SecurityError）ため、**blob URL 経由**で起動する（`pdfEngine.ts`）。

## エンジンを変更したら再ビルド

`engine-src/`（pdf.js連携・色検出・ビューア）を変更したら、必ず再ビルドして
`assets/engine.zip` と `src/engine/engineVersion.ts` を更新する：

```powershell
npm run engine:all      # engine:build (vite) + engine:bundle (zip + version)
```

## 検証コマンド（ローカル）

```powershell
# 検出アルゴリズムの単体テスト（PDF不要）
cd engine-src; npm test

# 実PDFでの統合テスト（任意・iPhone不要）
cd engine-src; npm i -D @napi-rs/canvas
$env:ANKI_SHEET_TEST_PDF="C:\path\to\redsheet.pdf"; npm test

# 型チェック
npx tsc --noEmit                         # RNアプリ
cd engine-src; npm run typecheck         # エンジン
npx expo-doctor                          # プロジェクト構成
```

## 1. iPhone 実機で動かす（開発ビルド）

> iOSシミュレータは Windows 不可。実機 + EAS クラウドビルドを使う。

### 前提
- **Expoアカウント**（無料）: https://expo.dev
- **Apple Developer Program（$99/年）**: 実機配布・公開・課金に必須

### 手順（すべて Windows の PowerShell）
```powershell
npx eas-cli login
npx eas-cli init                          # projectId を app.json に書き込み
npx eas-cli device:create                 # iPhoneのUDIDを登録（URL/QRを実機で開く）
npx eas-cli build --profile development --platform ios
#   → 完了後の install リンクを iPhone で開き Dev Client を入れる
npx expo start --dev-client               # QRをDev Clientで読む
```

### 受け入れテスト
- 取り込み: PDFを選ぶ→検出数>0、本棚にカバー表示
- ビューア: 赤シートON/OFF、個別タップ表示、縦/横、ズーム、目次、続き復元
- 設定: 色プリセット/詳細調整でプレビュー更新、再検出
- バックアップ: 書き出し→読み込みで復元（Web版JSONとも相互運用）

## 2. 課金（RevenueCat）の設定

1. **App Store Connect**: サブスク商品（例 月額/年額）と無料トライアルを作成。
2. **RevenueCat**（https://app.revenuecat.com）: プロジェクト作成 → Apple アプリを接続 →
   Entitlement を **`premium`** で作成（`src/iap/purchases.ts` の `ENTITLEMENT_ID` と一致）→
   商品を Entitlement に紐付け → Offering（current）に Package を追加。
3. **APIキー**: RevenueCat の iOS 公開キーを環境変数で渡す（または `purchases.ts` の
   プレースホルダを置換）。EAS では eas.json/Secrets に設定:
   ```powershell
   npx eas-cli env:create --name EXPO_PUBLIC_RC_IOS_KEY --value appl_xxx --environment production
   ```
4. **検証**: TestFlight のサンドボックスで購入→Premium解放、「購入を復元」を確認。
   - サブスク制: 7日無料トライアル → Standard(本 `STANDARD_DECK_LIMIT`=3 冊) / Pro(無制限)。
     未契約はペイウォールでロック。Standard で上限超過時は残す3冊を選んで削除。
   - 開発中は ペイウォールの `[DEV] tier 切替`（Pro/Standard/未契約/解除）でゲートを試験可能。

## 3. App Store へ公開（Windowsから）

```powershell
# 本番ビルド（クラウドmacOS、署名はEASが管理）
npx eas-cli build --profile production --platform ios

# App Store Connect へアップロード
npx eas-cli submit --profile production --platform ios
```
- App Store Connect でスクリーンショット・説明・プライバシー（「ユーザーが自分のPDFを
  端末内で処理、外部送信なし」）・サブスクの審査情報を入力 → 審査提出。
- TestFlight で内部/外部テスター配布も可。

## 残りの手動作業（コードは実装済み）
- [ ] EAS/Apple/RevenueCat アカウントと商品・Entitlement・APIキーの設定（上記2）
- [ ] 実機での受け入れテスト（上記1）
- [ ] アプリアイコン/スプラッシュのブランド差し替え（`assets/icon.png` 等。現状は既定画像）
- [ ] App Store メタ情報・スクショ・審査提出（上記3）

## 既知の設計メモ / 今後
- pdf.js worker は blob URL 起動。失敗時はメインスレッド実行へ自動フォールバック。
- 巨大PDFのメモリ対策（モバイル1.5x描画・ページcleanup・遅延描画）は移植済み。
- ビューアは v1 でハイブリッド（WebView描画）。将来ネイティブ描画への置換は最適化課題。
