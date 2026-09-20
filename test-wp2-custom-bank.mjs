import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const port = 5500 + Math.floor(Math.random() * 200);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'kaogong-wp2-'));
const base = `http://127.0.0.1:${port}`;
let child;

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
      if ((await fetch(`${base}/`)).ok) return;
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

async function request(url, body) {
  const response = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(url) {
  const response = await fetch(`${base}${url}`);
  return { status: response.status, body: await response.json() };
}

const questions = [
  {
    external_id: 'wp2-q-1',
    prompt: '下列哪项是正确答案？',
    options: ['A. 甲', 'B. 乙'],
    answer: 'B',
    answer_index: 1,
    analysis: '基础判断。',
  },
  {
    external_id: 'wp2-q-2',
    prompt: '这是一道待核验题。',
    options: ['A. 是', 'B. 否'],
    answer: '',
    answer_index: -1,
  },
];

before(async () => { await startServer(); });
after(async () => {
  await stopServer();
  await rm(dataDir, { recursive: true, force: true });
});

test('WP2 导入校验、逻辑身份、幂等去重和冲突预览', async () => {
  const imported = await request('/api/custom/import', { name: 'WP2 题库', questions });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.created, 2);
  assert.equal(imported.body.revisions, 0);

  const firstList = await get(`/api/custom/questions?batch_id=${imported.body.id}`);
  assert.equal(firstList.status, 200);
  assert.equal(firstList.body.questions.length, 2);
  const first = firstList.body.questions.find((q) => q.external_id === 'wp2-q-1');
  assert.match(first.question_uid, /^[0-9a-f-]{36}$/);
  assert.equal(first.revision, 1);
  assert.equal(first.is_current, 1);
  assert.equal(first.answer_status, 'unconfirmed');
  assert.equal(first.fingerprint.length, 64);
  assert.equal(firstList.body.questions.find((q) => q.external_id === 'wp2-q-2').answer_status, 'missing');

  const repeated = await request('/api/custom/import', { name: '重复导入不应新建批次', questions });
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.body.created, 0);
  assert.equal(repeated.body.unchanged, 2);
  assert.equal(repeated.body.idempotent, true);
  const batches = await get('/api/custom/batches');
  assert.equal(batches.body.batches.length, 1);
  assert.equal(batches.body.batches[0].count, 2);

  const changed = { ...questions[0], prompt: '下列哪项是更新后的正确答案？' };
  const preview = await request('/api/custom/import/preview', { questions: [changed] });
  assert.equal(preview.status, 409);
  assert.equal(preview.body.valid, false);
  assert.equal(preview.body.conflicts[0].code, 'content_conflict');

  const rejected = await request('/api/custom/import', { name: '不应写入', questions: [changed] });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'custom_import_conflict');
  const unchangedList = await get(`/api/custom/questions?batch_id=${imported.body.id}`);
  assert.equal(unchangedList.body.questions.find((q) => q.external_id === 'wp2-q-1').prompt, questions[0].prompt);
});

test('WP2 显式 new_revision 保留旧版本且只让当前版本出题', async () => {
  const changed = { ...questions[0], prompt: '下列哪项是第二版正确答案？', analysis: '第二版解析。' };
  const revised = await request('/api/custom/import', {
    batch_id: 1,
    conflict_mode: 'new_revision',
    questions: [changed],
  });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal(revised.body.revisions, 1);
  assert.equal(revised.body.created, 0);

  const current = await get('/api/custom/questions?batch_id=1');
  assert.equal(current.body.questions.length, 2);
  const currentQ = current.body.questions.find((q) => q.external_id === 'wp2-q-1');
  assert.equal(currentQ.prompt, changed.prompt);
  assert.equal(currentQ.revision, 2);
  assert.equal(currentQ.is_current, 1);

  const history = await get('/api/custom/questions?batch_id=1&include_history=1');
  const versions = history.body.questions.filter((q) => q.external_id === 'wp2-q-1');
  assert.equal(versions.length, 2);
  assert.deepEqual(versions.map((q) => q.revision).sort(), [1, 2]);
  assert.equal(versions.find((q) => q.revision === 1).is_current, 0);

  const practice = await get('/api/custom/practice?batch_id=1');
  assert.equal(practice.body.questions.length, 2);
  assert.equal(practice.body.questions.filter((q) => q.questionUid === currentQ.question_uid).length, 1);
});

test('WP2 非法题目在写库前被拒绝', async () => {
  const bad = await request('/api/custom/import', {
    name: '非法题目',
    questions: [{ options: ['A. 空题'], answer: 'A', answer_index: 0 }],
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'custom_import_validation');
  assert.equal(bad.body.errors[0].code, 'empty_question');
  const batches = await get('/api/custom/batches');
  assert.equal(batches.body.batches.length, 1);
});
