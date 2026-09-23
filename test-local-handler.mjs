// test-local-handler.mjs — 路由覆盖回归：app.js 全部 API 调用路径在本地模式下都必须有实现
// 运行：node --test test-local-handler.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- mock query / records / store / ai ----------
function makeMocks() {
  const calls = [];
  const fn = (name) => async (...args) => { calls.push([name, ...args]); return { mock: name, args }; };
  const query = {
    subjects: fn('query.subjects'),
    categories: fn('query.categories'),
    chapters: fn('query.chapters'),
    papers: fn('query.papers'),
    paperById: fn('query.paperById'),
    practice: fn('query.practice'),
    questionById: fn('query.questionById'),
    paperMaterials: fn('query.paperMaterials'),
    generatePaper: fn('query.generatePaper'),
  };
  const records = {
    addRecord: fn('records.addRecord'),
    recent: fn('records.recent'),
    wrong: fn('records.wrong'),
    favorites: fn('records.favorites'),
    toggleFavorite: fn('records.toggleFavorite'),
  };
  const store = {
    getAll: async () => [],
    put: async () => {},
    deleteBy: async () => {},
  };
  const ai = {
    material: fn('ai.material'),
    ocr: fn('ai.ocr'),
    grade: fn('ai.grade'),
    explain: fn('ai.explain'),
    chat: fn('ai.chat'),
    agents: fn('ai.agents'),
    getAgent: fn('ai.getAgent'),
    updateAgent: fn('ai.updateAgent'),
    test: fn('ai.test'),
    clearExplainCache: fn('ai.clearExplainCache'),
  };
  return { query, records, store, ai, calls };
}

// ---------- app.js 的全部 API 调用（含模板字符串形态，静态提取后按实际 URL 展开） ----------
const ROUTES = [
  // GET 题库
  ['GET', '/api/subjects'],
  ['GET', '/api/records/stats'],
  ['GET', '/api/records/stats?subject=%E5%85%AC%E5%8A%A1%E5%91%98%C2%B7%E8%A1%8C%E6%B5%8B&days=7'],
  ['GET', '/api/records/stats?subject=%E5%85%AC%E5%8A%A1%E5%91%98%C2%B7%E8%A1%8C%E6%B5%8B&from=2026-08-01&to=2026-08-11'],
  ['GET', '/api/categories?subject=%E5%85%AC%E5%8A%A1%E5%91%98%C2%B7%E8%A1%8C%E6%B5%8B'],
  ['GET', '/api/chapters?subject=%E5%85%AC%E5%8A%A1%E5%91%98%C2%B7%E8%A1%8C%E6%B5%8B&mock=0'],
  ['GET', '/api/papers?subject=%E5%85%AC%E5%8A%A1%E5%91%98%C2%B7%E8%A1%8C%E6%B5%8B&category=%E5%9B%BD%E8%80%83&limit=300'],
  ['GET', '/api/papers/123'],
  ['GET', '/api/practice?subject=%E5%85%AC%E5%8A%A1%E5%91%98%C2%B7%E8%A1%8C%E6%B5%8B&n=15'],
  ['GET', '/api/practice?subject=%E5%85%AC%E5%8A%A1%E5%91%98%C2%B7%E8%A1%8C%E6%B5%8B&group=%E6%95%B0%E9%87%8F%E5%85%B3%E7%B3%BB&sub=%E5%85%A8%E9%83%A8&n=15'],
  ['GET', '/api/practice?subject=%E5%85%AC%E5%8A%A1%E5%91%98%C2%B7%E8%A1%8C%E6%B5%8B&chapter=%E8%B5%84%E6%96%99%E5%88%86%E6%9E%90&n=15'],
  ['GET', '/api/practice?subject=%E5%85%AC%E5%8A%A1%E5%91%98%C2%B7%E8%A1%8C%E6%B5%8B&chapters=%E8%A1%8C%E6%B5%8B%E4%B8%80,%E8%A1%8C%E6%B5%8B%E4%BA%8C&n=15'],
  ['GET', '/api/practice?subject=%E5%85%AC%E5%8A%A1%E5%91%98%C2%B7%E7%94%B3%E8%AE%BA&group=%E5%BD%92%E7%BA%B3%E6%A6%82%E6%8B%AC%E9%A2%98&sub=%E5%85%A8%E9%83%A8&n=2'],
  ['GET', '/api/question?id=123456'],
  ['GET', '/api/materials?paperId=23'],
  ['GET', '/api/ai/material?paperId=23'],
  ['GET', '/api/ai/agents'],
  ['GET', '/api/ai/agents/1'],
  ['GET', '/api/ai/agents/1/history'],
  ['GET', '/api/records/recent?limit=20'],
  ['GET', '/api/attempts?limit=20'],
  ['GET', '/api/records/wrong?limit=50&offset=0'],
  ['GET', '/api/favorites?limit=50&offset=0'],
  ['GET', '/api/favorites'],
  // POST
  ['POST', '/api/check', { questionId: 123456, selected: 'A' }],
  ['POST', '/api/records', { question_id: 1, subject: '公务员·行测', chapter: '判断推理', selected: 'B', is_correct: 1 }],
  ['POST', '/api/attempts/complete', { attemptId: 'local-complete-smoke', subject: '公务员·行测', mode: 'chapter', questionCount: 0 }],
  ['POST', '/api/favorites', { questionId: 123456, subject: '公务员·行测', chapter: '判断推理' }],
  ['POST', '/api/paper/generate', { subject: '公务员·行测', count: 20, difficulty: 'balanced' }],
  ['POST', '/api/paper/generate', { subject: '事业编·职测', count: 20 }],
  ['POST', '/api/ai/ocr', { image: 'data:image/png;base64,xxx', subject: '公务员·行测' }],
  ['POST', '/api/ai/grade', { questionId: 123, answer: '我的作答' }],
  ['POST', '/api/ai/explain', { questionId: 123456, selected: 'A' }],
  ['POST', '/api/ai/chat', { agentId: 1, messages: [{ role: 'user', content: '测试' }] }],
  ['POST', '/api/ai/chat/stream', { agentId: 1, messages: [{ role: 'user', content: '测试' }] }],
  ['GET', '/api/ai/conversations?questionId=local-1&questionUid=local-1&questionRevision=1'],
  ['POST', '/api/ai/conversations', { questionId: 'local-1', questionUid: 'local-1', questionRevision: 1, questionSnapshot: { prompt: '测试题' } }],
  ['POST', '/api/ai/agents/1/test', { content: '测试内容' }],
  // PUT
  ['PUT', '/api/ai/agents/1', { system_prompt: '新提示词', skill: 'gongkao-huasheng13', api_key: 'sk-****' }],
  // DELETE
  ['DELETE', '/api/favorites', { questionId: 123456 }],
  ['DELETE', '/api/records/wrong', {}],
  ['DELETE', '/api/ai/explain-cache'],
];

test('本地路由：app.js 全部 API 路径均有实现且不抛"未实现"', async () => {
  const { createLocalHandler } = await import('./public/local-handler.js');
  const mocks = makeMocks();
  const handler = createLocalHandler(mocks);
  const errors = [];
  for (const [method, url, body] of ROUTES) {
    try {
      const r = await handler(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r && r.error) errors.push(`${method} ${url} → 返回 error: ${r.error}`);
    } catch (e) {
      errors.push(`${method} ${url} → 抛错: ${e.message}`);
    }
  }
  assert.equal(errors.length, 0, '未实现/报错的路由：\n' + errors.join('\n'));
});

test('本地路由：路径解析正确（papers/:id 调用 paperById）', async () => {
  const { createLocalHandler } = await import('./public/local-handler.js');
  const mocks = makeMocks();
  const handler = createLocalHandler(mocks);
  await handler('/api/papers/123', { method: 'GET' });
  const hit = mocks.calls.find((c) => c[0] === 'query.paperById');
  assert.ok(hit, '应调用 query.paperById');
  assert.equal(hit[1], 123, 'paperId 应为数字 123');
});

test('本地路由：DELETE /ai/explain-cache 调用 ai.clearExplainCache', async () => {
  const { createLocalHandler } = await import('./public/local-handler.js');
  const mocks = makeMocks();
  const handler = createLocalHandler(mocks);
  await handler('/api/ai/explain-cache', { method: 'DELETE' });
  assert.ok(mocks.calls.some((c) => c[0] === 'ai.clearExplainCache'), '应调用 ai.clearExplainCache');
});

test('本地路由：POST /check 传 body.questionId', async () => {
  const { createLocalHandler } = await import('./public/local-handler.js');
  const mocks = makeMocks();
  mocks.query.questionById = (id) => { mocks.calls.push(['query.questionById', id]); return { answerIndex: 0, options: ['A', 'B', 'C', 'D'] }; };
  const handler = createLocalHandler(mocks);
  const r = await handler('/api/check', { method: 'POST', body: JSON.stringify({ questionId: 777, selected: 'A' }) });
  const hit = mocks.calls.find((c) => c[0] === 'query.questionById');
  assert.equal(hit[1], 777, 'questionById 收到 questionId');
  assert.ok(r, 'check 返回结果');
});

test('本地题库保存可见范围，新建时默认公开', async () => {
  const { createLocalHandler } = await import('./public/local-handler.js');
  const data = { custom_batches: [], custom_questions: [] };
  const counters = { custom_batches: 0, custom_questions: 0 };
  const store = {
    async getAll(kind) { return (data[kind] || []).map((row) => ({ ...row })); },
    async nextId(kind) { counters[kind] = (counters[kind] || 0) + 1; return counters[kind]; },
    async put(kind, row) {
      const rows = data[kind] || (data[kind] = []);
      const index = rows.findIndex((entry) => Number(entry.id) === Number(row.id));
      if (index >= 0) rows[index] = { ...row }; else rows.push({ ...row });
    },
  };
  const handler = createLocalHandler({ ...makeMocks(), store });
  const imported = await handler('/api/custom/import', {
    method: 'POST',
    body: JSON.stringify({ name: '本地题库', questions: [{ prompt: '测试题', options: ['A. 甲'], answer: 'A', answer_index: 0 }] }),
  });
  assert.equal(imported.visibility, 'public');
  const listed = await handler('/api/custom/batches', { method: 'GET' });
  assert.equal(listed.batches[0].visibility, 'public');
  assert.equal(listed.batches[0].is_owner, true);

  await handler('/api/custom/batch', {
    method: 'PUT',
    body: JSON.stringify({ id: imported.id, visibility: 'private' }),
  });
  const updated = await handler('/api/custom/batches', { method: 'GET' });
  assert.equal(updated.batches[0].visibility, 'private');
});

test('本地练习历史保留题目快照、逐题计时并可回顾', async () => {
  const { createLocalHandler } = await import('./public/local-handler.js');
  const data = { attempts: [], records: [], custom_questions: [], custom_batches: [] };
  const store = {
    async getAll(kind) { return (data[kind] || []).map((row) => ({ ...row })); },
    async put(kind, row) {
      const rows = data[kind] || (data[kind] = []);
      const key = kind === 'attempts' ? 'attempt_id' : 'id';
      const index = rows.findIndex((entry) => String(entry[key]) === String(row[key]));
      if (index >= 0) rows[index] = { ...row }; else rows.push({ ...row });
    },
  };
  const mocks = makeMocks();
  mocks.query.questionById = (id) => ({
    questionId: id, type: 0, content: '快照题面', contentHtml: '', material: '', options: ['A. 甲', 'B. 乙'],
    answer: '0', answerIndex: 0, analysis: '答案解析',
  });
  mocks.records.addRecord = async (body) => {
    const row = {
      id: 'record-1', question_id: body.questionId, subject: body.subject, chapter: body.chapter,
      question_type: body.type, selected: body.selected, is_correct: body.correct == null ? null : (body.correct ? 1 : 0),
      cost_ms: body.costMs, explanation_ms: body.explanationMs, attempt_id: body.attemptId,
      question_snapshot: body.questionSnapshot, answer_snapshot: body.answerSnapshot,
    };
    data.records.push(row);
    return { ok: true };
  };
  const handler = createLocalHandler({ ...mocks, store });
  const startedAtMs = Date.now() - 5000;
  await handler('/api/records', {
    method: 'POST',
    body: JSON.stringify({
      questionId: 9123, subject: '公务员·行测', chapter: '判断推理', type: 0, selected: [1], correct: true,
      costMs: 4200, explanationMs: 800, attemptId: 'local-history-1', attemptMode: 'chapter',
      attemptQuestionCount: 1, startedAtMs,
    }),
  });
  await handler('/api/attempts/complete', {
    method: 'POST',
    body: JSON.stringify({
      attemptId: 'local-history-1', subject: '公务员·行测', mode: 'chapter', questionCount: 1,
      startedAtMs, durationMs: 6500, explanationMs: 800,
    }),
  });
  const listed = await handler('/api/attempts?limit=10', { method: 'GET' });
  assert.equal(listed.attempts.length, 1);
  assert.equal(listed.attempts[0].wrongCount, 1, '本地仍应按题库答案权威判分');
  assert.equal(listed.attempts[0].durationMs, 6500);
  const detail = await handler('/api/attempts/local-history-1', { method: 'GET' });
  assert.equal(detail.records.length, 1);
  assert.equal(detail.records[0].question.prompt, '快照题面');
  assert.equal(detail.records[0].correct, false);
  assert.equal(detail.records[0].solveMs, 4200);
  assert.equal(detail.records[0].explanationMs, 800);
});

test('本地路由：非 /api 路径抛错提示', async () => {
  const { createLocalHandler } = await import('./public/local-handler.js');
  const mocks = makeMocks();
  const handler = createLocalHandler(mocks);
  await assert.rejects(() => handler('/other/path', { method: 'GET' }), /本地模式不支持的路径/);
});
