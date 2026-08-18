# CLAUDE.md

このファイルは、このリポジトリで作業する Claude Code(claude.ai/code)向けのガイドです。

## プロジェクト概要

固定した対象サイトの内容に基づいて質問に答えるチャットボットの学習用サンプル。
質問窓に入力した質問と `.env.local` で固定したサイト URL を Gemini API
(`gemini-2.5-flash` + `url_context` ツール)に渡し、回答をストリーミングでチャット欄に表示する。

Create React App(react-scripts 5)+ React 18。

### 主な機能

- 対象サイトの内容に基づく回答(`url_context` で Gemini がサイトを直接取得)
- 回答のストリーミング表示(SSE を自前パースして逐次描画)
- 会話履歴を踏まえたマルチターン対応(`contents` に user / model 交互で履歴を送信)
- 回答中の URL の自動リンク化(正規表現 → `<a>` 要素。依存パッケージなし)
- 吹き出し UI(user 右 / assistant 左)、自動スクロール、モバイル(≤768px)対応
- API キー未設定・API エラー時はチャット欄にエラーメッセージを表示(クラッシュしない)

## コマンド

- `npm run server` — Gemini プロキシサーバー起動(ポート 3002。**API キーはここだけが持つ** — 先に起動しておくこと)
- `npm start` — 開発サーバー起動(既定ポート 3000。この開発機では 3000 が使用中のため `PORT=3001 BROWSER=none npm start` を使う — 詳細は run-chatbot-app スキル)
- `npm test` — テストを watch モードで実行(Jest + React Testing Library)
- `CI=true npm test -- --watchAll=false` — テストを一度だけ実行(CI モード。**全件パスが正常**)
- `npm test -- --testPathPattern=<pattern>` — 特定のテストファイルのみ実行
- `npm run build` — 本番ビルド

## セットアップ(環境変数)

プロジェクトルートに `.env.local` を作成する(gitignore 済み。キー名は `.env.example` 参照):

```
GEMINI_API_KEY=<Google AI Studio で発行した API キー>          # プロキシサーバーだけが読む
REACT_APP_TARGET_SITE_URL=<回答の根拠にするサイトの URL 初期値>  # 画面から変更可能
```

- **API キーに `REACT_APP_` を付けないこと** — CRA は `REACT_APP_` 接頭辞の環境変数をバンドルに埋め込む(秘密はプロキシ側の `GEMINI_API_KEY` に置く。旧名 `REACT_APP_GEMINI_API_KEY` も移行用にプロキシが読む)
- 環境変数を変更したら該当サーバーの再起動が必要(`GEMINI_API_KEY` → プロキシ、`REACT_APP_*` → CRA)

## アーキテクチャ

- エントリポイント: `src/index.js` → `<App>` → `<Chatbot>`
- `src/App.js` — ヘッダー(タイトル + 対象サイトの URL リンク)と Chatbot を表示
- `src/Chatbot.js` — チャットの中核。メッセージ(`{ role: 'user' | 'assistant', text, isError? }`)の
  state 管理、送信 UX(ローディング・多重送信防止・Enter 送信・空文字抑止)、
  ストリーミング逐次描画(末尾メッセージの置換方式)、URL の linkify、自動スクロール
- `src/gemini.js` — Gemini API 呼び出し(フロント側)。**公式 SDK は使わず素の fetch**
  (CRA の webpack が SDK の Node 専用モジュールを解決できないため)。
  `/api/gemini/<model>/<generate|stream>` をプロキシ経由で叩き、SSE を自前パース。
  二段階プロンプト(計画 → 実行)と 429 時の flash-lite フォールバックを持つ
- `server/index.mjs` — Gemini への**プロキシサーバー**(依存ゼロの node:http、ポート 3002)。
  API キーの付与はここだけで行い、SSE はパススルー。開発時は package.json の `"proxy"` 設定で
  CRA の /api/* が同一オリジンからここへ転送される
- スタイルは素の CSS(`src/index.css`)。CSS 変数で配色を一元管理、≤768px のメディアクエリでモバイル対応
- テストは `src/App.test.js` と `src/Chatbot.test.js`。`gemini.js` を `jest.mock` するため
  API キーなしで走る

## 注意

- ソースコードのコメントは日本語
- ESLint は `react-app` / `react-app/jest` を継承(package.json で設定)
- **セキュリティ**: API キーはプロキシサーバー(`server/index.mjs`)だけが保持し、
  **フロントのバンドルには含まれない**(タスク 12 で `x-goog-api-key` / キー参照がバンドルにないことを確認済み)。
  公開時はプロキシを本番ホスティングに載せ、必要ならレート制限・認証を足すこと
- Gemini 無料枠のクォータに注意(このキーは日次 limit: 20 に到達した実績あり)。
  実 API 検証のやり方と 429 対策のペーシングは run-chatbot-app スキルの Gotchas を参照
