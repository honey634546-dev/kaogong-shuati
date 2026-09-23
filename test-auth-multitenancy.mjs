// Better Auth login/session and per-user isolation regression tests.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(new URL(import.meta.url).pathname);
const port = 6100 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
let dataDir;
let child;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/`);
      if (response.ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error('认证测试服务未启动');
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';')[0] || '';
}

async function request(pathname, { method = 'GET', body, cookie = '' } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      origin: base,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch {}
  return { response, payload };
}

async function signUp(name, email) {
  const result = await request('/api/auth/sign-up/email', {
    method: 'POST',
    body: { name, email, password: 'password123' },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const cookie = cookieFrom(result.response);
  assert.match(cookie, /^better-auth\.session_token=/);
  return { cookie, user: result.payload.user };
}

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'kaogong-auth-'));
  child = spawn(process.execPath, ['server.mjs', String(port)], {
    cwd: root,
    env: { ...process.env, APP_DATA_DIR: dataDir, BETTER_AUTH_SECRET: 'auth-test-secret-123456789012345678901234567890' },
    stdio: 'ignore',
  });
  await waitForServer();
});

after(async () => {
  child?.kill('SIGTERM');
  await rm(dataDir, { recursive: true, force: true });
});

test('未登录不能访问业务 API，注册后会话可恢复', async () => {
  const unauthenticated = await request('/api/custom/batches');
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.payload.code, 'auth_required');

  const account = await signUp('测试用户', `auth-${Date.now()}@example.com`);
  const session = await request('/api/auth/get-session', { cookie: account.cookie });
  assert.equal(session.response.status, 200);
  assert.equal(session.payload.user.id, account.user.id);
});

test('题库、AI 配置和随题会话按账号隔离', async () => {
  const userA = await signUp('用户 A', `a-${Date.now()}@example.com`);
  const userB = await signUp('用户 B', `b-${Date.now()}@example.com`);

  const importedA = await request('/api/custom/import', {
    method: 'POST', cookie: userA.cookie,
    body: { name: 'A 的题库', questions: [{ prompt: 'A 的题', options: ['A. 对'], answer: 'A', answer_index: 0 }] },
  });
  assert.equal(importedA.response.status, 200, JSON.stringify(importedA.payload));
  assert.equal(importedA.payload.visibility, 'public');
  const publicBatchId = importedA.payload.id;

  const batchesB = await request('/api/custom/batches', { cookie: userB.cookie });
  assert.equal(batchesB.payload.batches.length, 1);
  assert.equal(batchesB.payload.batches[0].id, publicBatchId);
  assert.equal(batchesB.payload.batches[0].visibility, 'public');
  assert.equal(batchesB.payload.batches[0].is_owner, 0);
  const publicQuestionsB = await request(`/api/custom/questions?batch_id=${publicBatchId}`, { cookie: userB.cookie });
  assert.equal(publicQuestionsB.response.status, 200);
  assert.equal(publicQuestionsB.payload.questions[0].prompt, 'A 的题');
  const publicPracticeB = await request(`/api/custom/practice?batch_id=${publicBatchId}`, { cookie: userB.cookie });
  assert.equal(publicPracticeB.response.status, 200);
  assert.equal(publicPracticeB.payload.questions.length, 1);
  const publicQuestionB = await request(`/api/question?id=custom-${publicQuestionsB.payload.questions[0].id}`, { cookie: userB.cookie });
  assert.equal(publicQuestionB.response.status, 200);
  const publicCheckB = await request('/api/custom/check', {
    method: 'POST', cookie: userB.cookie,
    body: { questionId: `custom-${publicQuestionsB.payload.questions[0].id}`, selected: [0], batchId: publicBatchId },
  });
  assert.equal(publicCheckB.response.status, 200, JSON.stringify(publicCheckB.payload));
  assert.equal(publicCheckB.payload.ok, true);
  const attemptStartedAtMs = Date.now() - 3000;
  const attemptRecordA = await request('/api/records', {
    method: 'POST', cookie: userA.cookie,
    body: {
      questionId: `custom-${publicQuestionsB.payload.questions[0].id}`, subject: '自定义', chapter: 'A 的题库',
      selected: [0], costMs: 1200, explanationMs: 400, attemptId: 'attempt-private-to-a',
      attemptMode: 'custom', attemptQuestionCount: 1, startedAtMs: attemptStartedAtMs,
      submissionKey: 'attempt-private-to-a:final:0:custom-1',
    },
  });
  assert.equal(attemptRecordA.response.status, 200, JSON.stringify(attemptRecordA.payload));
  const attemptCompleteA = await request('/api/attempts/complete', {
    method: 'POST', cookie: userA.cookie,
    body: { attemptId: 'attempt-private-to-a', subject: '自定义', mode: 'custom', questionCount: 1, startedAtMs: attemptStartedAtMs, durationMs: 1900, explanationMs: 400 },
  });
  assert.equal(attemptCompleteA.response.status, 200, JSON.stringify(attemptCompleteA.payload));
  const historyA = await request('/api/attempts', { cookie: userA.cookie });
  assert.equal(historyA.payload.attempts.length, 1);
  const historyB = await request('/api/attempts', { cookie: userB.cookie });
  assert.equal(historyB.payload.attempts.length, 0);
  const historyDetailB = await request('/api/attempts/attempt-private-to-a', { cookie: userB.cookie });
  assert.equal(historyDetailB.response.status, 404);
  const publicEditB = await request('/api/custom/batch', {
    method: 'PUT', cookie: userB.cookie,
    body: { id: publicBatchId, visibility: 'private' },
  });
  assert.equal(publicEditB.response.status, 404);

  const importedPrivateA = await request('/api/custom/import', {
    method: 'POST', cookie: userA.cookie,
    body: { name: 'A 的私有題庫', visibility: 'private', questions: [{ prompt: '私有题目', options: ['A. 不公开'], answer: 'A', answer_index: 0 }] },
  });
  assert.equal(importedPrivateA.response.status, 200, JSON.stringify(importedPrivateA.payload));
  assert.equal(importedPrivateA.payload.visibility, 'private');
  const batchesBAfterPrivate = await request('/api/custom/batches', { cookie: userB.cookie });
  assert.deepEqual(batchesBAfterPrivate.payload.batches.map((batch) => batch.id), [publicBatchId]);
  const privateQuestionsB = await request(`/api/custom/questions?batch_id=${importedPrivateA.payload.id}`, { cookie: userB.cookie });
  assert.equal(privateQuestionsB.response.status, 404);
  const privatePracticeB = await request(`/api/custom/practice?batch_id=${importedPrivateA.payload.id}`, { cookie: userB.cookie });
  assert.equal(privatePracticeB.response.status, 404);
  const privateQuestionsA = await request(`/api/custom/questions?batch_id=${importedPrivateA.payload.id}`, { cookie: userA.cookie });
  assert.equal(privateQuestionsA.payload.questions.length, 1);
  const privateQuestionB = await request(`/api/question?id=custom-${privateQuestionsA.payload.questions[0].id}`, { cookie: userB.cookie });
  assert.equal(privateQuestionB.response.status, 404);

  const makePrivateA = await request('/api/custom/batch', {
    method: 'PUT', cookie: userA.cookie,
    body: { id: publicBatchId, visibility: 'private' },
  });
  assert.equal(makePrivateA.response.status, 200);
  const batchesBAfterVisibilityChange = await request('/api/custom/batches', { cookie: userB.cookie });
  assert.equal(batchesBAfterVisibilityChange.payload.batches.length, 0);
  const publicQuestionsAfterPrivate = await request(`/api/custom/questions?batch_id=${publicBatchId}`, { cookie: userB.cookie });
  assert.equal(publicQuestionsAfterPrivate.response.status, 404);
  const restorePublicA = await request('/api/custom/batch', {
    method: 'PUT', cookie: userA.cookie,
    body: { id: publicBatchId, visibility: 'public' },
  });
  assert.equal(restorePublicA.response.status, 200);

  const batchesA = await request('/api/custom/batches', { cookie: userA.cookie });
  assert.equal(batchesA.payload.batches.find((batch) => batch.id === publicBatchId).name, 'A 的题库');

  const savedA = await request('/api/ai/agents/1', {
    method: 'PUT', cookie: userA.cookie,
    body: { key_storage_mode: 'server', api_key: 'account-a-secret', base_url: 'https://gateway.example/v1' },
  });
  assert.equal(savedA.response.status, 200, JSON.stringify(savedA.payload));
  assert.equal(savedA.payload.agent.api_key, '');

  const agentsB = await request('/api/ai/agents', { cookie: userB.cookie });
  assert.equal(agentsB.response.status, 200);
  assert.ok(agentsB.payload.length > 0);
  assert.ok(agentsB.payload.every((agent) => agent.key_storage_mode === 'server'));
  assert.ok(agentsB.payload.every((agent) => !agent.api_key));

  const agentB = await request('/api/ai/agents/1', { cookie: userB.cookie });
  assert.equal(agentB.response.status, 200);
  assert.equal(agentB.payload.key_storage_mode, 'server');
  assert.equal(agentB.payload.api_key, '');
  assert.equal(agentB.payload.api_key_masked || '', '');

  const agentAAgain = await request('/api/ai/agents/1', { cookie: userA.cookie });
  assert.equal(agentAAgain.payload.key_storage_mode, 'server');
  assert.equal(agentAAgain.payload.api_key, '');
  assert.equal(agentAAgain.payload.api_key_masked, 'acco…cret');

  const savedB = await request('/api/ai/agents/1', {
    method: 'PUT', cookie: userB.cookie,
    body: { key_storage_mode: 'server', api_key: 'b-key-unique-007', base_url: 'https://other.example/v1' },
  });
  assert.equal(savedB.response.status, 200, JSON.stringify(savedB.payload));
  assert.equal(savedB.payload.agent.api_key, '');
  const agentAAfterBSave = await request('/api/ai/agents/1', { cookie: userA.cookie });
  assert.equal(agentAAfterBSave.payload.api_key_masked, 'acco…cret');
  const agentBAfterSave = await request('/api/ai/agents/1', { cookie: userB.cookie });
  assert.equal(agentBAfterSave.payload.api_key_masked, 'b-ke…-007');
  assert.equal(agentBAfterSave.payload.base_url, 'https://other.example/v1');

  const conversationA = await request('/api/ai/conversations', {
    method: 'POST', cookie: userA.cookie,
    body: { questionId: 'custom-a', questionUid: 'custom-a', questionRevision: 1, questionSnapshot: { prompt: 'A 的题' } },
  });
  assert.equal(conversationA.response.status, 200, JSON.stringify(conversationA.payload));
  const conversationId = conversationA.payload.conversation.conversationId;
  const conversationB = await request(`/api/ai/conversations/${conversationId}`, { cookie: userB.cookie });
  assert.equal(conversationB.response.status, 404);

  const db = new DatabaseSync(path.join(dataDir, 'ai-config.db'), { readOnly: true });
  const rowA = db.prepare('SELECT api_key_encrypted FROM user_ai_agents WHERE user_id = ? AND agent_id = 1').get(userA.user.id);
  const rowB = db.prepare('SELECT api_key_encrypted FROM user_ai_agents WHERE user_id = ? AND agent_id = 1').get(userB.user.id);
  assert.ok(rowA?.api_key_encrypted);
  assert.ok(rowB?.api_key_encrypted);
  assert.equal(rowA.api_key_encrypted.includes('account-a-secret'), false);
  assert.equal(rowB.api_key_encrypted.includes('b-key-unique-007'), false);
  assert.notEqual(rowA.api_key_encrypted, rowB.api_key_encrypted);
  db.close();
});
