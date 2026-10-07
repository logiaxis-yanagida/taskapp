# タスク管理アプリ 仕様・モジュール契約（SPEC）

## 目的
- 自分用タスク管理。**文字入力は最小限**、ワンタップUIと**音声入力（Web Speech API, ja-JP）**で登録。
- 単一ページのWebアプリ（ブラウザで動作、PC/スマホ両対応）。データは localStorage、JSONエクスポート/インポートあり。
- 期限のあるタスクは **Googleカレンダーに終日予定として自動登録**（Google Identity Services + Calendar REST API）。

## 動作環境
- Chrome / Edge 最新（音声入力・OAuthの都合）。
- ES Modules と Google OAuth のため **http(s) で配信**する（file:// 不可）。`起動.bat` で `python -m http.server 8787` を起動し `http://localhost:8787/` を開く。
- 外部ライブラリは使わない（GIS スクリプト `https://accounts.google.com/gsi/client` のみ動的ロード）。

## ファイル構成（担当を厳守。他人のファイルは編集しない）
```
3.タスク管理/
  index.html            # UI担当
  css/style.css         # UI担当
  js/app.js             # UI担当（エントリ、イベント配線、描画）
  js/store.js           # UI担当（localStorage 永続化・状態管理）
  js/dateutil.js        # 共通ユーティリティ（UI担当が作成。parser担当も import して使う。下記API固定）
  js/parser.js          # 解析担当（純粋関数、DOM非依存）
  js/voice.js           # 解析担当（Web Speech API ラッパ）
  js/gcal.js            # カレンダー担当
  tests/parser.test.mjs # 解析担当（node --test）
  tests/dateutil.test.mjs # UI担当
  docs/Googleカレンダー連携_設定手順.md  # カレンダー担当
  起動.bat              # カレンダー担当
  README.md             # 統合時に作成（リーダー）
```

## コーディング規約
- セマンティックHTML、インラインstyle禁止、JSはESモジュール。
- 不要なコメント・Docstring・絵文字を書かない。UI文言は日本語。
- `console.log` を残さない（エラーは `console.error` 可）。

## データモデル（localStorage キー: `taskapp.v1`）
```ts
type Priority = 'high' | 'mid' | 'low';
type Repeat   = 'none' | 'daily' | 'weekly' | 'monthly';

interface Task {
  id: string;             // crypto.randomUUID()
  title: string;
  memo: string;           // 既定 ''。前後の空白を除去し改行は保持。タスク行のタイトル下に小さく表示（議事録アプリからの取り込みでは元会議名・担当）
  due: string | null;     // 'YYYY-MM-DD'（ローカル日付）。null=期限なし
  time: string | null;    // 'HH:MM'（24時間）。null=時刻なし（終日）。時刻あり＋期限なしの登録時は due=今日
  priority: Priority;     // 既定 'mid'
  categoryId: string | null;
  repeat: Repeat;         // 既定 'none'
  done: boolean;
  createdAt: string;      // ISO
  completedAt: string | null;
  gcalEventId: string | null;   // Googleカレンダー連携済みなら eventId
  gcalSyncedDue: string | null; // 同期時点の due（変更検知用）
  gcalSyncedTime: string | null; // 同期時点の time（変更検知用）
}
interface Category { id: string; name: string; color: string; } // color は '#RRGGBB'
interface Settings {
  gcalClientId: string;      // OAuth クライアントID（空なら未設定）
  gcalCalendarId: string;    // 既定 'primary'
  gcalSyncMode: 'auto' | 'confirm' | 'manual';  // 既定 'confirm'（登録後に「追加しますか？」トーストで確認）
  voiceAutoAdd: boolean;     // 既定 true（音声の最終結果で自動登録）
  defaultCategoryId: string | null;
}
interface State { version: 1; tasks: Task[]; categories: Category[]; settings: Settings; }
```
初期カテゴリ: `仕事`(#2563eb) / `LOGIAXIS`(#7c3aed) / `私用`(#16a34a)。カテゴリは追加・名称変更・色変更・削除可（削除時は該当タスクの categoryId を null に）。

## js/dateutil.js（UI担当が実装、API固定）
```js
export function toYMD(date)                 // Date → ローカル日付 'YYYY-MM-DD'
export function fromYMD(ymd)                // 'YYYY-MM-DD' → ローカル 00:00 の Date
export function addDays(ymd, n)             // → 'YYYY-MM-DD'
export function addMonths(ymd, n)           // 月末は丸める（1/31 +1 → 2/28）
export function todayYMD(now = new Date())
export function diffDays(fromYmd, toYmd)    // to - from（日）
export function weekdayOf(ymd)              // 0=日..6=土
export function endOfWeekYMD(ymd)           // その週の日曜日（週は月曜始まり）
export function startOfNextWeekYMD(ymd)     // 来週の月曜日
export function nextWeekdayYMD(ymd, weekday, includeToday = false) // 次に来るその曜日
export function endOfMonthYMD(ymd)
export function startOfNextMonthYMD(ymd)
export function formatDueLabel(ymd, today)
  // null→'期限なし'、today→'今日'、+1→'明日'、+2→'明後日'、過去→'M/D（n日超過）'、
  // 今週中（today より後で endOfWeek 以内）→'金曜' のように曜日名、それ以外→'M/D'
```

## js/store.js（UI担当が実装）
```js
export const store = {
  getState(), getTasks(), getCategories(), getSettings(),
  addTask(partial),            // { title 必須, memo, due, priority, categoryId, repeat } → Task
  updateTask(id, patch),       // → Task | null
  deleteTask(id),
  toggleDone(id),              // → { task, next }
    // 未完了→完了。repeat !== 'none' なら次回タスクを新規作成して next に返す
    // （次回 due = due + 1日/7日/1ヶ月。due が null なら today 基準。next の gcalEventId は null）
    // 完了→未完了に戻すのも可（next は null）
  addCategory(name, color),    // → Category
  updateCategory(id, patch), deleteCategory(id),
  updateSettings(patch),
  exportJSON(),                // → string（整形JSON）
  importJSON(json, { merge = false } = {}),  // → { imported: number }。merge=false は置換。merge=true は id 重複をスキップして追加
  subscribe(fn),               // 変更のたびに fn(state) を呼ぶ。戻り値は解除関数
};
```

## js/parser.js（解析担当が実装、純粋関数）
```js
export function parseTaskText(text, { categories, today }) // → ParseResult
// ParseResult:
// {
//   title: string,          // 解析で消費した語句を除いた残り（前後空白・読点を整理）
//   due: string | null,     // 'YYYY-MM-DD'
//   time: string | null,    // 'HH:MM'（「朝9時」「午後3時半」「21:00」「正午」等。「3時間」は時刻ではない）
//   priority: 'high'|'mid'|'low'|null,  // 言及なしは null（UI側で既定 'mid'）
//   repeat: 'none'|'daily'|'weekly'|'monthly'|null,  // 言及なしは null
//   categoryId: string | null,
//   matched: { due?: string, priority?: string, repeat?: string, category?: string } // 元テキスト中のマッチ語
// }
```
解析ルール（日本語、音声入力の口語を想定。`today` は 'YYYY-MM-DD'、`categories` は Category[]）:
- 期限: 今日/本日、明日/あした、明後日/あさって、今週(中)→今週の日曜、来週→来週の月曜、週末→今週の土曜、今月末/月末、来月→来月1日、
  「○日」「○月○日」「○/○」「○日まで(に)」「○曜(日)(まで)」→次に来るその曜日（今日が該当曜日なら今日）、「来週○曜」、「○日後」。
  過去の「○月○日」は来年扱い。「○日」のみで今月のその日が過去なら来月。「まで」「までに」「期限」「締切」等の助詞・語尾は除去。
- 優先度: 高/重要/至急/急ぎ/最優先/優先度高 → 'high'、低/あとで/いつか/優先度低 → 'low'、中/普通/優先度中 → 'mid'。
  単独の「高」「中」「低」は「優先度」「優先」の直後、または文末付近のみ採用（「最高の提案書」を誤検知しない）。
- 繰り返し: 毎日/デイリー→daily、毎週/ウィークリー→weekly、毎月/マンスリー→monthly。「毎週金曜」は weekly + due=次の金曜。
- カテゴリ: categories の name が本文に含まれていれば categoryId（最長一致）。「仕事の」「私用で」のような直後の助詞は除去。
- title が空になった場合は元テキストをそのまま title にする。
- 数字は全角・漢数字（一〜三十一）も受け付ける。
- 音声認識は「あしたまでに請求書送付優先度高」のように空白なしで来ることがあるため、空白に依存しない。

## js/voice.js（解析担当が実装）
```js
export function isVoiceSupported()  // → boolean
export function createRecognizer({ lang = 'ja-JP', onResult, onEnd, onError })
  // → { start(), stop(), get listening() }
  // onResult(text, isFinal)。interimResults=true、continuous=false。
  // 1回の発話で終了。onEnd() は認識終了時に必ず呼ぶ。onError(code, message)。
  // 'not-allowed' / 'no-speech' / 'network' / 'audio-capture' などは日本語メッセージに変換して渡す。
```

## js/gcal.js（カレンダー担当が実装）
```js
export class GcalAuthError extends Error {}
export class GcalApiError extends Error { status; }
export const gcal = {
  configure({ clientId, calendarId }),  // 設定変更時に呼ぶ。clientId 空なら未設定扱い
  isConfigured(),
  isSignedIn(),                         // 有効なアクセストークンを保持しているか
  signIn({ silent = false } = {}),      // Promise<void>。GIS token client で scope calendar.events を要求
  signOut(),
  onAuthChange(fn),                     // fn(signedIn: boolean)。戻り値は解除関数
  upsertEvent(task, category),          // Promise<string> eventId
    // task.gcalEventId があれば PATCH、無ければ POST。
    // time が null: 終日予定 start.date=due, end.date=due+1
    // time あり: start.dateTime=due+time（ローカルTZ）、end=start+30分。PATCH 時は切替のため date/dateTime の他方を null で送る
    // summary: title（priority high は先頭に '【重要】'）、
    // description に カテゴリ/優先度/繰り返し と 'taskapp:' + id、
    // extendedProperties.private.taskappId = task.id、colorId はカテゴリ色から近いものを選ぶ（任意）
    // 404（イベントが消されている）なら新規作成し直す
  deleteEvent(eventId),                 // Promise<void>。404/410 は成功扱い
  buildTemplateUrl(task),               // 未設定時のフォールバック: calendar.google.com/calendar/render?action=TEMPLATE&...
};
```
- トークンは sessionStorage に `taskapp.gcal.token` として { access_token, expires_at } を保存。期限5分前は無効扱い。
- 401 が返ったらトークンを破棄し、`signIn({silent:true})`（prompt: ''）を1回だけ試して再実行。それでも失敗なら `GcalAuthError`。
- GIS スクリプトは内部 `loadGis()` で `<script>` を1回だけ動的追加して Promise で待つ。
- `js/dateutil.js` の `addDays` を import してよい。

## 同期ポリシー（UI担当が app.js で実装、gcal.js を呼ぶ）
- 設定 `gcalSyncMode`:
  - `auto`: 下記のとおり自動同期。
  - `confirm`（既定）: タスク登録直後に「カレンダーに追加しますか？［追加］」トースト（8秒）を表示し、追加を押したときだけ登録。すでにカレンダー登録済み（gcalEventId あり）のタスクは、期限変更・完了・削除を自動で反映する。
  - `manual`: タスク行のカレンダーボタンでのみ登録。登録済みタスクの変更反映は confirm と同じ。
- `auto` かつ `gcal.isSignedIn()` のとき:
  - タスク追加/更新で due が非 null → `upsertEvent` → `gcalEventId`, `gcalSyncedDue` を保存。
  - due が null になった、またはタスク削除 → `deleteEvent` → `gcalEventId=null`。
  - 完了（done=true）→ イベントは削除する（カレンダーに残さない）。
- 未サインイン時は同期せず、タスク行のカレンダーボタン押下で `buildTemplateUrl` を新規タブで開く（未設定）／サインインを促す（設定済）。
- 同期失敗はトースト表示し、タスク保存自体は成功させる（オフラインでも使える）。
- 「未同期の期限付きタスクをまとめて同期」ボタンを設定画面に置く。

## UI 要件（UI担当）
- モバイルファースト、最大幅 720px 中央寄せ、ダーク/ライトは `prefers-color-scheme` 追従。
- 画面上部: 入力バー（テキスト input + 大きなマイクボタン + 追加ボタン）。入力中（音声の interim 含む）に `parseTaskText` をリアルタイム適用し、**プレビューチップ**（期限・時刻・優先度・カテゴリ・繰り返し）を表示。チップをタップすると選択肢（期限: 今日/明日/明後日/今週/来週/日付指定/なし、時刻: 9:00〜18:00 のプリセット/時刻指定/なし（終日）、優先度: 高/中/低、カテゴリ一覧、繰り返し: なし/毎日/毎週/毎月）がポップオーバーで出て上書きできる。
- Enter または追加ボタンで登録。音声は最終結果が出たら自動で登録（設定 voiceAutoAdd、既定ON）。
- 一覧: フィルタタブ「今日」「予定」「すべて」「完了」。「今日」=期限切れ+今日。並び: 期限昇順（null は最後）→優先度(high>mid>low)→作成順。グループ見出し: 期限切れ／今日／明日／今週／以降／期限なし。
- タスク行: チェック（完了）、タイトル（タップでインライン編集）、期限ラベル（タップで期限ポップオーバー）、優先度バッジ（タップで切替）、カテゴリ色ドット＋名（タップで切替）、繰り返しアイコン、カレンダー状態アイコン（同期済み/未同期、タップで同期または予定作成URL）、削除（取り消しトースト付き）。
- 設定モーダル: カテゴリ管理（追加・名称・色・削除）、Googleカレンダー（クライアントID、カレンダーID、登録方式の選択（確認/自動/手動）、サインイン/アウト、未同期一括同期、設定手順へのリンク docs/Googleカレンダー連携_設定手順.md）、音声自動登録トグル、JSONエクスポート（ダウンロード）/インポート（ファイル選択、置換 or 統合）。
- キーボード: `/` で入力欄フォーカス、`Esc` でポップオーバー閉じ。
- 空状態の案内文（「マイクを押して話すか、入力してください」）。
- 音声非対応ブラウザではマイクボタンを無効化しツールチップで案内。

## ドライブ同期（js/drive.js, js/sync.js, store.js 拡張）
- 目的: サインインした Google アカウントの **Drive appDataFolder** にタスクデータを保存し、PC とスマホ（ホーム画面アプリ）でタスクを共有する。設定（settings）は端末ローカルで同期しない。
- 保存先: appDataFolder 内の単一ファイル `taskapp-state.json`。内容は `store.getSyncPayload()` の `{ version: 1, tasks, categories, deleted, savedAt }`。push は常に全体上書き。
- OAuth スコープ: `calendar.events` に加えて `https://www.googleapis.com/auth/drive.appdata`（gcal.js の SCOPE、空白区切り）。
- データモデル拡張（store.js）:
  - `Task.updatedAt: string`（ISO）。addTask / updateTask / toggleDone / カテゴリ変更などの更新で必ず現在時刻にする。欠けていれば normalizeTask が createdAt で補う。
  - `Category.updatedAt: string`（ISO）。addCategory / updateCategory で更新。
  - `State.deleted: { [id]: string }` 削除日時 ISO のトゥームストーン（タスク・カテゴリ共通）。deleteTask / deleteCategory で記録。load 時に 90 日より古いものを掃除。importJSON（置換）でもローカルの deleted は維持（取り込むタスク/カテゴリに同じ id のトゥームストーンがあれば取り除き、その項目の updatedAt を現在時刻にする）。
- store.js 追加 API:
```js
store.getSyncPayload()   // → { version: 1, tasks, categories, deleted, savedAt }（settings は含まない）
store.mergeRemote(remote) // → { changed: boolean }。変更があれば commit（subscribe 通知）
```
- マージルール（mergeRemote）:
  - deleted は双方を統合し、同じ id は新しい日時を採用。
  - tasks: id ごとに `updatedAt` が新しい方を採用（同時刻はローカル）。採用候補の `updatedAt` 以降（同時刻含む）のトゥームストーンがあれば削除扱い（remote の削除がローカルの更新より新しければローカルから消える／ローカルの削除が remote の更新より新しければ remote の版は採用しない）。採用された項目のトゥームストーンは取り除く。
  - categories: tasks と同様。削除されたカテゴリを参照するタスクは `categoryId = null`（updatedAt は変えない）。settings.defaultCategoryId も同様に null。
  - `gcalEventId` / `gcalSyncedDue` / `gcalSyncedTime` はタスクの一部としてそのまま統合する（カレンダー予定は共有）。
- js/drive.js:
```js
export const drive = {
  pull(),       // Promise<{ fileId, state } | null>。appDataFolder から taskapp-state.json を検索→ダウンロード
  push(state),  // Promise<void>。無ければ multipart で作成、あれば uploadType=media で PATCH。fileId は内部で記憶
};
```
  - Drive API v3（`files?spaces=appDataFolder&q=name='taskapp-state.json'`、`files/{id}?alt=media`、`upload/drive/v3/files`）。通信はすべて gcal.js の `authorizedFetch(method, url, body, okStatuses, { contentType })` を使い、401 の扱い（トークン破棄・silent 再サインイン）は gcal.js に任せる。
- js/sync.js:
```js
export function createSync({ store, gcal, drive, onStatus, afterPull })
  // → { start(), pullNow(), pushNow(), getStatus() }
  // afterPull: 任意の async 関数。pull → mergeRemote の直後、push 判定の前に呼ぶ（議事録 Drive inbox の取り込みに使用）。
  //   その間の store 変更はデバウンス対象外で、同じ実行の push に含まれる。例外は console.error のみで同期は続行
  // status: { state: 'idle' | 'syncing' | 'synced' | 'error' | 'signed-out', lastSyncedAt: ISO | null, message }
```
  - `gcal.isSignedIn()` のときのみ動く。start 時・onAuthChange(true)・タブが visible になった時（前回 pull から 30 秒以上）に「pull → mergeRemote → ローカルが remote と異なれば push」。
  - store.subscribe で変更を検知したら 2 秒デバウンスで同じ手順を実行。mergeRemote 由来の変更はフラグで無視し、push を再トリガーしない。
  - 失敗は `onStatus({ state: 'error', message })` で通知し、次の変更・online 復帰時に再試行。オフライン（`navigator.onLine === false`）なら保留し `online` イベントで再開。
- UI（index.html 設定ダイアログ Googleカレンダーセクション）: 「今すぐ同期（Googleドライブ）」ボタン `#drive-sync-now` と状態表示 `#drive-status`（「同期済み（12:34）」「同期中…」「未サインイン（サインインすると PC とスマホでタスクが共有されます）」「エラー: …」）。
- Google Cloud 側: 同じプロジェクトで **Google Drive API を有効化**し、OAuth 同意画面のスコープに `.../auth/drive.appdata` を追加する。

## リダイレクト認証（js/gcal.js）
- 背景: iPhone のホーム画面アプリ（standalone 表示）では GIS のポップアップが使えないため、OAuth 2.0 implicit flow の **リダイレクト方式**でサインインする。
- `gcal.signIn({ silent = false, redirect = false })`:
  - `redirect === true`、または standalone 表示（`matchMedia('(display-mode: standalone)').matches || navigator.standalone === true`）のときは `https://accounts.google.com/o/oauth2/v2/auth` へ `location.assign` で遷移する。パラメータ: `client_id`, `redirect_uri = location.origin + location.pathname`（クエリ・ハッシュなし）, `response_type=token`, `scope`, `include_granted_scopes=true`, `state`（ランダム文字列。sessionStorage `taskapp.gcal.state` に保存）。`prompt` は付けない。
  - GIS ポップアップが `popup_failed_to_open` で失敗した場合も自動でリダイレクト方式にフォールバックする。
  - `silent: true`（401 時の再サインイン）は standalone ではリダイレクトせず `GcalAuthError` を投げる（突然の画面遷移を避ける）。
- `gcal.handleRedirectResult()` → boolean:
  - ページ読み込み時に呼ぶ。`location.hash` に `access_token` があれば `state` を照合し、トークンを sessionStorage に保存（`expires_in` から `expires_at`）、`history.replaceState` でハッシュを消し、onAuthChange(true) を通知して true を返す。
  - `error=` があれば `GcalAuthError` を throw（呼び出し側でトースト）。state 不一致も `GcalAuthError`。該当パラメータが無ければ false。
  - app.js では `configureGcal()` の直後に try/catch で呼び、成功時は「サインインしました」トーストを出し、その後 `sync.start()` を呼ぶ。
- `export const authorizedFetch = apiFetch`（drive.js から利用）。`authorizedFetch(method, url, body, okStatuses = [], { contentType, headers } = {})`。body が文字列ならそのまま送信（Content-Type は contentType）、オブジェクトなら JSON。
- Google Cloud 側: OAuth クライアント（ウェブ アプリケーション）の **「承認済みのリダイレクト URI」** に、アプリを開く URL のオリジン＋パス（例: `http://localhost:8787/`、`https://<ホスト>/<パス>/`。末尾の `/` まで一致させる。クエリ・ハッシュなし）を追加する。「承認済みの JavaScript 生成元」は従来どおりオリジンを登録する。

## 議事録アプリからのタスク取り込み（js/inbox.js）
- 議事録アプリ（`../5.議事録`）がタスクを2経路で書き込み、taskapp が取り込む。
  - 端末内: localStorage `minutes.taskappInbox` に `InboxItem[]`
  - Drive: appDataFolder のファイル `taskapp-inbox-<id>.json`（1ファイル1件）
  - `InboxItem { id, title, due: YMD|null, memo, categoryId: string|null, source: 'minutes', meetingId, createdAt }`
```js
export const LOCAL_INBOX_KEY = 'minutes.taskappInbox';
export function importLocalInbox(store, storage = localStorage)  // → 取り込み件数
export async function importDriveInbox(store, apiFetch)          // → 取り込み件数（apiFetch は gcal.js の authorizedFetch）
```
- 取り込み: id・title が空でない項目のうち、`store.getTasks()` に同じ id が無く、`deleted` にトゥームストーンも無いものだけを `store.importJSON({ version: 1, tasks, categories: store.getCategories() }, { merge: true })` で追加（taskapp で削除済みのタスクは復活させない）。Task は `time=null, priority='mid', repeat='none', done=false`、`categoryId` は存在するカテゴリのみ（無ければ null）、`createdAt` は InboxItem の値、`updatedAt` は現在時刻。
- 端末内: 処理後にキーを読み直し、処理済み id を除いて残りがあれば書き戻し、無ければキーを削除。
- Drive: `files?spaces=appDataFolder&q=name contains 'taskapp-inbox-'&fields=files(id,name)` で列挙 → `files/{id}?alt=media` で取得 → 取り込み → `DELETE files/{id}`（404 は無視）。取り込み済み・削除済みでもファイルは削除する。
- 呼び出し（app.js）: 起動時（store.subscribe 後、sync.start 前）、`visibilitychange`（visible）、`storage` イベント（キー一致時）で端末内を取り込む。Drive 分は `createSync` の `afterPull` で同期のたびに取り込む（pull 後なので他端末で削除済みのトゥームストーンも反映済み）。
- 取り込み件数が 1 以上なら「議事録から N 件のタスクを取り込みました」をトースト表示。取り込んだタスクのカレンダー登録確認は出さない。
- タスク行: memo があればタイトル下に表示（タップで編集ポップオーバー）。memo が無ければメタ行の「メモ」ボタンから追加。ポップオーバーは textarea ＋「保存」（Ctrl/Cmd+Enter でも保存）。
