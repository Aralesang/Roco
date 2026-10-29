import { chmod, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// node-pty 的 macOS 预编译包可能缺少 helper 执行权限，安装时补齐。
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const relative of [`prebuilds/darwin-${process.arch}/spawn-helper`, 'build/Release/spawn-helper']) {
    const path = join(root, relative);
    try { await access(path); await chmod(path, 0o755); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
