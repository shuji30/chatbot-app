import { render, screen, fireEvent } from '@testing-library/react';
import App from './App';

// gemini.js はネットワークを呼ぶためモックする(描画テストでも import はされる)
jest.mock('./gemini');

test('見出しとチャット UI が表示される', () => {
  render(<App />);
  expect(
    screen.getByRole('heading', { name: /welcome to my website/i })
  ).toBeInTheDocument();
  expect(screen.getByLabelText(/対象サイト/)).toBeInTheDocument();
  expect(screen.getByPlaceholderText('質問を入力…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '送信' })).toBeInTheDocument();
});

test('対象サイトの URL を画面で編集できる(controlled)', () => {
  render(<App />);
  const urlInput = screen.getByLabelText(/対象サイト/);
  fireEvent.change(urlInput, { target: { value: 'https://example.com/' } });
  expect(urlInput).toHaveValue('https://example.com/');
});
