/**
 * 掌握度模型（2026-09-26）验收测试。
 *
 * 为什么要测：掌握度环、错题"已对 M/3 天"标签、以及"一键重做待攻克"的题量，
 * 三者必须同源。任何一处口径漂移，用户就会看到"环说已掌握、题却还留在错题本"这类
 * 自相矛盾的界面。本测试把口径钉死在数据上，而不是靠肉眼看界面。
 *
 * 判定口径（与 POST /api/records 的"跨天累计做对 3 次自动移出错题本"严格一致）：
 *   mastered  = 跨不同日期累计做对 >= 3 天
 *   pending   = 未移出（archived=0）且 okDays < 3
 *   dismissed = 已移出（archived=1）且 okDays < 3（用户主动移除，不计入环）
 *   主观题 is_correct IS NULL 不参与
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 端口段 7300–7449：与既有测试（3900/4200/4500/4800/4900/5200/5500/5700/5900/6100 各段）不重叠。
// node --test 会并行跑多个测试文件，端口段重叠会导致随机端口被别的测试占用而误报失败。
const port = 7300 + Math.floor(Math.random() * 150);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'kaogong-mastery-'));
const base = `http://127.0.0.1:${port}`;
let child;

/**
 * AUTH_DISABLED=1 下的运行时归属用户（server.mjs 中 req.user 的兜底值）。
 * 必须写真实 owner：库里的 'legacy-user' 只在首次请求时被一次性迁移到该用户，
 * 测试中途插入的记录若写成 'legacy-user' 会永远查不到（曾因此得到假阴性）。
 */
const OWNER = 'legacy-test-user';

async function waitForServer() {
  // 60s 而非 15s：node --test 会并行跑 20+ 个测试文件（其中多个会拉起 Playwright/Chrome），
  // 机器满载时服务端冷启动可能远超 15s，超时过短会在整套运行时产生假失败。
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/`)).ok) return;
    } catch { /* 未就绪 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('服务未在 60 秒内启动');
}
const getJson = async (url) => (await fetch(`${base}${url}`)).json();

/** 直接落库，便于构造"跨天"这一无法靠实时作答产生的时间维度 */
function seed(rows) {
  const db = new DatabaseSync(path.join(dataDir, 'practice.db'), { timeout: 10000 });
  try {
    const stmt = db.prepare(`
      INSERT INTO practice_records
        (user_id, question_id, subject, chapter, question_type, selected, is_correct, archived, group_key, sub_key, created_at)
      VALUES ('${OWNER}', ?, ?, ?, 1, '[0]', ?, ?, ?, ?, ?)
    `);
    for (const r of rows) stmt.run(String(r.qid), r.subject, r.chapter, r.correct, r.archived ? 1 : 0, r.group || '', r.sub || r.chapter, r.at);
  } finally {
    db.close();
  }
}

before(async () => {
  // 最小题库：错题列表的 available / 题面取自 tiku.db；没有它就无法验证"错题可重做"这条闭环
  {
    const tiku = new DatabaseSync(path.join(dataDir, 'tiku.db'));
    tiku.exec(`
      CREATE TABLE papers (id INTEGER PRIMARY KEY, subjectName TEXT DEFAULT '', category TEXT DEFAULT '', name TEXT DEFAULT '', questionCount INTEGER DEFAULT 0, difficulty INTEGER, chapters TEXT DEFAULT '[]');
      CREATE TABLE questions (id INTEGER PRIMARY KEY, questionId TEXT NOT NULL, paperId INTEGER, chapter TEXT DEFAULT '', type INTEGER DEFAULT 0, content TEXT DEFAULT '', contentHtml TEXT DEFAULT '', options TEXT DEFAULT '[]', answer TEXT DEFAULT '', answerIndex INTEGER DEFAULT -1, difficulty INTEGER, analysis TEXT DEFAULT '');
    `);
    tiku.prepare('INSERT INTO papers (id, subjectName, category, name) VALUES (1, ?, ?, ?)').run('公务员·行测', '言语理解', '测试卷');
    const ins = tiku.prepare('INSERT INTO questions (questionId, paperId, chapter, type, content, options, answer, answerIndex, analysis) VALUES (?, 1, ?, 1, ?, ?, ?, ?, ?)');
    for (const [qid, ch] of [['1001', '言语理解'], ['1002', '判断推理'], ['1003', '数量关系'], ['1004', '资料分析']]) {
      ins.run(qid, ch, `题面 ${qid}`, JSON.stringify(['选项A', '选项B']), '0', 0, `解析 ${qid}`);
    }
    tiku.close();
  }
  child = spawn(process.execPath, ['server.mjs', String(port)], {
    cwd: ROOT,
    env: { ...process.env, APP_DATA_DIR: dataDir, AUTH_DISABLED: '1', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  await waitForServer();
  // 题 1001：错 2 次、从未答对            → pending, wrongCount=2, okDays=0
  // 题 1002：错 1 次 + 答对 1 天           → pending, okDays=1
  // 题 1003：错 1 次 + 答对 3 个不同日期   → mastered
  // 题 1004：错 1 次 + 已移出且从未答对    → dismissed
  // 题 1005：主观题（is_correct NULL）     → 不参与
  seed([
    { qid: 1001, subject: '公务员·行测', chapter: '言语理解', correct: 0, group: '公务员·行测', at: '2026-09-01 10:00:00' },
    { qid: 1001, subject: '公务员·行测', chapter: '言语理解', correct: 0, group: '公务员·行测', at: '2026-09-02 10:00:00' },
    { qid: 1002, subject: '公务员·行测', chapter: '判断推理', correct: 0, group: '公务员·行测', at: '2026-09-01 10:00:00' },
    { qid: 1002, subject: '公务员·行测', chapter: '判断推理', correct: 1, group: '公务员·行测', at: '2026-09-03 10:00:00' },
    { qid: 1003, subject: '公务员·行测', chapter: '数量关系', correct: 0, group: '公务员·行测', at: '2026-09-01 10:00:00' },
    { qid: 1003, subject: '公务员·行测', chapter: '数量关系', correct: 1, group: '公务员·行测', at: '2026-09-02 10:00:00' },
    { qid: 1003, subject: '公务员·行测', chapter: '数量关系', correct: 1, group: '公务员·行测', at: '2026-09-03 10:00:00' },
    { qid: 1003, subject: '公务员·行测', chapter: '数量关系', correct: 1, group: '公务员·行测', at: '2026-09-04 10:00:00' },
    { qid: 1004, subject: '事业编·职测', chapter: '资料分析', correct: 0, archived: 1, group: '事业编·职测', at: '2026-09-01 10:00:00' },
  ]);
  // 主观题单独插（is_correct = NULL）
  const db = new DatabaseSync(path.join(dataDir, 'practice.db'), { timeout: 10000 });
  db.prepare(`INSERT INTO practice_records (user_id, question_id, subject, chapter, question_type, is_correct, created_at) VALUES ('${OWNER}', 1005, '公务员·申论', '归纳概括', 21, NULL, '2026-09-01 10:00:00')`).run();
  db.close();
});

after(async () => {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await rm(dataDir, { recursive: true, force: true });
});

test('掌握度总览：mastered / pending / dismissed 三分且互斥完备', async () => {
  const m = await getJson('/api/records/mastery');
  assert.equal(m.mastered, 1, `已掌握应为 1（题 1003）：${JSON.stringify(m)}`);
  assert.equal(m.pending, 2, `待攻克应为 2（题 1001/1002）：${JSON.stringify(m)}`);
  assert.equal(m.dismissed, 1, `已移出应为 1（题 1004）：${JSON.stringify(m)}`);
  assert.equal(m.total, 3, `环上的题 = mastered + pending = 3：${JSON.stringify(m)}`);
  assert.equal(m.rate, 33, `掌握度 = 1/3 = 33%：${JSON.stringify(m)}`);
  assert.equal(m.okDaysTarget, 3, '掌握阈值应为跨天 3 次');
  // 主观题不参与
  assert.ok(!JSON.stringify(m.bySubject).includes('申论'), `主观题不应进入掌握度：${JSON.stringify(m.bySubject)}`);
});

test('单题掌握度：wrongCount 与 okDays 与记录一致', async () => {
  const data = await getJson('/api/records/wrong?limit=50');
  const byId = new Map(data.list.map((w) => [String(w.questionId), w]));
  assert.equal(data.total, 2, `错题本只应列出未移出的 2 题：${JSON.stringify(data.list.map((w) => w.questionId))}`);

  const a = byId.get('1001');
  assert.ok(a, '题 1001 应在错题本中');
  assert.equal(a.wrongCount, 2, `题 1001 答错 2 次：${JSON.stringify(a)}`);
  assert.equal(a.okDays, 0, `题 1001 从未答对：${JSON.stringify(a)}`);
  assert.equal(a.mastered, false, '题 1001 未掌握');

  const b = byId.get('1002');
  assert.ok(b, '题 1002 应在错题本中');
  assert.equal(b.okDays, 1, `题 1002 答对 1 天：${JSON.stringify(b)}`);
  assert.equal(b.mastered, false, '题 1002 未掌握');

  assert.ok(!byId.has('1003'), '已掌握的题 1003 不应出现在错题本（服务端已自动移出）');
  assert.ok(!byId.has('1004'), '用户主动移出的题 1004 不应出现在错题本');
  assert.ok(!byId.has('1005'), '主观题不应出现在错题本');
});

test('掌握度环上的题量 = 错题本列表题量（待攻克可直接一键重做）', async () => {
  const [m, data] = await Promise.all([getJson('/api/records/mastery'), getJson('/api/records/wrong?limit=200')]);
  assert.equal(
    data.total, m.pending,
    `"一键重做待攻克（N 题）"的 N 必须等于错题本实际题量，否则按钮承诺与结果不符：pending=${m.pending} list=${data.total}`,
  );
  // 分组计数是"一键重做（N 题）"按钮上 N 的来源，必须与列表同口径（曾因 SQL 多写一个 FROM 而 500）
  const groupsRes = await fetch(`${base}/api/records/wrong/groups`);
  assert.equal(groupsRes.status, 200, `分组接口应可用（按钮的 N 取自这里）`);
  const groups = await groupsRes.json();
  const g = groups.find((x) => x.key === '公务员·行测');
  assert.ok(g, `应返回"公务员·行测"分组：${JSON.stringify(groups)}`);
  assert.equal(g.count, m.pending, `分组计数应等于待攻克题量：${g.count} vs ${m.pending}`);
});

test('错题可重做：available 为真且能按 questionId 取回题目', async () => {
  // 回归守卫：node:sqlite 把 JS number 绑成 REAL（1001 → 1001.0），而 questions.questionId 是 TEXT 列，
  // 直接比较会全部落空——表现为所有错题被标成"已移除"、无法重做，且判分退回信任前端传入的 correct。
  const data = await getJson('/api/records/wrong?limit=50');
  assert.ok(data.list.length > 0, '应有错题用于验证');
  for (const w of data.list) {
    assert.equal(w.available, true, `错题 ${w.questionId} 应可从题库取回（available=true），否则无法重做`);
    assert.ok(w.content && w.content.length > 0, `错题 ${w.questionId} 应带题面`);
  }
  const q = await getJson('/api/question?id=1001');
  // /api/question 的响应字段是 id（= questionId），前端按 q.questionId ?? q.id 兼容
  assert.equal(String(q.id), '1001', `按 questionId 取题应命中：${JSON.stringify(q).slice(0, 120)}`);
  assert.ok(Array.isArray(q.options) && q.options.length === 2, `题目选项应完整：${JSON.stringify(q.options)}`);
  assert.equal(q.answer, '0', '应取回权威答案（判分不依赖前端传入的 correct）');
});

test('答对满 3 个不同日期后自动移出错题本（与掌握度判定同源）', async () => {
  const r = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ questionId: 1002, subject: '公务员·行测', chapter: '判断推理', type: 1, selected: [0], correct: true }),
  });
  assert.equal(r.status, 200);
  // 题 1002 此前已有 1 个答对日（09-03），本次实时作答记在"今天"，共 2 个日期 → 仍未掌握
  const m1 = await getJson('/api/records/mastery');
  assert.equal(m1.mastered, 1, `仅 2 个答对日不应判定掌握：${JSON.stringify(m1)}`);
  const w1 = await getJson('/api/records/wrong?limit=50');
  assert.ok(w1.list.some((w) => String(w.questionId) === '1002'), '题 1002 应仍在错题本');

  // 再补一个历史答对日 → 达到 3 天，服务端应自动移出
  const db = new DatabaseSync(path.join(dataDir, 'practice.db'), { timeout: 10000 });
  db.prepare(`INSERT INTO practice_records (user_id, question_id, subject, chapter, question_type, selected, is_correct, created_at) VALUES ('${OWNER}', 1002, '公务员·行测', '判断推理', 1, '[0]', 1, '2026-09-05 10:00:00')`).run();
  db.close();
  // 再触发一次实时答对，让服务端的自动移出逻辑重新计算 okDays
  await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ questionId: 1002, subject: '公务员·行测', chapter: '判断推理', type: 1, selected: [0], correct: true }),
  });
  const m2 = await getJson('/api/records/mastery');
  assert.equal(m2.mastered, 2, `跨 3 个答对日应判定已掌握：${JSON.stringify(m2)}`);
  assert.equal(m2.pending, 1, `题 1002 移出后待攻克剩 1（题 1001）：${JSON.stringify(m2)}`);
  const w2 = await getJson('/api/records/wrong?limit=50');
  assert.ok(!w2.list.some((w) => String(w.questionId) === '1002'), '题 1002 应已自动移出错题本');
  assert.equal(w2.total, m2.pending, '移出后列表题量仍应与 pending 对齐');
});
