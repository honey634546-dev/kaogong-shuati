// test-challenger-2-stress.mjs — Adversarial Stress Test Suite for R3 (Dashboard) and R4 (AI Tutor)
// Challenger 2 Verification Harness

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8600 + Math.floor(Math.random() * 200);
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'kaogong-challenger-2-'));
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server, browser, context, page, batchId;

const STRESS_QUESTIONS = [
  {
    prompt: '【常识判断题】根据我国宪法和法律规定，下列关于公民基本权利的表述正确的是：\nA. 宪法所规定的公民基本权利具有最高法律效力\nB. 任何公民享有宪法和法律规定的权利，同时必须履行宪法和法律规定的义务\nC. 劳动权和受教育权既是公民的权利，不是公民的义务\nD. 我国公民有言论、出版、集会、结社、游行、示威和罢工的自由',
    options: [
      '宪法所规定的公民基本权利具有最高法律效力',
      '任何公民享有宪法和法律规定的权利，同时必须履行宪法和法律规定的义务',
      '劳动权和受教育权既是公民的权利，不是公民的义务',
      '我国公民有言论、出版、集会、结社、游行、示威和罢工的自由',
    ],
    answer: 'B',
    answer_index: 1,
    analysis: '【解析】根据《宪法》规定，公民有劳动的权利和义务，也有受教育的权利和义务。公民享有权利的同时必须履行义务。罢工自由未在我国现行宪法公民基本权利中列举。',
  },
  {
    prompt: '【言语理解题】在信息爆炸的数字时代，人们获取知识的渠道愈发多元，但思维的碎片化和浅表化也日益加剧。我们必须学会在纷繁复杂的信息洪流中______，坚守深度思考的定力。\nA. 去伪存真\nB. 择善而从\nC. 独善其身\nD. 随波逐流',
    options: ['去伪存真', '择善而从', '独善其身', '随波逐流'],
    answer: 'A',
    answer_index: 0,
    analysis: '【解析】横线处对应前文“纷繁复杂的信息洪流”，需要识别甄别信息，“去伪存真”指除掉虚假的，留下真实的，最符合语境。',
  },
];

async function waitForServer() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server failed to start on port ${PORT}`);
}

async function api(url, options = {}) {
  const res = await fetch(`${BASE_URL}${url}`, options);
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  assert.equal(res.ok, true, `API request failed ${url}: ${JSON.stringify(body)}`);
  return body;
}

before(async () => {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(PORT, '127.0.0.1', () => probe.close(resolve));
  });

  server = spawn(process.execPath, ['server.mjs', String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      APP_DATA_DIR: DATA_DIR,
      AUTH_DISABLED: '1',
      AI_MOCK: '1',
      HOST: '127.0.0.1',
    },
    stdio: 'ignore',
  });
  await waitForServer();

  const imported = await api('/api/custom/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Challenger 2 压力测试批次',
      questions: STRESS_QUESTIONS,
    }),
  });
  batchId = imported.id;

  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  } catch {
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
    });
  }

  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
});

beforeEach(async () => {
  page = await context.newPage();
});

afterEach(async () => {
  await page?.close();
  page = null;
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode == null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  await rm(DATA_DIR, { recursive: true, force: true });
});

// Helper: Seed practice records
function seedPracticeRecords(records) {
  const pdbPath = path.join(DATA_DIR, 'practice.db');
  const pdb = new DatabaseSync(pdbPath);
  const insertStmt = pdb.prepare(`
    INSERT INTO practice_records
      (user_id, question_id, subject, chapter, question_type, selected, is_correct, created_at, cost_ms)
    VALUES ('legacy-test-user', ?, '常识判断', '政治常识', 0, 'A', ?, ?, ?)
  `);
  for (const r of records) {
    insertStmt.run(r.question_id || 100, r.is_correct ?? 1, r.created_at, r.cost_ms || 35000);
  }
  pdb.close();
}

function clearPracticeRecords() {
  const pdbPath = path.join(DATA_DIR, 'practice.db');
  const pdb = new DatabaseSync(pdbPath);
  pdb.exec(`DELETE FROM practice_records WHERE user_id = 'legacy-test-user'`);
  pdb.close();
}

async function startQuizInBackMode(p, questions = STRESS_QUESTIONS) {
  await p.goto(BASE_URL);
  await p.locator('#view').waitFor({ timeout: 10000 });
  await p.locator('.today-atmosphere-banner, .today-combat-hero, .today-onboarding').first().waitFor({ timeout: 10000 });
  await p.evaluate((qs) => {
    window.enterQuiz(qs, '常识判断', 'custom', null, null, null, true);
  }, questions);
  await p.locator('.ai-tutor-card').waitFor({ timeout: 10000 });
}

// -------------------------------------------------------------
// Test Group 1: R3 Today Dashboard Stress & Edge Cases
// -------------------------------------------------------------

test('Stress-R3-1: 0 题冷启动零状态与空数据降级', async () => {
  clearPracticeRecords();
  await page.goto(BASE_URL);
  await page.evaluate(() => {
    localStorage.setItem('exam_goal', JSON.stringify({ name: '2026国考', date: '2026-11-28', dailyTarget: 15 }));
  });
  await page.reload();
  await page.locator('.today-combat-hero').waitFor({ timeout: 10000 });

  // 1. 验证 0 题时的仪表盘显示与进度
  const gaugeVal = await page.locator('.gauge-val').textContent();
  const gaugeTarget = await page.locator('.gauge-target').textContent();
  assert.equal(gaugeVal.trim(), '0', '0做题数时 gauge-val 必须为 0');
  assert.equal(gaugeTarget.trim(), '/15题', 'gauge-target 必须显示 /15题');

  // 2. 验证 SVG stroke-dashoffset 处于未开始状态（满偏移 251.3）
  const strokeOffset = await page.locator('.gauge-progress').getAttribute('style');
  assert.ok(strokeOffset.includes('251.3'), `stroke-dashoffset 必须是 251.3: ${strokeOffset}`);

  // 3. 验证四维指标
  const statVals = await page.locator('.stat-item-val').allTextContents();
  assert.equal(statVals[0].trim(), '0 题');
  assert.equal(statVals[1].trim(), '0%');
  assert.equal(statVals[2].trim(), '--', '0题无正确率时应显示 -- 而非 NaN%');
  assert.equal(statVals[3].trim(), '48s/题', '0题实战配速应提供默认安全配速 48s/题');

  const statStatuses = await page.locator('.stat-item-status').allTextContents();
  assert.ok(statStatuses[0].includes('尚未开刷'));
  assert.ok(statStatuses[1].includes('还差 15 题'));
  assert.ok(statStatuses[2].includes('暂无数据'));

  // 4. 验证打卡勋章显示今日待打卡与 ✨ 图标
  const streakText = await page.locator('.punch-badge-title').textContent();
  const flameText = await page.locator('.punch-badge-flame').textContent();
  assert.ok(streakText.includes('今日待打卡'), `零打卡应提示今日待打卡: ${streakText}`);
  assert.ok(flameText.includes('✨'), `零打卡应显示✨: ${flameText}`);
});

test('Stress-R3-2: 100% 正确率与超额达标（50/15 题）边界与安全截断', async () => {
  clearPracticeRecords();
  const now = new Date();
  const nowStr = now.toISOString().replace('T', ' ').slice(0, 19);
  const records = [];
  for (let i = 0; i < 50; i++) {
    records.push({
      question_id: 3000 + i,
      is_correct: 1, // 100% 正确率
      created_at: nowStr,
      cost_ms: 32000,
    });
  }
  seedPracticeRecords(records);

  await page.goto(BASE_URL);
  await page.evaluate(() => {
    localStorage.setItem('exam_goal', JSON.stringify({ name: '2026省考', date: '2026-12-20', dailyTarget: 15 }));
  });
  await page.reload();
  await page.locator('.today-combat-hero').waitFor({ timeout: 10000 });

  // 1. 验证今日刷题 50
  const gaugeVal = await page.locator('.gauge-val').textContent();
  assert.equal(gaugeVal.trim(), '50');

  // 2. 验证 stroke-dashoffset 截断在 0，不得产生负数倒走
  const strokeOffset = await page.locator('.gauge-progress').getAttribute('style');
  assert.ok(strokeOffset.includes('stroke-dashoffset: 0;'), `超额达标 dashoffset 必须截断在 0: ${strokeOffset}`);

  // 3. 验证日目标进度安全截断在 100%
  const statVals = await page.locator('.stat-item-val').allTextContents();
  assert.equal(statVals[0].trim(), '50 题');
  assert.equal(statVals[1].trim(), '100%', '超额完成必须封顶显示 100%');
  assert.equal(statVals[2].trim(), '100%', '100% 正确率显示');

  // 4. 验证达标文案与火热手感状态
  const statStatuses = await page.locator('.stat-item-status').allTextContents();
  assert.ok(statStatuses[1].includes('今日已达标'), '应提示 🎉 今日已达标');
  assert.ok(statStatuses[2].includes('手感火热'), '100% 正确率状态应为手感火热');

  // 5. 验证配速降级安全兜底为 48s/题
  assert.ok(statVals[3].includes('s/题'), '实战配速应保持秒数格式');
});

test('Stress-R3-3: 极端超大打卡天数（25 天真数据与 9999 天超长字符）布局容错与异常负数防御', async () => {
  clearPracticeRecords();
  // 插入连续 25 天打卡记录验证真实服务端推导
  const now = new Date();
  const records = [];
  for (let offset = 24; offset >= 0; offset--) {
    const d = new Date(now);
    d.setDate(d.getDate() - offset);
    const dateStr = d.toISOString().replace('T', ' ').slice(0, 19);
    records.push({
      question_id: 5000 + offset,
      is_correct: 1,
      created_at: dateStr,
      cost_ms: 25000,
    });
  }
  seedPracticeRecords(records);

  await page.goto(BASE_URL);
  await page.locator('.today-streak-badge').waitFor({ timeout: 10000 });

  const streakBadge = page.locator('.today-streak-badge');
  const title = await streakBadge.locator('.punch-badge-title').textContent();
  assert.ok(title.includes('连续 25 天打卡'), `必须正确计算并渲染 25 天连续打卡: ${title}`);
  assert.equal(await streakBadge.locator('.punch-badge-flame').textContent(), '🔥');

  // 进一步压力测试：模拟 9999 天超长极端天数下的布局抗拉伸性
  await page.evaluate(() => {
    const titleEl = document.querySelector('.punch-badge-title');
    if (titleEl) titleEl.textContent = '连续 9999 天打卡';
  });

  const box = await streakBadge.boundingBox();
  assert.ok(box.width > 50 && box.width < 400, `打卡勋章在 9999 天下应保持正常宽度: ${box.width}px`);
  assert.ok(box.height > 20 && box.height < 100, `打卡勋章在 9999 天下高度应正常未换行折断: ${box.height}px`);
});

test('Stress-R3-4: 考期配置缺失、已过期、非法字段时首页健壮性', async () => {
  // Case A: 完全未设置考期
  await page.goto(BASE_URL);
  await page.evaluate(() => localStorage.removeItem('exam_goal'));
  await page.evaluate(() => window.renderToday());
  await page.locator('.today-atmosphere-banner').waitFor({ timeout: 5000 });

  const setGoalBtn = page.locator('#today-set-goal');
  assert.ok(await setGoalBtn.isVisible(), '未设置考期时必须渲染“设定考试目标”按钮');
  assert.ok((await setGoalBtn.textContent()).includes('设定考试目标'));

  // Case B: 考期已过期 (left < 0)
  await page.evaluate(() => {
    localStorage.setItem('exam_goal', JSON.stringify({ name: '2023历史国考', date: '2023-01-01' }));
  });
  await page.evaluate(() => window.renderToday());
  await page.locator('.today-atmosphere-banner').waitFor({ timeout: 5000 });

  const expiredText = await page.locator('.today-countdown').textContent();
  assert.ok(expiredText.includes('已结束'), `过期考期应显示已结束: ${expiredText}`);

  // 确认在没有 #today-set-goal 的情况下页面未抛错
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.locator('.today-atmosphere-banner').click();
  assert.equal(errors.length, 0, '过期考期点击不应产生未捕获异常');

  // Case C: 脏数据 / 非法 JSON
  await page.evaluate(() => {
    localStorage.setItem('exam_goal', '{ bad-json: true ');
  });
  await page.evaluate(() => window.renderToday());
  await page.locator('.today-atmosphere-banner').waitFor({ timeout: 5000 });
  const degradedBtn = page.locator('#today-set-goal');
  assert.ok(await degradedBtn.isVisible(), 'localStorage 脏数据应平稳降级为未设置考期');
});

// -------------------------------------------------------------
// Test Group 2: R4 AI Tutor Shortcut Bubbles & Interactions Stress
// -------------------------------------------------------------

test('Stress-R4-1: 快捷锦囊气泡极速连击（Multi-Click Storming）防重与单发保障', async () => {
  await startQuizInBackMode(page);

  const bubble1 = page.locator('.ai-tutor-tip-btn').first();
  await bubble1.waitFor({ timeout: 5000 });

  // 快速连续触发 5 次 click 事件
  await page.evaluate(() => {
    const btn = document.querySelector('.ai-tutor-tip-btn');
    for (let i = 0; i < 5; i++) {
      btn.click();
    }
  });

  // 等待 AI 回复生成完成
  await page.locator('.ai-tutor-message.assistant .ai-tutor-message-body').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(350); // 确保所有可能由于并发导致的排队消息落地

  // 验证用户发送的消息数量恰好为 1，绝不多发
  const userMessages = await page.locator('.ai-tutor-message.user').count();
  assert.equal(userMessages, 1, `极速 5 连击气泡必须被严格防重拦截为单次发送，实际用户消息数: ${userMessages}`);

  // 验证助手回复数量恰好为 1
  const assistantMessages = await page.locator('.ai-tutor-message.assistant').count();
  assert.equal(assistantMessages, 1, `极速 5 连击助手回复必须为恰好 1 轮，实际助手回复数: ${assistantMessages}`);

  // 验证回复内容包含破题切入点
  const replyContent = await page.locator('.ai-tutor-message.assistant .ai-tutor-message-body').first().textContent();
  assert.ok(replyContent.includes('破题切入点') || replyContent.includes('切入点'), '回复应切题包含切入点点拨');
});

test('Stress-R4-2: AI 思考态加载期间并发点击与快捷气泡防御', async () => {
  await startQuizInBackMode(page);

  // 点击第一个气泡开始生成
  await page.locator('.ai-tutor-tip-btn').nth(0).click();

  // 立即检查是否进入思考态（存在 .ai-tutor-thinking 与 .ai-tutor-dots）
  const thinkingLocator = page.locator('.ai-tutor-thinking');
  assert.ok(await thinkingLocator.isVisible(), '点击气泡后应立即展现 .ai-tutor-thinking 思考态');

  // 在思考态存续期间，所有气泡和发送按钮必须被 disabled
  const disabledCount = await page.locator('.ai-tutor-tip-btn:disabled, .ai-tutor-bubble:disabled').count();
  assert.equal(disabledCount, 3, '思考态期间所有 3 个快捷气泡都必须处于 disabled 状态');

  const sendBtnDisabled = await page.locator('.ai-tutor-send').isDisabled();
  assert.equal(sendBtnDisabled, true, '思考态期间主发送按钮必须 disabled');

  const inputDisabled = await page.locator('.ai-tutor-input').isDisabled();
  assert.equal(inputDisabled, true, '思考态期间输入框必须 disabled');

  // 强行尝试在思考中调用 send
  await page.evaluate(() => {
    const input = document.querySelector('.ai-tutor-input');
    if (input) input.value = '强行插话内容';
    const sendBtn = document.querySelector('.ai-tutor-send');
    if (sendBtn) sendBtn.click();
  });

  // 等待生成结束
  await page.locator('.ai-tutor-message.assistant').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(350);

  // 验证思考态期间的强行点击没有产生额外的消息
  const userMessages = await page.locator('.ai-tutor-message.user').count();
  assert.equal(userMessages, 1, '思考态期间注入的点击不得追加消息');
});

test('Stress-R4-3: 用户输入框未提交草稿在触发快捷气泡时绝对保全', async () => {
  await startQuizInBackMode(page);

  const inputLocator = page.locator('.ai-tutor-input');
  const userDraft = '考生重要草稿：我认为选项C也有疑问，因为关于劳动权和受教育权的具体性质在教材里是...';

  // 1. 用户输入草稿
  await inputLocator.fill(userDraft);
  assert.equal(await inputLocator.inputValue(), userDraft, '输入框应正确填入草稿');

  // 2. 用户转而点击快捷气泡（如第二个辨析点）
  const bubble2 = page.locator('.ai-tutor-tip-btn').nth(1);
  await bubble2.click();

  // 3. 验证在思考生成中及生成完成后，草稿均未被清空或被气泡文字覆盖！
  await page.locator('.ai-tutor-message.assistant').first().waitFor({ timeout: 10000 });
  // 等待控件重新解除 disabled
  await page.locator('.ai-tutor-send:not(:disabled)').waitFor({ timeout: 5000 });

  const draftAfter = await inputLocator.inputValue();
  assert.equal(draftAfter, userDraft, `快捷气泡点击完成后，用户草稿必须完整保留，实际值为: "${draftAfter}"`);

  // 4. 用户恢复输入后点击发送，应能成功提交该草稿
  await page.locator('.ai-tutor-send').click();
  await page.locator('.ai-tutor-message.assistant').nth(1).waitFor({ timeout: 10000 });
  await page.locator('.ai-tutor-send:not(:disabled)').waitFor({ timeout: 5000 });

  // 提交后草稿被清空
  assert.equal(await inputLocator.inputValue(), '', '主动提交草稿后输入框应清空');

  // 会话流中有 2 条用户提问：第 1 条是辨析点快捷气泡，第 2 条是用户的手写草稿
  const allUserTexts = await page.locator('.ai-tutor-message.user .ai-tutor-message-body').allTextContents();
  assert.equal(allUserTexts.length, 2, `用户提问流中应有 2 条记录，当前: ${JSON.stringify(allUserTexts)}`);
  assert.ok(allUserTexts[0].includes('选项之间的核心辨析点在哪里？'), '第 1 条应为快捷气泡提问');
  assert.ok(allUserTexts[1].includes('考生重要草稿'), `第 2 条应包含用户草稿，实际内容: ${allUserTexts[1]}`);
});

test('Stress-R4-4: 连续调用多个快捷锦囊气泡上下文与答案针对性验证', async () => {
  await startQuizInBackMode(page);

  // 触发气泡 1 (切入点)
  await page.locator('.ai-tutor-tip-btn').nth(0).click();
  await page.locator('.ai-tutor-message.assistant').first().waitFor({ timeout: 10000 });
  await page.locator('.ai-tutor-send:not(:disabled)').waitFor({ timeout: 5000 });

  // 触发气泡 3 (陷阱)
  await page.locator('.ai-tutor-tip-btn').nth(2).click();
  await page.locator('.ai-tutor-message.assistant').nth(1).waitFor({ timeout: 10000 });
  await page.locator('.ai-tutor-send:not(:disabled)').waitFor({ timeout: 5000 });

  const assistantTexts = await page.locator('.ai-tutor-message.assistant .ai-tutor-message-body').allTextContents();
  assert.equal(assistantTexts.length, 2, '连续使用快捷锦囊应产生 2 条助教点拨');
  assert.ok(assistantTexts[0].includes('切入点'), '第一轮回复切合切入点');
  assert.ok(assistantTexts[1].includes('限定词') || assistantTexts[1].includes('陷阱'), '第二轮回复切合限定词陷阱');
});

// -------------------------------------------------------------
// Test Group 3: CSS Breathing Animation & Tutor Styling Verification
// -------------------------------------------------------------

test('Verify-CSS-1: 助教思考呼吸动画关键帧与延时交错 (aiTutorPulse)', async () => {
  await page.goto(BASE_URL);

  // 检查 stylesheet 中是否存在 @keyframes aiTutorPulse
  const keyframeExists = await page.evaluate(() => {
    let found = false;
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'aiTutorPulse') {
            found = true;
            break;
          }
        }
      } catch {}
    }
    return found;
  });
  assert.equal(keyframeExists, true, 'CSS 样式表中必须声明 @keyframes aiTutorPulse');

  // 进入背题模式挂载辅导卡并触发思考态
  await startQuizInBackMode(page);

  // 点击气泡进入思考态并检查 3 个 dot 的计算样式
  await page.locator('.ai-tutor-tip-btn').first().click();
  await page.locator('.ai-tutor-dots').waitFor({ timeout: 5000 });

  const dotsInfo = await page.evaluate(() => {
    const dots = document.querySelectorAll('.ai-tutor-dots .dot');
    return Array.from(dots).map((dot) => {
      const style = window.getComputedStyle(dot);
      return {
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationIterationCount: style.animationIterationCount,
        animationDelay: style.animationDelay,
        borderRadius: style.borderRadius,
      };
    });
  });

  assert.equal(dotsInfo.length, 3, '必须恰好渲染 3 个呼吸动画圆点');
  assert.equal(dotsInfo[0].animationName, 'aiTutorPulse', '动画名称必须为 aiTutorPulse');
  assert.equal(dotsInfo[0].animationDuration, '1.2s', '动画周期应为 1.2s');
  assert.equal(dotsInfo[0].animationIterationCount, 'infinite', '动画必须无限循环');

  // 验证交错延时 (staggered delay)
  assert.equal(dotsInfo[0].animationDelay, '0s');
  assert.equal(dotsInfo[1].animationDelay, '0.2s', '第 2 点延时 0.2s');
  assert.equal(dotsInfo[2].animationDelay, '0.4s', '第 3 点延时 0.4s');
});

test('Verify-CSS-2: 助教对话气泡在明/暗双主题下的设计规范还原与对比度', async () => {
  await startQuizInBackMode(page);

  await page.locator('.ai-tutor-tip-btn').first().click();
  await page.locator('.ai-tutor-message.assistant').first().waitFor({ timeout: 10000 });

  // 1. 浅色主题检查：气泡容器 .ai-tutor-message.user 与 .ai-tutor-message.assistant
  const lightStyles = await page.evaluate(() => {
    const userMsg = document.querySelector('.ai-tutor-message.user');
    const assistantMsg = document.querySelector('.ai-tutor-message.assistant');
    return {
      userBg: window.getComputedStyle(userMsg).backgroundColor,
      userColor: window.getComputedStyle(userMsg).color,
      assistantBg: window.getComputedStyle(assistantMsg).backgroundColor,
      assistantColor: window.getComputedStyle(assistantMsg).color,
    };
  });
  assert.notEqual(lightStyles.userBg, 'rgba(0, 0, 0, 0)', '用户消息气泡必须具备实体背景色');
  assert.notEqual(lightStyles.assistantBg, 'rgba(0, 0, 0, 0)', '助教消息气泡必须具备实体背景色');

  // 2. 深色主题检查
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.waitForTimeout(100);

  const darkStyles = await page.evaluate(() => {
    const assistantMsg = document.querySelector('.ai-tutor-message.assistant');
    return {
      assistantBg: window.getComputedStyle(assistantMsg).backgroundColor,
      assistantColor: window.getComputedStyle(assistantMsg).color,
    };
  });
  assert.notEqual(darkStyles.assistantBg, 'rgba(0, 0, 0, 0)', '深色主题下助教气泡背景必须正确适配');
});
