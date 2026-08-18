// Gemini API をプロキシサーバー(server/index.mjs)経由の素の fetch で呼ぶ。
// API キーはサーバー側だけが保持し、フロントのバンドルには含まれない。
// 開発時は CRA の package.json "proxy" 設定で /api/* が同一オリジンからプロキシに転送される。
// 注: 公式 SDK は使わない — CRA(react-scripts 5)の webpack で Node 専用モジュールが
// 解決できない問題を避けるため、raw HTTP で統一する。

// 対象サイトの URL は UI(ヘッダー)の入力欄の初期値になる
// (REACT_APP_ 接頭辞のみ CRA がバンドルに埋め込む。秘密情報はここに置かないこと)
export const SITE_URL = process.env.REACT_APP_TARGET_SITE_URL;

const MODEL = 'gemini-2.5-flash';
// 無料枠の上限(429)時に一度だけ自動フォールバックするモデル。
// url_context 対応で、無料枠が MODEL とは別カウントかつ大きい。
// 固定バージョン名(例: gemini-2.5-flash-lite)は提供終了で 404 になった実績があるため、
// 常に最新の flash-lite を指すエイリアスを使う
const FALLBACK_MODEL = 'gemini-flash-lite-latest';

// mode は 'generate'(非ストリーミング)または 'stream'(SSE)
const apiUrl = (model, mode) => `/api/gemini/${model}/${mode}`;

// 回答スコープの制御: サイト特化ボットとして回答ソースを対象サイトに固定し、
// 一般知識でのハルシネーション(それらしい代答)を抑制する
const SYSTEM_PROMPT =
  'あなたは指定されたサイト専用のサポートアシスタントです。' +
  '回答は必ず対象サイト(プロンプト中の URL から取得できた内容)のみを根拠にし、日本語で簡潔に答えてください。' +
  'サイトに記載のない事柄を聞かれた場合は、推測や一般知識で代答せず、' +
  '「対象サイトに記載がありません」と明示してください(そのうえで関連するサイト内の情報があれば案内してよい)。' +
  'ただし、これまでの会話のやり取り自体に関する質問には、会話履歴に基づいて答えて構いません。' +
  '対象サイトへのアクセス自体が失敗し内容を一切取得できなかった場合は、' +
  '「対象サイトを取得できませんでした(サイト側のアクセス制限の可能性があります)」と明示してください。' +
  'この場合に「URL が指定されていない」という説明はしないこと(URL は必ずプロンプトに含まれています)。';

// 第 1 段階(補足プロンプト生成)用のシステムプロンプト。
// url_context はプロンプト中に書かれた URL しか取得できない(クロールしない)ため、
// sitemap.xml / robots.txt / /sitemap/ を候補としてここで探索させ、
// 第 2 段階で読むべき URL を本文に含んだ指示プロンプトを作らせる
const PLAN_SYSTEM_PROMPT =
  'あなたは検索計画アシスタントです。ユーザーの質問に「対象サイトの内容に基づいて」答える' +
  '最終回答者への指示プロンプトを作成してください。' +
  'まず候補 URL(トップページ・sitemap.xml・robots.txt・サイトマップページ)のうち取得できた内容を確認し、' +
  '質問に答えるために読むべきページを特定します。' +
  '出力は指示プロンプト本文のみとし、必ず次を含めること: ' +
  '(1) 読むべきページの完全な URL(実在が確認できたもののみ、最大 10 件)、' +
  '(2) ユーザーの質問(入力ミス、意図を推測し補正したもの)、' +
  '(3) 「これらのページの内容に基づいて日本語で簡潔に回答し、記載のないことはその旨を伝える」という指示。' +
  '前置き・説明・コードブロックは出力しないこと。';

// 対象サイトの URL と質問を Gemini に渡し、回答テキストを返す。
// 二段階方式: まず補足プロンプト(読むべき URL 入り)を生成し、それを実行して回答する。
// 第 1 段階が失敗した場合は従来どおり質問を直接渡す。
// history には過去のやり取り({ role: 'user' | 'assistant', text } の配列)を渡す。
// onDelta は受信のたびに「それまでの全文」で呼ばれる(逐次描画用)。
// siteUrl は画面の入力欄から渡される(省略時は .env.local の値)。
// onPhase は段階の切り替わり('planning' → 'answering')で呼ばれる(UI 表示用)。
// onPrompt は第 2 段階(実行)に実際に渡すプロンプト本文が確定した時点で 1 回呼ばれる
// (画面での透明性表示用。第 1 段階が失敗した場合は直接質問の本文が渡る)。
export async function askAboutSite(
  question,
  history = [],
  onDelta,
  siteUrl = SITE_URL,
  onPhase,
  onPrompt
) {
  if (!siteUrl) {
    throw new Error(
      '対象サイトが未設定です。ヘッダーの「対象サイト」欄に URL を入力してください。'
    );
  }

  // 会話履歴を user / model の交互ロールで積む(Gemini では assistant ではなく model)
  const historyContents = history.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.text }],
  }));

  // 第 1 段階: 読むべき URL を含む補足プロンプトを生成する(失敗したら null → 直接質問)
  if (onPhase) onPhase('planning');
  let plannedPrompt = null;
  try {
    const planContents = [
      ...historyContents,
      { role: 'user', parts: [{ text: buildPlanRequest(question, siteUrl) }] },
    ];
    plannedPrompt = await withQuotaFallback((model) =>
      generateOnce(model, PLAN_SYSTEM_PROMPT, planContents)
    );
  } catch {
    plannedPrompt = null; // 計画の失敗は致命傷にしない(直接質問にフォールバック)
  }

  // 第 2 段階: 生成されたプロンプト(なければ従来の直接質問)をストリーミング実行する。
  // 質問の原文を必ず併記する — プランナーの指示文だけだと、会話履歴に関するメタ質問が
  // 「ページに基づいて答えよ」に埋もれて誤答するため(タスク 13)。
  // `対象サイト: <URL>` も必ず併記する — プランナーが「実在確認できた URL のみ」の方針で
  // 候補 URL を全て落としても、最低限トップページが url_context の対象になるように(タスク 14)
  if (onPhase) onPhase('answering');
  const finalText =
    plannedPrompt && plannedPrompt.trim()
      ? `対象サイト: ${siteUrl}\n\n${plannedPrompt.trim()}\n\n[ユーザーの質問の原文]\n${question}`
      : `対象サイト: ${siteUrl}\n\n質問: ${question}`;
  if (onPrompt) onPrompt(finalText);
  const contents = [...historyContents, { role: 'user', parts: [{ text: finalText }] }];
  return withQuotaFallback((model) => streamAnswer(model, SYSTEM_PROMPT, contents, onDelta));
}

// 第 1 段階に渡す本文。url_context に読ませたい候補 URL をすべて明記する
function buildPlanRequest(question, siteUrl) {
  let origin;
  try {
    origin = new URL(siteUrl).origin;
  } catch {
    origin = siteUrl.replace(/\/+$/, '');
  }
  return (
    `対象サイト: ${siteUrl}\n` +
    `候補 URL:\n` +
    `- ${siteUrl}\n` +
    `- ${origin}/sitemap.xml\n` +
    `- ${origin}/robots.txt\n` +
    `- ${origin}/sitemap/\n\n` +
    `質問: ${question}`
  );
}

// 429(無料枠上限)のときだけ、枠が別カウントの軽量モデルで一度だけ再試行する
async function withQuotaFallback(run) {
  try {
    return await run(MODEL);
  } catch (error) {
    if (error.status !== 429) throw error;
    return run(FALLBACK_MODEL);
  }
}

function buildRequestBody(systemPrompt, contents) {
  return JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    // url_context: プロンプト中の URL を Gemini 側が直接取得する(ブラウザの CORS 制約を受けない)
    tools: [{ url_context: {} }],
  });
}

// エラーレスポンスを日本語メッセージ付きの Error にして投げる(status はフォールバック判定用)
async function throwApiError(response) {
  const data = await response.json().catch(() => ({}));
  const detail = data?.error?.message ?? response.statusText;
  let message;
  if (response.status === 400 && /API key/i.test(detail)) {
    message = 'API キーが無効です。.env.local の GEMINI_API_KEY を確認し、プロキシサーバーを再起動してください。';
  } else if (response.status === 403) {
    message = `API キーに権限がありません(403): ${detail}`;
  } else if (response.status === 429) {
    message = `利用上限に達しました(429): ${detail}`;
  } else {
    message = `API エラー(${response.status}): ${detail}`;
  }
  const error = new Error(message);
  error.status = response.status;
  throw error;
}

// 非ストリーミングで 1 回生成する(第 1 段階用)。ブロック時や空応答は null を返す
async function generateOnce(model, systemPrompt, contents) {
  const response = await fetch(apiUrl(model, 'generate'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: buildRequestBody(systemPrompt, contents),
  });
  if (!response.ok) await throwApiError(response);

  const data = await response.json();
  if (data.promptFeedback?.blockReason) return null;
  const candidate = data.candidates?.[0];
  if (!candidate || candidate.finishReason === 'SAFETY') return null;
  const text = (candidate.content?.parts ?? [])
    .filter((part) => part.text)
    .map((part) => part.text)
    .join('');
  return text || null;
}

// 指定モデルに contents を送り、SSE をパースして回答テキストを返す(第 2 段階用)
async function streamAnswer(model, systemPrompt, contents, onDelta) {
  const response = await fetch(apiUrl(model, 'stream'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: buildRequestBody(systemPrompt, contents),
  });
  // エラー時は SSE ではなく JSON が返る
  if (!response.ok) await throwApiError(response);

  // SSE("data: {...}" 行)をパースし、テキスト片を連結していく
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let blocked = false;

  const processDataLine = (jsonText) => {
    let chunk;
    try {
      chunk = JSON.parse(jsonText);
    } catch {
      return; // 不完全な行は無視
    }
    if (chunk.promptFeedback?.blockReason) {
      blocked = true;
      return;
    }
    const candidate = chunk.candidates?.[0];
    if (!candidate) return;
    if (candidate.finishReason === 'SAFETY') {
      blocked = true;
      return;
    }
    const text = (candidate.content?.parts ?? [])
      .filter((part) => part.text)
      .map((part) => part.text)
      .join('');
    if (text) {
      fullText += text;
      if (onDelta) onDelta(fullText);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.startsWith('data: ')) processDataLine(line.slice(6));
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith('data: ')) processDataLine(rest.slice(6));

  if (blocked) {
    return 'この質問にはお答えできません。別の聞き方を試してください。';
  }
  if (!fullText) {
    throw new Error('回答が返りませんでした。もう一度お試しください。');
  }
  return fullText;
}
