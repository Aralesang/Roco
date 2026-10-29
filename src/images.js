import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const MAX_BYTES = 10 * 1024 * 1024;
// 中文标点和冒号作为路径边界；引号内保留空格、标点，网址整体跳过。
// 支持终端拖入时的反斜杠转义，不执行任何 shell 内容。
const tokens = /https?:\/\/[^\s]+|"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|(?:\\ |[^\s：:，,。！？；;（）()"'`])+/g;
const imageExtension = /\.(png|jpe?g|gif|webp)$/i;

function mimeOf(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('文件不是支持的图片，请使用 PNG、JPEG、GIF 或 WebP。');
}

export async function buildUserMessage(raw, { cwd = process.cwd() } = {}) {
  const explicit = /^\/?image(?:\s|$)/.test(raw);
  const text = explicit ? raw.replace(/^\/?image\s*/, '') : raw;
  // 不将网址当成本地文件；普通消息只自动识别图片扩展名。
  const matcher = new RegExp(tokens.source, 'g');
  const paths = [];
  for (const match of text.matchAll(matcher)) {
    const value = (match[1] || match[2] || match[3] || match[0]).replace(/\\ /g, ' ');
    if (/^https?:\/\//i.test(value)) continue;
    if (imageExtension.test(value) || (explicit && paths.length === 0 && match.index === 0)) {
      paths.push({ path: value, start: match.index, end: match.index + match[0].length });
    }
  }
  if (explicit && !paths.length) throw new Error('用法：/image "图片路径" 可选的问题');
  if (!paths.length) return { role: 'user', content: raw };
  if (paths.length > 4) throw new Error('每条消息最多附带 4 张图片。');
  const parts = [];
  const attachments = [];
  for (const item of paths) {
    const expanded = item.path.startsWith('~/') ? resolve(homedir(), item.path.slice(2)) : resolve(cwd, item.path);
    let file;
    try {
      file = await open(expanded, 'r');
      const info = await file.stat();
      if (!info.isFile()) throw new Error('路径不是文件');
      if (info.size > MAX_BYTES) throw new Error('图片超过本地 10 MB 限制');
      // 有界读取，即使文件在读取期间增大也不会无限占用内存。
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_BYTES) throw new Error('图片超过本地 10 MB 限制');
      const bytes = buffer.subarray(0, size);
      const mime = mimeOf(bytes);
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } });
      attachments.push(expanded);
    } catch (error) {
      throw new Error(`无法读取图片 ${item.path}：${error.code === 'ENOENT' ? '文件不存在' : error.message}`);
    } finally { await file?.close(); }
  }
  let prompt = text;
  for (const item of paths.toReversed()) prompt = prompt.slice(0, item.start) + prompt.slice(item.end);
  prompt = prompt.trim() || '请描述这些图片。';
  // 图片快照随历史存储，源文件移动或删除后依然能继续会话。
  return { role: 'user', content: [{ type: 'text', text: prompt }, ...parts], attachments };
}

export function displayContent(message) {
  if (typeof message.content === 'string') return message.content;
  return message.content.map(part => part.type === 'text' ? part.text : '[图片]').join('\n')
    + (message.attachments?.length ? `\n附件：${message.attachments.join('、')}` : '');
}

export function hasImages(messages) {
  return messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
}

// 以提供商返回的能力为准，不根据模型名称猜测是否支持视觉。
export function assertImageSupport(models, model) {
  const selected = models.find(item => item.id === model);
  if (!selected?.input_modalities?.includes('image')) {
    throw new Error(`模型 ${model} 未声明支持图片，请用 /models 选择标有“支持图片”的模型；含图片的历史会话也需要视觉模型。`);
  }
}
