import test from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSshServer, verifyPublicKey } from '../src/ssh-server.js';

// 真正完成 SSH 握手、公钥签名、PTY、中文补全和退出，不调用模型 API。
test('SSH 登录进入聊天，命令补全可用，退出断开', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'roco-ssh-'));
  const service = await startSshServer({ root, port: 0 });
  const client = new ssh2.Client();
  try {
    const privateKey = await readFile(join(root, 'ssh/client_ed25519'));
    const allowed = ssh2.utils.parseKey(await readFile(join(root, 'ssh/client_ed25519.pub')));
    assert.equal(verifyPublicKey({ method: 'publickey', username: 'other', key: { data: allowed.getPublicSSH() } }, allowed), false);
    assert.equal(verifyPublicKey({ method: 'publickey', username: 'roco', key: { data: Buffer.from('wrong') } }, allowed), false);
    assert.equal(verifyPublicKey({ method: 'publickey', username: 'roco', key: { data: allowed.getPublicSSH() }, signature: Buffer.from('wrong'), blob: Buffer.from('test') }, allowed), false);
    const hostKey = ssh2.utils.parseKey(await readFile(join(root, 'ssh/host_ed25519.pub'))).getPublicSSH();
    await new Promise((resolve, reject) => {
      client.once('ready', resolve).once('error', reject).connect({
        host: '127.0.0.1', port: service.server.address().port, username: 'roco', privateKey,
        hostVerifier: key => key.equals(hostKey),
      });
    });
    await new Promise((resolve, reject) => client.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (error, stream) => {
      if (error) return reject(error);
      let output = '';
      let stage = 0;
      stream.on('error', reject);
      stream.on('data', data => {
        output += data.toString();
        if (stage === 0 && output.includes('当前模型：') && output.includes('>')) {
          stage = 1;
          stream.write('/h');
        }
        if (stage === 1 && output.includes('Tab 补全')) { stage = 2; stream.write('\t'); }
        if (stage === 2 && output.includes('> /help')) { stage = 3; stream.write('\r'); }
        if (stage === 3 && output.includes('session <ID前缀>')) { stage = 4; stream.write('/exit\r'); }
      });
      stream.stderr.on('data', data => { output += data.toString(); });
      stream.on('close', () => {
        try {
          assert.equal(stage, 4, output);
          assert.ok(output.includes('SSH 对话'), output);
          assert.ok(output.includes('再见'), output);
          resolve();
        } catch (error) { reject(error); }
      });
    }));
  } finally {
    client.destroy();
    const closed = new Promise(resolve => service.server.once('close', resolve));
    service.close();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});
