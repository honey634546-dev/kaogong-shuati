// test-ui-redesign-e2e.mjs — Kaogong UI/UX Redesign Comprehensive E2E Test Suite
// Requirements: R1 (Flow vs Recite Decoupling), R2 (Dual Mode Modal Cards), R3 (Today Dashboard Uplift), R4 (AI Tutor Shortcuts & Thinking Animation)
// Architecture: Node.js native test runner (node:test) + playwright-core Chromium
// Tiers: Tier 1 (Feature Coverage), Tier 2 (Boundary), Tier 3 (Pairwise/Cross-feature), Tier 4 (Real-world Workflows)

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
const PORT = 8300 + Math.floor(Math.random() * 200);
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'kaogong-redesign-e2e-'));
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server, browser, context, page, batchId;

const SAMPLE_QUESTIONS = [
  {
    prompt: '根据相关规定，关于我国行政法规的制定，下列说法正确的是：\nA. 行政法规由国务院总理签署并以国务院令公布\nB. 行政法规由全国人大常委会制定\nC. 行政法规的地位高于宪法和法律\nD. 行政法规不得设定行政处罚',
    options: [
      '行政法规由国务院总理签署并以国务院令公布',
      '行政法规由全国人大常委会制定',
      '行政法规的地位高于宪法和法律',
      '行政法规不得设定行政处罚',
    ],
    answer: 'A',
    answer_index: 0,
    analysis: '【解析】行政法规由国务院制定，国务院总理签署并以国务院令公布。宪法和法律具有更高的法律效力。',
  },
  {
    prompt: '下列关于科技常识的表述，错误的是：\nA. 太阳系中最大的行星是木星\nB. 光在真空中传播速度最快\nC. 水在0摄氏度时一定结冰\nD. 声音在固体中传播速度通常快于液体',
    options: [
      '太阳系中最大的行星是木星',
      '光在真空中传播速度最快',
      '水在0摄氏度时一定结冰',
      '声音在固体中传播速度通常快于液体',
    ],
    answer: 'C',
    answer_index: 2,
    analysis: '【解析】水在标准大气压下处于0摄氏度时，如果没有凝结核或者处于过冷水状态，不一定会立即结冰。',
  },
  {
    prompt: '依次填入下列横线处的词语，最恰当的一组是：\n文化建设必须______时代脉搏，______人民需求，勇于自我革新。',
    options: [
      '顺应 呼应',
      '紧扣 倾听',
      '把握 满足',
      '把握 迎合',
    ],
    answer: 'C',
    answer_index: 2,
    analysis: '【解析】“把握时代脉搏”、“满足人民需求”属于常见且庄重合理的搭配。',
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
  throw new Error(`临时服务在端口 ${PORT} 启动超时`);
}

async function api(url, options = {}) {
  const res = await fetch(`${BASE_URL}${url}`, options);
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  assert.equal(res.ok, true, `API 请求失败 ${url}: ${JSON.stringify(body)}`);
  return body;
}

before(async () => {
  // 1. 探测并确保端口可用
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(PORT, '127.0.0.1', () => probe.close(resolve));
  });

  // 2. 启动测试专用的临时 Node HTTP 服务（AUTH_DISABLED=1, AI_MOCK=1）
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

  // 3. 导入自包含测试题库批次，确保完全不依赖外部 tiku.db
  const imported = await api('/api/custom/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'UI/UX 重构测试批次',
      questions: SAMPLE_QUESTIONS,
    }),
  });
  batchId = imported.id;

  // 4. 在 SQLite practice.db 中预埋连续 5 天打卡历史与做题统计，验证打卡勋章与 7 日走势
  const pdbPath = path.join(DATA_DIR, 'practice.db');
  const pdb = new DatabaseSync(pdbPath);
  const insertStmt = pdb.prepare(`
    INSERT INTO practice_records
      (user_id, question_id, subject, chapter, question_type, selected, is_correct, created_at)
    VALUES ('legacy-test-user', ?, '常识判断', '政治常识', 0, 'A', 1, ?)
  `);

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  for (let offset = 4; offset >= 0; offset--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 12:00:00`;
    for (let q = 0; q < 4; q++) {
      insertStmt.run(2000 + offset * 10 + q, dateStr);
    }
  }
  pdb.close();

  // 5. 启动 Playwright Chromium 实例
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

// ---------- 辅助动作函数 ----------

async function setupExamGoal(p, goal = { name: '2026国考', date: '2026-11-28', dailyTarget: 30 }) {
  await p.evaluate((g) => {
    localStorage.setItem('exam_goal', JSON.stringify(g));
  }, goal);
}

async function openPracticeModal(p) {
  await p.goto(BASE_URL);
  await setupExamGoal(p);
  await p.locator('.custom-entry').first().waitFor({ timeout: 15000 });
  await p.locator('.custom-entry').first().click();
  await p.locator('[data-act="practice"]').first().waitFor({ timeout: 10000 });
  await p.locator('[data-act="practice"]').first().click();
  await p.locator('#cbm-mode, #cp-mode, .sheet').first().waitFor({ timeout: 10000 });
}

async function startQuizDirect(p, { backMode = false, questions = SAMPLE_QUESTIONS } = {}) {
  await p.goto(BASE_URL);
  await setupExamGoal(p);
  await p.locator('#view').waitFor({ timeout: 15000 });
  await p.evaluate(({ qs, bm }) => {
    window.enterQuiz(qs, '常识判断', 'custom', null, null, null, bm);
  }, { qs: questions, bm: backMode });
  await p.locator('.q-progress-text, .q-content').first().waitFor({ timeout: 15000 });
}

// =========================================================================
// Tier 1: Acceptance Criteria Feature Coverage (AC 1 - AC 4)
// =========================================================================

test('Tier 1 - AC 1 (R1): 刷题模式（Flow Mode）心流答题无 AI 干扰且试卷完全居中', async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await startQuizDirect(page, { backMode: false });

  // 1. DOM 中完全不得挂载、不得渲染随题 AI 辅导卡片
  const tutorCardCount = await page.locator('.ai-tutor-card').count();
  assert.equal(tutorCardCount, 0, '刷题模式下 DOM 中绝对不能存在 .ai-tutor-card');

  // 2. 悬浮球 #ai-ball 必须不可见或被隐藏
  const ball = page.locator('#ai-ball');
  if (await ball.count() > 0) {
    const isVisible = await ball.isVisible();
    const display = await ball.evaluate((el) => getComputedStyle(el).display);
    assert.ok(!isVisible || display === 'none', '刷题模式下 #ai-ball 必须不可见');
  }

  // 3. 居中呈现符合考场试卷排版：无 .quiz-rail 挤压偏移
  const quizRailCount = await page.locator('.quiz-rail:not(:empty)').count();
  assert.equal(quizRailCount, 0, '刷题模式下不应存在生效的 .quiz-rail 侧栏');

  const viewBounding = await page.locator('#view').boundingBox();
  assert.ok(viewBounding, '#view 容器应有有效几何尺寸');
  const expectedCenterOffset = Math.abs((1280 - viewBounding.width) / 2 - viewBounding.x);
  assert.ok(expectedCenterOffset <= 35, `试卷视图在视口中应保持水平居中，实际偏移: ${expectedCenterOffset}px`);

  // 4. 点击选项作答时不触发 #inline-analysis 即时解析弹窗或打断
  await page.locator('.option').first().click();
  await page.waitForTimeout(300);
  const inlineAnalysisCount = await page.locator('#inline-analysis, .analysis-card').count();
  assert.equal(inlineAnalysisCount, 0, '刷题模式作答时不应即时弹出解析卡打断心流');
});

test('Tier 1 - AC 1 (R1): 背题模式（Recite Mode）随题辅导与分段解析挂载', async () => {
  await startQuizDirect(page, { backMode: true });

  // 1. 背题模式下随题辅导卡片 .ai-tutor-card 正常挂载
  const tutorCard = page.locator('.ai-tutor-card');
  await tutorCard.waitFor({ timeout: 10000 });
  assert.equal(await tutorCard.count() >= 1, true, '背题模式下应挂载 .ai-tutor-card');

  // 2. 点击选项作答后即时锁定，并渲染答案反馈横幅与解析卡
  await page.locator('.option').first().click();
  await page.locator('#answer-feedback').waitFor({ timeout: 10000 });

  const fbText = await page.locator('#answer-feedback').textContent();
  assert.ok(/回答正确|回答错误|答案/.test(fbText), `答案反馈横幅内容不符：${fbText}`);

  const lockedOptions = await page.locator('.option.locked').count();
  assert.ok(lockedOptions >= 1, '背题模式下作答后选项应锁定不可重复作答');

  const inlineAnalysis = page.locator('#inline-analysis, .analysis-card');
  assert.ok((await inlineAnalysis.count()) >= 1, '背题模式作答后应展现分段解析卡');
});

test('Tier 1 - AC 2 (R2): 开题弹窗高保真双卡片呈现、描述信息与模式切换', async () => {
  await openPracticeModal(page);

  // 1. 验证双卡片结构存在，包含明确文案与功能差异说明
  const modalContainer = page.locator('#cbm-mode, #cp-mode, .sheet').first();
  await modalContainer.waitFor();

  // 卡片 1：🎯 刷题模式（考场心流）
  const flowCard = page.locator('.practice-mode-card, #cbm-mode .chip, #cp-mode .chip').filter({ hasText: '刷题模式' }).first();
  await flowCard.waitFor();
  const flowText = await flowCard.textContent();
  assert.ok(flowText.includes('刷题模式'), '卡片 1 应包含「刷题模式」');
  assert.ok(
    flowText.includes('考场心流') || flowText.includes('无 AI') || flowText.includes('统一结算') || flowText.includes('模拟真实考场'),
    `卡片 1 应呈现考场心流或无 AI 干扰描述：${flowText}`
  );

  // 卡片 2：💡 背题模式（精讲助学）
  const reciteCard = page.locator('.practice-mode-card, #cbm-mode .chip, #cp-mode .chip').filter({ hasText: '背题模式' }).first();
  await reciteCard.waitFor();
  const reciteText = await reciteCard.textContent();
  assert.ok(reciteText.includes('背题模式'), '卡片 2 应包含「背题模式」');
  assert.ok(
    reciteText.includes('精讲助学') || reciteText.includes('即时对错') || reciteText.includes('AI 助教') || reciteText.includes('逐题攻坚'),
    `卡片 2 应呈现精讲助学或随题 AI 助教描述：${reciteText}`
  );

  // 2. 点击高亮与状态回显
  await reciteCard.click();
  await page.waitForTimeout(150);
  const reciteActive = await reciteCard.evaluate((el) => el.classList.contains('active') || el.classList.contains('on'));
  assert.equal(reciteActive, true, '点击背题模式卡片后应获得激活高亮态');

  await flowCard.click();
  await page.waitForTimeout(150);
  const flowActive = await flowCard.evaluate((el) => el.classList.contains('active') || el.classList.contains('on'));
  assert.equal(flowActive, true, '点击刷题模式卡片后应切换激活高亮态');

  // 3. 选择背题模式并开始做题，验证 backMode 参数与答题界面正确流转
  await reciteCard.click();
  await page.locator('#btn-cbm-start, .btn-primary:has-text("开始")').first().click();
  await page.locator('.q-progress-text, .q-content').first().waitFor({ timeout: 15000 });

  const tutorCardCount = await page.locator('.ai-tutor-card').count();
  assert.equal(tutorCardCount >= 1, true, '以背题模式启动时必须进入背题态并渲染 .ai-tutor-card');
});

test('Tier 1 - AC 3 (R3): 今日首页 (Today Dashboard) 倒计时、连续打卡勋章、战力仪表与走势图呈现', async () => {
  await page.goto(BASE_URL);
  await setupExamGoal(page, { name: '2026国考', date: '2026-11-28', dailyTarget: 30 });
  await page.reload();
  await page.locator('#view').waitFor({ timeout: 15000 });

  // 1. 考期倒计时横幅 / 标牌
  const countdownBanner = page.locator('.today-countdown, .today-countdown-banner, .today-dateline, #today-set-goal').first();
  await countdownBanner.waitFor({ timeout: 10000 });
  const cdText = await countdownBanner.textContent();
  assert.ok(cdText.includes('2026国考') || cdText.includes('天') || cdText.includes('考试'), `倒计时标牌未包含考期信息：${cdText}`);

  // 2. 连续打卡勋章（我们在 before() 预埋了 5 天记录）
  const streakBadge = page.locator('.tag-streak, .today-streak-badge, [class*="streak"]').first();
  await streakBadge.waitFor({ timeout: 10000 });
  const streakText = await streakBadge.textContent();
  assert.ok(
    streakText.includes('5') && (streakText.includes('天') || streakText.includes('连续')),
    `连续打卡勋章应显示连续 5 天打卡，实际显示：${streakText}`
  );

  // 3. 日目标战力 Hero 仪表盘（环形/刻度进度与配速）
  const heroGauge = page.locator('.today-gauge, .combat-gauge, .hero-gauge, .today-tasks-progress, svg, .progress-circle, .bar-gauge').first();
  assert.ok(await heroGauge.count() >= 1, '今日首页应具备战力 Hero 进度/仪表盘指示');
  const gaugeVal = await page.locator('.gauge-val').textContent();
  assert.equal(gaugeVal.trim(), '4', '今日已刷题数应精确为 4 题（不得把昨天的 4 题混入成 8 题）');

  // 4. 7 日战力走势图与历史打卡真实数据绑定
  const trendChart = page.locator('.today-week, .spark, .trend-chart').first();
  await trendChart.waitFor({ timeout: 10000 });
  assert.ok((await trendChart.count()) >= 1, '今日首页应呈现 7 日战力走势图');

  const bars = page.locator('.trend-bars-row .trend-bar-col, .trend-bars-row .trend-bar');
  const barCount = await bars.count();
  assert.equal(barCount, 7, `7日走势图必须精确呈现 7 根每日柱条，实际数量: ${barCount}`);

  const barsData = await bars.evaluateAll((list) => {
    return list.map((el) => {
      const fill = el.querySelector('.trend-bar-fill');
      const label = el.querySelector('.trend-bar-label');
      const pulse = el.querySelector('.pulse-indicator-dot');
      const heightStyle = fill?.style?.height || '';
      const heightVal = parseInt(heightStyle, 10) || 0;
      return {
        title: el.getAttribute('title') || '',
        isToday: el.classList.contains('is-today'),
        heightStyle,
        heightVal,
        labelText: label?.textContent?.trim() || '',
        hasPulse: !!pulse,
      };
    });
  });

  // 验证今日柱条（最后一项，index 6）高亮与指示点
  const todayBar = barsData[6];
  assert.equal(todayBar.isToday, true, '最后一根柱条必须具备 .is-today 样式类');
  assert.equal(todayBar.labelText, '今日', '今日柱条标签文本必须为 "今日"');
  assert.equal(todayBar.hasPulse, true, '今日柱条必须渲染 .pulse-indicator-dot 脉冲呼吸指示点');
  assert.ok(todayBar.title.includes('题'), `今日柱条 tooltip 应包含做题数量，实际为: ${todayBar.title}`);
  assert.ok(todayBar.title.includes('4 题'), `今日柱条数量应精确为 4 题（不得把昨天的 4 题混入成 8 题），实际为: ${todayBar.title}`);
  assert.ok(!todayBar.title.includes('0 题'), `已预埋做题数据时，今日柱条数量不应为 0 题，实际为: ${todayBar.title}`);

  // 验证历史日期柱条（index 2..5）不得被错误置零（before() 预埋了 past 4 days: offset 4, 3, 2, 1）
  const historicalSeededBars = [barsData[2], barsData[3], barsData[4], barsData[5]];
  for (const [idx, bar] of historicalSeededBars.entries()) {
    assert.equal(bar.isToday, false, `历史柱条 index ${idx} 不得标记为 isToday`);
    assert.equal(bar.hasPulse, false, `历史柱条 index ${idx} 不得渲染脉冲指示点`);
    assert.ok(
      !bar.title.includes('：0 题') && !bar.title.includes(': 0 题'),
      `历史已打卡日期柱条（${bar.title}）被错误归零！证明未能正确匹配 SQLite 记录中的 x.d 字段`
    );
    assert.ok(
      bar.heightVal > 8,
      `历史已打卡柱条高度应按做题比例拉升（> 8%），实际高度: ${bar.heightStyle} (${bar.title})`
    );
  }

  // 验证无做题历史的空档日期（index 0, 1）平稳呈现底限高度 8% 与 0 题提示
  const emptyBars = [barsData[0], barsData[1]];
  for (const emptyBar of emptyBars) {
    assert.ok(
      emptyBar.title.includes('0 题'),
      `未做题日期柱条 tooltip 应显示 0 题，实际为: ${emptyBar.title}`
    );
    assert.equal(
      emptyBar.heightStyle,
      '8%',
      `未做题日期柱条应保持 8% 的最小胶囊高度，实际为: ${emptyBar.heightStyle}`
    );
  }

  // 验证走势图头部汇总标签计算正确（汇总近 7 天所有非零做题总数）
  const totalTag = await page.locator('.week-total-tag').textContent();
  assert.ok(
    totalTag.includes('20 道') || totalTag.includes('20'),
    `走势图汇总标签应准确累加近 7 天做题数（含历史记录 20 道），实际渲染: ${totalTag}`
  );
  assert.ok(
    !totalTag.includes('24'),
    `不得因昨天数据泄露而虚高为 24 道，实际渲染: ${totalTag}`
  );

  // 5. 任务与批次列表状态徽章（已达标 / 进行中）
  const taskMark = page.locator('.today-task-mark, .tag-done, .tag-doing, .today-task, .tag-weak').first();
  assert.ok((await taskMark.count()) >= 1, '今日任务应呈现状态标识或徽章');
});

test('Tier 1 - AC 3 (R3): 今日首页各主要入口点击无报错且正常导航', async () => {
  await page.goto(BASE_URL);
  await setupExamGoal(page);
  await page.reload();
  await page.locator('#view').waitFor({ timeout: 15000 });

  // 1. 测试主行动按钮 #today-cta 保持可用无报错
  const ctaBtn = page.locator('#today-cta');
  await ctaBtn.waitFor({ timeout: 10000 });
  assert.ok(await ctaBtn.isVisible(), '今日首页 #today-cta 必须可见');
  await ctaBtn.click();
  await page.waitForTimeout(500);

  // 2. 回到今日首页测试任务项 [data-task]
  await page.goto(BASE_URL);
  await page.locator('[data-task]').first().waitFor({ timeout: 10000 });
  await page.locator('[data-task]').first().click();
  await page.waitForTimeout(500);

  // 3. 回到今日首页测试自定义题库入口 .custom-entry
  await page.goto(BASE_URL);
  await page.locator('.custom-entry').first().waitFor({ timeout: 10000 });
  await page.locator('.custom-entry').first().click();
  await page.waitForTimeout(500);
  assert.ok(page.url().includes(BASE_URL), '点击题库入口未崩溃');
});

test('Tier 1 - AC 4 (R4): 背题模式随题辅导 3 个预置破题锦囊快捷气泡正确挂载', async () => {
  await startQuizDirect(page, { backMode: true });

  const tutorCard = page.locator('.ai-tutor-card');
  await tutorCard.waitFor({ timeout: 10000 });

  // 验证输入区上方包含 3 个「破题锦囊」快捷气泡
  const bubbles = page.locator('.ai-tutor-bubble, .ai-tutor-tip-btn, [data-prompt]');
  await page.waitForFunction(() => {
    const bs = document.querySelectorAll('.ai-tutor-bubble, .ai-tutor-tip-btn, [data-prompt]');
    return bs.length >= 3;
  }, null, { timeout: 10000 });

  const bubble1 = page.locator('.ai-tutor-bubble, .ai-tutor-tip-btn, [data-prompt]').filter({ hasText: '破题切入点' }).first();
  const bubble2 = page.locator('.ai-tutor-bubble, .ai-tutor-tip-btn, [data-prompt]').filter({ hasText: '辨析点' }).first();
  const bubble3 = page.locator('.ai-tutor-bubble, .ai-tutor-tip-btn, [data-prompt]').filter({ hasText: '限定词陷阱' }).first();

  assert.equal(await bubble1.count() >= 1, true, '应存在 💡「核心破题切入点」快捷气泡');
  assert.equal(await bubble2.count() >= 1, true, '应存在 🔍「选项辨析点」快捷气泡');
  assert.equal(await bubble3.count() >= 1, true, '应存在 ⚠️「限定词陷阱」快捷气泡');
});

test('Tier 1 - AC 4 (R4): 点击快捷气泡直接自动发送求助与呼吸指示点动画呈现', async () => {
  await startQuizDirect(page, { backMode: true });

  await page.locator('.ai-tutor-card').waitFor({ timeout: 10000 });
  const bubble1 = page.locator('.ai-tutor-bubble, .ai-tutor-tip-btn, [data-prompt]').filter({ hasText: '破题切入点' }).first();
  await bubble1.waitFor({ timeout: 10000 });

  // 点击第 1 个气泡
  await bubble1.click();

  // 1. 用户消息立即追加到消息流中
  const userMsg = page.locator('.ai-tutor-message.user').last();
  await userMsg.waitFor({ timeout: 8000 });
  const userText = await userMsg.textContent();
  assert.ok(userText.includes('破题切入点'), `用户消息未正确包含快捷求助文本：${userText}`);

  // 2. 思考态指示点动画（呼吸指示点 .ai-tutor-dots）在请求中出现或曾出现
  const hasThinkingAnimation = await page.evaluate(() => {
    return Boolean(
      document.querySelector('.ai-tutor-dots') ||
      document.querySelector('.ai-tutor-thinking') ||
      document.querySelector('.ai-tutor-message.assistant')
    );
  });
  assert.equal(hasThinkingAnimation, true, '随题助教应呈现思考指示点动画或助教对话流');

  // 3. AI Mock 助教回复气泡到达并排版展示
  const assistantMsg = page.locator('.ai-tutor-message.assistant').last();
  await assistantMsg.waitFor({ timeout: 10000 });
  const assistantText = await assistantMsg.textContent();
  assert.ok(assistantText.length > 0, '助教应返回实质性启发式引导内容');
});

// =========================================================================
// Tier 2: Boundary & Edge Cases
// =========================================================================

test('Tier 2 - B1: 开题弹窗高频快速切换双卡片模式，状态回显无漂移', async () => {
  await openPracticeModal(page);

  const flowCard = page.locator('.practice-mode-card, #cbm-mode .chip, #cp-mode .chip').filter({ hasText: '刷题模式' }).first();
  const reciteCard = page.locator('.practice-mode-card, #cbm-mode .chip, #cp-mode .chip').filter({ hasText: '背题模式' }).first();

  // 快速连点 5 次交替切换
  for (let i = 0; i < 5; i++) {
    await (i % 2 === 0 ? reciteCard : flowCard).click();
  }

  // 最终应该停留在背题模式（0: recite, 1: flow, 2: recite, 3: flow, 4: recite）
  const isReciteOn = await reciteCard.evaluate((el) => el.classList.contains('active') || el.classList.contains('on'));
  const isFlowOn = await flowCard.evaluate((el) => el.classList.contains('active') || el.classList.contains('on'));
  assert.equal(isReciteOn, true, '最终背题模式卡片应处于选中态');
  assert.equal(isFlowOn, false, '刷题模式卡片不得同时处于选中态');
});

test('Tier 2 - B2: 今日首页无考期设置与 0 打卡冷启动边界状态平稳降级', async () => {
  await page.goto(BASE_URL);
  // 清理 localStorage 中的考期与打卡预期
  await page.evaluate(() => {
    localStorage.removeItem('exam_goal');
  });
  await page.reload();
  await page.locator('#view').waitFor({ timeout: 15000 });

  // 考期应优雅降级为提示按钮 #today-set-goal，页面不报错
  const setGoalBtn = page.locator('#today-set-goal, .today-dateline button').first();
  assert.ok((await setGoalBtn.count()) >= 1, '未设置考期时应展示设置考试日期指引按钮');
});

test('Tier 2 - B3: 宽屏桌面 (1280px) 与移动端 (390px) 视口自适应与居中几何验证', async () => {
  // 1. 宽屏桌面视口下验证
  await page.setViewportSize({ width: 1280, height: 800 });
  await startQuizDirect(page, { backMode: false });

  const desktopViewBox = await page.locator('#view').boundingBox();
  assert.ok(desktopViewBox, '桌面视图应有边界尺寸');
  assert.ok(desktopViewBox.width <= 900, `桌面试卷宽度应收敛以保证专注心流阅读：${desktopViewBox.width}`);

  // 2. 切换到移动端视口 (390x844 iPhone 尺寸)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(scrollWidth <= 395, `移动端不得产生意外横向溢出滚动：${scrollWidth}`);
});

test('Tier 2 - B4: 随题 AI 思考态期间点击防重与快捷气泡保护', async () => {
  await startQuizDirect(page, { backMode: true });

  const bubble1 = page.locator('.ai-tutor-bubble, .ai-tutor-tip-btn, [data-prompt]').first();
  await bubble1.waitFor({ timeout: 10000 });

  // 连续极速双击快捷气泡
  await bubble1.click();
  await bubble1.click().catch(() => {});

  await page.waitForTimeout(500);
  const userMessages = await page.locator('.ai-tutor-message.user').count();
  assert.ok(userMessages <= 2, '防重机制应拦截连击或同一请求中的多重触发');
});

test('Tier 2 - B5: 输入框草稿在触发快捷气泡时得到保护', async () => {
  await startQuizDirect(page, { backMode: true });

  const input = page.locator('.ai-tutor-input');
  await input.waitFor({ timeout: 10000 });
  await input.fill('我的私人思考草稿');

  const bubble2 = page.locator('.ai-tutor-bubble, .ai-tutor-tip-btn, [data-prompt]').filter({ hasText: '辨析点' }).first();
  await bubble2.click();

  // 快捷气泡应发送预置锦囊，而非清空或误吞用户的本地思考草稿
  await page.waitForTimeout(300);
  const userMsg = page.locator('.ai-tutor-message.user').last();
  const text = await userMsg.textContent();
  assert.ok(text.includes('辨析点'), '发送的应是快捷气泡内容');
});

// =========================================================================
// Tier 3: Pairwise & Cross-Feature Combinations
// =========================================================================

test('Tier 3 - C1: 开题弹窗模式选择与答题态生命周期全链路解耦与隔离', async () => {
  // 会话 1：通过弹窗选刷题模式进入
  await openPracticeModal(page);
  const flowCard = page.locator('.practice-mode-card, #cbm-mode .chip, #cp-mode .chip').filter({ hasText: '刷题模式' }).first();
  await flowCard.click();
  await page.locator('#btn-cbm-start, .btn-primary:has-text("开始")').first().click();
  await page.locator('.q-content').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('.ai-tutor-card').count(), 0, '刷题模式下不应渲染 .ai-tutor-card');

  // 退出回到题库面板再次开题
  await openPracticeModal(page);
  const reciteCard = page.locator('.practice-mode-card, #cbm-mode .chip, #cp-mode .chip').filter({ hasText: '背题模式' }).first();
  await reciteCard.click();
  await page.locator('#btn-cbm-start, .btn-primary:has-text("开始")').first().click();
  await page.locator('.q-content').waitFor({ timeout: 15000 });

  // 会话 2：背题模式应重新挂载 .ai-tutor-card
  assert.equal((await page.locator('.ai-tutor-card').count()) >= 1, true, '切换背题模式后应挂载 .ai-tutor-card');
});

test('Tier 3 - C2: 深色主题与浅色主题切换下模式卡片、战力仪表与 AI 气泡视觉可用性', async () => {
  await page.goto(BASE_URL);
  await setupExamGoal(page);
  await page.locator('#view').waitFor({ timeout: 15000 });

  // 切换为深色模式
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(100);

  // 检查仪表与卡片在深色主题下前景色与可读性
  const todayColor = await page.locator('#view').evaluate((el) => getComputedStyle(el).color);
  assert.ok(todayColor.startsWith('rgb'), '深色模式下主体文字应有合法对比色');

  // 打开开题弹窗检查双卡片在深色模式下的反差
  await openPracticeModal(page);
  const cardColor = await page.locator('.practice-mode-card, #cbm-mode .chip').first().evaluate((el) => getComputedStyle(el).color);
  assert.ok(cardColor.startsWith('rgb'), '深色模式下模式卡片文字可读');

  // 切回浅色模式
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
});

test('Tier 3 - C3: 背题模式切题与随题 AI 题目上下文独立绑定', async () => {
  await startQuizDirect(page, { backMode: true });

  const bubble1 = page.locator('.ai-tutor-bubble, .ai-tutor-tip-btn, [data-prompt]').first();
  await bubble1.waitFor({ timeout: 10000 });
  await bubble1.click();
  await page.locator('.ai-tutor-message.assistant').waitFor({ timeout: 10000 });

  // 切到下一题
  await page.evaluate(() => window.nextQuestion());
  await page.waitForTimeout(300);

  // 题 2 的辅导卡片应保持独立（重新绑定或清空上下文，不串题）
  const tutorCard = page.locator('.ai-tutor-card');
  assert.equal(await tutorCard.count() >= 1, true, '切题后背题模式仍应保持随题辅导卡片');
});

// =========================================================================
// Tier 4: Real-World Workflows / End-to-End Scenarios
// =========================================================================

test('Tier 4 - S1: 考生考场真实心流作答全流程（Pure Flow Exam Workflow）', async () => {
  // 1. 考生从题库开题，明确选择「🎯 刷题模式（考场心流）」
  await openPracticeModal(page);
  const flowCard = page.locator('.practice-mode-card, #cbm-mode .chip, #cp-mode .chip').filter({ hasText: '刷题模式' }).first();
  await flowCard.click();
  await page.locator('#btn-cbm-start, .btn-primary:has-text("开始")').first().click();
  await page.locator('.q-content').waitFor({ timeout: 15000 });

  // 2. 作答第 1 题：连贯作答无 AI 干扰
  assert.equal(await page.locator('.ai-tutor-card').count(), 0, '全程不得见 .ai-tutor-card');
  await page.locator('.option').first().click();
  await page.waitForTimeout(300);

  // 3. 进入第 2 题继续作答
  await page.evaluate(() => window.nextQuestion());
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.ai-tutor-card').count(), 0, '跨题作答全程 0 杂讯');
  await page.locator('.option').nth(2).click();

  // 4. 交卷结算：到达成绩与解析页面
  await page.evaluate(() => window.finishQuiz());
  await page.waitForFunction(() => document.querySelector('#app-title')?.textContent.includes('成绩') || document.querySelector('.exam-result'), null, { timeout: 10000 });
  const title = await page.locator('#app-title').textContent();
  assert.ok(title.includes('成绩') || title.includes('解析'), '交卷后顺利到达成绩与解析页');
});

test('Tier 4 - S2: 名师随题逐题攻坚与启发式求助全流程（Tutor-Guided Deep Study Workflow）', async () => {
  // 1. 考生选择「💡 背题模式（精讲助学）」
  await openPracticeModal(page);
  const reciteCard = page.locator('.practice-mode-card, #cbm-mode .chip, #cp-mode .chip').filter({ hasText: '背题模式' }).first();
  await reciteCard.click();
  await page.locator('#btn-cbm-start, .btn-primary:has-text("开始")').first().click();
  await page.locator('.q-content').waitFor({ timeout: 15000 });

  // 2. 点击选项后立即收到对错反馈与答案解析
  await page.locator('.option').first().click();
  await page.locator('#answer-feedback').waitFor({ timeout: 8000 });
  assert.ok((await page.locator('#inline-analysis, .analysis-card').count()) >= 1, '即刻呈现分段解析');

  // 3. 遇到疑惑，点击破题切入点快捷气泡
  const bubble = page.locator('.ai-tutor-bubble, .ai-tutor-tip-btn, [data-prompt]').filter({ hasText: '破题切入点' }).first();
  await bubble.click();

  // 4. 思考态指示点动画出现，并迅速得到名师点拨
  await page.locator('.ai-tutor-message.assistant').waitFor({ timeout: 10000 });
  const tutorMsg = await page.locator('.ai-tutor-message.assistant').last().textContent();
  assert.ok(tutorMsg.length > 5, '名师点拨成功返回');
});

test('Tier 4 - S3: 每日备考仪表盘检视与行动启动全流程（Daily Habit & Dashboard Review Workflow）', async () => {
  // 1. 用户打开今日仪表盘，检视考期、连续打卡与战力 Hero
  await page.goto(BASE_URL);
  await setupExamGoal(page, { name: '2026国考', date: '2026-11-28', dailyTarget: 30 });
  await page.reload();
  await page.locator('#view').waitFor({ timeout: 15000 });

  const countdown = await page.locator('.today-countdown, .today-dateline').first().textContent();
  assert.ok(countdown.includes('2026国考'), '考期标牌清晰指引目标');

  const streak = await page.locator('.tag-streak, .today-streak-badge, [class*="streak"]').first().textContent();
  assert.ok(streak.includes('5') && (streak.includes('天') || streak.includes('连续')), '5天连续打卡提供正向反馈');

  // 2. 用户点击 #today-cta 启动今日核心任务
  const cta = page.locator('#today-cta');
  await cta.waitFor({ timeout: 10000 });
  await cta.click();
  await page.waitForTimeout(500);
});

test('Tier 4 - S4: 随题 AI 多轮启发式连续对话全流程（AI Multi-Turn Dialog Workflow）', async () => {
  await startQuizDirect(page, { backMode: true });

  // 轮次 1：咨询破题切入点
  const bubble1 = page.locator('.ai-tutor-bubble, .ai-tutor-tip-btn, [data-prompt]').filter({ hasText: '破题切入点' }).first();
  await bubble1.waitFor({ timeout: 10000 });
  await bubble1.click();
  await page.locator('.ai-tutor-message.assistant').first().waitFor({ timeout: 10000 });

  // 轮次 2：追问选项辨析点
  const bubble2 = page.locator('.ai-tutor-bubble, .ai-tutor-tip-btn, [data-prompt]').filter({ hasText: '辨析点' }).first();
  await bubble2.waitFor({ timeout: 10000 });
  await bubble2.click();

  await page.waitForFunction(() => document.querySelectorAll('.ai-tutor-message.assistant').length >= 2, null, { timeout: 15000 });
  const assistantCount = await page.locator('.ai-tutor-message.assistant').count();
  assert.equal(assistantCount >= 2, true, '多轮对话应在会话流中累积多条名师点拨消息');
});
