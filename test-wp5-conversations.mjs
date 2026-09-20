// WP5 随题 AI 会话：题目版本隔离、跨请求历史、SSE 持久化和本地 IndexedDB 路由。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

let app;
let upstream;
let appBase;
let upstreamBase;
let dataDir;
const upstreamCalls = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(url, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error(`服务未在 ${timeout}ms 内启动: ${url}`);
}

async function api(path, body, options = {}) {
  const response = await fetch(`${appBase}${path}`, {
    method: options.method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'kaogong-wp5-'));
  upstream = http.createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const parsed = JSON.parse(raw || '{}');
    upstreamCalls.push(parsed);
    if (parsed.model === 'slow-model') await sleep(1500);
    const last = [...(parsed.messages || [])].reverse().find((m) => m.role === 'user');
    const answer = `上游回答：${String(last?.content || '').slice(0, 50)}`;
    if (parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '流式回答' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] }));
  });
  const upstreamPort = await listen(upstream);
  upstreamBase = `http://127.0.0.1:${upstreamPort}/v1`;

  const appPort = 5200 + Math.floor(Math.random() * 300);
  appBase = `http://127.0.0.1:${appPort}`;
  app = spawn(process.execPath, ['server.mjs', String(appPort)], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, APP_DATA_DIR: dataDir, AI_CONFIG_DB: join(dataDir, 'ai-config.db'), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  await waitFor(`${appBase}/`);
});

after(async () => {
  app?.kill();
  await new Promise((resolve) => upstream?.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
});

test('WP5 服务端：会话按题目版本幂等隔离，多轮消息持久化并恢复', async () => {
  const saved = await api('/api/ai/agents/1', {
    api_key: 'wp5-key', base_url: upstreamBase, model: 'tutor-model',
    provider_mode: 'openai-compatible', stream_enabled: 1, timeout_ms: 3000,
  }, { method: 'PUT' });
  assert.equal(saved.status, 200);

  const identity = {
    questionId: 'custom-42', questionUid: 'logic-42', questionRevision: 1,
    subject: '自定义', title: '比例题',
    questionSnapshot: { prompt: '比例题', options: ['A', 'B'], selected: 'B' },
  };
  const first = await api('/api/ai/conversations', identity);
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.created, true);
  const conversationId = first.body.conversation.conversationId;

  const repeat = await api('/api/ai/conversations', identity);
  assert.equal(repeat.body.created, false);
  assert.equal(repeat.body.conversation.conversationId, conversationId);

  const firstMessage = await api(`/api/ai/conversations/${conversationId}/messages`, { agentId: 1, content: '为什么选 B？' });
  assert.equal(firstMessage.body.ok, true, JSON.stringify(firstMessage.body));
  assert.equal(firstMessage.body.messages.length, 2);
  assert.equal(firstMessage.body.messages[0].role, 'user');
  assert.equal(firstMessage.body.messages[1].role, 'assistant');

  const secondMessage = await api(`/api/ai/conversations/${conversationId}/messages`, { agentId: 1, content: '换一种更快的方法。' });
  assert.equal(secondMessage.body.ok, true, JSON.stringify(secondMessage.body));
  assert.equal(secondMessage.body.messages.length, 4);
  const modelCall = upstreamCalls.at(-1);
  assert.match(modelCall.messages.find((m) => m.role === 'user')?.content || '', /当前题目上下文/);
  assert.ok(modelCall.messages.filter((m) => m.role === 'system').length >= 1);
  assert.equal(modelCall.messages.at(-2).content, '上游回答：为什么选 B？');
  assert.equal(modelCall.messages.at(-1).content, '换一种更快的方法。');

  const restored = await api('/api/ai/conversations?questionId=custom-42&questionUid=logic-42&questionRevision=1', null, { method: 'GET' });
  assert.equal(restored.body.conversation.conversationId, conversationId);
  assert.equal(restored.body.messages.length, 4);

  const newRevision = await api('/api/ai/conversations', { ...identity, questionRevision: 2, questionSnapshot: { prompt: '修订后的比例题' } });
  assert.equal(newRevision.body.created, true);
  assert.notEqual(newRevision.body.conversation.conversationId, conversationId);
  const isolated = await api('/api/ai/conversations?questionId=custom-42&questionUid=logic-42&questionRevision=2', null, { method: 'GET' });
  assert.deepEqual(isolated.body.messages, []);
});

test('WP5 服务端 SSE：随题流式回答完成后写入消息历史', async () => {
  const created = await api('/api/ai/conversations', {
    questionId: 'builtin-77', questionUid: 'builtin-77', questionRevision: 1,
    subject: '公务员·行测', questionSnapshot: { prompt: '一道题' },
  });
  const id = created.body.conversation.conversationId;
  const response = await fetch(`${appBase}/api/ai/conversations/${id}/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 1, content: '请流式讲解' }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const events = [...text.matchAll(/event: ([^\n]+)\ndata: (.+?)\n\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));
  assert.deepEqual(events.map((e) => e.event), ['meta', 'delta', 'done']);
  assert.equal(events.at(-1).data.message.role, 'assistant');
  const restored = await api(`/api/ai/conversations?questionId=builtin-77&questionUid=builtin-77&questionRevision=1`, null, { method: 'GET' });
  assert.equal(restored.body.messages.length, 2);
  assert.equal(restored.body.messages[1].content, '流式回答');
});

test('WP5 服务端停止：客户端取消后消息标记为 cancelled，不伪造 assistant', async () => {
  const saved = await api('/api/ai/agents/1', { model: 'slow-model', timeout_ms: 3000 }, { method: 'PUT' });
  assert.equal(saved.status, 200);
  const created = await api('/api/ai/conversations', {
    questionId: 'builtin-slow', questionUid: 'builtin-slow', questionRevision: 1,
    questionSnapshot: { prompt: '慢题' },
  });
  const id = created.body.conversation.conversationId;
  const controller = new AbortController();
  const request = fetch(`${appBase}/api/ai/conversations/${id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 1, content: '请停止这次回答' }), signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(request, /AbortError|aborted|signal/i);
  await sleep(120);
  const restored = await api('/api/ai/conversations?questionId=builtin-slow&questionUid=builtin-slow&questionRevision=1', null, { method: 'GET' });
  assert.equal(restored.body.messages.length, 1);
  assert.equal(restored.body.messages[0].status, 'cancelled');
});

test('WP5 本地路由：IndexedDB 适配器接口可保存会话并按版本隔离', async () => {
  const rows = new Map();
  const keyOf = (kind, row) => kind === 'ai_conversations' ? row.conversation_id : row.id;
  const store = {
    async getAll(kind) { return [...rows.values()].filter((r) => r.kind === kind).map((r) => ({ ...r.row })); },
    async put(kind, row) { rows.set(`${kind}:${keyOf(kind, row)}`, { kind, row: { ...row } }); },
  };
  const { createLocalHandler } = await import('./public/local-handler.js');
  const handler = createLocalHandler({
    query: {}, records: {}, store,
    ai: { chat: async ({ messages }) => ({ ok: true, content: `本地回答：${messages.at(-1).content}`, model: 'local-mock', mock: true }) },
  });
  const identity = { questionId: 'local-1', questionUid: 'local-uid', questionRevision: 1, questionSnapshot: { prompt: '本地题' } };
  const made = await handler('/api/ai/conversations', { method: 'POST', body: JSON.stringify(identity) });
  const id = made.conversation.conversationId;
  const reply = await handler(`/api/ai/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ content: '本地怎么做？' }) });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.messages.length, 2);
  const history = await handler('/api/ai/conversations?questionId=local-1&questionUid=local-uid&questionRevision=1', { method: 'GET' });
  assert.equal(history.messages.length, 2);
  const other = await handler('/api/ai/conversations', { method: 'POST', body: JSON.stringify({ ...identity, questionRevision: 2 }) });
  assert.notEqual(other.conversation.conversationId, id);
  assert.deepEqual(other.messages, []);
});

// 保留 DatabaseSync 引用在测试文件中，确保当前 Node 版本能打开服务端新表。
test('WP5 schema：服务端会话表可查询', () => {
  const db = new DatabaseSync(join(dataDir, 'practice.db'), { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ai_conversations','ai_messages') ORDER BY name").all().map((r) => r.name);
  db.close();
  assert.deepEqual(tables, ['ai_conversations', 'ai_messages']);
});
