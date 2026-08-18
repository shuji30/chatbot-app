// gemini.js の二段階プロンプト(計画 → 実行)と 429 フォールバックを fetch モックで検証する。
// 環境変数はモジュール読み込み時に評価されるため、テストごとに resetModules + require する。
import { TextEncoder, TextDecoder } from 'util';

// jsdom には TextEncoder/TextDecoder がないため Node 実装で補う
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

// SSE ストリーミング成功レスポンス(第 2 段階)のモック
function sseResponse(text) {
  const payload = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
  const chunks = [new TextEncoder().encode(`data: ${payload}\n\n`)];
  let index = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { done: false, value: chunks[index++] }
            : { done: true, value: undefined },
      }),
    },
  };
}

// 非ストリーミング成功レスポンス(第 1 段階)のモック
function jsonResponse(text) {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  };
}

function errorResponse(status, message) {
  return {
    ok: false,
    status,
    statusText: String(status),
    json: async () => ({ error: { message } }),
  };
}

function loadGemini() {
  jest.resetModules();
  // API キーはプロキシサーバー側にあり、フロントは参照しない
  process.env.REACT_APP_TARGET_SITE_URL = 'https://example.com/';
  return require('./gemini');
}

// n 番目の fetch 呼び出しの本文(JSON)を返す
const bodyOf = (n) => JSON.parse(global.fetch.mock.calls[n][1].body);
const lastUserText = (body) => body.contents.at(-1).parts[0].text;

afterEach(() => {
  delete global.fetch;
});

test('二段階: 計画(候補 URL 入り)を生成し、そのプロンプトで回答を実行する', async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(jsonResponse('生成された指示プロンプト https://example.com/page1'))
    .mockResolvedValueOnce(sseResponse('最終回答'));
  const { askAboutSite } = loadGemini();

  const phases = [];
  await expect(askAboutSite('質問', [], undefined, undefined, (p) => phases.push(p))).resolves.toBe(
    '最終回答'
  );
  expect(global.fetch).toHaveBeenCalledTimes(2);
  // 第 1 段階は非ストリーミング(プロキシの /generate)で、sitemap 等の候補 URL を本文に含める
  expect(global.fetch.mock.calls[0][0]).toBe('/api/gemini/gemini-2.5-flash/generate');
  const planText = lastUserText(bodyOf(0));
  expect(planText).toContain('https://example.com/sitemap.xml');
  expect(planText).toContain('https://example.com/robots.txt');
  expect(planText).toContain('質問');
  // 第 2 段階はストリーミング(プロキシの /stream)で、生成されたプロンプト + 質問の原文を実行する
  expect(global.fetch.mock.calls[1][0]).toBe('/api/gemini/gemini-2.5-flash/stream');
  const finalText = lastUserText(bodyOf(1));
  expect(finalText).toContain('生成された指示プロンプト https://example.com/page1');
  expect(finalText).toContain('[ユーザーの質問の原文]');
  expect(finalText).toContain('質問');
  // 計画が候補 URL を落としても、対象サイトの URL は必ず本文に残る(タスク 14)
  expect(finalText).toContain('対象サイト: https://example.com/');
  expect(phases).toEqual(['planning', 'answering']);
});

test('第 2 段階に渡す最終プロンプトが onPrompt で通知される', async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(jsonResponse('生成された指示プロンプト'))
    .mockResolvedValueOnce(sseResponse('回答'));
  const { askAboutSite } = loadGemini();

  let notifiedPrompt = null;
  await askAboutSite('質問', [], undefined, undefined, undefined, (prompt) => {
    notifiedPrompt = prompt;
  });
  expect(notifiedPrompt).toBe(lastUserText(bodyOf(1)));
  expect(notifiedPrompt).toContain('生成された指示プロンプト');
});

test('回答スコープを制御する system_instruction が第 2 段階で送信される', async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(jsonResponse('計画プロンプト'))
    .mockResolvedValueOnce(sseResponse('回答'));
  const { askAboutSite } = loadGemini();

  await askAboutSite('質問');
  const instruction = bodyOf(1).system_instruction.parts[0].text;
  // サイトのみを根拠にし、記載がなければ代答しないこと(スコープ制御)が指示されている
  expect(instruction).toContain('対象サイト');
  expect(instruction).toContain('一般知識で代答');
  expect(instruction).toContain('対象サイトに記載がありません');
  // 取得不能サイトの安全網(タスク 14): 誤った「URL 未指定」説明をせず、正直に取得失敗を明示する
  expect(instruction).toContain('取得できませんでした');
  expect(instruction).toContain('URL が指定されていない');
});

test('第 1 段階が失敗したら従来の直接質問で回答を実行する', async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(errorResponse(500, 'server error'))
    .mockResolvedValueOnce(sseResponse('直接回答'));
  const { askAboutSite } = loadGemini();

  await expect(askAboutSite('質問')).resolves.toBe('直接回答');
  const finalText = lastUserText(bodyOf(1));
  expect(finalText).toContain('対象サイト: https://example.com/');
  expect(finalText).toContain('質問');
});

test('第 1 段階の 429 は flash-lite で再試行される', async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(errorResponse(429, 'quota'))
    .mockResolvedValueOnce(jsonResponse('計画プロンプト'))
    .mockResolvedValueOnce(sseResponse('回答'));
  const { askAboutSite } = loadGemini();

  await expect(askAboutSite('質問')).resolves.toBe('回答');
  expect(global.fetch.mock.calls[0][0]).toContain('/gemini-2.5-flash/');
  expect(global.fetch.mock.calls[1][0]).toContain('/gemini-flash-lite-latest/');
});

test('第 2 段階の 429 は flash-lite で再試行される', async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(jsonResponse('計画プロンプト'))
    .mockResolvedValueOnce(errorResponse(429, 'quota'))
    .mockResolvedValueOnce(sseResponse('フォールバック回答'));
  const { askAboutSite } = loadGemini();

  await expect(askAboutSite('質問')).resolves.toBe('フォールバック回答');
  expect(global.fetch).toHaveBeenCalledTimes(3);
  expect(global.fetch.mock.calls[1][0]).toContain('/gemini-2.5-flash/');
  expect(global.fetch.mock.calls[2][0]).toContain('/gemini-flash-lite-latest/');
});

test('第 2 段階の 429 以外のエラーではフォールバックしない', async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(jsonResponse('計画プロンプト'))
    .mockResolvedValueOnce(errorResponse(403, 'forbidden'));
  const { askAboutSite } = loadGemini();

  await expect(askAboutSite('質問')).rejects.toThrow(/403/);
  expect(global.fetch).toHaveBeenCalledTimes(2);
});
