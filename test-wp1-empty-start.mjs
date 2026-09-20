import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const port = 5200 + Math.floor(Math.random() * 300);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'kaogong-wp1-'));
let child;
const base = `http://127.0.0.1:${port}`;

function startServer() {
  child = spawn(process.execPath, ['server.mjs', String(port)], {
    cwd: ROOT,
    env: { ...process.env, APP_DATA_DIR: dataDir, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  return waitForServer();
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('服务未在 10 秒内启动');
}

async function stopServer() {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

async function api(url, options) {
  const response = await fetch(`${base}${url}`, options);
  const body = await response.json();
  assert.equal(response.ok, true, `${url}: ${JSON.stringify(body)}`);
  return body;
}

before(async () => { await startServer(); });
after(async () => {
  await stopServer();
  await rm(dataDir, { recursive: true, force: true });
});

test('WP1 空数据目录可以启动并进入自定义题库', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<title>没钱考什么公/);
  assert.deepEqual(await api('/api/subjects'), []);
  assert.deepEqual((await api('/api/custom/batches')).batches, []);
});

test('WP1 自定义题库导入、练习、判分和重启后数据保留', async () => {
  const imported = await api('/api/custom/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'WP1 冒烟题库',
      questions: [
        { prompt: '1+1 等于多少？', options: ['A. 1', 'B. 2'], answer: 'B', answer_index: 1, analysis: '基础加法。' },
        { prompt: '地球是圆的吗？', options: ['正确', '错误'], answer: '正确', answer_index: 0 },
      ],
    }),
  });
  assert.equal(imported.count, 2);

  const practice = await api(`/api/custom/practice?batch_id=${imported.id}`);
  assert.equal(practice.questions.length, 2);
  const first = practice.questions[0];
  const answer = first.answerIndex === 1 ? 1 : 0;
  const checked = await api('/api/custom/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ questionId: first.id, selected: [answer], batchId: imported.id }),
  });
  assert.equal(checked.ok, true);

  const batches = await api('/api/custom/batches');
  assert.deepEqual(batches.batches.map((b) => b.count), [2]);
  await stopServer();
  await startServer();
  const afterRestart = await api('/api/custom/batches');
  assert.equal(afterRestart.batches[0].name, 'WP1 冒烟题库');
  assert.equal(afterRestart.batches[0].count, 2);
});
