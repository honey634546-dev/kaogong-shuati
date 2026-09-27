// Isolated integration checks: fixture providers only, no production data or paid model calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import vm from 'node:vm';

const root = dirname(fileURLToPath(import.meta.url));
const fixtureReview = {
  status: 'method', methodName: '百分数转分数', recognition: '12.5% 等于八分之一。',
  steps: ['把 12.5% 化为 1/8。', '240 ÷ 8 = 30，对应选项 B。'],
  whyCorrect: '12.5/100 = 1/8，240 × 1/8 = 30，等价变形保持答案不变。',
  applicability: '百分数能精确化为熟悉分数且整数便于整除时使用。',
  caution: '此处是精确等价；百分数不等于熟悉分数时不能直接套用。',
  diagnosis: '仅凭用时无法判断慢因；用户自述逐位乘法可能增加步骤。',
  drillMethod: 'percent_fraction',
};
const question = { prompt: '快照原题：240 的 12.5% 是多少？', options: ['A. 20', 'B. 30', 'C. 40', 'D. 50'], answer: 'B', answerIndex: 1, category: '资料分析', analysis: '240 × 0.125 = 30。' };
let app, upstream, dataDir, base, upstreamBase, userA, userB, questionId, questionUid;
let providerContent = JSON.stringify(fixtureReview);
const providerCalls = [];

async function listen(server) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
}
async function request(path, body, { cookie = userA?.cookie || '', method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), response };
}
async function signup(name) {
  const r = await request('/api/auth/sign-up/email', { name, email: `${name}-${Date.now()}@example.com`, password: 'speed-review-test-password' }, { cookie: '' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { cookie: r.response.headers.get('set-cookie').split(';')[0], id: r.body.user.id };
}
async function configure(fields = {}, account = userA) {
  const r = await request('/api/ai/agents/1', {
    key_storage_mode: 'server', api_key: 'fixture-test-key', base_url: upstreamBase, model: 'fixture-model',
    provider_mode: 'openai-compatible', reasoning_effort: 'off', system_prompt: '必须硬套技巧的旧提示词', skill: '旧技能不应注入',
    ...fields,
  }, { method: 'PUT', cookie: account.cookie });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
function reviewInput(extra = {}) {
  return {
    attemptId: 'speed-attempt-a', questionId, questionUid, questionRevision: 1,
    questionData: { ...question, prompt: '客户端伪造题面' }, selected: [3], correct: false,
    timing: { solveMs: 999, referenceSeconds: 60 }, userReason: '计算步骤多', userApproach: '逐位计算 240 × 0.125', ...extra,
  };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'exam-speed-review-'));
  upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    providerCalls.push(JSON.parse(raw || '{}'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: providerContent } }] }));
  });
  upstreamBase = `http://127.0.0.1:${await listen(upstream)}/v1`;
  const portProbe = http.createServer();
  const port = await listen(portProbe);
  await new Promise((resolve) => portProbe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server.mjs', String(port)], {
    cwd: root, env: { ...process.env, AUTH_DISABLED: '0', AI_MOCK: '0', APP_DATA_DIR: dataDir, AI_CONFIG_DB: join(dataDir, 'ai-config.db'), BETTER_AUTH_SECRET: 'speed-review-auth-test-secret-12345678901234567890', HOST: '127.0.0.1' }, stdio: 'ignore',
  });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, 'isolated test server must start');
  userA = await signup('speed-a');
  userB = await signup('speed-b');
  const imported = await request('/api/custom/import', { name: '提速测试私有题库', visibility: 'private', questions: [question] });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const list = await request(`/api/custom/questions?batch_id=${imported.body.id}`);
  const stored = list.body.questions[0];
  const practice = await request(`/api/custom/practice?batch_id=${imported.body.id}`);
  assert.equal(practice.body.questions[0].category, '资料分析');
  questionId = `custom-${stored.id}`;
  questionUid = stored.question_uid;
  const record = await request('/api/records', { questionId, subject: '资料分析', chapter: '百分数', selected: [1], correct: false, costMs: 154000, explanationMs: 8000, attemptId: 'speed-attempt-a', attemptQuestionCount: 1, submissionKey: 'speed-attempt-a:final:0', startedAtMs: Date.now() - 170000 });
  assert.equal(record.status, 200, JSON.stringify(record.body));
  const completed = await request('/api/attempts/complete', { attemptId: 'speed-attempt-a', subject: '资料分析', questionCount: 1, durationMs: 162000 });
  assert.equal(completed.status, 200);
  // Edit only the disposable test database after the attempt. Its saved snapshot must win.
  const fixtureDb = new DatabaseSync(join(dataDir, 'practice.db'));
  fixtureDb.prepare('UPDATE custom_questions SET prompt = ? WHERE id = ?').run('修改后的当前题面', stored.id);
  fixtureDb.close();
  await configure();
});

after(async () => {
  if (app && app.exitCode == null) { app.kill(); await new Promise((resolve) => app.once('exit', resolve)); }
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('uses authenticated historical snapshot, actual solve time and independent review requests', async () => {
  const history = await request('/api/attempts/speed-attempt-a');
  assert.equal(history.body.records[0].assisted, null, 'old or unspecified assistance evidence must stay unknown');
  assert.equal(history.body.records[0].question.category, '资料分析');
  const result = await request('/api/ai/speed-review', reviewInput());
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.review, fixtureReview);
  const sent = JSON.stringify(providerCalls.at(-1).messages);
  assert.match(sent, /快照原题/);
  assert.doesNotMatch(sent, /客户端伪造题面|修改后的当前题面|硬套技巧的旧提示词|旧技能不应注入/);
  assert.match(sent, /154000|154/);
  assert.match(sent, /逐位计算/);
  assert.ok(providerCalls.at(-1).max_tokens >= 8192);
  assert.equal(providerCalls.at(-1).reasoning_effort, 'low');
  assert.equal(providerCalls.at(-1).temperature, 0.2);
  const count = providerCalls.length;
  const again = await request('/api/ai/speed-review', reviewInput({ userApproach: '改用分数但犹豫' }));
  assert.equal(again.body.review.status, 'method');
  assert.equal(providerCalls.length, count + 1, 'same answer must not reuse generic explanation cache');
  assert.match(JSON.stringify(providerCalls.at(-1).messages), /改用分数但犹豫/);
  const db = new DatabaseSync(join(dataDir, 'practice.db'), { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_explains').get().n, 0);
  db.close();
});

test('rejects another account, stale attempt and mismatched version without client fallback', async () => {
  const before = providerCalls.length;
  assert.equal((await request('/api/ai/speed-review', reviewInput(), { cookie: '' })).status, 401);
  const other = await request('/api/ai/speed-review', reviewInput(), { cookie: userB.cookie });
  assert.equal(other.status, 404);
  assert.doesNotMatch(JSON.stringify(other.body), /快照原题/);
  assert.equal((await request('/api/ai/speed-review', reviewInput({ attemptId: 'missing' }))).status, 404);
  assert.equal((await request('/api/ai/speed-review', reviewInput({ questionRevision: 9 }))).status, 404);
  assert.equal((await request('/api/ai/speed-review', reviewInput({ questionUid: 'wrong-identity' }))).status, 404);
  assert.equal(providerCalls.length, before);
});

test('invalid provider schema is refused; unreadable image and missing snapshot never trigger a model call', async () => {
  providerContent = '{"status":"method","steps":["猜一个答案"]}';
  const failed = await request('/api/ai/speed-review', reviewInput());
  assert.equal(failed.body.review, null);
  assert.match(failed.body.notice, /格式校验失败/);
  providerContent = JSON.stringify(fixtureReview);
  const before = providerCalls.length;
  const missing = await request('/api/ai/speed-review', { questionId: 'no-snapshot' });
  assert.equal(missing.body.review.status, 'insufficient');
  const image = await request('/api/ai/speed-review', { questionId: 'image', questionData: { ...question, contentHtml: '<img src="https://example.invalid/chart.png">' } });
  assert.equal(image.body.review.status, 'insufficient');
  for (const invalidAnswer of [{ answer: '', answerIndex: -1 }, { answer: 'Z', answerIndex: 26 }, { answer: 'B', answerIndex: 1, answerStatus: 'disputed' }]) {
    const missingAnswer = await request('/api/ai/speed-review', { questionId: 'no-answer', questionData: { ...question, ...invalidAnswer } });
    assert.equal(missingAnswer.body.review.status, 'insufficient');
  }
  assert.equal(providerCalls.length, before);
});

test('repeated questions require the exact submission and preserve assisted evidence in history', async () => {
  for (const [index, assisted, costMs] of [[0, true, 45000], [1, false, 117000]]) {
    const saved = await request('/api/records', {
      questionId, selected: [1], attemptId: 'duplicate-attempt', costMs, assisted,
      submissionKey: `duplicate-attempt:final:${index}:${questionId}`,
    });
    assert.equal(saved.status, 200);
  }
  await request('/api/attempts/complete', { attemptId: 'duplicate-attempt', questionCount: 2 });
  const history = await request('/api/attempts/duplicate-attempt');
  assert.deepEqual(history.body.records.map((r) => r.assisted), [true, false]);
  assert.equal(history.body.records[1].submissionKey, `duplicate-attempt:final:1:${questionId}`);
  const ambiguous = await request('/api/ai/speed-review', reviewInput({ attemptId: 'duplicate-attempt' }));
  assert.equal(ambiguous.status, 409);
  const before = providerCalls.length;
  const exact = await request('/api/ai/speed-review', reviewInput({ attemptId: 'duplicate-attempt', submissionKey: `duplicate-attempt:final:1:${questionId}` }));
  assert.equal(exact.body.review.status, 'method');
  assert.equal(providerCalls.length, before + 1);
  assert.match(JSON.stringify(providerCalls.at(-1).messages), /117000|117/);
  const assisted = await request('/api/ai/speed-review', reviewInput({ attemptId: 'duplicate-attempt', submissionKey: `duplicate-attempt:final:0:${questionId}`, assisted: false, timing: { assisted: false } }));
  assert.equal(assisted.body.review.status, 'method');
  assert.match(JSON.stringify(providerCalls.at(-1).messages), /\\"assisted\\":true/);
  assert.equal((await request('/api/ai/speed-review', reviewInput({ attemptId: 'duplicate-attempt', submissionKey: 'wrong' }))).status, 404);
});

test('explicit common-knowledge and political-theory questions use the transparent deterministic scope boundary', async () => {
  const before = providerCalls.length;
  for (const category of ['常识判断', '政治理论']) {
    const result = await request('/api/ai/speed-review', { questionId: 'scope-boundary', questionData: { ...question, category } });
    assert.equal(result.body.review.status, 'no_shortcut');
    assert.equal(result.body.review.drillMethod, null);
    assert.match(JSON.stringify(result.body.review), /首版|当前|暂不|范围|知识/);
  }
  assert.equal(providerCalls.length, before);
});

test('browser-key preparation includes trusted timing and mock is explicitly marked', async () => {
  await configure({ key_storage_mode: 'browser', api_key: '' });
  const before = providerCalls.length;
  const prepared = await request('/api/ai/speed-review', reviewInput());
  assert.equal(prepared.body.clientCall.kind, 'speed-review');
  assert.match(JSON.stringify(prepared.body.clientCall.messages), /154000|154/);
  assert.doesNotMatch(JSON.stringify(prepared.body), /fixture-test-key|客户端伪造题面/);
  assert.equal(providerCalls.length, before);
  await configure({ provider_mode: 'mock', api_key: '' });
  const mock = await request('/api/ai/speed-review', reviewInput());
  assert.equal(mock.body.mock, true);
  assert.equal(mock.body.review.status, 'insufficient');
  assert.match(mock.body.review.recognition + mock.body.notice, /Mock/);
  assert.equal(providerCalls.length, before);
  await configure();
});

test('local mode restores attempt snapshot and rejects an invalid attempt before the AI', async () => {
  const { createLocalHandler } = await import('./public/local-handler.js');
  const calls = [];
  const tables = {
    attempts: [{ attempt_id: 'local-attempt', completed: 1 }],
    records: [{ attempt_id: 'local-attempt', question_id: 'local-q', question_uid: 'uid-local', question_revision: 2, question_snapshot: JSON.stringify(question), answer_snapshot: JSON.stringify({ selected: [1], assisted: true }), is_correct: 1, cost_ms: 88000, submission_key: 'local-attempt:final:0' }],
  };
  const local = createLocalHandler({ query: {}, records: {}, store: { getAll: async (name) => tables[name] || [] }, ai: { speedReview: async (input, options) => { calls.push({ ...input, signal: options?.signal }); return { review: fixtureReview }; } } });
  const requestBody = { attemptId: 'local-attempt', questionId: 'local-q', questionUid: 'uid-local', questionRevision: 2, questionData: { prompt: '伪造' }, timing: { solveMs: 1, referenceSeconds: 60 } };
  const controller = new AbortController();
  const result = await local('/api/ai/speed-review', { method: 'POST', body: JSON.stringify(requestBody), signal: controller.signal });
  assert.equal(result.review.status, 'method');
  assert.equal(calls[0].questionData.prompt, question.prompt);
  assert.equal(calls[0].timing.solveMs, 88000);
  assert.equal(calls[0].correct, true);
  assert.deepEqual(calls[0].selected, [1]);
  assert.equal(calls[0].assisted, true);
  assert.equal(calls[0].signal, controller.signal);
  const history = await local('/api/attempts/local-attempt');
  assert.equal(history.records[0].assisted, true);
  assert.equal(history.records[0].submissionKey, 'local-attempt:final:0');
  await assert.rejects(local('/api/ai/speed-review', { method: 'POST', body: JSON.stringify({ ...requestBody, attemptId: 'invalid' }) }), /练习记录不存在/);
  assert.equal(calls.length, 1);
  tables.records.push({ ...tables.records[0], submission_key: 'local-attempt:final:1', cost_ms: 123000 });
  await assert.rejects(local('/api/ai/speed-review', { method: 'POST', body: JSON.stringify(requestBody) }), /多次作答/);
  await local('/api/ai/speed-review', { method: 'POST', body: JSON.stringify({ ...requestBody, submissionKey: 'local-attempt:final:1' }) });
  assert.equal(calls[1].timing.solveMs, 123000);
});

test('local AI adapter uses independent prompt and validates the provider schema', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) };
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ id: 1, role: 'xingce-explainer', api_key: '', base_url: 'https://example.invalid/v1', model: 'fixture-local', skill: 'must-not-load', system_prompt: 'must-not-use' }] });
  try {
    const { createAiApi } = await import('./public/ai-local.js');
    const calls = [];
    let content = JSON.stringify(fixtureReview), capturedSignal = null, blockUntilAbort = false;
    const ai = await createAiApi({ request: async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      capturedSignal = opts.signal;
      if (blockUntilAbort) await new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }, query: {}, tiku: {} });
    await ai.updateAgent(1, { api_key: 'local-memory-fixture-key', provider_mode: 'openai-compatible' });
    const input = { questionData: question, timing: { solveMs: 91000, referenceSeconds: 60 }, selected: [1], correct: true };
    assert.equal((await ai.speedReview(input)).review.status, 'method');
    assert.match(JSON.stringify(calls[0].messages), /91000|91/);
    assert.doesNotMatch(JSON.stringify(calls[0].messages), /must-not-use|must-not-load/);
    assert.ok(calls[0].max_tokens >= 8192);
    const noAnswer = await ai.speedReview({ ...input, questionData: { ...question, answer: '', answerIndex: -1 } });
    assert.equal(noAnswer.review.status, 'insufficient');
    const commonKnowledge = await ai.speedReview({ ...input, questionData: { ...question, category: '常识判断' } });
    assert.equal(commonKnowledge.review.status, 'no_shortcut');
    assert.equal(calls.length, 1);
    content = '模型未按格式返回';
    assert.equal((await ai.speedReview(input)).review, null);
    blockUntilAbort = true;
    const controller = new AbortController();
    const pending = ai.speedReview(input, { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capturedSignal, controller.signal);
    controller.abort();
    const stopped = await pending;
    assert.equal(stopped.cancelled, true);
    assert.equal(stopped.review, null);
    await ai.updateAgent(1, { provider_mode: 'mock' });
    const mock = await ai.speedReview(input);
    assert.equal(mock.mock, true);
    assert.equal(mock.review.status, 'insufficient');
    assert.equal(calls.length, 3);
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});

test('browser adapter normalizes prepared reviews and keeps its key out of app requests', async () => {
  const source = await readFile(join(root, 'public/ai-browser.js'), 'utf8');
  const providerRequests = [];
  const serverRequests = [];
  let providerText = JSON.stringify(fixtureReview);
  const agent = { id: 1, role: 'xingce-explainer', key_storage_mode: 'browser', base_url: 'https://fixture.invalid/v1', model: 'fixture-browser', provider_mode: 'openai-compatible', system_prompt: 'must-not-use', skill_text: 'must-not-load' };
  const response = (payload) => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  const context = { AbortController, Headers, Response, TextDecoder, Uint8Array, setTimeout, clearTimeout, console, window: { addEventListener() {} }, fetch: async (url, opts = {}) => {
    if (String(url).startsWith('/api/ai/agents/1?')) return response(agent);
    if (String(url) === 'https://fixture.invalid/v1/chat/completions') { providerRequests.push(opts); return response({ choices: [{ message: { content: providerText } }] }); }
    throw new Error(`unexpected browser request: ${url}`);
  } };
  new vm.Script(source, { filename: join(root, 'public/ai-browser.js'), importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).runInNewContext(context);
  const browser = context.window.__AI_BROWSER_KEYS__;
  const rawFetch = async (path, opts) => {
    serverRequests.push({ path, opts });
    if (path === '/api/ai/agents/1') return { agent };
    return { clientCall: { kind: 'speed-review', agentId: 1, messages: [{ role: 'user', content: 'fixture prepared prompt' }] } };
  };
  await browser.handle('/api/ai/agents/1', { method: 'PUT', body: JSON.stringify({ key_storage_mode: 'browser', api_key: 'memory-only-fixture-key' }) }, rawFetch);
  const input = { method: 'POST', body: JSON.stringify({ questionId: 'fixture' }) };
  const result = await browser.handle('/api/ai/speed-review', input, rawFetch);
  assert.equal(result.review.status, 'method');
  assert.equal(providerRequests[0].headers.Authorization, 'Bearer memory-only-fixture-key');
  assert.doesNotMatch(JSON.stringify(serverRequests), /memory-only-fixture-key/);
  assert.doesNotMatch(providerRequests[0].body, /must-not-use|must-not-load/);
  providerText = '{"status":"unknown"}';
  assert.equal((await browser.handle('/api/ai/speed-review', input, rawFetch)).review, null);
});
