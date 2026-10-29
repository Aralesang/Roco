import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import * as pty from 'node-pty';
import { mkdir, chmod, readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { timingSafeEqual, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 独立 SSH 服务使用高位端口，无需修改系统 sshd 或创建系统账户。
const project = dirname(dirname(fileURLToPath(import.meta.url)));

async function ensureKey(path) {
  try { await access(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'roco-local', '-f', path], { stdio: 'pipe' });
  }
  await chmod(path, 0o600);
  return readFile(path);
}

export function verifyPublicKey(ctx, allowed) {
  // SSH 公钥探测与正式签名验证分两步；仅接受被授权的那把密钥。
  const actual = ctx.key?.data;
  const expected = allowed.getPublicSSH();
  if (ctx.username !== 'roco' || ctx.method !== 'publickey' || !actual || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  return !ctx.signature || allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true;
}

export async function startSshServer(options = {}) {
  const dataRoot = resolve(options.root || process.env.ROCO_HOME || join(homedir(), '.roco'));
  const keyRoot = join(dataRoot, 'ssh');
  const host = options.host || process.env.ROCO_SSH_HOST || '127.0.0.1';
  const port = options.port ?? Number(process.env.ROCO_SSH_PORT || 2222);
  // 测试可通过 options.port=0 申请空闲端口，环境变量仍需有效固定端口。
  if (!Number.isInteger(port) || port < (options.port === 0 ? 0 : 1) || port > 65535) throw new Error('ROCO_SSH_PORT 必须是 1–65535 的整数。');
  await mkdir(keyRoot, { recursive: true, mode: 0o700 });
  await chmod(dataRoot, 0o700);
  await chmod(keyRoot, 0o700);
  const hostKey = await ensureKey(join(keyRoot, 'host_ed25519'));
  const parsedHostKey = utils.parseKey(hostKey);
  if (parsedHostKey instanceof Error) throw parsedHostKey;
  const fingerprint = `SHA256:${createHash('sha256').update(parsedHostKey.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  const clientKey = join(keyRoot, 'client_ed25519');
  // 本地测试自动生成专用客户端密钥；也可指定已有的公钥文件。
  if (!process.env.ROCO_SSH_PUBLIC_KEY) await ensureKey(clientKey);
  const publicPath = process.env.ROCO_SSH_PUBLIC_KEY || `${clientKey}.pub`;
  const allowed = utils.parseKey(await readFile(publicPath));
  if (allowed instanceof Error || Array.isArray(allowed)) throw new Error('客户端公钥无法解析，请检查 ROCO_SSH_PUBLIC_KEY。');
  const clients = new Set();
  const terminals = new Set();
  const server = new Server({ hostKeys: [hostKey], readyTimeout: 20_000 }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => {
      if (ctx.method === 'publickey' && verifyPublicKey(ctx, allowed)) ctx.accept();
      else ctx.reject(['publickey']);
    });
    client.on('ready', () => {
      let opened = false;
      client.on('session', (accept, reject) => {
        if (opened) return reject();
        opened = true;
        const session = accept();
        let terminal;
        let channel;
        let dimensions;
        session.on('pty', (acceptPty, rejectPty, info) => {
          if (dimensions || !info) return rejectPty?.();
          dimensions = { cols: clamp(info.cols, 80), rows: clamp(info.rows, 24), term: info.term || 'xterm-256color' };
          acceptPty?.();
        });
        session.on('window-change', (acceptResize, _rejectResize, info) => {
          if (terminal && info) terminal.resize(clamp(info.cols, 80), clamp(info.rows, 24));
          acceptResize?.();
        });
        session.on('shell', (acceptShell, rejectShell) => {
          if (!dimensions || terminal) return rejectShell();
          channel = acceptShell();
          try {
            // 真正的 PTY 保证补全菜单、方向键、Ctrl+C 与本地终端一致。
            terminal = pty.spawn(process.execPath, [join(project, 'src/cli.js')], {
              name: dimensions.term, cols: dimensions.cols, rows: dimensions.rows,
              cwd: project,
              env: { ...process.env, ROCO_HOME: dataRoot, TERM: dimensions.term, ROCO_SSH_SESSION: '1' },
            });
            terminals.add(terminal);
            const output = terminal.onData(data => channel.write(data));
            const exit = terminal.onExit(({ exitCode, signal }) => {
              terminals.delete(terminal);
              channel.exit(exitCode || (signal ? 1 : 0));
              channel.end();
              output.dispose();
              exit.dispose();
            });
            const inputDecoder = new StringDecoder('utf8');
            channel.on('data', data => terminal.write(inputDecoder.write(data)));
            const stop = () => { if (terminals.delete(terminal)) terminal.kill(); };
            channel.on('close', stop);
            client.once('close', stop);
            channel.on('error', stop);
          } catch (error) {
            console.error(`SSH 终端启动失败：${error.message}`);
            channel.stderr.write('无法启动 Roco 终端，请检查服务器日志和 Node.js 环境。\n');
            channel.exit(1);
            channel.end();
          }
        });
        // 不提供远程执行、SFTP 或端口转发，仅开放聊天 shell。
        session.on('exec', (_acceptExec, rejectExec) => rejectExec());
        session.on('subsystem', (_acceptSubsystem, rejectSubsystem) => rejectSubsystem());
      });
      client.on('tcpip', (_acceptForward, rejectForward) => rejectForward());
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, resolveListen);
  });
  server.on('error', error => console.error(`SSH 服务错误：${error.message}`));
  const actualPort = server.address().port;
  console.log(`Roco SSH 已启动：${host}:${actualPort}`);
  console.log(process.env.ROCO_SSH_PUBLIC_KEY
    ? `使用对应私钥连接：ssh -tt -p ${actualPort} roco@${host}`
    : `在另一个终端连接：\nssh -tt -i ${JSON.stringify(clientKey)} -p ${actualPort} roco@${host}`);
  console.log(`主机指纹：${fingerprint}`);
  console.log('首次连接请核对主机指纹；按 Ctrl+C 停止服务。');
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    for (const terminal of terminals) terminal.kill();
    terminals.clear();
    for (const client of clients) client.end();
    server.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  server.once('close', () => {
    process.removeListener('SIGINT', close);
    process.removeListener('SIGTERM', close);
  });
  return { server, close };
}

// 限制恶意或异常终端尺寸，避免渲染时分配过大的缓冲区。
function clamp(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 500) : fallback;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startSshServer().catch(error => { console.error(`SSH 启动失败：${error.message}`); process.exitCode = 1; });
}
