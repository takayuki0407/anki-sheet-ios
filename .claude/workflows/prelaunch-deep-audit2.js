export const meta = {
  name: 'prelaunch-deep-audit',
  description: 'Kiokumate両リポジトリの徹底監査 — バグと意図しない動作を8観点で発見し、所見ごとに敵対的検証',
  phases: [
    { title: 'Find', detail: '8観点の並列レビュー（設計意図スペック付き）' },
    { title: 'Verify', detail: '所見ごとに反証検証（実コードを読んで判定）' },
  ],
}

const WEB = 'C:/Users/zabie/dev/_ref-anki-sheet'
const IOS = 'C:/Users/zabie/dev/anki-sheet-ios'

const SPEC = `
# Kiokumate 設計意図スペック（これとの「ズレ」も所見として報告すること）
製品: 赤シートPDF暗記アプリ。Web(${WEB}: Vite+React+Cloudflare Pages Functions+D1+R2)とiOS(${IOS}: Expo RN+WebView pdf.jsエンジン)。共有バックエンドはWebリポジトリのfunctions/。
## プラン
- free ¥0: 本1冊 / AI生成 月1回 / クラウド同期なし
- standard ¥300: 本10冊 / AI月10回 / 同期なし
- pro ¥600: 本無制限 / AI月30回 / クラウド同期(5GB,100MB/file)
- premium ¥980: Proの全機能 / AI月100回 / SM-2「今日の復習」/ 初回7日間無料トライアル(トライアル中のAIは30回にキャップ)
- admin: 無制限。users.tier行が管理者メールより優先(開発者が自プランを切替テストするため)。webhookはtier='admin'行を絶対に上書きしない。
- 年額=月額×10。
## 冊数とクラウド
- capはアカウント全体のACTIVEな本の数。free/standardは「単一ホーム」: 本は1端末(holder)にのみ存在し、holderはbooks.deviceにスタンプ、他端末はリコンサイル時にローカルコピー削除。pro+は多端末同期。
- canFetchOwnBook: ACTIVEな本のblob/content/progressのGETは全プランのオーナーに開放(データ人質禁止)。retained/trimmedはPro+のみ(再Pro復元専用)。PUTは常にPro+。
- trim(ダウングレード超過時): keep集合→active、他はretained(size>0)/trimmed(size=0)。trim_required=0なら{skipped:true}で何も退避せず、クライアントもローカル削除をスキップ。
- retentionワーカー(worker/retention.ts): 非pro+でdowngraded_atから183日経過→uid配下のR2全削除・books.size=0・questions/reviews削除・クロック解除。UIはsize=0で「端末のみ(復元不可)」表示になり正直であること。
## AI生成
- 生成1回=1ページ×問題種別(tf/mc4)。サーバで原子的に予約し失敗時返金。キャッシュ済み再表示は無料。再生成も1回消費。AI同意(初回)必須。Haiku使用。
## 学習
- 全プランがローカルに解答記録(間違いのみ復習は全プラン)。reviewsのクラウド同期(GET/POST)はpremium|adminのみ、403は静かにローカルのみ動作。
- SM-2: 正解q=4/不正解q=1、ease床1.3、間隔1→6→round(i×ease)、不正解でreps=0/interval=1。per-key LWW(updated_at大が勝ち)。
- questionsのGET/DELETEはオーナーならプラン不問。
## 章ラベル(topics)
- しおり(本物の目次)優先。なければ本全体から自動目次(バッジ「重要度/★」除去、分断バナー縫合、柱除外、前方継承、本文断片フォールバック禁止)。キャッシュ(web localStorage kk.autoToc.<deckId> / iOS meta autoToc:<deckId>)はTOPICS_VERSION=2とpageCountで無効化。
## ビューア
- fitは両プラットフォームで"width"固定(全体表示トグルは廃止済み)。拡大はズーム±/ピンチ。iOSは新設の純JSページスライダー(実ページ数にクランプ、ドラッグ中P.nバブル)。★復習と目次はヘッダー。webビューアは100dvhフレックス+body:has(.viewer) overflow:hidden(ウィンドウは絶対スクロールしない、下14px)。エンジン背景#e9e2d3。
## IAP/認証
- 購入・復元はログイン必須(匿名購入はwebhookのtier反映が次の課金イベントまで遅れるため)。purchase/restore(pkg,uid)は直前にensureIdentified(getAppUserID≠uidならlogIn)。account.tsのlogIn/logOutはinitPurchases()完了を待つ。
- クライアントの機能表示はサーバtier優先(getGenUsage/listBooksのtier)、RCローカル資格情報はオフライン時のフォールバックのみ。iOS Infoはサーバ確認完了まで「確認中…」。
- webに課金なし(ローンチ後にRC Web Billing予定)。アップグレード文言は「iOSアプリから」。
- iOS Loginにパスワード再設定あり。Firebaseエラーは日本語化。
## 取り込み
- スキャンPDF非対応(「今後のアップデートで対応予定」と表示)。100MB/file上限。capはサーバ402が真実でクライアントは早期ゲート(オフラインは最後に見たクォータでブロック方向のみ)。
## 直近の変更(回帰リスク高・重点確認)
Paywallカード統合+購入ログイン必須+ensureIdentified / webhook TRANSFER対応+admin不可侵 / topics自動目次v2+章チップ+TocHint(目次を開く→viewer遷移) / iOSビューア刷新(スライダー・ヘッダー★目次・fit廃止・エンジン背景) / webビューア100dvhフレックス+overflowロック / Info鯖tier優先+確認中 / Login再設定+日本語エラー / 本棚クラウド欄の「取り込む」全プラン化 / trim skippedガード / progress GET開放(canFetchOwnBook) / syncErrorMessage・Onboarding・ヘルプ・規約の文言更新
`

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['file', 'title', 'detail', 'severity', 'confidence', 'kind'],
    properties: {
      file: { type: 'string' }, line: { type: 'number' },
      title: { type: 'string' }, detail: { type: 'string' },
      severity: { enum: ['critical', 'major', 'minor'] },
      confidence: { enum: ['high', 'medium', 'low'] },
      kind: { enum: ['bug', 'unintended', 'copy-mismatch'] },
    } } } },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['isReal', 'severity', 'explanation'],
  properties: {
    isReal: { type: 'boolean' },
    severity: { enum: ['critical', 'major', 'minor'] },
    explanation: { type: 'string' },
    fix: { type: 'string' },
  },
}

const DIMENSIONS = [
  {
    key: 'server-core',
    files: `${WEB}/functions/api/sync/_middleware.ts, books.ts, trim.ts, account.ts, books/[bookId].ts, books/[bookId]/blob.ts, books/[bookId]/content.ts, books/[bookId]/retain.ts, dev/tier.ts, ${WEB}/functions/_lib/tier.ts, types.ts`,
    focus: '認証ミドルウェア(トークン検証/uid/email)、所有権チェック漏れ、cap計算と402の原子性(同時importでの競合超過)、booksのstatus遷移の整合(active/retained/trimmed/pending)、canFetchOwnBookの適用漏れエンドポイント、trimのstale-screenガードとkeep検証、SQLバインド、エラー時のレスポンス整合',
  },
  {
    key: 'server-data-ai',
    files: `${WEB}/functions/api/sync/generate.ts, questions.ts, reviews.ts, progress.ts, progress/[bookId].ts, ${WEB}/functions/_lib/contentMerge.ts, progressMerge.ts, ${WEB}/functions/api/webhook/revenuecat.ts, ${WEB}/worker/retention.ts`,
    focus: 'クォータ予約/返金の全エラー経路(AI失敗・パース失敗・D1失敗時に返金されるか/二重返金しないか)、キャッシュ再表示が無料か、月境界、LWWマージの収束とトゥームストーン復活、webhook: GRANT/REVOKE/TRANSFERの網羅とBILLING_ISSUE等未処理の妥当性・admin行不可侵・冪等性、retention: 対象(activeも消す)と「約6ヶ月」文言の整合・reviews/questions削除の妥当性・R2リスト処理',
  },
  {
    key: 'ios-iap-auth',
    files: `${IOS}/src/iap/purchases.ts, entitlements.ts, ${IOS}/src/auth/account.ts, firebase.ts, ${IOS}/src/screens/Paywall.tsx, Login.tsx, Info.tsx, ${IOS}/src/components/DevTierSwitch.tsx`,
    focus: 'ensureIdentifiedとlogIn順序の競合、logOut時の状態、購入キャンセル/二重タップ/オフライン、fail-closed方針(ネット断で勝手にProにならない)、Paywallのロック画面と閉じる動線、Infoの「確認中…」とeffの整合(usage失敗時のフォールバック)、パスワード再設定のエラー、アカウント削除フロー、別アカウントログイン時のローカルデータ全消去ガードの誤爆条件',
  },
  {
    key: 'ios-bookshelf',
    files: `${IOS}/src/screens/DeckList.tsx, DowngradeSelect.tsx, Settings.tsx, ImportWizard.tsx, ${IOS}/App.tsx, ${IOS}/src/sync/deck.ts, api.ts, ${IOS}/src/db/repo.ts, backup.ts`,
    focus: '最重要=破壊的リコンサイル: nonActive/heldElsewhere/orphan判定でローカル本を削除する条件の誤爆(オフライン・部分応答・listBooks失敗・空配列・タイミング)。ダウンロードとholderスタンプの競合、trim skipped後の状態、Gateのtrim強制表示条件、importのcap/402/オフラインゲート、バックアップの網羅性(questions/reviewsは含む?)、クラウド欄の取り込む/外すの全プラン挙動',
  },
  {
    key: 'web-client',
    files: `${WEB}/src/components/DeckList.tsx, DowngradeSelect.tsx, ImportWizard.tsx, Info.tsx, PageViewer.tsx, QuizScreen.tsx, SolveSession.tsx, ReviewScreen.tsx, Pricing.tsx, Home.tsx, ${WEB}/src/sync/api.ts, deck.ts, ${WEB}/src/styles.css(viewer/toc-hint/chapter-chips/qlist部分), ${WEB}/src/App.tsx`,
    focus: 'iOSとのパリティずれ(機能・文言・ゲート)、viewerの100dvhフレックス化の副作用(フルスクリーン・モバイル・短いウィンドウ・モーダル/ドロワー・タブレット)、body:has overflowロックが他ビューに漏れないか、章チップ/TocHintの動作、削除/退避confirm文言と実動作の一致、PWA(SW)キャッシュで古いUIが出る問題への耐性',
  },
  {
    key: 'shared-learning',
    files: `${WEB}/src/sync/srs.ts, reviews.ts, topics.ts, ${WEB}/src/components/QuizScreen.tsx, SolveSession.tsx, ReviewScreen.tsx, ${IOS}/src/sync/srs.ts, reviews.ts, topics.ts, ${IOS}/src/screens/Quiz.tsx, SolveSession.tsx, Review.tsx, ${IOS}/src/db/repo.ts(questions/reviews部), ${WEB}/scripts/check-shared.mjs`,
    focus: 'SM-2数値と境界(dueAtちょうど・初回)、reviews LWWの時計依存(端末時計ズレ)、再生成/削除時のreviews孤児とSRS件数整合、topicsキャッシュの無効化漏れ(しおり追加・再検出・ページ数同一の別PDF差替)、章チップのグルーピングが種類/出題フィルタへ正しく追従するか、今日の復習/間違いのみの件数とセッション内容の一致、SolveSessionの解答記録とflushタイミング(離脱時)',
  },
  {
    key: 'ios-viewer-import',
    files: `${IOS}/src/screens/PageViewer.tsx, ImportWizard.tsx, Onboarding.tsx, ${IOS}/src/engine/ViewerWebView.tsx, EngineProvider.tsx, setupEngine.ts, ${IOS}/engine-src/index.html(スタイル部)`,
    focus: '新スライダー: PanResponderのlocationX挙動(ドラッグ中に指が縦に外れた時)・pageCount=0/1・連打・goToPageの範囲、ヘッダーの★/目次/問題/⚙のタップ領域とタイトル切詰め、fit廃止の残骸(setFit未使用ハンドルは害なしか)、編集モード中のスライダー操作、エンジン背景#e9e2d3変更が赤シート/赤マスクの視認性・検出プレビューに与える影響、エンジン再ステージング(バージョン更新)の確実性、インポート中止/失敗からの復帰',
  },
  {
    key: 'copy-behavior',
    files: `ユーザー向け文言全般: ${IOS}/src/screens/Onboarding.tsx, Info.tsx, ImportWizard.tsx, Paywall.tsx, DeckList.tsx, DowngradeSelect.tsx の alert/confirm/注記、${WEB}/src/components/Info.tsx, Home.tsx, Service.tsx, Pricing.tsx, ImportWizard.tsx, DeckList.tsx, DowngradeSelect.tsx, ${WEB}/public/terms.html, privacy.html, ${WEB}/README.md`,
    focus: '文言と実装の不一致を実コードで裏取り: 「約6ヶ月」(実装183日)、「Proに戻すと復元」(premiumでも復元される/isUnlimited)、AI回数とプラン表、トライアル文言(Premiumのみか)、年額表記、単一ホームの説明、スキャン対応予定の整合、「端末内で完結」の範囲(AI生成・クラウド同期の例外明記)、規約/プライバシーの機能名、価格・冊数の数字が全箇所で一致するか',
  },
]

function finderPrompt(d) {
  return `あなたはローンチ前の徹底コードレビュー担当です。以下の設計意図スペックを前提に、担当範囲の「バグ」と「動くが意図していない挙動」「文言と実動作の不一致」をすべて報告してください。
${SPEC}
## あなたの担当
対象ファイル(必ずReadで全部読む。関連する呼び出し元/先も追う): ${d.files}
重点: ${d.focus}
## 報告ルール
- 網羅優先: 確信が持てない所見も含めてすべて報告する(下流で別の検証者が反証する)。重要度や確信度で自己検閲しない。
- ただし所見は実際にコードを読んで根拠の行を特定したものに限る(憶測の一般論は不可)。
- 各所見: file(絶対パス), line(分かれば), title(一行), detail(何が起き、スペックのどことズレるか、ユーザーにどう見えるか), severity(critical=データ消失/課金/認可, major=機能不全/誤動作, minor=表示/エッジ), confidence, kind(bug/unintended/copy-mismatch)。
- 「直近の変更」一覧に挙がった箇所は特に念入りに。問題が見つからなかった確認事項は報告不要。`
}

function verifyPrompt(f, d) {
  return `あなたは懐疑的な検証者です。次のコードレビュー所見が本物かどうか、必ず該当ファイルをReadして実コードで裏取りし、可能なら反証してください。
${SPEC}
## 所見(担当領域: ${d.key})
${JSON.stringify(f, null, 2)}
## 判定ルール
- ファイル ${f.file} の該当箇所と、関係する呼び出し元/先・サーバ/クライアント対応物まで読むこと。
- isReal=true は「実際に挙動がスペック/ユーザー期待から逸脱する、または文言が実動作と食い違う」と確認できた場合のみ。設計意図どおり(スペックに合致)ならfalse。既に対策コード(catch/ガード/フォールバック)があり実害がないならfalse。
- 迷ったらfalse(誤検出を通すコストの方が高い)。ただし反証できなかった具体的なデータ消失/課金/認可系はtrueに倒す。
- explanationに根拠(ファイル:行と読んだ事実)を必ず書く。isReal=trueならfixに最小修正案を一行で。severityは実害ベースで付け直す。`
}

phase('Find')
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(finderPrompt(d), { label: `find:${d.key}`, phase: 'Find', schema: FINDINGS_SCHEMA }),
  (found, d) => {
    const fs = (found && found.findings) ? found.findings : []
    log(`${d.key}: ${fs.length}件の所見 → 検証へ`)
    return parallel(fs.map((f) => () =>
      agent(verifyPrompt(f, d), {
        label: `verify:${d.key}:${String(f.title).slice(0, 24)}`,
        phase: 'Verify',
        schema: VERDICT_SCHEMA,
      }).then((v) => ({ ...f, dimension: d.key, verdict: v }))
    ))
  },
)

const all = results.filter(Boolean).flat().filter(Boolean)
const confirmed = all.filter((x) => x.verdict && x.verdict.isReal)
const rejected = all.filter((x) => x.verdict && !x.verdict.isReal)
log(`検証完了: 所見${all.length}件 → 確定${confirmed.length}件 / 棄却${rejected.length}件`)
return {
  confirmed: confirmed
    .sort((a, b) => ['critical', 'major', 'minor'].indexOf(a.verdict.severity) - ['critical', 'major', 'minor'].indexOf(b.verdict.severity))
    .map((x) => ({
      severity: x.verdict.severity, kind: x.kind, dimension: x.dimension,
      file: x.file, line: x.line, title: x.title,
      why: x.verdict.explanation, fix: x.verdict.fix,
    })),
  rejected: rejected.map((x) => ({ title: x.title, file: x.file, why: x.verdict.explanation })),
}