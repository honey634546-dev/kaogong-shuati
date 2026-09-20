import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const port = 5900 + Math.floor(Math.random() * 150);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'kaogong-wp3-'));
const base = `http://127.0.0.1:${port}`;
let child;

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

async function post(url, body) {
  const response = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  child = spawn(process.execPath, ['server.mjs', String(port)], {
    cwd: ROOT,
    env: { ...process.env, APP_DATA_DIR: dataDir, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  await waitForServer();
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await rm(dataDir, { recursive: true, force: true });
});

test('WP3 服务端判分、提交幂等、作答快照和版本隔离', async () => {
  const imported = await post('/api/custom/import', {
    name: 'WP3 作答快照题库',
    questions: [{
      external_id: 'wp3-q-1',
      prompt: '旧版题面',
      options: ['A. 错', 'B. 对'],
      answer: 'B',
      answer_index: 1,
    }],
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const questionId = 'custom-1';

  // 故意把 correct 传成 true；服务端必须依据题库答案判为 false。
  const first = await post('/api/records', {
    questionId,
    subject: '自定义',
    chapter: 'WP3 作答快照题库',
    type: 'custom',
    selected: [0],
    correct: true,
    attemptId: 'wp3-attempt-1',
    attemptMode: 'custom',
    attemptQuestionCount: 1,
    submissionKey: 'wp3-attempt-1:final:0:custom-1',
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.authoritative, true);
  assert.equal(first.body.correct, false);
  assert.equal(first.body.idempotent, false);

  const repeated = await post('/api/records', {
    questionId,
    subject: '自定义',
    chapter: 'WP3 作答快照题库',
    type: 'custom',
    selected: [0],
    correct: true,
    attemptId: 'wp3-attempt-1',
    submissionKey: 'wp3-attempt-1:final:0:custom-1',
  });
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.body.id, first.body.id);
  assert.equal(repeated.body.idempotent, true);

  const conflict = await post('/api/records', {
    questionId,
    selected: [1],
    submissionKey: 'wp3-attempt-1:final:0:custom-1',
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'submission_key_conflict');

  const revised = await post('/api/custom/import', {
    batch_id: imported.body.id,
    conflict_mode: 'new_revision',
    questions: [{
      external_id: 'wp3-q-1',
      prompt: '新版题面',
      options: ['A. 对', 'B. 错'],
      answer: 'A',
      answer_index: 0,
    }],
  });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal(revised.body.revisions, 1);
  const currentPractice = await (await fetch(`${base}/api/custom/practice?batch_id=${imported.body.id}`)).json();
  const currentQuestionId = currentPractice.questions[0].id;
  assert.notEqual(currentQuestionId, questionId);

  const second = await post('/api/records', {
    questionId: currentQuestionId,
    subject: '自定义',
    chapter: 'WP3 作答快照题库',
    type: 'custom',
    selected: [0],
    correct: false,
    attemptId: 'wp3-attempt-2',
    attemptMode: 'custom',
    attemptQuestionCount: 1,
    submissionKey: 'wp3-attempt-2:final:0:custom-1',
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.correct, true);
  assert.equal(second.body.revision, 2);

  const done = await post('/api/attempts/complete', { attemptId: 'wp3-attempt-1' });
  assert.equal(done.status, 200);
  const statsResponse = await fetch(`${base}/api/records/stats`);
  const stats = await statsResponse.json();
  assert.equal(stats.total, 2);
  assert.equal(stats.correct, 1);
  assert.equal(stats.wrong, 1);

  await new Promise((resolve) => {
    if (child.exitCode != null) resolve();
    else { child.once('exit', resolve); child.kill('SIGTERM'); }
  });
  const db = new DatabaseSync(path.join(dataDir, 'practice.db'), { readOnly: true });
  const rows = db.prepare('SELECT submission_key, attempt_id, question_uid, question_revision, question_snapshot, answer_snapshot FROM practice_records ORDER BY id').all();
  const attempts = db.prepare('SELECT attempt_id, completed FROM practice_attempts ORDER BY attempt_id').all().map((row) => ({ attempt_id: row.attempt_id, completed: row.completed }));
  db.close();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].question_revision, 1);
  assert.match(rows[0].question_snapshot, /旧版题面/);
  assert.match(rows[0].answer_snapshot, /"ok":false/);
  assert.equal(rows[1].question_revision, 2);
  assert.match(rows[1].question_snapshot, /新版题面/);
  assert.deepEqual(attempts, [
    { attempt_id: 'wp3-attempt-1', completed: 1 },
    { attempt_id: 'wp3-attempt-2', completed: 0 },
  ]);
});
