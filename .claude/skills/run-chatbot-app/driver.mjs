// chatbot-app を headless ブラウザで起動確認するドライバー。
// 使い方: node .claude/skills/run-chatbot-app/driver.mjs [URL]
//   URL 省略時は http://localhost:3001
// 前提: プロジェクトルートで `npm i --no-save playwright` 済みであること。
//       ブラウザ本体はダウンロードせず、システムの Chrome(なければ Edge)を使う。
// スクリーンショットはこのファイルと同じ場所の screenshots/ に保存される。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.argv[2] ?? 'http://localhost:3001';
const shotDir = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(shotDir, { recursive: true });

// Gemini 無料枠は分あたりのクォータが小さく、url_context 付きリクエストは 1 回で複数単位を
// 消費するため、API を呼ぶ送信の間隔を空ける(429 対策)。DRIVER_PACE_MS=0 で無効化できる。
const PACE_MS = Number(process.env.DRIVER_PACE_MS ?? 20000);
const pace = () => new Promise((resolve) => setTimeout(resolve, PACE_MS));

async function launch() {
  // Playwright 管理のブラウザは入れていないので channel 指定が必須
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (e) {
      console.log(`channel "${channel}" で起動できず、次を試す: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error('Chrome も Edge も起動できない。どちらかをインストールすること。');
}

const errors = [];
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  // タスク 15 で追加した「送信したプロンプト」の折りたたみ(.prompt-details)は非表示でも
  // textContent には含まれてしまうため、素の el.textContent では回答の検証文字列が汚染される。
  // 判定用の本文取得は window.__messageText(el)(.prompt-details を除いたクローンから読む)を経由する
  await page.addInitScript(() => {
    window.__messageText = (el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.prompt-details').forEach((d) => d.remove());
      return clone.textContent;
    };
  });
  // 429(無料枠上限 → flash-lite へ自動フォールバック)と 503(Gemini 側の一時的な過負荷。
  // 計画段階の 503 は直接質問へのフォールバックで自動的に飲み込まれる)は想定内の resource
  // エラーなので失敗扱いにしない(実害があれば回答がエラー吹き出しになり各 STEP で検出される)
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (/Failed to load resource.*(429|503)/.test(msg.text())) return;
    errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('h1:has-text("Welcome to My Website")', { timeout: 15000 });
  await page.screenshot({ path: join(shotDir, 'shot-1-initial.png') });
  console.log('STEP1 OK: 初期ページ描画');

  // ヘッダーに対象サイトの入力欄があり、.env.local の URL が初期値に入っている
  const siteValue = await page.inputValue('#siteUrl');
  if (siteValue.startsWith('http')) {
    console.log(`STEP1b OK: ヘッダーの対象サイト入力欄に初期値(${siteValue})`);
  } else {
    console.log('STEP1b SKIP: 対象サイト未設定(REACT_APP_TARGET_SITE_URL なし)のため初期値は空 — 仕様どおり');
  }

  await page.fill('#userInput', 'こんにちは、チャットボット!');
  await page.click('button:has-text("送信")');
  await page.waitForSelector('.message:has-text("こんにちは、チャットボット!")', { timeout: 10000 });
  console.log('STEP2 OK: 1 件目のメッセージがリストに表示');

  // 送信するとアシスタントの応答(キー未設定時はエラー案内)が追加される
  // ローディング表示(考え中…)は .loading が付くため除外して待つ
  await page.waitForSelector('.message.assistant:not(.loading)', { timeout: 120000 });
  const reply = await page.$eval('.message.assistant:not(.loading)', (el) => window.__messageText(el));
  console.log(`STEP2b OK: アシスタント応答が表示 — "${reply.slice(0, 60)}"`);

  // Enter キーでも送信できる
  await pace();
  await page.fill('#userInput', '調子はどう?');
  await page.press('#userInput', 'Enter');
  await page.waitForSelector('.message:has-text("調子はどう?")', { timeout: 10000 });
  console.log('STEP3 OK: Enter キー送信で 2 件目のメッセージが表示');

  // 2 件目の応答を待ってから、空文字送信が抑止されることを確認
  await page.waitForSelector(':nth-match(.message.assistant:not(.loading), 2)', { timeout: 120000 });
  const countBefore = await page.$$eval('.message', (els) => els.length);
  await page.click('button:has-text("送信")');
  await page.waitForTimeout(500);
  const countAfter = await page.$$eval('.message', (els) => els.length);
  if (countAfter !== countBefore) {
    throw new Error(`空文字送信が抑止されていない(${countBefore} → ${countAfter} 件)`);
  }
  console.log('STEP3b OK: 空文字送信ではメッセージが増えない');

  const inputValue = await page.inputValue('#userInput');
  if (inputValue !== '') throw new Error(`送信後も入力欄が残っている: "${inputValue}"`);
  console.log('STEP4 OK: 送信後に入力欄がクリアされる');

  // 応答の描画(ストリーミングの置換処理)でユーザーメッセージが消えていないこと
  const userCount = await page.$$eval('.message.user', (els) => els.length);
  if (userCount !== 2) {
    throw new Error(`ユーザーメッセージが消えている(期待 2 件、実際 ${userCount} 件)`);
  }
  console.log('STEP5 OK: ユーザーメッセージ 2 件が最後まで残っている');

  // 吹き出しレイアウト: user は右寄せ、assistant は左寄せ、メッセージ領域はスクロール可能で
  // 常に最新メッセージ(最下部)までスクロールされていること
  const layout = await page.evaluate(() => {
    const style = (sel) => getComputedStyle(document.querySelector(sel));
    const container = document.querySelector('.message-container');
    return {
      user: style('.message.user').alignSelf,
      assistant: style('.message.assistant').alignSelf,
      overflowY: getComputedStyle(container).overflowY,
      atBottom: container.scrollTop + container.clientHeight >= container.scrollHeight - 5,
    };
  });
  if (layout.user !== 'flex-end') throw new Error(`user 吹き出しが右寄せでない: ${layout.user}`);
  if (layout.assistant !== 'flex-start') throw new Error(`assistant 吹き出しが左寄せでない: ${layout.assistant}`);
  if (layout.overflowY !== 'auto') throw new Error(`メッセージ領域がスクロール可能でない: ${layout.overflowY}`);
  if (!layout.atBottom) throw new Error('メッセージ領域が最下部まで自動スクロールされていない');
  console.log('STEP6 OK: 吹き出しレイアウト(user 右 / assistant 左)と自動スクロール');

  const messages = await page.$$eval('.message', (els) => els.map((e) => window.__messageText(e)));
  console.log('MESSAGES:', JSON.stringify(messages));

  await page.screenshot({ path: join(shotDir, 'shot-2-after-send.png') });

  // モバイル幅(≤768px)で横スクロールが発生しないこと
  await page.setViewportSize({ width: 375, height: 667 });
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  if (scrollWidth > 375) throw new Error(`モバイル幅で横スクロールが発生(scrollWidth: ${scrollWidth})`);
  await page.screenshot({ path: join(shotDir, 'shot-3-mobile.png') });
  console.log('STEP7 OK: モバイル幅(375px)で横スクロールなし');

  // マルチターン: 「先ほど挙げてくれた」の解決には会話履歴が必要(1 件目の回答のサービス一覧を参照)。
  // メッセージの逐語再現(メタ質問)はサイト特化ボットの仕様外なので検証しない — 履歴の送信自体は Jest で検証済み。
  // (リンク化の検証はサイトマップ一覧の STEP10 で行う — URL を確実に含む回答が得られるため)
  await page.setViewportSize({ width: 900, height: 700 });
  await pace();
  await page.fill('#userInput', '先ほど挙げてくれたサービスの中で、水に関係するものだけ教えてください。');
  await page.press('#userInput', 'Enter');
  await page.waitForSelector(':nth-match(.message.assistant:not(.loading), 3)', { timeout: 120000 });
  await page.waitForSelector('.input-container button:not([disabled])', { timeout: 120000 });
  const followUp = await page.$eval(
    ':nth-match(.message.assistant:not(.loading), 3)',
    (el) => ({ text: window.__messageText(el), isError: el.classList.contains('error') })
  );
  if (followUp.isError || !/(浄水|天然水|ウォーター)/.test(followUp.text)) {
    throw new Error(`文脈依存のフォローアップに答えられていない: "${followUp.text.slice(0, 120)}"`);
  }
  await page.screenshot({ path: join(shotDir, 'shot-5-multiturn.png') });
  console.log(`STEP8 OK: 文脈依存のフォローアップに回答 — "${followUp.text.slice(0, 60)}"`);

  // フルフロー: サイトの内容そのものへの質問に、エラーでない回答が返ること
  await pace();
  await page.fill('#userInput', 'このサイトは何のサービスのサイトですか?一文で教えてください。');
  await page.press('#userInput', 'Enter');
  await page.waitForSelector(':nth-match(.message.assistant:not(.loading), 4)', { timeout: 150000 });
  const fullFlow = await page.$eval(
    ':nth-match(.message.assistant:not(.loading), 4)',
    (el) => ({ text: window.__messageText(el), isError: el.classList.contains('error') })
  );
  if (fullFlow.isError || !fullFlow.text.trim()) {
    throw new Error(`サイト内容への質問に回答できていない: "${fullFlow.text}"`);
  }
  await page.screenshot({ path: join(shotDir, 'shot-6-fullflow.png') });
  console.log(`STEP9 OK: サイト内容への質問に回答 — "${fullFlow.text.slice(0, 80)}"`);

  // 二段階プロンプト + サイトマップ自動探索: トップページに sitemap へのリンクがなくても、
  // 第 1 段階が sitemap.xml 等を探索するので、ページ一覧の質問に実在 URL で答えられる。
  // 回答中の URL のリンク化(<a> 要素・target/rel 属性)もここで検証する
  await pace();
  await page.fill('#userInput', 'サイトマップに載っているページの URL を 5 件、箇条書きで一覧してください。');
  await page.press('#userInput', 'Enter');
  await page.waitForSelector(':nth-match(.message.assistant:not(.loading), 5)', { timeout: 180000 });
  // ストリーミング完了(送信ボタンの再有効化)まで待ってから全文を評価する
  await page.waitForSelector('.input-container button:not([disabled])', { timeout: 180000 });
  const sitemapReply = await page.$eval(
    ':nth-match(.message.assistant:not(.loading), 5)',
    (el) => ({
      text: window.__messageText(el),
      isError: el.classList.contains('error'),
      links: [...el.querySelectorAll('a')].map((a) => ({
        href: a.href,
        target: a.target,
        rel: a.rel,
      })),
    })
  );
  if (sitemapReply.isError) {
    throw new Error(`サイトマップの質問がエラー応答: "${sitemapReply.text.slice(0, 120)}"`);
  }
  if (sitemapReply.links.length < 2) {
    throw new Error(
      `サイトマップのリンク一覧が返っていない(リンク ${sitemapReply.links.length} 件): "${sitemapReply.text.slice(0, 120)}"`
    );
  }
  const badLink = sitemapReply.links.find(
    (l) => l.target !== '_blank' || !l.rel.includes('noopener')
  );
  if (badLink) throw new Error(`リンクの属性が不正: ${JSON.stringify(badLink)}`);
  await page.screenshot({ path: join(shotDir, 'shot-7-sitemap.png') });
  console.log(
    `STEP10 OK: サイトマップのリンク一覧に回答(リンク ${sitemapReply.links.length} 件、例: ${sitemapReply.links[0].href})`
  );

  // 回答スコープの制御: サイトに記載のない一般知識の質問には代答せず「記載がない」と答えること
  await pace();
  await page.fill('#userInput', '日本の首相の名前を教えてください。');
  await page.press('#userInput', 'Enter');
  await page.waitForSelector(':nth-match(.message.assistant:not(.loading), 6)', { timeout: 150000 });
  await page.waitForSelector('.input-container button:not([disabled])', { timeout: 150000 });
  const scopeReply = await page.$eval(
    ':nth-match(.message.assistant:not(.loading), 6)',
    (el) => ({ text: window.__messageText(el), isError: el.classList.contains('error') })
  );
  if (scopeReply.isError) {
    throw new Error(`サイト外質問がエラー応答: "${scopeReply.text.slice(0, 120)}"`);
  }
  if (!/記載/.test(scopeReply.text)) {
    throw new Error(`サイト外の質問に一般知識で代答している: "${scopeReply.text.slice(0, 120)}"`);
  }
  await page.screenshot({ path: join(shotDir, 'shot-8-scope.png') });
  console.log(`STEP11 OK: サイト外の質問に「記載がない」と回答 — "${scopeReply.text.slice(0, 60)}"`);

  // 送信されたプロンプトの折りたたみ表示: 直前の回答(6 件目のアシスタント発言)に
  // <details class="prompt-details"> が付き、開くと対象サイトの URL を含む本文が見える
  const promptDetails = await page.$(':nth-match(.message.assistant:not(.loading), 6) .prompt-details');
  if (!promptDetails) throw new Error('送信したプロンプトの折りたたみが表示されていない');
  await promptDetails.$eval('summary', (el) => el.click());
  const promptText = await promptDetails.$eval('pre', (el) => el.textContent);
  if (!promptText.trim()) throw new Error('折りたたみを開いてもプロンプト本文が空');
  await page.screenshot({ path: join(shotDir, 'shot-9-prompt.png') });
  console.log(`STEP12 OK: 送信したプロンプトを表示(${promptText.length} 文字)`);

  if (errors.length) {
    console.log('CONSOLE_ERRORS:', JSON.stringify(errors));
    process.exitCode = 1;
  } else {
    console.log('CONSOLE_ERRORS: none');
    console.log(`PASS — screenshots: ${shotDir}`);
  }
} finally {
  await browser.close();
}
