import React, { useState, useRef, useEffect } from 'react';
import { askAboutSite } from './gemini';

// 回答テキスト中の URL を検出する(空白・引用符・括弧・和文の句読点は URL に含めない —
// 「https://example.com/docs。以上」のように URL 直後に句点が続くケースを区切るため)
const URL_PATTERN = /https?:\/\/[^\s<>"'「」『』()（）、。！？]+/g;

// テキスト中の URL を <a> 要素に変換する(依存パッケージなしの軽量方式)。
// React 要素として組み立てるので、HTML 文字列の挿入(XSS の危険)はない。
// Markdown の [タイトル](URL) 記法の本格レンダリングはスコープ外。
function linkify(text) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    // 文末の ASCII 句読点はリンクに含めない(和文の句読点はパターン側で除外済み)
    const url = match[0].replace(/[.,;:!?]+$/, '');
    if (!url) continue;
    nodes.push(text.slice(last, match.index));
    nodes.push(
      <a key={match.index} href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>
    );
    last = match.index + url.length;
  }
  nodes.push(text.slice(last));
  return nodes;
}

function Chatbot({ siteUrl }) {
  // メッセージは { role: 'user' | 'assistant', text, isError? } で管理する
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messageContainerRef = useRef(null);

  // メッセージが追加・更新(ストリーミング追記)されるたびに最新メッセージまでスクロールする
  useEffect(() => {
    const container = messageContainerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages]);

  // メッセージの送信ハンドラ
  const handleSendMessage = async () => {
    const question = input.trim();
    // 空文字は送らない。応答待ち中の多重送信も抑止する
    if (!question || isLoading) return;
    setInput('');
    setIsLoading(true);

    // これまでの会話をマルチターンの文脈として渡す。
    // メッセージは常に [user, assistant] のペアで積まれるので、ペア単位で走査し、
    // 回答がエラーだったやり取りは文脈に含めない
    const history = [];
    for (let i = 0; i + 1 < messages.length; i += 2) {
      const userMessage = messages[i];
      const botMessage = messages[i + 1];
      if (botMessage.isError || !botMessage.text) continue;
      history.push(userMessage, botMessage);
    }

    // ユーザーのメッセージと、回答用のプレースホルダをまとめて追加。
    // 以降の更新は常に「末尾のメッセージの置換」なので、state updater が
    // 遅延実行されても取り違えが起きない
    setMessages((prevMessages) => [
      ...prevMessages,
      { role: 'user', text: question },
      { role: 'assistant', text: '', streaming: true, phase: 'planning' },
    ]);

    // 末尾(このターンのアシスタントメッセージ)を置き換えるヘルパー
    const replaceLast = (message) => {
      setMessages((prevMessages) => {
        const next = [...prevMessages];
        next[next.length - 1] = message;
        return next;
      });
    };

    // 第 1 段階で作成された実行用プロンプトは、確定した時点で prompt に保持し、
    // 以降のメッセージ更新(ストリーミング差分・最終確定)すべてに引き継ぐ(透明性表示用)
    let generatedPrompt = null;

    // 固定サイト + 質問を Gemini に渡し、回答をストリーミングで逐次描画する
    try {
      const answer = await askAboutSite(
        question,
        history,
        (text) => replaceLast({ role: 'assistant', text, streaming: true, prompt: generatedPrompt }),
        siteUrl,
        // 段階が変わったらプレースホルダの表示を切り替える(本文が届くまでの間だけ見える)
        (phase) => replaceLast({ role: 'assistant', text: '', streaming: true, phase, prompt: generatedPrompt }),
        (prompt) => {
          generatedPrompt = prompt;
        }
      );
      replaceLast({ role: 'assistant', text: answer, prompt: generatedPrompt }); // 最終確定
    } catch (error) {
      replaceLast({ role: 'assistant', text: error.message, isError: true });
    } finally {
      setIsLoading(false);
    }
  };

  // Enter キーで送信(日本語 IME の変換確定 Enter は送信しない)
  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      handleSendMessage();
    }
  };

  return (
    <div>
      <div className="chat-container">
        {/* メッセージの表示エリア */}
        <div className="message-container" ref={messageContainerRef}>
          {messages.map((message, index) => (
            <div
              key={index}
              className={`message ${message.role}${message.isError ? ' error' : ''}${
                message.streaming && !message.text ? ' loading' : ''
              }`}
            >
              {/* テキスト片が届くまでは段階に応じたプレースホルダを表示。
                  アシスタントの回答は URL をリンク化して表示する */}
              {message.text
                ? message.role === 'assistant'
                  ? linkify(message.text)
                  : message.text
                : message.streaming
                ? message.phase === 'planning'
                  ? 'プロンプト作成中…'
                  : '考え中…'
                : ''}

              {/* 実際に AI へ送信されたプロンプトを、透明性のため折りたたみで表示する */}
              {message.role === 'assistant' && message.prompt && (
                <details className="prompt-details">
                  <summary>送信したプロンプトを表示</summary>
                  <pre>{message.prompt}</pre>
                </details>
              )}
            </div>
          ))}
        </div>

        {/* ユーザーの入力フィールドと送信ボタン */}
        <div className="input-container">
          <input
            type="text"
            id="userInput"
            placeholder="質問を入力…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
          />
          <button onClick={handleSendMessage} disabled={isLoading}>
            送信
          </button>
        </div>
      </div>
    </div>
  );
}

export default Chatbot;
