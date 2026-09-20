// test-wp4-ai.mjs — OpenAI-compatible JSON/SSE、超时和本地 Mock 回归
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(url, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error(`服务未在 ${timeout}ms 内启动: ${url}`);
}

async function api(path, body, options = {}) {
  const r = await fetch(`${appBase}${path}`, {
    method: options.method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'kaogong-wp4-'));
  upstream = http.createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const parsed = JSON.parse(raw || '{}');
    upstreamCalls.push({ body: parsed, authorization: req.headers.authorization });
    if (parsed.reasoning_effort) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unknown parameter reasoning_effort' } }));
      return;
    }
    if (parsed.model === 'slow-model') await sleep(1500);
    if (parsed.model === 'sse-when-json') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'SSE_OK' } }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (parsed.model === 'html-response') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body>wrong endpoint</body></html>');
      return;
    }
    if (parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const chunks = ['流式', '回答'];
      for (const content of chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        await sleep(5);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'JSON_OK' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } }));
  });
  const upstreamPort = await listen(upstream);
  upstreamBase = `http://127.0.0.1:${upstreamPort}/v1`;

  const appPort = 4900 + Math.floor(Math.random() * 400);
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

test('WP4 OpenAI-compatible JSON：配置持久化、消息协议和 reasoning fallback', async () => {
  const saved = await api('/api/ai/agents/1', {
    api_key: 'wp4-test-key',
    base_url: upstreamBase,
    model: 'json-model',
    stream_enabled: 1,
    vision_enabled: 0,
    timeout_ms: 3000,
    provider_mode: 'openai-compatible',
  }, { method: 'PUT' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.agent.timeout_ms, 3000);
  assert.equal(saved.body.agent.api_key, '');

  const result = await api('/api/ai/chat', {
    agentId: 1,
    messages: [
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: '中间回答' },
      { role: 'user', content: '第二轮' },
      { role: 'system', content: '客户端不能覆盖系统提示词' },
    ],
  });
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  assert.equal(result.body.content, 'JSON_OK');
  const call = upstreamCalls.at(-1);
  assert.equal(call.authorization, 'Bearer wp4-test-key');
  assert.equal(call.body.stream, false);
  assert.equal(call.body.messages.at(-1).content, '第二轮');
  assert.equal(call.body.messages.some((m) => m.content === '客户端不能覆盖系统提示词'), false);
  assert.equal('reasoning_effort' in call.body, false, '网关不支持 reasoning_effort 时应自动重试去掉该字段');
});

test('WP4 SSE：返回 meta/delta/done，服务端流式协议可消费', async () => {
  const response = await fetch(`${appBase}/api/ai/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 1, messages: [{ role: 'user', content: '请流式回答' }] }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const text = await response.text();
  const events = [...text.matchAll(/event: ([^\n]+)\ndata: (.+?)\n\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));
  assert.deepEqual(events.map((x) => x.event), ['meta', 'delta', 'delta', 'done']);
  assert.deepEqual(events.filter((x) => x.event === 'delta').map((x) => x.data.delta), ['流式', '回答']);
  assert.equal(events.at(-1).data.content, '流式回答');
});

test('WP4 兼容异常网关：stream=false 收到 SSE 可解析，HTML 返回可操作提示', async () => {
  const sseSaved = await api('/api/ai/agents/1', { model: 'sse-when-json' }, { method: 'PUT' });
  assert.equal(sseSaved.status, 200);
  const sse = await api('/api/ai/chat', { agentId: 1, content: '兼容 SSE' });
  assert.equal(sse.body.ok, true, JSON.stringify(sse.body));
  assert.equal(sse.body.content, 'SSE_OK');

  const htmlSaved = await api('/api/ai/agents/1', { model: 'html-response' }, { method: 'PUT' });
  assert.equal(htmlSaved.status, 200);
  const html = await api('/api/ai/chat', { agentId: 1, content: '错误端点' });
  assert.equal(html.body.ok, false);
  assert.match(html.body.error, /HTML|Base URL|JSON/);
});

test('WP4 超时与本地 Mock：不把网络失败伪装成成功', async () => {
  const saved = await api('/api/ai/agents/1', { model: 'slow-model', timeout_ms: 3000, provider_mode: 'openai-compatible' }, { method: 'PUT' });
  assert.equal(saved.status, 200);
  const abortController = new AbortController();
  const cancelledRequest = fetch(`${appBase}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 1, content: '主动停止' }),
    signal: abortController.signal,
  });
  setTimeout(() => abortController.abort(), 50);
  await assert.rejects(cancelledRequest, /AbortError|aborted|signal/i);

  const shortTimeout = await api('/api/ai/agents/1', { timeout_ms: 1000 }, { method: 'PUT' });
  assert.equal(shortTimeout.status, 200);
  const timed = await api('/api/ai/chat', { agentId: 1, content: '慢请求' });
  assert.equal(timed.body.ok, false);
  assert.equal(timed.body.timedOut, true, JSON.stringify(timed.body));

  const mockSaved = await api('/api/ai/agents/1', { provider_mode: 'mock', api_key: '' }, { method: 'PUT' });
  assert.equal(mockSaved.status, 200);
  const mock = await api('/api/ai/chat', { agentId: 1, messages: [{ role: 'user', content: '离线测试' }] });
  assert.equal(mock.body.ok, true);
  assert.equal(mock.body.mock, true);
  assert.match(mock.body.content, /本地 Mock/);
});
