# セキュリティ／依存スキャンの実行手順（Windows / PowerShell 5.1）

2026-06-13 実施時のメモ。`security-audit.md` の結果を再現する手順。

- **gitleaks** — npmパッケージは無く `npx gitleaks` は失敗（"could not determine executable"）。Goバイナリを取得：GitHub API `repos/gitleaks/gitleaks/releases/latest` → `gitleaks_*_windows_x64.zip` を展開して `gitleaks.exe` を実行。注意点：
  - (1) 設定TOMLは**BOM無し**で書く。`Set-Content -Encoding utf8` はBOMを付け、gitleaks が "invalid character at start of key" で拒否する → `-Encoding ascii` を使う。
  - (2) `gitleaks dir .` / `--no-git` は node_modules も舐めて巨大＆ノイズだらけになる → config の `[allowlist] paths` で `node_modules` / `dist` / `.expo` / `ios[\\/]Pods` / `android` を除外。
  - `gitleaks dir <src>`（作業ツリー）と `gitleaks git <src>`（履歴）の両方を回す。結果（v8.30.1）＝クリーン。

- **/security-review** — 「ambiguous argument 'origin/HEAD'」で失敗 → `git remote set-head origin main`（不足している `refs/remotes/origin/HEAD` シンボリック参照を作成）で修正。web backend `../_ref-anki-sheet` でも同じ設定が要る。

- **depcheck** — `typescript` / `expo-dev-client` を未使用と誤検出するが、両方とも意図的（`typescript`=tsc型チェック、`expo-dev-client`=`eas.json` の `developmentClient:true`）。**削除しないこと。**
