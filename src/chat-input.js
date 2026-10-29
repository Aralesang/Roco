import { createPrompt, useState, useKeypress } from '@inquirer/core';

// 命令与别名集中登记，候选说明只用于终端菜单。
export const commands = [
  { value: '/connect', description: '连接 DeepSeek' },
  { value: '/image', description: '发送本地图片：/image 路径 问题' },
  { value: '/models', description: '获取并选择模型' },
  { value: '/model', description: '获取并选择模型（别名）' },
  { value: '/session', description: '浏览和恢复会话' },
  { value: '/sessions', description: '浏览和恢复会话（别名）' },
  { value: '/session new', description: '新建会话' },
  { value: '/new', description: '新建会话' },
  { value: '/help', description: '查看帮助' },
  { value: '/exit', description: '退出' },
  { value: '/quit', description: '退出（别名）' },
];

export function matchingCommands(value) {
  // 普通聊天不触发菜单，带参数的 session new 也支持前缀补全。
  return value.startsWith('/') ? commands.filter(command => command.value.startsWith(value)) : [];
}

export const chatInput = createPrompt((_config, done) => {
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [finished, setFinished] = useState(false);
  const matches = matchingCommands(value);
  const visible = !hidden && matches.length > 0;

  useKeypress((key, rl) => {
    if (finished) return;
    if (key.name === 'return' || key.name === 'enter') {
      setFinished(true);
      done(value);
      return;
    }
    if (visible && (key.name === 'up' || key.name === 'down')) {
      // 方向键只改变候选项，保留正在编辑的输入。
      rl.clearLine(0);
      rl.write(value);
      setSelected((selected + (key.name === 'down' ? 1 : -1) + matches.length) % matches.length);
      return;
    }
    if (key.name === 'tab') {
      const completion = visible ? matches[selected]?.value : value;
      // 清除 readline 收到的 Tab，再写入选中命令；不直接执行。
      rl.clearLine(0);
      rl.write(completion || value);
      setValue(completion || value);
      setSelected(0);
      setHidden(true);
      return;
    }
    if (key.name === 'escape') { setHidden(true); return; }
    if (rl.line !== value) {
      setValue(rl.line);
      setSelected(0);
      setHidden(false);
    }
  });

  // 仅保留简洁提示符，不再显示“你”或默认问号前缀。
  return [
    `> ${value}`,
    !finished && visible
      ? `${matches.map((command, index) => `${index === selected ? '❯' : ' '} ${command.value.padEnd(14)} ${command.description}`).join('\n')}\n  ↑↓ 选择 · Tab 补全 · Enter 提交 · Esc 收起`
      : '',
  ];
});
