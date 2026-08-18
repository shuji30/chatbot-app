// Gemini API へのプロキシサーバー。
// 目的: API キーをフロント(CRA のバンドル)から排除し、サーバー側だけで保持する。
// 起動: node server/index.mjs(または npm run server)。ポートは PROXY_PORT(既定 3002)。
// 開発時は CRA の package.json "proxy" 設定により、フロントの /api/* が同一オリジン経由でここに届く。
// 依存パッケージなし(node:http + Node 18+ の global fetch)。
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// .env.local を自前パースする(dotenv 依存を避ける)
function loadEnvLocal() {
  const envPath = join(root, '.env.local');
  if (!existsSync(envPath)) return {};
  return Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
      })
  );
}

const envLocal = loadEnvLocal();
// 推奨はサーバー専用の GEMINI_API_KEY。移行期間中は旧 REACT_APP_GEMINI_API_KEY も読む
// (REACT_APP_ 接頭辞の値は gemini.js が参照しない限り CRA のバンドルには埋め込まれない)
const API_KEY =
  process.env.GEMINI_API_KEY ?? envLocal.GEMINI_API_KEY ?? envLocal.REACT_APP_GEMINI_API_KEY;

const PROXY_PORT = Number(process.env.PROXY_PORT ?? 3002);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const server = createServer(async (req, res) => {
  const match =
    req.method === 'POST' && /^\/api\/gemini\/([\w.-]+)\/(generate|stream)$/.exec(req.url);
  if (!match) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `未知のエンドポイントです: ${req.url}` } }));
    return;
  }
  if (!API_KEY) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message:
            'GEMINI_API_KEY がサーバーに設定されていません。プロジェクトルートの .env.local に設定し、プロキシサーバーを再起動してください。',
        },
      })
    );
    return;
  }

  const [, model, mode] = match;
  const method = mode === 'stream' ? 'streamGenerateContent?alt=sse' : 'generateContent';

  // リクエストボディをそのまま Gemini へ転送する(キーはここで付与)
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  try {
    const upstream = await fetch(`${GEMINI_BASE}/${model}:${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': API_KEY },
      body: Buffer.concat(chunks),
    });
    // ステータスと content-type を保ったままパススルー(SSE はチャンクごとに書き出す)
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ error: { message: `プロキシから Gemini に接続できません: ${error.message}` } })
    );
  }
});

server.listen(PROXY_PORT, () => {
  console.log(`gemini proxy listening on http://localhost:${PROXY_PORT}`);
});
