---
name: brushup-chatbot-app
description: Iteratively brush up chatbot-app — pick the next task from ROADMAP.md, implement it, verify in the running app, update the roadmap/history, and commit (one loop = one commit). Use when asked to improve, brush up, or continue development of the chatbot app, or when run repeatedly via /loop. アプリのブラッシュアップ・継続改善・次のタスクの実施に使う。
---

chatbot-app を 1 呼び出し 1 タスクずつ改善していくループ用スキル。ゴール:**`.env.local` に固定したサイト URL と、質問窓に入力した質問を Gemini API に渡し、サイト内容に基づく回答をチャットに表示する**アプリに仕上げ、UI/UX も磨き上げる。

パスはすべてリポジトリルート基準。連続実行は `/loop /brushup-chatbot-app`。

## 1 イテレーションの手順(1 ループ = 1 コミット)

1. **[ROADMAP.md](.claude/skills/brushup-chatbot-app/ROADMAP.md) を読む。** 未完了 `[ ]` の最上位タスクを 1 つだけ選ぶ。全タスク完了なら実装せず「全タスク完了」と報告し、/loop 実行中ならループを停止する。
2. **実装する。** 下記の技術仕様に従う。選んだタスクの範囲を超えない(次のタスクに手を出さない)。
3. **実アプリで検証する。** `run-chatbot-app` スキルの手順どおり(`PORT=3001 BROWSER=none npm start` → `node .claude/skills/run-chatbot-app/driver.mjs`)。スクリーンショットを必ず目視確認。タスク内容に応じて driver.mjs の検証ステップを拡張してよい(拡張はそのままコミットに含める)。`CI=true npm test -- --watchAll=false` も実行し、結果を履歴に記録する。
4. **ROADMAP.md を書き換える。** タスクを `[x]` にし、「履歴」セクションに 1 行追記(日付 / やったこと / 検証結果)。実装中に見つかった新たな改善点はタスク末尾に追加してよい。
5. **コミットする。** そのイテレーションの変更(コード + ROADMAP.md + driver 拡張)を現在のブランチに 1 コミット。メッセージは `brushup: <タスクの要約>`、末尾に `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。**コミットは 1 イテレーションに 1 つだけ**(ユーザーからの常時許可あり。push はしない)。
6. **ユーザーに報告して終了。** 何を実装し、どう検証し、何をコミットしたかを簡潔に。

## 技術仕様(Gemini API 連携)

> 2026-08-08 の変遷: Claude API → ChatGPT(OpenAI)API(ユーザー指示)→ **Gemini API**(ユーザー指示。OpenAI 組織にクレジット残高がなく動かせないため)。Gemini API には無料枠があるため、有効なキーがあればクレジット購入なしで動く見込み。

- **モデルは `gemini-2.5-flash` 固定**(無料枠で利用可、`url_context` ツール対応。ユーザーが別モデルを指名しない限り変更しない)。ただし **429(無料枠上限)時は `gemini-flash-lite-latest` に一度だけ自動フォールバック**する(ユーザー指示 2026-08-09。flash-lite 系も url_context 対応で、無料枠は flash と別カウントかつ大きい)。フォールバック先に固定バージョン名を使わないこと — `gemini-2.5-flash-lite` は「新規ユーザーには提供終了」の 404 を返した実績があり、`-latest` エイリアスなら追従できる。
- **公式 SDK は使わない** — CRA(react-scripts 5)の webpack が Node 専用モジュールを解決できない問題(Claude SDK で実測)を避けるため、**素の fetch で呼ぶ**(フロント実装は `src/gemini.js`)。
- **プロキシ経由(タスク 12)**: フロントは `/api/gemini/<model>/<generate|stream>` を叩き、`server/index.mjs`(依存ゼロの node:http、ポート 3002、`npm run server` で起動)が `x-goog-api-key` を付与して Gemini へ転送する。**API キーはプロキシだけが持ち、バンドルには含まれない**。開発時は package.json の `"proxy": "http://localhost:3002"` で CRA が /api/* を転送(設定変更時は CRA 再起動)。
- 環境変数(CRA は `REACT_APP_` 接頭辞のみバンドルに埋め込む。**変更後は該当サーバーの再起動が必要**):
  - `.env.local`(gitignore 済み、権限保護されており内容は読めない/読まないこと): `GEMINI_API_KEY` — **プロキシサーバーだけが読む。`REACT_APP_` を付けないこと**(旧名 `REACT_APP_GEMINI_API_KEY` も移行用にプロキシが読む)
  - `REACT_APP_TARGET_SITE_URL` — 対象サイト URL の初期値(タスク 9 以降は画面のヘッダーで変更可能)
  - `.env.example` がキー名を記録(実キーは書かない)
- サイト読み取りは **`url_context` ツール**(プロンプト中の URL を Gemini 側が直接取得 — Claude の web_fetch 相当で、検索ベースだった OpenAI web_search より用途に合う。ブラウザの CORS 制約を受けない):

```
POST /api/gemini/gemini-2.5-flash/generate   ← プロキシが Gemini の :generateContent へ転送(/stream は :streamGenerateContent?alt=sse)
headers: content-type: application/json      ← キーはプロキシが付与するのでフロントは付けない
body: {
  system_instruction: { parts: [{ text: '<サイト内容のみに基づいて日本語で回答…>' }] },
  contents: [{ role: 'user', parts: [{ text: `対象サイト: ${siteUrl}\n\n質問: ${question}` }] }],
  tools: [{ url_context: {} }],
}
```

- ストリーミング(タスク 3)は `:generateContent` を `:streamGenerateContent?alt=sse` に替え、SSE を fetch の reader でパースして各イベントの `candidates[0].content.parts[].text` を連結表示する(自前パース)。
- **二段階プロンプト(タスク 10)**: 送信ごとに (1) 第 1 段階 = 非ストリーミング `generateContent` で「読むべき URL 入りの指示プロンプト」を生成(候補としてトップ / `sitemap.xml` / `robots.txt` / `/sitemap/` を本文に明記 — **url_context はプロンプト中の URL しか取得せずクロールしない**ため)、(2) 第 2 段階 = 生成プロンプトをストリーミング実行。第 1 段階の失敗は直接質問にフォールバック(Gemini の一時的な過負荷 = 503 もここで自動的に吸収される)。両段階とも 429 時は flash-lite に自動フォールバック。1 質問 = 最低 2 リクエスト消費する点に注意。
- **プロンプトの画面表示(タスク 15)**: 第 2 段階に実際に渡した本文は `askAboutSite` の `onPrompt` コールバックで通知され、回答吹き出し内の `<details class="prompt-details">` に表示される。**driver でこの表示を扱うときは注意**: `<details>` は閉じていても DOM の `textContent` には内容が含まれるため、回答本文だけを検証したい場合は `.prompt-details` を除いたクローンから読む(`driver.mjs` の `window.__messageText()` 参照)。

### API の注意点

- **url_context はプロンプト中に現れた URL を取得する** — 固定 URL は必ず本文(contents)に含めること。
- **`promptFeedback.blockReason`** があればプロンプトがブロックされている → 丁寧な断り文を表示。`candidates[0].finishReason === 'SAFETY'` も同様。
- 表示するのは `candidates[0].content.parts` の `text` のみ連結。url_context のメタデータ等はそのまま表示しない。
- マルチターン(タスク 5)は `contents` に `role: 'user'` / `role: 'model'` を交互に積む(assistant ではなく **model**)。
- エラーはレスポンス JSON の `error.message` を表示に含める(400 API_KEY_INVALID → キー無効、403 → 権限、429 RESOURCE_EXHAUSTED → 無料枠/レート上限)。**キー未設定・API エラー時はクラッシュせず、チャット欄にエラーメッセージを表示**する。
- セキュリティ: **API キーはプロキシサーバーだけが保持し、ビルド成果物には含まれない**(タスク 12 で解消。バンドルに `x-goog-api-key` / キー参照がないことを確認済み)。公開時はプロキシを本番ホスティングへ載せ、必要ならレート制限・認証を追加する。

## 検証の注意

- **API キー・無料枠がない環境でも検証を止めない**: キー未設定時の案内表示・ユーザーメッセージの表示・入力欄クリアまでは driver で検証できる。API 応答の実検証はキーが有効な環境でのみ行い、未検証ならその旨を履歴と報告に明記する。
- ポート 3000 は別アプリ(Open WebUI)が常駐 — 必ず 3001 を使う(詳細は run-chatbot-app スキル)。
- `npm test` は全件パスが正常(タスク 6 でテスト整備済み)。失敗したらアプリの異常として扱う。
