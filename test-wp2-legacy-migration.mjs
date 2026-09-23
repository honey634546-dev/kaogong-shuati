import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const port = 5700 + Math.floor(Math.random() * 200);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'kaogong-wp2-legacy-'));
const dbPath = path.join(dataDir, 'practice.db');
const legacy = new DatabaseSync(dbPath);
legacy.exec(`
  CREATE TABLE custom_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE custom_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    material TEXT DEFAULT '',
    options TEXT DEFAULT '[]',
    answer TEXT DEFAULT '',
    answer_index INTEGER DEFAULT -1,
    analysis TEXT DEFAULT '',
    images TEXT DEFAULT '[]',
    material_id TEXT DEFAULT ''
  );
  CREATE TABLE practice_attempts (
    attempt_id TEXT PRIMARY KEY,
    subject TEXT DEFAULT '',
    mode TEXT DEFAULT '',
    question_count INTEGER DEFAULT 0,
    started_at TEXT DEFAULT (datetime('now','localtime')),
    completed_at TEXT DEFAULT NULL,
    completed INTEGER DEFAULT 0
  );
`);
legacy.prepare('INSERT INTO custom_batches (name) VALUES (?)').run('旧版批次');
legacy.prepare(`
  INSERT INTO custom_questions (batch_id, prompt, options, answer, answer_index, analysis)
  VALUES (1, ?, ?, ?, ?, ?)
`).run('旧版题目', JSON.stringify(['A. 甲', 'B. 乙']), 'A', 0, '旧版解析');
legacy.prepare('INSERT INTO practice_attempts (attempt_id, subject, mode, question_count, completed) VALUES (?, ?, ?, ?, ?)')
  .run('legacy-attempt-1', '旧版科目', 'random', 3, 1);
legacy.close();

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
  child?.kill('SIGTERM');
  await rm(dataDir, { recursive: true, force: true });
});

test('WP2 旧版自定义题库回填逻辑身份且保留旧自增 id', async () => {
  const batchesResponse = await fetch(`${base}/api/custom/batches`);
  const batches = await batchesResponse.json();
  assert.equal(batchesResponse.ok, true);
  assert.equal(batches.batches.length, 1);
  assert.equal(batches.batches[0].visibility, 'private');

  const listResponse = await fetch(`${base}/api/custom/questions?batch_id=1`);
  const list = await listResponse.json();
  assert.equal(listResponse.ok, true);
  assert.equal(list.questions.length, 1);
  assert.equal(list.questions[0].id, 1);
  assert.match(list.questions[0].question_uid, /^[0-9a-f-]{36}$/);
  assert.equal(list.questions[0].revision, 1);
  assert.equal(list.questions[0].is_current, 1);
  assert.equal(list.questions[0].fingerprint.length, 64);

  const practiceResponse = await fetch(`${base}/api/custom/practice?batch_id=1`);
  const practice = await practiceResponse.json();
  assert.equal(practiceResponse.ok, true);
  assert.equal(practice.questions.length, 1);
  assert.equal(practice.questions[0].id, 'custom-1');
});

test('WP2 新导入的题库默认为公开', async () => {
  const response = await fetch(`${base}/api/custom/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '新批次', questions: [{ prompt: '新导入题目', options: ['A. 甲'], answer: 'A', answer_index: 0 }] }),
  });
  const imported = await response.json();
  assert.equal(response.status, 200, JSON.stringify(imported));
  assert.equal(imported.visibility, 'public');
  const listResponse = await fetch(`${base}/api/custom/batches`);
  const list = await listResponse.json();
  assert.equal(list.batches.find((batch) => batch.id === imported.id).visibility, 'public');
});

test('旧版练习记录表迁移后保留会话并补齐计时字段', async () => {
  const response = await fetch(`${base}/api/attempts?limit=10`);
  const history = await response.json();
  assert.equal(response.status, 200, JSON.stringify(history));
  assert.equal(history.attempts.length, 1);
  assert.equal(history.attempts[0].attemptId, 'legacy-attempt-1');
  assert.equal(history.attempts[0].subject, '旧版科目');
  assert.equal(history.attempts[0].questionCount, 3);
  assert.equal(history.attempts[0].durationMs, 0);
  assert.equal(history.attempts[0].explanationMs, 0);
});
