// test-challenger-iter2-deep.mjs — Deep Empirical Stress & Bug Reproduction Suite for Iteration 2
// Challenger 2 Verification Harness for R3 (7-Day Trend Chart) & R4 (AI Tutor Bubbles)

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
const PORT = 8820 + Math.floor(Math.random() * 150);
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'kaogong-challenger-deep-'));
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server, browser, context, page;

const SAMPLE_QUESTIONS = [
  {
    prompt: '【常识判断】根据民法典规定，下列哪一项属于无民事行为能力人？\nA. 8周岁以上不满18周岁未成年人\nB. 不满8周岁的未成年人\nC. 不能完全辨认自己行为的成年人\nD. 16周岁以上不满18周岁以自己劳动收入为主要生活来源的未成年人',
    options: [
      '8周岁以上不满18周岁未成年人',
      '不满8周岁的未成年人',
      '不能完全辨认自己行为的成年人',
      '16周岁以上不满18周岁以自己劳动收入为主要生活来源的未成年人',
    ],
    answer: 'B',
    answer_index: 1,
    analysis: '【解析】根据民法典规定，不满8周岁的未成年人为无民事行为能力人。',
  },
  {
    prompt: '【常识判断】下列关于我国行政处罚的表述正确的是：\nA. 违法行为在二年内未被发现的，不再给予行政处罚\nB. 行政机关因事实不清可以延长听证期限\nC. 任何部门规章都可以设定吊销执照的行政处罚\nD. 行政机关实施罚款必须当场收缴',
    options: [
      '违法行为在二年内未被发现的，不再给予行政处罚',
      '行政机关因事实不清可以延长听证期限',
      '任何部门规章都可以设定吊销执照的行政处罚',
      '行政机关实施罚款必须当场收缴',
    ],
    answer: 'A',
    answer_index: 0,
    analysis: '【解析】违法行为在二年内未被发现的，不再给予行政处罚；涉及公民生命健康安全、金融安全且有危害后果的，上述期限延长至五年。法律另有规定的除外。',
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

function seedCustomMultiDayRecords(dayCounts) {
  // dayCounts is array of 7 numbers: [offset6, offset5, offset4, offset3, offset2, offset1, offset0(today)]
  const pdbPath = path.join(DATA_DIR, 'practice.db');
  const pdb = new DatabaseSync(pdbPath);
  pdb.exec(`DELETE FROM practice_records WHERE user_id = 'legacy-test-user'`);

  const insertStmt = pdb.prepare(`
    INSERT INTO practice_records
      (user_id, question_id, subject, chapter, question_type, selected, is_correct, created_at, cost_ms)
    VALUES ('legacy-test-user', ?, '常识判断', '法律常识', 0, 'A', 1, ?, 30000)
  `);

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');

  let qId = 1000;
  for (let i = 6; i >= 0; i--) {
    const count = dayCounts[6 - i];
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 11:30:00`;
    for (let c = 0; c < count; c++) {
      insertStmt.run(qId++, dateStr);
    }
  }
  pdb.close();
}

// -------------------------------------------------------------
// Test 1: R4 AI Tutor Shortcut Bubbles Exact Contract & Behavior
// -------------------------------------------------------------
test('R4 Deep Stress: 随题 AI 3 个快捷锦囊文本契约、图标与切题持久性', async () => {
  await page.goto(BASE_URL);
  await page.locator('#view').waitFor({ timeout: 10000 });

  // Enter quiz in Recite mode
  await page.evaluate((qs) => {
    window.enterQuiz(qs, '常识判断', 'custom', null, null, null, true);
  }, SAMPLE_QUESTIONS);

  await page.locator('.ai-tutor-card').waitFor({ timeout: 10000 });

  // 1. 校验 3 个预置气泡的完整文本契约与类名
  const bubbles = page.locator('.ai-tutor-tip-btn');
  const count = await bubbles.count();
  assert.equal(count, 3, `必须恰好存在 3 个快捷锦囊气泡，实际数量: ${count}`);

  const bubbleTexts = await bubbles.allTextContents();
  assert.equal(bubbleTexts[0].trim(), '💡 这道题的核心破题切入点是什么？');
  assert.equal(bubbleTexts[1].trim(), '🔍 选项之间的核心辨析点在哪里？');
  assert.equal(bubbleTexts[2].trim(), '⚠️ 题干有没有容易忽视的限定词陷阱？');

  // 2. 校验气泡容器在输入框上方
  const isAboveInput = await page.evaluate(() => {
    const tips = document.querySelector('.ai-tutor-tips');
    const input = document.querySelector('.ai-tutor-input');
    const compose = document.querySelector('.ai-tutor-compose');
    return tips && input && compose && tips.compareDocumentPosition(input) === Node.DOCUMENT_POSITION_FOLLOWING;
  });
  assert.equal(isAboveInput, true, '.ai-tutor-tips 必须在 DOM 结构中位于 .ai-tutor-input 之前');

  // 3. 校验切题后（从第 1 题切换至第 2 题）3 个快捷气泡依然健全
  const nextBtn = page.locator('#quiz-next');
  if (await nextBtn.isVisible()) {
    await nextBtn.click();
    await page.waitForTimeout(300);
    const countAfterSwitch = await page.locator('.ai-tutor-tip-btn').count();
    assert.equal(countAfterSwitch, 3, '切题后 3 个快捷锦囊气泡必须依然完整挂载可用');
  }
});

// -------------------------------------------------------------
// Test 2: R4 AI Tutor Auto-Send with Mocked Delay and Protection
// -------------------------------------------------------------
test('R4 Deep Stress: 点击快捷气泡自动发送并在流中渲染，思考态严密防暴击', async () => {
  await page.goto(BASE_URL);
  await page.locator('#view').waitFor({ timeout: 10000 });

  await page.evaluate((qs) => {
    window.enterQuiz(qs, '常识判断', 'custom', null, null, null, true);
  }, SAMPLE_QUESTIONS);

  await page.locator('.ai-tutor-card').waitFor({ timeout: 10000 });

  // 校验发送前无用户消息
  assert.equal(await page.locator('.ai-tutor-message.user').count(), 0);

  // 点击第 3 个气泡（限定词陷阱）
  const trapBubble = page.locator('.ai-tutor-tip-btn').nth(2);
  await trapBubble.click();

  // 立即检查用户消息是否渲染，且文本完全对应
  const userMsg = page.locator('.ai-tutor-message.user').first();
  await userMsg.waitFor({ timeout: 3000 });
  const userContent = await userMsg.locator('.ai-tutor-message-body').textContent();
  assert.ok(userContent.includes('题干有没有容易忽视的限定词陷阱？'), '用户会话流中必须立即追加快捷气泡文本');

  // 思考态与禁用状态
  assert.ok(await page.locator('.ai-tutor-thinking').isVisible(), '必须展现思考态指示器');
  assert.ok(await trapBubble.isDisabled(), '思考态期间快捷气泡必须 disabled');

  // 等待回复完成
  await page.locator('.ai-tutor-message.assistant').first().waitFor({ timeout: 10000 });
  await page.locator('.ai-tutor-send:not(:disabled)').waitFor({ timeout: 5000 });

  // 回复完成后快捷气泡解除禁用
  assert.equal(await trapBubble.isDisabled(), false, 'AI 回复完成后快捷气泡必须恢复可点击状态');
});

// -------------------------------------------------------------
// Test 3: Pulsing Dot CSS Properties and Dynamic Positioning
// -------------------------------------------------------------
test('R3 Deep Stress: 脉冲呼吸点在不同柱高下的顶部吸附与动画参数严格校验', async () => {
  seedCustomMultiDayRecords([0, 0, 0, 0, 0, 0, 5]);

  await page.goto(BASE_URL);
  await page.locator('.today-week').waitFor({ timeout: 10000 });

  const pulseInfo = await page.evaluate(() => {
    const dot = document.querySelector('.pulse-indicator-dot');
    if (!dot) return null;
    const style = window.getComputedStyle(dot);
    const rect = dot.getBoundingClientRect();
    const fillRect = dot.parentElement.getBoundingClientRect();
    return {
      position: style.position,
      top: style.top,
      animationName: style.animationName,
      borderRadius: style.borderRadius,
      relativeToFillTop: Math.round(rect.top - fillRect.top),
    };
  });

  assert.ok(pulseInfo, '必须存在 .pulse-indicator-dot 元素');
  assert.equal(pulseInfo.position, 'absolute');
  assert.equal(pulseInfo.top, '-7px');
  assert.equal(pulseInfo.animationName, 'pulse-indicator');
  assert.equal(pulseInfo.borderRadius, '50%');
  assert.ok(pulseInfo.relativeToFillTop <= 0, `脉冲点应紧贴柱条顶点外沿，实际偏移: ${pulseInfo.relativeToFillTop}px`);
});

// -------------------------------------------------------------
// Test 4: Empirical Bug Reproduction: Yesterday Data Leakage to Today
// -------------------------------------------------------------
test('R3 Empirical Defect: 昨天作答记录向今日数据泄露与今日柱条/战力 Hero 虚假达标复现', async () => {
  // 极端业务场景：用户昨天作答了 10 道题，今天尚未开始刷题（做题数为 0）
  // 预期：
  // 1. 今日已刷 (.gauge-val) 应当为 0
  // 2. 今日走势柱条 tooltip 应当为 "YYYY-MM-DD：0 题"
  // 3. 今日走势柱条应当具备 .is-empty 类，高度为 8%
  // 实际现象：
  // 由于 api('/api/records/stats?days=1') 在 SQLite 下执行 date(created_at) >= date('now','localtime','-1 days')
  // 导致昨天的 10 题被全部划入 todayStats，使得今日做题数虚高为 10，走势图今日柱条也被撑满为 10 题！
  const dayCounts = [0, 0, 0, 0, 0, 10, 0]; // Day-1: 10题, Day-0(今日): 0题
  seedCustomMultiDayRecords(dayCounts);

  await page.goto(BASE_URL);
  await page.locator('.today-week').waitFor({ timeout: 10000 });

  const gaugeValText = (await page.locator('.gauge-val').textContent()).trim();
  const todayBar = page.locator('.trend-bars-row .trend-bar-col.is-today');
  const todayTitle = await todayBar.getAttribute('title');
  const todayHasEmptyClass = await todayBar.evaluate((el) => el.classList.contains('is-empty'));
  const todayHeight = await todayBar.locator('.trend-bar-fill').evaluate((el) => el.style.height);

  const leakDetected = gaugeValText === '10' && todayTitle.includes('10 题') && !todayHasEmptyClass;
  console.log(`[Defect Observation] gaugeVal: ${gaugeValText}, todayTitle: ${todayTitle}, isEmpty: ${todayHasEmptyClass}, height: ${todayHeight}`);

  if (leakDetected) {
    assert.fail(
      `[CRITICAL BUG REPRODUCED] 昨天记录向今日泄露！用户今日刷题为 0，但仪表盘显示 "今日已刷 ${gaugeValText} 题"，今日柱条显示 "${todayTitle}" 且高度为 ${todayHeight} (应为 8% 且含 .is-empty)。`
    );
  } else {
    assert.equal(gaugeValText, '0', '今日未做题时 gauge-val 必须为 0');
    assert.ok(todayTitle.includes('0 题'), `今日柱条数量必须为 0 题: ${todayTitle}`);
    assert.equal(todayHasEmptyClass, true, '今日未做题时柱条必须包含 .is-empty 类');
  }
});
