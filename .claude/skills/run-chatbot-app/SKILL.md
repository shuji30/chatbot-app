---
name: run-chatbot-app
description: Build, run, and drive chatbot-app — start the CRA dev server and interact with the chat UI via the bundled Playwright driver (headless system Chrome). Use when asked to run/start the app, take a screenshot of the chat UI, or verify a change in the running app. アプリの起動・動作確認・スクリーンショット取得に使う。
---

Create React App(react-scripts 5)のチャットボットアプリ。dev サーバーを起動し、同梱の `.claude/skills/run-chatbot-app/driver.mjs`(Playwright + システムの Chrome/Edge、headless)で駆動する。この環境に `chromium-cli` はないので使わないこと。

パスはすべてリポジトリルート(`chatbot-app/`)基準。検証環境: Windows 11 + Git Bash、Node v22.21.0 / npm 10.9.4。

## Prerequisites

- Node.js(v22 で検証)
- Google Chrome または Microsoft Edge がインストール済みであること(ドライバーは Playwright の `channel: 'chrome'` → `'msedge'` の順で試す。ブラウザ本体のダウンロードは不要)

## Setup

```bash
npm install
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i --no-save --no-audit --no-fund playwright
```

`--no-save` なので package.json / package-lock.json は変更されない。playwright はドライバー実行にだけ必要。

## Run (agent path)

プロキシと dev サーバーをバックグラウンドで起動してポーリングし、ドライバーを流す:

```bash
# 1) Gemini プロキシ(ポート 3002。API キーはここだけが持つ — 未起動だと回答がエラーになる)
node server/index.mjs              # ← バックグラウンドで実行すること
# 2) CRA dev サーバー。ポート 3000 はこのマシンでは別アプリが常駐しているので必ず 3001 を使う
PORT=3001 BROWSER=none npm start   # ← バックグラウンドで実行すること
timeout 90 bash -c 'until curl -sf http://localhost:3001 >/dev/null 2>&1; do sleep 2; done' && echo "SERVER UP"
```

```bash
node .claude/skills/run-chatbot-app/driver.mjs
```

ドライバーは各ステップを `STEP<n> OK` で報告し、失敗時は非ゼロで終了する。検証内容:
初期描画とヘッダーの対象サイト入力欄 → 送信 UX(表示・Enter 送信・空文字抑止・入力欄クリア)→ 吹き出しレイアウトと自動スクロール → モバイル幅 → マルチターン想起 → サイト内容への回答(フルフロー)→ サイトマップのリンク一覧(二段階プロンプトの検証。回答中 URL のリンク化と target/rel 属性もここで確認)→ コンソールエラーなし。API を呼ぶ送信の間にはペーシング(既定 20 秒)が入るため、**1 回の実行に 5 分前後かかるのは正常**。

スクリーンショット → `.claude/skills/run-chatbot-app/screenshots/`(`shot-1-initial.png` 〜 `shot-7-sitemap.png`)。**必ず画像を開いて確認すること。**

別 URL を叩く場合は第 1 引数で渡す(省略時は `http://localhost:3001`)。

停止(Windows には lsof がない。プロキシは ':3002' で同様に):

```bash
netstat -ano | grep ':3001' | grep LISTENING   # 右端が PID
taskkill //F //PID <pid>                        # Git Bash では // でエスケープ
```

## Run (human path)

agent path と同じ起動行から `BROWSER=none` を外すとブラウザが自動で開く(この形は未検証)。Ctrl-C で停止。素の `npm start` はポート `PORT=3001` を指定。

## Test

```bash
CI=true npm test -- --watchAll=false
```

全 suite がパスするのが正常(App の描画テスト + `src/Chatbot.test.js` の Chatbot 基本テスト。gemini.js はモックされるため API キーなしで走る)。失敗はアプリの異常を意味する。

## Gotchas

- **プロキシ(3002)未起動だと回答がすべてエラーになる** — API 呼び出しは `server/index.mjs` 経由(API キー秘匿)。CRA より先に `node server/index.mjs` を起動しておく。package.json の `"proxy"` 設定を変えたときは CRA の再起動も必要。
- **ポート 3000 は使えない** — このマシンでは別アプリが 3000 を常駐使用。CRA は使用中ポートを検知すると「別ポートで起動するか」を対話で聞いてきて、ヘッドレス実行ではそこで固まる。常に `PORT=3001` を指定する。
- **`BROWSER=none` 必須** — 付けないと CRA がブラウザウィンドウを開こうとする。
- **`chromium-cli` は存在しない** — この環境では Playwright + システム Chrome(`channel: 'chrome'`)で代替。`npm i playwright` はブラウザをダウンロードしないので `channel` 指定が必須(指定なしの `chromium.launch()` は実行ファイルが見つからず失敗する)。
- **スクリーンショットが素の HTML に見えるのは正常** — `src/index.css` には ≤768px のメディアクエリ内に最小限の flex 指定しかなく、装飾スタイルは未実装。真っ白・エラーページなら失敗だが、無装飾は成功。
- **`npm i <パッケージ>` を実行すると playwright が消える** — playwright は `--no-save` 導入なので、npm は次の install 時に「package.json にない余分なパッケージ」として削除する。ドライバーが `Cannot find package 'playwright'` で落ちたら、Setup の playwright インストール行を再実行する。
- **起動ログの警告は無害** — `caniuse-lite is outdated` と `onAfterSetupMiddleware`/`onBeforeSetupMiddleware` の DeprecationWarning は出るが動作に影響なし。`webpack compiled successfully` が出れば OK。
- **Gemini 無料枠の分あたりクォータに注意** — `url_context` 付きリクエストは 1 回で複数のクォータ単位を消費するらしく、連続送信すると 3〜5 通目で 429 になる(実測: `limit: 20, retry in 〜60s`)。driver は API を呼ぶ送信の間に既定 20 秒のペーシングを入れている(`DRIVER_PACE_MS` で調整、0 で無効)。このため 1 回の実行に 2 分前後かかるのは正常。

## Troubleshooting

- **テスト実行時の `babel-preset-react-app is importing "@babel/plugin-proposal-private-property-in-object" without declaring it` 警告**: CRA が非メンテなことによる既知の警告。無害。消したければ devDependencies に当該パッケージを追加する。
- **ドライバーが `channel "chrome" で起動できず…` を出す**: Chrome 未インストールのマシン。Edge に自動フォールバックする。両方ないと失敗するので、どちらかを入れる。
