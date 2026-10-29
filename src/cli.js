#!/usr/bin/env node
import { password, select } from '@inquirer/prompts';
import { Store } from './store.js';
import { chat, listModels } from './deepseek.js';
import { chatInput } from './chat-input.js';
import { buildUserMessage, displayContent, hasImages, assertImageSupport } from './images.js';

const help = `命令（可加 / 前缀）：
  connect             选择提供商并保存 API Key
  models / model      获取并选择模型
  image 路径 [问题]   发送本地图片（空格路径请加引号）
  session / sessions  浏览并切换历史会话
  session new / new   新建会话
  session <ID前缀>    恢复指定会话
  help                查看帮助
  exit                退出
输入 / 查看命令，↑↓ 选择、Tab 补全、Enter 提交。
直接输入文字即可聊天；回复中 Ctrl+C 中断，本轮不会保存。`;

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在交互式终端运行 npm start。');
  const store = new Store();
  await store.init();
  let config = await store.config();
  let session = store.create();

  async function connect() {
    await select({ message: '选择提供商', choices: [{ name: 'DeepSeek', value: 'deepseek' }] });
    const apiKey = (await password({ message: '输入 DeepSeek API Key', mask: '*', validate: value => value.trim() ? true : 'API Key 不能为空' })).trim();
    const next = { ...config, provider: 'deepseek', apiKey };
    await store.saveConfig(next);
    config = next;
    console.log('已保存 DeepSeek 配置。');
    await chooseModel();
  }

  async function chooseModel() {
    const apiKey = process.env.DEEPSEEK_API_KEY || config.apiKey;
    if (!apiKey) { console.log('请先输入 connect 连接提供商。'); return; }
    console.log('正在获取 DeepSeek 模型列表…');
    const models = await listModels({ apiKey });
    const current = config.model || 'deepseek-flash';
    const model = await select({
      message: `选择模型（当前：${current}）`,
      default: models.some(item => item.id === current) ? current : null,
      choices: [
        ...models.map(item => ({
          name: `${item.name || item.id}${item.name && item.name !== item.id ? ` (${item.id})` : ''}${item.input_modalities?.includes('image') ? ' · 支持图片' : ''}${item.id === current ? ' · 当前' : ''}`,
          value: item.id,
          description: [
            Number.isFinite(item.context_window) ? `上下文：${item.context_window.toLocaleString()} tokens` : '',
            Number.isFinite(item.max_output_tokens) ? `最大输出：${item.max_output_tokens.toLocaleString()} tokens` : '',
          ].filter(Boolean).join(' · ') || '提供商未提供额外模型信息',
        })),
        { name: '取消，保留当前模型', value: null },
      ],
    });
    if (!model) return;
    // 成功保存后再切换内存配置，重启后继续使用该模型。
    const next = { ...config, model };
    await store.saveConfig(next);
    config = next;
    console.log(`已切换模型：${model}`);
  }

  async function command(text) {
    const [name, ...args] = text.replace(/^\//, '').split(/\s+/);
    if (name === 'exit' || name === 'quit') return 'exit';
    if (name === 'help') { console.log(help); return true; }
    if (name === 'models' || name === 'model') { await chooseModel(); return true; }
    if (name === 'connect') { await connect(); return true; }
    if (name === 'new' || ((name === 'session' || name === 'sessions') && args[0] === 'new')) {
      session = store.create();
      console.log('已新建会话。');
      return true;
    }
    if (name === 'session' || name === 'sessions') {
      const list = await store.list();
      if (!list.length) { console.log('暂无历史会话，发送第一条消息后自动保存。'); return true; }
      let selected;
      if (args.length) {
        const matches = list.filter(item => item.id.startsWith(args[0]));
        if (matches.length !== 1) throw new Error('会话 ID 不存在或前缀不唯一。');
        selected = matches[0];
      } else {
        const id = await select({ message: '选择历史会话', choices: [
          { name: '返回当前会话', value: null },
          ...list.map(item => ({ name: `${item.title} · ${item.id.slice(0, 8)} · ${new Date(item.updatedAt).toLocaleString()}`, value: item.id })),
        ] });
        if (!id) return true;
        selected = list.find(item => item.id === id);
      }
      session = selected;
      console.log(`\n已恢复：${session.title} (${session.id})`);
      for (const message of session.messages) console.log(`\n${message.role === 'user' ? '' : 'Roco '}> ${displayContent(message)}`);
      return true;
    }
    if (name === 'image') return false;
    // 绝对图片路径以 / 开头，应进入附件解析而非未知命令分支。
    if (/\.(png|jpe?g|gif|webp)(?=[\s"']|$)/i.test(text)) return false;
    if (text.startsWith('/')) { console.log('未知命令，输入 help 查看帮助。'); return true; }
    return false;
  }

  console.log('\nRoco · DeepSeek 终端 Agent\n输入 connect 连接提供商，models 选择模型，session 管理历史会话。\n');
  if (process.env.ROCO_SSH_SESSION) console.log('SSH 对话：图片路径指向服务端文件；输入 exit 即断开连接。');
  console.log(`当前模型：${config.model || 'deepseek-flash'}\n`);
  const initial = process.argv.slice(2).join(' ').trim();
  if (initial && !await command(initial)) throw new Error('未知启动命令，请使用 connect、models、session 或 help。');
  if (initial === 'exit' || initial === 'quit') return;
  while (true) {
    try {
      const text = (await chatInput({})).trim();
      if (!text) continue;
      const handled = await command(text);
      if (handled === 'exit') break;
      if (handled) continue;
      const apiKey = process.env.DEEPSEEK_API_KEY || config.apiKey;
      if (!apiKey) { console.log('尚未连接提供商，请先输入 connect。'); continue; }
      const userMessage = await buildUserMessage(text);
      const messages = [...session.messages, userMessage];
      const model = config.model || 'deepseek-flash';
      if (hasImages(messages)) {
        assertImageSupport(await listModels({ apiKey }), model);
      }
      if (userMessage.attachments) console.log(`已附加 ${userMessage.attachments.length} 张图片。`);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel);
      process.stdout.write('\nRoco > ');
      let content;
      try {
        content = await chat({ apiKey, model, messages: messages.map(({ role, content }) => ({ role, content })), signal: controller.signal, onToken: token => process.stdout.write(token) });
      } finally {
        process.removeListener('SIGINT', cancel);
        process.stdout.write('\n\n');
      }
      // 仅完整成功的问答进入历史；保存失败时也保留内存，避免悄悄丢失上下文。
      session.messages.push(userMessage, { role: 'assistant', content });
      if (session.title === '新会话') session.title = text.replace(/\s+/g, ' ').slice(0, 40);
      await store.save(session);
    } catch (error) {
      if (error.name === 'ExitPromptError') break;
      if (error.name === 'AbortError') console.log('已中断，本轮未保存。');
      else if (error.name === 'TimeoutError') console.log('请求超时，本轮未保存，请重试。');
      else console.error(`错误：${error.message}`);
    }
  }
  console.log('再见。');
}
main().catch(error => { if (error.name !== 'ExitPromptError') { console.error(`错误：${error.message}`); process.exitCode = 1; } });
