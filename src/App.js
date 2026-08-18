import React, { useState } from 'react';
import Chatbot from './Chatbot';
import { SITE_URL } from './gemini';

function App() {
  // 対象サイトの URL は画面で変更できる(初期値は .env.local の REACT_APP_TARGET_SITE_URL)
  const [siteUrl, setSiteUrl] = useState(SITE_URL ?? '');

  return (
    <div className="App">
      {/* ヘッダー: 何について答えるチャットボットかを示し、対象サイトをここで変更できる */}
      <header className="app-header">
        <h1>Welcome to My Website</h1>
        <label className="site-info">
          対象サイト:{' '}
          <input
            type="url"
            id="siteUrl"
            value={siteUrl}
            onChange={(event) => setSiteUrl(event.target.value)}
            placeholder="https://example.com/"
          />
        </label>
      </header>

      {/* チャットボットコンポーネント */}
      <Chatbot siteUrl={siteUrl} />
    </div>
  );
}

export default App;
