import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { chat } from '../src/deepseek.js';

// 使用临时目录验证历史恢复及密钥文件权限，不触碰真实配置。
test('保存配置、会话，并恢复完整上下文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roco-test-'));
  try {
    const store = new Store(root);
    await store.init();
    await store.saveConfig({ apiKey: 'test-only' });
    const session = store.create();
    session.messages = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好！' }];
    await store.save(session);
    assert.deepEqual((await new Store(root).list())[0].messages, session.messages);
    assert.equal((await store.config()).apiKey, 'test-only');
    assert.equal((await stat(join(root, 'config.json'))).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// 刻意将中文 UTF-8 字节和 SSE 行切开，覆盖实际网络分片场景。
test('流式响应支持跨分片中文与 CRLF', async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\n\n');
  let output = '';
  const result = await chat({ apiKey: 'test-only', messages: [], onToken: token => output += token,
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).stream, true);
      return new Response(new ReadableStream({ start(controller) {
        for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2));
        controller.close();
      } }));
    },
  });
  assert.equal(result, '你好');
  assert.equal(output, '你好');
});
test('中断响应不能作为成功问答保存', async () => {
  await assert.rejects(chat({ apiKey: 'test', messages: [], onToken() {}, fetchImpl: async () => new Response('data: {"choices":[{"delta":{"content":"半段"}}]}\n') }), /提前中断/);
});
test('鉴权错误给出操作提示且不回显响应体', async () => {
  await assert.rejects(chat({ apiKey: 'test', messages: [], onToken() {}, fetchImpl: async () => new Response('sensitive', { status: 401 }) }), /API Key 无效/);
});

// 补全仅匹配命令前缀，不干扰正常消息或会话 ID 输入。
test('斜杠命令按前缀筛选', async () => {
  const { matchingCommands, commands } = await import('../src/chat-input.js');
  assert.equal(matchingCommands('/').length, commands.length);
  assert.deepEqual(matchingCommands('/c').map(item => item.value), ['/connect']);
  assert.deepEqual(matchingCommands('/session n').map(item => item.value), ['/session new']);
  assert.deepEqual(matchingCommands('你好'), []);
  assert.deepEqual(matchingCommands('/unknown'), []);
  assert.deepEqual(matchingCommands('/session abc'), []);
});

// 模型发现兼容只有 id 的响应，也保留提供商给出的展示信息。
test('动态获取模型并去重，保留元数据', async () => {
  const { listModels } = await import('../src/deepseek.js');
  const models = await listModels({ apiKey: 'test-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/models');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    return Response.json({ data: [{ id: 'a', name: '模型 A', context_window: 1000 }, { id: 'b' }, { id: 'a' }, {}] });
  } });
  assert.deepEqual(models, [{ id: 'a', name: '模型 A', context_window: 1000 }, { id: 'b' }]);
});
test('模型接口错误、空列表和异常结构给出提示', async () => {
  const { listModels } = await import('../src/deepseek.js');
  for (const [response, message] of [
    [new Response('', { status: 401 }), /API Key 无效/],
    [Response.json({ data: [] }), /未返回可用模型/],
    [Response.json({}), /格式异常/],
  ]) {
    await assert.rejects(listModels({ apiKey: 'test', fetchImpl: async () => response }), message);
  }
});
test('对话请求使用选择的模型', async () => {
  await chat({ apiKey: 'test', model: 'selected-model', messages: [], onToken() {}, fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).model, 'selected-model');
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\ndata: [DONE]\n');
  } });
});
