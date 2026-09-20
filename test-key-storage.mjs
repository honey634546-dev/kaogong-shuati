// Key storage modes: browser memory is the safe default, server persistence is explicit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';

let app;
let base;
let dataDir;

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
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers: body == null ? undefined : { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'kaogong-key-storage-'));
  const port = 5700 + Math.floor(Math.random() * 200);
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server.mjs', String(port)], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, APP_DATA_DIR: dataDir, AI_CONFIG_DB: join(dataDir, 'ai-config.db'), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  await waitFor(`${base}/`);
});

after(async () => {
  app?.kill();
  await rm(dataDir, { recursive: true, force: true });
});

test('browser mode is the default and never persists a submitted key', async () => {
  const initial = await api('/api/ai/agents');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.find((a) => a.id === 1).key_storage_mode, 'browser');

  const saved = await api('/api/ai/agents/1', {
    key_storage_mode: 'browser',
    api_key: 'browser-only-test-secret',
    base_url: 'https://example.invalid/v1',
    model: 'browser-model',
  }, { method: 'PUT' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.agent.key_storage_mode, 'browser');
  assert.equal(saved.body.agent.api_key, '');

  const db = new DatabaseSync(join(dataDir, 'ai-config.db'), { readOnly: true });
  const row = db.prepare('SELECT api_key, key_storage_mode FROM ai_agents WHERE id = 1').get();
  db.close();
  assert.equal(row.key_storage_mode, 'browser');
  assert.equal(row.api_key, '');
});

test('server mode is explicit and switching back wipes the stored key', async () => {
  const saved = await api('/api/ai/agents/1', {
    key_storage_mode: 'server',
    api_key: 'server-mode-test-secret',
  }, { method: 'PUT' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.agent.key_storage_mode, 'server');
  assert.equal(saved.body.agent.api_key, '');
  assert.equal(saved.body.agent.api_key_masked, 'serv…cret');

  let db = new DatabaseSync(join(dataDir, 'ai-config.db'), { readOnly: true });
  let row = db.prepare('SELECT api_key, key_storage_mode FROM ai_agents WHERE id = 1').get();
  db.close();
  assert.equal(row.key_storage_mode, 'server');
  assert.equal(row.api_key, 'server-mode-test-secret');

  const browser = await api('/api/ai/agents/1', { key_storage_mode: 'browser' }, { method: 'PUT' });
  assert.equal(browser.status, 200);
  assert.equal(browser.body.agent.key_storage_mode, 'browser');
  db = new DatabaseSync(join(dataDir, 'ai-config.db'), { readOnly: true });
  row = db.prepare('SELECT api_key, key_storage_mode FROM ai_agents WHERE id = 1').get();
  db.close();
  assert.equal(row.key_storage_mode, 'browser');
  assert.equal(row.api_key, '');
});

test('browser-mode AI routes return a client-call descriptor instead of relaying a key', async () => {
  const response = await api('/api/ai/chat', {
    agentId: 1,
    content: '浏览器直连测试',
  }, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(response.body.browserOnly, true);
  assert.equal(response.body.clientCall.kind, 'chat');
  assert.equal(response.body.clientCall.agentId, 1);
});

test('browser client keeps the key out of server requests and persistent storage', async () => {
  const source = await readFile(new URL('./public/ai-browser.js', import.meta.url), 'utf8');
  const providerRequests = [];
  const agent = {
    id: 1,
    name: '测试 AI',
    role: 'test-agent',
    key_storage_mode: 'browser',
    api_key: '',
    base_url: 'https://gateway.example/v1',
    model: 'test-model',
    provider_mode: 'openai-compatible',
    system_prompt: '你是测试助手',
    skill_text: '',
    stream_enabled: 1,
    vision_enabled: 0,
    timeout_ms: 10000,
  };
  const response = (body, status = 200, contentType = 'application/json') => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  });
  const context = {
    AbortController,
    Headers,
    Response,
    TextDecoder,
    Uint8Array,
    clearTimeout,
    console,
    fetch: async (url, options = {}) => {
      if (String(url) === '/api/ai/agents' || String(url).startsWith('/api/ai/agents?_=')) return response([agent]);
      if (String(url).startsWith('/api/ai/agents/1?')) return response(agent);
      if (String(url) === 'https://gateway.example/v1/chat/completions') {
        providerRequests.push(options);
        return response({ choices: [{ message: { content: '浏览器直连成功' } }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    localStorage: new Proxy({}, { get() { throw new Error('localStorage must not be read'); } }),
    sessionStorage: new Proxy({}, { get() { throw new Error('sessionStorage must not be read'); } }),
    indexedDB: new Proxy({}, { get() { throw new Error('indexedDB must not be read'); } }),
    window: { addEventListener() {} },
    setTimeout,
  };
  vm.runInNewContext(source, context, { filename: 'public/ai-browser.js' });
  const browser = context.window.__AI_BROWSER_KEYS__;
  const serverRequests = [];
  const rawFetch = async (path, options = {}) => {
    serverRequests.push({ path, options });
    return { agent: { ...agent, api_key: '' } };
  };

  await browser.handle('/api/ai/agents/1', {
    method: 'PUT',
    body: JSON.stringify({ key_storage_mode: 'browser', api_key: 'browser-memory-secret', model: 'test-model' }),
  }, rawFetch);
  assert.equal(JSON.parse(serverRequests[0].options.body).api_key, undefined);
  assert.equal(browser.keyFor(1), 'browser-memory-secret');

  const chat = await browser.handle('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ agentId: 1, content: '你好' }),
  }, rawFetch);
  assert.equal(chat.content, '浏览器直连成功');
  assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].headers.Authorization, 'Bearer browser-memory-secret');
  assert.equal(JSON.stringify(serverRequests), JSON.stringify(serverRequests).replace('browser-memory-secret', ''));

  const roleChat = await browser.handle('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ role: 'test-agent', content: '按角色查找也应成功' }),
  }, rawFetch);
  assert.equal(roleChat.content, '浏览器直连成功');
  assert.equal(providerRequests.length, 2);

  browser.clear(1);
  assert.equal(browser.has(1), false);
  await browser.handle('/api/ai/agents/1', {
    method: 'PUT',
    body: JSON.stringify({ key_storage_mode: 'browser', api_key: 'account-a-memory-secret' }),
  }, rawFetch);
  assert.equal(browser.has(1), true);
  browser.clearAll();
  assert.equal(browser.has(1), false);
});
