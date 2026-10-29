import { mkdir, readFile, writeFile, rename, readdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// 配置与会话放在用户目录，避免密钥进入项目仓库。
export class Store {
  constructor(root = process.env.ROCO_HOME || join(homedir(), '.roco')) {
    this.root = root;
    this.sessions = join(root, 'sessions');
  }
  async init() {
    await mkdir(this.sessions, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await chmod(this.sessions, 0o700);
  }
  async read(path, fallback) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }
  async write(path, value) {
    // 同目录原子替换，避免中途退出留下半份 JSON。
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  }
  config() { return this.read(join(this.root, 'config.json'), {}); }
  saveConfig(config) { return this.write(join(this.root, 'config.json'), config); }
  create() {
    return { id: randomUUID(), title: '新会话', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
  }
  async save(session) {
    session.updatedAt = new Date().toISOString();
    await this.write(join(this.sessions, `${session.id}.json`), session);
  }
  async list() {
    const sessions = [];
    for (const name of await readdir(this.sessions)) {
      if (!name.endsWith('.json')) continue;
      const session = await this.read(join(this.sessions, name));
      if (!session || !Array.isArray(session.messages) || typeof session.id !== 'string') {
        throw new Error(`会话文件格式错误：${name}`);
      }
      sessions.push(session);
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
