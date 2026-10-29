// 使用 DeepSeek 官方兼容接口；不回显响应体，防止网关错误泄露敏感信息。
export async function chat({ apiKey, model = 'deepseek-flash', messages, onToken, signal, fetchImpl = fetch }) {
  const response = await fetchImpl('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, thinking: { type: 'disabled' }, messages, stream: true }),
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok) {
    const hints = { 401: 'API Key 无效，请重新 connect。', 402: '账户余额不足。', 429: '请求过于频繁，请稍后重试。' };
    throw new Error(hints[response.status] || `DeepSeek 请求失败（HTTP ${response.status}）。`);
  }
  if (!response.body) throw new Error('DeepSeek 未返回响应流。');
  let buffer = '';
  let content = '';
  let finished = false;
  const consume = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { finished = true; return; }
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error('DeepSeek 返回流错误，请稍后重试。');
    const choice = chunk.choices?.[0];
    const token = choice?.delta?.content || '';
    content += token;
    if (token) onToken(token);
    if (choice?.finish_reason === 'length') throw new Error('回复超过长度限制，本轮未保存，请缩短问题后重试。');
  };
  // TextDecoderStream 保留跨网络分片的中文字符，按行解析 SSE。
  for await (const text of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += text;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      consume(buffer.slice(0, index).replace(/\r$/, ''));
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer.trim()) consume(buffer.trim());
  if (!finished) throw new Error('连接提前中断，本轮未保存，请重试。');
  if (!content.trim()) throw new Error('DeepSeek 返回了空回复，本轮未保存。');
  return content;
}

// 每次打开模型菜单实时查询，不把模型列表写死在客户端。
export async function listModels({ apiKey, fetchImpl = fetch }) {
  const response = await fetchImpl('https://api.deepseek.com/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const hints = { 401: 'API Key 无效，请重新 connect。', 429: '请求过于频繁，请稍后重试。' };
    throw new Error(hints[response.status] || `获取模型失败（HTTP ${response.status}）。`);
  }
  const result = await response.json();
  if (!Array.isArray(result.data)) throw new Error('模型列表响应格式异常。');
  const seen = new Set();
  const models = result.data.filter(model => {
    if (typeof model?.id !== 'string' || !model.id.trim() || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
  if (!models.length) throw new Error('提供商未返回可用模型。');
  return models;
}
