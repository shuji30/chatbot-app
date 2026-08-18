import { render, screen, fireEvent } from '@testing-library/react';
import Chatbot from './Chatbot';
import { askAboutSite } from './gemini';

// gemini.js は実 API(ネットワーク)を呼ぶためモックする
jest.mock('./gemini');

beforeEach(() => {
  askAboutSite.mockReset();
});

test('入力欄と送信ボタンが表示される', () => {
  render(<Chatbot />);
  expect(screen.getByPlaceholderText('質問を入力…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '送信' })).toBeInTheDocument();
});

test('入力欄がタイプした値を反映する(controlled component)', () => {
  render(<Chatbot />);
  const input = screen.getByPlaceholderText('質問を入力…');
  fireEvent.change(input, { target: { value: 'テスト質問' } });
  expect(input).toHaveValue('テスト質問');
});

test('送信するとユーザーメッセージと回答が表示され、入力欄がクリアされる', async () => {
  askAboutSite.mockResolvedValue('モックの回答です');
  render(<Chatbot />);
  const input = screen.getByPlaceholderText('質問を入力…');

  fireEvent.change(input, { target: { value: 'こんにちは' } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));

  expect(await screen.findByText('こんにちは')).toBeInTheDocument();
  expect(await screen.findByText('モックの回答です')).toBeInTheDocument();
  expect(input).toHaveValue('');
});

test('Enter キーでも送信できる', async () => {
  askAboutSite.mockResolvedValue('Enter への回答');
  render(<Chatbot />);
  const input = screen.getByPlaceholderText('質問を入力…');

  fireEvent.change(input, { target: { value: 'Enter で送信' } });
  fireEvent.keyDown(input, { key: 'Enter' });

  expect(await screen.findByText('Enter への回答')).toBeInTheDocument();
});

test('画面で指定した対象サイトの URL が askAboutSite に渡る', async () => {
  askAboutSite.mockResolvedValue('回答');
  render(<Chatbot siteUrl="https://user-input.example/" />);

  fireEvent.change(screen.getByPlaceholderText('質問を入力…'), {
    target: { value: '質問' },
  });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  await screen.findByText('回答');

  expect(askAboutSite).toHaveBeenCalledWith(
    '質問',
    [],
    expect.any(Function),
    'https://user-input.example/',
    expect.any(Function),
    expect.any(Function)
  );
});

test('送信されたプロンプトが折りたたみ表示に反映される', async () => {
  askAboutSite.mockImplementation(async (question, history, onDelta, siteUrl, onPhase, onPrompt) => {
    onPrompt('実際に送信されたプロンプト本文');
    return '回答';
  });
  render(<Chatbot />);

  fireEvent.change(screen.getByPlaceholderText('質問を入力…'), {
    target: { value: '質問' },
  });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));

  await screen.findByText('回答');
  expect(screen.getByText('送信したプロンプトを表示')).toBeInTheDocument();
  expect(screen.getByText('実際に送信されたプロンプト本文')).toBeInTheDocument();
});

test('応答が届くまでは「プロンプト作成中…」のプレースホルダを表示する', async () => {
  let resolveAnswer;
  askAboutSite.mockImplementation(() => new Promise((resolve) => (resolveAnswer = resolve)));
  render(<Chatbot />);

  fireEvent.change(screen.getByPlaceholderText('質問を入力…'), {
    target: { value: '質問' },
  });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));

  expect(await screen.findByText('プロンプト作成中…')).toBeInTheDocument();
  resolveAnswer('回答');
  expect(await screen.findByText('回答')).toBeInTheDocument();
});

test('2 回目の送信では会話履歴が askAboutSite に渡る', async () => {
  askAboutSite.mockResolvedValue('1 回目の回答');
  render(<Chatbot />);
  const input = screen.getByPlaceholderText('質問を入力…');

  fireEvent.change(input, { target: { value: '1 回目の質問' } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  await screen.findByText('1 回目の回答');

  askAboutSite.mockResolvedValue('2 回目の回答');
  fireEvent.change(input, { target: { value: '2 回目の質問' } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  await screen.findByText('2 回目の回答');

  const history = askAboutSite.mock.calls[1][1];
  expect(history).toEqual([
    { role: 'user', text: '1 回目の質問' },
    expect.objectContaining({ role: 'assistant', text: '1 回目の回答' }),
  ]);
});

test('API エラー時はエラーメッセージを表示する(クラッシュしない)', async () => {
  askAboutSite.mockRejectedValue(new Error('API キーが未設定です。'));
  render(<Chatbot />);

  fireEvent.change(screen.getByPlaceholderText('質問を入力…'), {
    target: { value: '質問' },
  });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));

  const errorMessage = await screen.findByText('API キーが未設定です。');
  expect(errorMessage).toHaveClass('error');
});

test('空文字では送信されない', () => {
  render(<Chatbot />);
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  expect(askAboutSite).not.toHaveBeenCalled();
});

test('回答中の URL はリンクとして描画される(文末の句読点は含めない)', async () => {
  askAboutSite.mockResolvedValue('詳細は https://www.example.com/docs。以上です。');
  render(<Chatbot />);

  fireEvent.change(screen.getByPlaceholderText('質問を入力…'), {
    target: { value: 'リンクをください' },
  });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));

  const link = await screen.findByRole('link', { name: 'https://www.example.com/docs' });
  expect(link).toHaveAttribute('href', 'https://www.example.com/docs');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});
