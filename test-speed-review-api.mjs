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
const reasoningCases = [
  { category: '判断推理', label: '文字判断', source: 'source', prompt: '甲、乙、丙三人排队，甲不在最后，乙在丙前。以下哪种顺序满足全部条件？', options: ['甲乙丙', '丙甲乙', '乙丙甲', '丙乙甲'], methodName: '逐项核对排队条件', steps: ['排除甲在最后的乙丙甲。', '排除乙在丙后的丙甲乙和丙乙甲，甲乙丙满足全部条件。'], whyCorrect: '甲乙丙中甲不在最后且乙在丙前，其他选项均违反至少一个条件。' },
  { category: '', label: '定义判断', source: 'structure', prompt: '公共物品是指能够供多人同时使用，且无法轻易排除他人使用的物品。根据上述定义，下列属于公共物品的是？', options: ['开放街道的照明', '个人餐盒', '会员私用储物柜', '售票影院的座位'], methodName: '核对定义的两个条件', steps: ['提取多人共用和难以排除他人两个条件。', '街道照明同时满足两条件；餐盒、私用储物柜和售票座位都能排除他人使用。'], whyCorrect: '按题目给出的定义逐项判断，只有开放街道照明满足两个必要条件。' },
  { category: '', label: '类比推理', source: 'structure', prompt: '剪刀：裁剪', options: ['锅铲：炒菜', '纸张：剪刀', '衣服：裁剪', '裁剪：剪刀'], methodName: '保持工具与用途的顺序', steps: ['剪刀是用于裁剪的工具，关系为工具到用途。', '锅铲用于炒菜且顺序一致；其他选项的关系或方向不同。'], whyCorrect: '锅铲与炒菜复现题干的工具与用途关系，且前后顺序一致。' },
  { category: '', label: '逻辑判断', source: 'structure', prompt: '所有参加培训的员工都已通过资格审核。小王参加了培训。由此可以推出哪项？', options: ['小王已通过资格审核', '所有通过审核的人都参加培训', '小王未通过审核', '未参加培训的人都未通过审核'], methodName: '沿充分条件正向推导', steps: ['把条件写成参加培训推出通过审核。', '小王参加培训，因此小王通过审核；不能反向推导。'], whyCorrect: '小王满足题目给定的充分条件，正向应用即可推出通过审核。' },
].map((item, index) => ({ ...item, answer: 'A', answerIndex: 0, analysis: item.whyCorrect, external_id: `method-classification-${index}` }));
const reasoningReview = (item) => ({ status: 'method', methodName: item.methodName, recognition: `先明确本题的${item.label}结构。`, steps: item.steps, whyCorrect: item.whyCorrect, applicability: '适用于本题给出的完整文字条件和选项。', caution: '只使用题目给出的条件，不添加常识假设或颠倒关系。', diagnosis: '仅凭用时无法确定慢因，可以对照上述步骤检查自己的过程。', drillMethod: null });
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
  const nativeFixture = new DatabaseSync(join(dataDir, 'tiku.db'));
  nativeFixture.exec(`
    CREATE TABLE papers(id INTEGER PRIMARY KEY, subjectName TEXT, category TEXT, name TEXT, questionCount INTEGER, difficulty INTEGER, chapters TEXT);
    CREATE TABLE questions(id INTEGER PRIMARY KEY, questionId TEXT, paperId INTEGER, chapter TEXT, type INTEGER, content TEXT, contentHtml TEXT, options TEXT, answer TEXT, answerIndex INTEGER, difficulty INTEGER, analysis TEXT);
    INSERT INTO papers VALUES(1, '公务员·行测', '真题', '2026年隔离材料测试', 4, 1, '[]');
  `);
  for (let i = 1; i <= 4; i++) nativeFixture.prepare('INSERT INTO questions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(i, String(91000 + i), 1, '资料分析', 1, `根据共享材料计算第${i}题。`, '', '["20","30","40","50"]', '1', 1, 1, '');
  nativeFixture.close();
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
  assert.equal(missing.body.unavailable, true);
  assert.equal(missing.body.review, undefined);
  const image = await request('/api/ai/speed-review', { questionId: 'image', questionData: { ...question, contentHtml: '<img src="https://example.invalid/chart.png">' } });
  assert.equal(image.body.capability.code, 'image_required');
  for (const invalidAnswer of [{ answer: '', answerIndex: -1 }, { answer: 'Z', answerIndex: 26 }, { answer: 'B', answerIndex: 1, answerStatus: 'disputed' }]) {
    const missingAnswer = await request('/api/ai/speed-review', { questionId: 'no-answer', questionData: { ...question, ...invalidAnswer } });
    assert.equal(missingAnswer.body.capability.code, 'invalid_answer');
    assert.equal(missingAnswer.body.review, undefined);
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

test('all unsupported or incomplete inputs are refused before any provider or fake review result', async () => {
  const before = providerCalls.length;
  for (const change of [
    ...['常识判断', '政治理论', '图形推理', '数字推理', '申论', '未知', ''].map((category) => ({ category })),
    { category: '数量关系', subCategory: '数字推理' },
    { category: '数量关系/言语理解' }, { images: '["image.png"]' },
    { prompt: '【本题原卷含题目图片，当前导入文件未包含图片】' },
    { material: '【共享材料含图片，当前导入文件未包含图片】' },
    { options: ['（原卷图形选项，图片未随导入提供）', '20'] },
    { image_missing: true }, { options: ['A', 'B', 'C', 'D'] },
    { options: ['<span>&nbsp;</span>', '30'] },
    { category: '', type: 'custom', chapter: '资料分析' },
  ]) {
    const result = await request('/api/ai/speed-review', { questionId: 'scope-boundary', questionData: { ...question, ...change } });
    assert.equal(result.body.unavailable, true, JSON.stringify(change));
    assert.equal(result.body.capability.available, false);
    assert.equal(result.body.review, undefined);
    assert.equal(result.body.clientCall, undefined);
  }
  assert.equal(providerCalls.length, before);
});

test('source paths and old broad or unlabeled snapshots gain methods without rewriting category, fingerprint or revision', async () => {
  const { getSpeedReviewCapability } = await import('./public/speed-review-core.mjs');
  const cases = [...reasoningCases, { ...reasoningCases[1], prompt: reasoningCases[1].prompt.replace('公共物品', '公用物品'), category: '判断推理/定义判断', source: 'source', external_id: 'method-source-path' }];
  const imported = await request('/api/custom/import', { name: '分类兼容验收', questions: cases });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const listBefore = (await request(`/api/custom/questions?batch_id=${imported.body.id}`)).body.questions;
  const practice = (await request(`/api/custom/practice?batch_id=${imported.body.id}`)).body.questions;
  for (const [index, item] of cases.entries()) {
    const current = practice.find((entry) => entry.content === item.prompt);
    assert.equal(current.category, item.category);
    assert.equal(current.subCategory, undefined, 'existing imports need no synthetic fine-category field');
    const capability = getSpeedReviewCapability(current);
    assert.equal(capability.available, true);
    assert.equal(capability.label, item.label);
    assert.equal(capability.classificationSource, item.source);
    await request('/api/records', { questionId: current.id, selected: [0], attemptId: 'classification-compat', submissionKey: `classification-compat:${index}`, costMs: 180000 });
  }
  await request('/api/attempts/complete', { attemptId: 'classification-compat', questionCount: cases.length });
  const historyBefore = (await request('/api/attempts/classification-compat')).body.records;
  const count = providerCalls.length;
  try {
    for (const [index, item] of cases.entries()) {
      const record = historyBefore[index];
      assert.equal(record.question.category, item.category);
      assert.equal(record.question.subCategory, undefined, 'legacy snapshot shape is accepted without adding metadata');
      providerContent = JSON.stringify(reasoningReview(item));
      const result = await request('/api/ai/speed-review', { attemptId: 'classification-compat', questionId: record.questionId, questionData: { ...question, prompt: '客户端伪造题面', category: '常识判断' } });
      assert.deepEqual(result.body.review, reasoningReview(item), JSON.stringify(result.body));
      const sent = JSON.stringify(providerCalls.at(-1).messages);
      assert.ok(sent.includes(item.prompt));
      assert.doesNotMatch(sent, /客户端伪造题面/);
      assert.ok(sent.includes(getSpeedReviewCapability(record.question).focus));
    }
  } finally { providerContent = JSON.stringify(fixtureReview); }
  assert.equal(providerCalls.length, count + cases.length);
  assert.deepEqual((await request('/api/attempts/classification-compat')).body.records, historyBefore, 'derived method routing never changes saved answers or snapshots');
  const repeat = await request('/api/custom/import', { name: '分类兼容重复导入', questions: cases });
  assert.equal(repeat.body.created, 0);
  assert.equal(repeat.body.unchanged, cases.length);
  assert.equal(repeat.body.revisions, 0);
  const listAfter = (await request(`/api/custom/questions?batch_id=${imported.body.id}`)).body.questions;
  assert.deepEqual(listAfter.map(({ category, question_uid, fingerprint, revision }) => ({ category, question_uid, fingerprint, revision })), listBefore.map(({ category, question_uid, fingerprint, revision }) => ({ category, question_uid, fingerprint, revision })));
  const noCall = providerCalls.length;
  for (const change of [{ category: '常识判断' }, { category: '政治理论' }, { category: '判断推理/图形推理' }, { category: '判断推理/言语理解' }, { material: '【共享材料含图片，当前导入文件未包含图片】' }, { answer: '', answerIndex: -1 }]) {
    const rejected = await request('/api/ai/speed-review', { questionId: 'inferred-scope-boundary', questionData: { ...reasoningCases[1], ...change } });
    assert.equal(rejected.body.unavailable, true, JSON.stringify(change));
  }
  assert.equal(providerCalls.length, noCall, 'clear reasoning structure never overrides source conflicts or incomplete inputs');
});

test('the import parser receives the fine-category preservation contract without changing saved agent settings', async () => {
  const agents = await request('/api/ai/agents');
  const parser = agents.body.find((agent) => agent.role === 'custom-question-parser');
  assert.ok(parser);
  const setup = await request(`/api/ai/agents/${parser.id}`, { enabled: 1, key_storage_mode: 'server', api_key: 'fixture-parser-key', base_url: upstreamBase, model: 'fixture-parser', provider_mode: 'openai-compatible', stream_enabled: 0, system_prompt: '解析员自定义提示词应保持原样', skill: '', timeout_ms: 3000 }, { method: 'PUT' });
  assert.equal(setup.status, 200);
  const saved = (await request(`/api/ai/agents/${parser.id}`)).body;
  const count = providerCalls.length;
  providerContent = JSON.stringify({ questions: [{ ...reasoningCases[1], category: '判断推理/定义判断' }] });
  try {
    const result = await request('/api/ai/structure', { text: `定义判断\n${reasoningCases[1].prompt}` });
    assert.equal(JSON.parse(result.body.text).questions[0].category, '判断推理/定义判断');
    assert.equal(providerCalls.length, count + 1);
    const prompt = JSON.stringify(providerCalls.at(-1).messages);
    assert.match(prompt, /解析员自定义提示词应保持原样/);
    assert.match(prompt, /category 可以保存.*大类\/细类/);
    assert.match(prompt, /不确定细类时保留/);
    assert.deepEqual((await request(`/api/ai/agents/${parser.id}`)).body, saved);
  } finally { providerContent = JSON.stringify(fixtureReview); }
});

test('shared-material snapshots restore the same scoped holder, freeze it, and reject missing or image-only material', async () => {
  const material = '本批次共享数据：总量为240，其中12.5%为目标部分。';
  const image = { role: 'material', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' };
  const imported = await request('/api/custom/import', { name: '真实材料组快照夹具', questions: [
    { ...question, prompt: '材料组首题', material, material_id: 'shared-fixture' },
    { ...question, prompt: '根据本组材料，目标部分是多少？', material: '', material_id: 'shared-fixture' },
    { ...question, prompt: '缺少共享材料的题', material: '', material_id: 'missing-fixture' },
    { ...question, prompt: '图片材料组首题', material: '', images: [image], material_id: 'image-fixture' },
    { ...question, prompt: '图片材料组第二题', material: '', material_id: 'image-fixture' },
  ] });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  // Same material id elsewhere must not supply the material for this batch or owner.
  await request('/api/custom/import', { name: '另一批次', questions: [{ ...question, prompt: '不同批次题', material: '错误的跨批次材料', material_id: 'shared-fixture' }] });
  await request('/api/custom/import', { name: '另一用户批次', questions: [{ ...question, prompt: '不同用户题', material: '错误的跨账号材料', material_id: 'shared-fixture' }] }, { cookie: userB.cookie });
  const practice = await request(`/api/custom/practice?batch_id=${imported.body.id}`);
  const questions = practice.body.questions;
  const tail = questions.find((item) => item.content === '根据本组材料，目标部分是多少？');
  const missing = questions.find((item) => item.content === '缺少共享材料的题');
  const imageTail = questions.find((item) => item.content === '图片材料组第二题');
  assert.equal(tail.material, material);
  assert.equal(tail.sharedMaterial, true);
  assert.equal(tail.materialId, 'shared-fixture');
  const single = await request(`/api/question?id=${tail.id}`);
  assert.equal(single.body.material, material);
  for (const [index, item] of [tail, missing, imageTail].entries()) {
    assert.equal((await request('/api/records', { questionId: item.id, selected: [1], attemptId: 'shared-attempt', submissionKey: `shared-attempt:${index}` })).status, 200);
  }
  await request('/api/attempts/complete', { attemptId: 'shared-attempt', questionCount: 3 });
  const db = new DatabaseSync(join(dataDir, 'practice.db'));
  db.prepare('UPDATE custom_questions SET material = ? WHERE batch_id = ? AND material_id = ?').run('作答后被修改的材料', imported.body.id, 'shared-fixture');
  db.close();
  const history = await request('/api/attempts/shared-attempt');
  assert.equal(history.body.records[0].question.material, material);
  assert.equal(history.body.records[0].question.sharedMaterial, true);
  assert.equal(history.body.records[0].question.materialId, 'shared-fixture');
  assert.equal(history.body.records[2].question.images.length, 1);
  const reviewed = await request('/api/ai/speed-review', { attemptId: 'shared-attempt', questionId: tail.id });
  assert.equal(reviewed.body.review.status, 'method');
  const sent = JSON.stringify(providerCalls.at(-1).messages);
  assert.match(sent, /本批次共享数据/);
  assert.doesNotMatch(sent, /错误的跨|作答后被修改/);
  const before = providerCalls.length;
  for (const [item, code] of [[missing, 'missing_material'], [imageTail, 'image_required']]) {
    const refused = await request('/api/ai/speed-review', { attemptId: 'shared-attempt', questionId: item.id, questionData: { ...question, material: '客户端伪造材料' } });
    assert.equal(refused.body.unavailable, true);
    assert.equal(refused.body.capability.code, code);
  }
  assert.equal(providerCalls.length, before);
});

test('native material snapshots use the paper subject and reject missing or ambiguous source mappings in current and historical views', async () => {
  const { getSpeedReviewCapability } = await import('./public/speed-review-core.mjs');
  const db = new DatabaseSync(join(dataDir, 'practice.db'));
  const map = db.prepare('INSERT INTO q_material_map(question_id, subject, material_id) VALUES(?,?,?)');
  const material = db.prepare('INSERT INTO q_materials(subject, material_id, content) VALUES(?,?,?)');
  const subject = '公务员·行测';
  map.run('91001', subject, 'native-valid'); material.run(subject, 'native-valid', '原生题库共享材料：总量240，比例12.5%。');
  map.run('91001', '其他科目', 'foreign'); material.run('其他科目', 'foreign', '不能混入的其他科目材料');
  map.run('91002', subject, 'native-missing');
  map.run('91003', subject, 'native-ambiguous-a'); map.run('91003', subject, 'native-ambiguous-b');
  material.run(subject, 'native-ambiguous-a', '候选材料一'); material.run(subject, 'native-ambiguous-b', '候选材料二');
  map.run('91004', subject, 'native-duplicate'); material.run(subject, 'native-duplicate', '重复标识材料一'); material.run(subject, 'native-duplicate', '重复标识材料二');
  db.close();
  for (let i = 1; i <= 4; i++) {
    const questionId = String(91000 + i);
    const current = await request(`/api/question?id=${questionId}`);
    assert.equal(current.status, 200, JSON.stringify(current.body));
    assert.equal(getSpeedReviewCapability(current.body).available, i === 1, questionId);
    assert.equal((await request('/api/records', { questionId, selected: [1], attemptId: 'native-shared', submissionKey: `native-shared:${i}` })).status, 200);
  }
  await request('/api/attempts/complete', { attemptId: 'native-shared', questionCount: 4 });
  const history = await request('/api/attempts/native-shared');
  for (const [index, record] of history.body.records.entries()) {
    assert.equal(record.question.sharedMaterial, true);
    assert.equal(getSpeedReviewCapability(record.question).available, index === 0);
  }
  assert.match(history.body.records[0].question.material, /原生题库共享材料/);
  const reviewed = await request('/api/ai/speed-review', { attemptId: 'native-shared', questionId: '91001' });
  assert.equal(reviewed.body.review.status, 'method');
  assert.doesNotMatch(JSON.stringify(providerCalls.at(-1).messages), /不能混入|其他科目材料/);
  const before = providerCalls.length;
  for (const questionId of ['91002', '91003', '91004']) {
    const refused = await request('/api/ai/speed-review', { attemptId: 'native-shared', questionId });
    assert.equal(refused.body.unavailable, true);
    assert.equal(refused.body.capability.code, 'missing_material');
  }
  assert.equal(providerCalls.length, before);
});

test('both local native query entrypoints match shared-material qualification using disposable SQLite fixtures', async () => {
  const { getSpeedReviewCapability } = await import('./public/speed-review-core.mjs');
  const tiku = new DatabaseSync(join(dataDir, 'tiku.db'), { readOnly: true });
  const practice = new DatabaseSync(join(dataDir, 'practice.db'), { readOnly: true });
  const adapter = (db) => ({
    get: (sql, ...params) => db.prepare(sql).get(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
  });
  try {
    for (const entrypoint of ['./public/lib/local-queries.js', './lib/local-queries.mjs']) {
      const { createLocalApi } = await import(entrypoint);
      const local = createLocalApi(adapter(tiku), adapter(practice), {});
      for (let i = 1; i <= 4; i++) {
        const questionId = String(91000 + i);
        const current = local.questionById(questionId);
        assert.equal(current.sharedMaterial, true, entrypoint);
        assert.equal(getSpeedReviewCapability(current).available, i === 1, entrypoint + ':' + questionId);
        if (i === 1) {
          assert.equal(current.materialId, 'native-valid');
          assert.match(current.material, /原生题库共享材料/);
          assert.doesNotMatch(current.material, /其他科目/);
        } else {
          assert.equal(current.material, null);
          assert.equal(getSpeedReviewCapability(current).code, 'missing_material');
        }
      }
    }
  } finally { tiku.close(); practice.close(); }
});

test('browser-key preparation includes trusted timing and mock is explicitly marked', async () => {
  await configure({ key_storage_mode: 'browser', api_key: '' });
  const before = providerCalls.length;
  const prepared = await request('/api/ai/speed-review', reviewInput());
  assert.equal(prepared.body.clientCall.kind, 'speed-review');
  assert.match(JSON.stringify(prepared.body.clientCall.messages), /154000|154/);
  assert.doesNotMatch(JSON.stringify(prepared.body), /fixture-test-key|客户端伪造题面/);
  assert.equal(providerCalls.length, before);
  for (const item of [reasoningCases[0], reasoningCases[1]]) {
    const compatible = await request('/api/ai/speed-review', { questionId: 'browser-classification', questionData: item });
    assert.equal(compatible.body.clientCall.kind, 'speed-review');
    assert.ok(JSON.stringify(compatible.body.clientCall.messages).includes(item.prompt));
  }
  const unavailable = await request('/api/ai/speed-review', { questionId: 'browser-scope', questionData: { ...question, category: '常识判断' } });
  assert.equal(unavailable.body.unavailable, true);
  assert.equal(unavailable.body.clientCall, undefined);
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
  const local = createLocalHandler({ query: {}, records: {}, store: { getAll: async (name) => tables[name] || [] }, ai: { speedReview: async (input, options) => { calls.push({ ...input, signal: options?.signal }); const match = reasoningCases.find((item) => item.prompt === input.questionData.prompt); return { review: match ? reasoningReview(match) : fixtureReview }; } } });
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
  for (const [index, item] of reasoningCases.entries()) {
    const id = `local-reasoning-${index}`;
    tables.records.push({ ...tables.records[0], question_id: id, question_snapshot: JSON.stringify(item), submission_key: id });
    const historical = await local('/api/ai/speed-review', { method: 'POST', body: JSON.stringify({ attemptId: 'local-attempt', questionId: id, questionData: { ...question, category: '常识判断' } }) });
    assert.equal(historical.review.methodName, item.methodName);
    assert.equal(calls.at(-1).questionData.category, item.category);
    assert.equal(calls.at(-1).questionData.subCategory, undefined);
  }
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
    for (const item of reasoningCases) {
      content = JSON.stringify(reasoningReview(item));
      assert.equal((await ai.speedReview({ ...input, questionData: item })).review.methodName, item.methodName);
      assert.ok(JSON.stringify(calls.at(-1).messages).includes(item.prompt));
    }
    content = JSON.stringify(fixtureReview);
    const validCalls = calls.length;
    const noAnswer = await ai.speedReview({ ...input, questionData: { ...question, answer: '', answerIndex: -1 } });
    assert.equal(noAnswer.capability.code, 'invalid_answer');
    const commonKnowledge = await ai.speedReview({ ...input, questionData: { ...question, category: '常识判断' } });
    assert.equal(commonKnowledge.unavailable, true);
    assert.equal(commonKnowledge.review, undefined);
    for (const change of [
      { category: '' }, { category: '图形推理' }, { category: '数量关系', subCategory: '数字推理' },
      { material: '【共享材料含图片，当前导入文件未包含图片】' }, { images: '["image.png"]' },
      { image_missing: true }, { options: ['<span>A</span>', '<span>B</span>'] },
      { answerStatus: 'disputed' }, { category: '数量关系/言语理解' },
    ]) {
      const refused = await ai.speedReview({ ...input, questionData: { ...question, ...change } });
      assert.equal(refused.unavailable, true, JSON.stringify(change));
      assert.equal(refused.review, undefined);
    }
    assert.equal(calls.length, validCalls);
    for (const change of [{ category: '常识判断' }, { category: '判断推理/图形推理' }, { category: '判断推理/言语理解' }, { material: '【共享材料含图片，当前导入文件未包含图片】' }, { answer: '', answerIndex: -1 }]) {
      const refused = await ai.speedReview({ ...input, questionData: { ...reasoningCases[1], ...change } });
      assert.equal(refused.unavailable, true, JSON.stringify(change));
      assert.equal(refused.review, undefined);
    }
    assert.equal(calls.length, validCalls);
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
    assert.equal(calls.length, validCalls + 2);
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
