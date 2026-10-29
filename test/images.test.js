import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildUserMessage, displayContent, hasImages, assertImageSupport } from '../src/images.js';
import { Store } from '../src/store.js';

// 真正的单像素 PNG，覆盖多模态内容和本地持久化。
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
test('图片路径、引号和转义空格均可构建多模态消息', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roco-image-'));
  try {
    await writeFile(join(root, 'a b.png'), png);
    for (const raw of ['看看 "a b.png"', '/image "a b.png" 看看', '看看 a\\ b.png', `看看 '${root}/a b.png'`]) {
      const message = await buildUserMessage(raw, { cwd: root });
      assert.equal(message.content[0].text, '看看');
      assert.equal(message.content[1].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
      assert.equal(hasImages([message]), true);
      assert.ok(!displayContent(message).includes('base64'));
    }
    const only = await buildUserMessage(`/image "${root}/a b.png"`);
    assert.equal(only.content[0].text, '请描述这些图片。');
    const store = new Store(join(root, 'data'));
    await store.init();
    const session = store.create();
    session.messages.push(only);
    await store.save(session);
    await rm(join(root, 'a b.png'));
    assert.deepEqual((await store.list())[0].messages[0], only);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('普通文本和远程链接保持原样', async () => {
  for (const text of ['你好', '看看 https://example.com/a.png']) {
    assert.deepEqual(await buildUserMessage(text), { role: 'user', content: text });
  }
});
test('无效路径、伪图片、过大附件及数量超限明确报错', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roco-image-'));
  try {
    await writeFile(join(root, 'fake.png'), 'not an image');
    await writeFile(join(root, 'large.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
    await assert.rejects(buildUserMessage('/image'), /用法/);
    await assert.rejects(buildUserMessage('./missing.png', { cwd: root }), /文件不存在/);
    await assert.rejects(buildUserMessage('fake.png', { cwd: root }), /不是支持的图片/);
    await assert.rejects(buildUserMessage('large.png', { cwd: root }), /10 MB/);
    await assert.rejects(buildUserMessage('a.png b.png c.png d.png e.png'), /最多附带/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('依据接口能力阻止纯文本模型接收图片历史', () => {
  const models = [{ id: 'vision', input_modalities: ['text', 'image'] }, { id: 'text', input_modalities: ['text'] }];
  assert.doesNotThrow(() => assertImageSupport(models, 'vision'));
  assert.throws(() => assertImageSupport(models, 'text'), /未声明支持图片/);
  assert.throws(() => assertImageSupport(models, 'unknown'), /未声明支持图片/);
});

// 回归：中文描述紧接冒号和路径时，不能把整句当成文件名。
test('自然语言标点分隔路径，保留前后描述', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roco-image-'));
  try {
    const path = join(root, 'img2.jpg');
    await writeFile(path, png);
    for (const separator of ['：', '： ', ':', ': ', '，']) {
      const message = await buildUserMessage(`那么请看看这张图片吧${separator}${path}`);
      assert.deepEqual(message.attachments, [path]);
      assert.ok(message.content[0].text.startsWith('那么请看看这张图片吧'));
    }
    for (const text of [`看看（${path}），哪里有问题？`, `看看\`${path}\`。`]) {
      assert.deepEqual((await buildUserMessage(text)).attachments, [path]);
    }
    assert.equal((await buildUserMessage('图片：https://example.com/img.png')).content, '图片：https://example.com/img.png');
  } finally { await rm(root, { recursive: true, force: true }); }
});
