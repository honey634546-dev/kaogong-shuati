// test-challenger-iter2-empirical.mjs — Iteration 2 Empirical Stress Test Harness
// Challenger 1: Deep Adversarial Verification of R1 (Flow Mode Decoupling & Centering) & R2 (Dual Cards Dialogs)

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8800 + Math.floor(Math.random() * 150);
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'kaogong-challenger-iter2-'));
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server, browser, context, page, batchId;

const STRESS_QUESTIONS = [
  {
    id: 101,
    content: '【常识判断】根据我国《宪法》，关于国家机构的职权，下列说法正确的是：\nA. 全国人民代表大会常务委员会有权决定特赦\nB. 国务院有权批准省、自治区、直辖市的建置\nC. 国家监察委员会对全国人民代表大会负责并报告工作\nD. 最高人民检察院领导地方各级人民检察院和专门人民检察院的工作',
    prompt: '【常识判断】根据我国《宪法》，关于国家机构的职权，下列说法正确的是：\nA. 全国人民代表大会常务委员会有权决定特赦\nB. 国务院有权批准省、自治区、直辖市的建置\nC. 国家监察委员会对全国人民代表大会负责并报告工作\nD. 最高人民检察院领导地方各级人民检察院和专门人民检察院的工作',
    options: [
      '全国人民代表大会常务委员会有权决定特赦',
      '国务院有权批准省、自治区、直辖市的建置',
      '国家监察委员会对全国人民代表大会负责并报告工作',
      '最高人民检察院领导地方各级人民检察院和专门人民检察院的工作',
    ],
    answer: 'A',
    answer_index: 0,
    analysis: '【解析】A项正确，宪法第67条规定全国人大常委会有权决定特赦。B项错误，批准省、自治区、直辖市建置属于全国人大职权。C项宪法第126条规定国家监察委员会对全国人民代表大会及其常委会负责。D项最高检领导地方各级检察院。',
  },
  {
    id: 102,
    content: '【言语理解】在当代技术变迁中，如果只注重硬件基础设施的搭建，而忽视了软性治理机制的建设，就极易产生“技术空转”。治理者应当保持清醒，______推动技术与制度的深度协同。\nA. 标本兼治\nB. 循序渐进\nC. 因地制宜\nD. 固步自封',
    prompt: '【言语理解】在当代技术变迁中，如果只注重硬件基础设施的搭建，而忽视了软性治理机制的建设，就极易产生“技术空转”。治理者应当保持清醒，______推动技术与制度的深度协同。\nA. 标本兼治\nB. 循序渐进\nC. 因地制宜\nD. 固步自封',
    options: ['标本兼治', '循序渐进', '因地制宜', '固步自封'],
    answer: 'A',
    answer_index: 0,
    analysis: '【解析】硬件与制度对应标与本，“标本兼治”最切合题意。',
  },
  {
    id: 103,
    content: '【资料分析材料题】2025年某高新技术开发区完成固定资产投资450亿元，比上年增长15.0%。其中高新技术制造业投资210亿元，同比增长22.5%；高新技术服务业投资140亿元，同比增长12.0%。\n\n问：2024年该开发区高新技术制造业投资约为多少亿元？',
    prompt: '【资料分析材料题】2025年某高新技术开发区完成固定资产投资450亿元，比上年增长15.0%。其中高新技术制造业投资210亿元，同比增长22.5%；高新技术服务业投资140亿元，同比增长12.0%。\n\n问：2024年该开发区高新技术制造业投资约为多少亿元？',
    material: '2025年某高新技术开发区完成固定资产投资450亿元，比上年增长15.0%。其中高新技术制造业投资210亿元，同比增长22.5%；高新技术服务业投资140亿元，同比增长12.0%。高技术研发人员达1.8万人。',
    options: ['171.4亿元', '187.5亿元', '195.0亿元', '162.8亿元'],
    answer: 'A',
    answer_index: 0,
    analysis: '【解析】基期量 = 210 / (1 + 22.5%) ≈ 210 / 1.225 ≈ 171.4 亿元。',
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
      name: 'Challenger Iter2 深度实证批次',
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
  try { await context?.close(); } catch {}
  try { await browser?.close(); } catch {}
  try {
    if (server) {
      server.kill();
      await new Promise((resolve) => server.once('exit', resolve));
    }
  } catch {}
  try {
    await rm(DATA_DIR, { recursive: true, force: true });
  } catch {}
});

async function setupExamGoal(p, goal = { name: '2026国考', date: '2026-11-28', dailyTarget: 30 }) {
  await p.evaluate((g) => {
    localStorage.setItem('exam_goal', JSON.stringify(g));
  }, goal);
}

async function startQuizDirect(p, { backMode = false, questions = STRESS_QUESTIONS } = {}) {
  await p.goto(BASE_URL);
  await setupExamGoal(p);
  await p.locator('#view').waitFor({ timeout: 15000 });
  await p.evaluate(({ qs, bm }) => {
    window.enterQuiz(qs, '常识判断', 'custom', null, null, null, bm);
  }, { qs: questions, bm: backMode });
  await p.locator('.q-progress-text, .q-content').first().waitFor({ timeout: 15000 });
}

// =========================================================================
// TEST 1: R1 True Centering Geometry & Zero AI Under Dynamic Resizing
// =========================================================================
test('Empirical R1-1: Dynamic viewport resizing across 7 breakpoints during active Flow session preserves strict centering', async () => {
  await startQuizDirect(page, { backMode: false });

  const DYNAMIC_BREAKPOINTS = [
    { w: 2560, h: 1440, name: '2K Ultrawide', isDesktop: true },
    { w: 1920, h: 1080, name: '1080p Desktop', isDesktop: true },
    { w: 1280, h: 800,  name: 'Standard Laptop', isDesktop: true },
    { w: 1024, h: 768,  name: 'Desktop/Tablet Breakpoint (1024px)', isDesktop: true },
    { w: 900,  h: 700,  name: 'Sub-1024 Tablet', isDesktop: false },
    { w: 600,  h: 900,  name: 'Phablet', isDesktop: false },
    { w: 320,  h: 568,  name: 'Compact iPhone SE', isDesktop: false },
  ];

  for (const bp of DYNAMIC_BREAKPOINTS) {
    await page.setViewportSize({ width: bp.w, height: bp.h });
    await page.waitForTimeout(100);

    const metrics = await page.evaluate((isDesktop) => {
      const view = document.getElementById('view');
      const rect = view.getBoundingClientRect();
      const winW = window.innerWidth;
      const leftGap = rect.left;
      const rightGap = winW - rect.right;
      const asymmetry = Math.abs(leftGap - rightGap);

      const sideNav = document.getElementById('side-nav');
      const sideNavDisplay = sideNav ? window.getComputedStyle(sideNav).display : 'none';
      const bodyPaddingLeft = parseFloat(window.getComputedStyle(document.body).paddingLeft || '0');

      const hOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
      const aiTutorCards = document.querySelectorAll('.ai-tutor-card').length;
      const quizRails = document.querySelectorAll('.quiz-rail').length;
      const aiBall = document.getElementById('ai-ball');
      const aiBallDisplay = aiBall ? window.getComputedStyle(aiBall).display : 'none';

      return {
        leftGap, rightGap, asymmetry, winW, rectWidth: rect.width,
        isDesktop, sideNavDisplay, bodyPaddingLeft, hOverflow,
        aiTutorCards, quizRails, aiBallDisplay,
      };
    }, bp.isDesktop);

    assert.equal(metrics.hOverflow, false, `[${bp.name}] No horizontal overflow`);
    assert.equal(metrics.aiTutorCards, 0, `[${bp.name}] Zero .ai-tutor-card in Flow mode`);
    assert.equal(metrics.quizRails, 0, `[${bp.name}] Zero .quiz-rail in Flow mode`);
    assert.equal(metrics.aiBallDisplay, 'none', `[${bp.name}] #ai-ball display must be none`);

    if (bp.isDesktop) {
      assert.equal(metrics.sideNavDisplay, 'none', `[${bp.name}] Side nav hidden on desktop in flow mode`);
      assert.equal(metrics.bodyPaddingLeft, 0, `[${bp.name}] Body padding-left must be 0 in flow mode`);
      assert.ok(metrics.asymmetry <= 2.0, `[${bp.name}] Desktop centering asymmetry must be <= 2px (observed: ${metrics.asymmetry}px)`);
    } else {
      assert.ok(metrics.asymmetry <= 5.0, `[${bp.name}] Mobile/tablet asymmetry must be <= 5px (observed: ${metrics.asymmetry}px)`);
    }
  }
});

// =========================================================================
// TEST 2: R1 In-Quiz Overlays & Interactions Purity (答题卡, 收藏, 暂停, 排除法)
// =========================================================================
test('Empirical R1-2: In-quiz sheets (答题卡, 收藏, 暂停, 选项排除) maintain strict zero AI and flow purity', async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await startQuizDirect(page, { backMode: false });

  // 1. Star / Unstar Question
  const favBtn = page.locator('#q-fav');
  await favBtn.click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => store.fav.has(store.state.questions[0].id)), true);
  await favBtn.click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => store.fav.has(store.state.questions[0].id)), false);

  // 2. Long-press Option 0 to exclude it
  const opt0 = page.locator('.option').first();
  await opt0.dispatchEvent('pointerdown', { clientX: 200, clientY: 300 });
  await page.waitForTimeout(600);
  await opt0.dispatchEvent('pointerup');
  assert.equal(await opt0.evaluate((el) => el.classList.contains('excluded')), true, 'Option must be marked excluded');

  // Verify clicking excluded option warns and does not select
  await opt0.click();
  assert.equal(await opt0.evaluate((el) => el.classList.contains('selected')), false, 'Excluded option must not become selected');

  // Restore excluded option via second long-press
  await opt0.dispatchEvent('pointerdown', { clientX: 200, clientY: 300 });
  await page.waitForTimeout(600);
  await opt0.dispatchEvent('pointerup');
  assert.equal(await opt0.evaluate((el) => el.classList.contains('excluded')), false, 'Option must be un-excluded');

  // Select Option 0 normally
  // In app.js pointerdown sets _lpFired, so first click clears it, second click records answer.
  // In single choice flow mode, recording answer advances to Q2 (s.idx = 1).
  await opt0.click();
  await opt0.click();
  await page.waitForTimeout(250);

  // 3. Open QuestionCard Modal (#q-card)
  const qCardBtn = page.locator('#q-card');
  await qCardBtn.click();
  const modal = page.locator('.sheet-overlay');
  await modal.waitFor({ state: 'visible' });

  // Check sheet cells
  const cells = modal.locator('.sheet-cell');
  assert.equal(await cells.count(), 3);
  assert.equal(await cells.first().evaluate((el) => el.classList.contains('ok')), true, 'Question 1 should be marked answered ok');

  // Jump to Question 3 (index 2) via sheet
  await cells.nth(2).click();
  await modal.waitFor({ state: 'detached' });

  // Verify we are on Question 3 and flow mode is fully intact
  const q3State = await page.evaluate(() => ({
    idx: store.state.idx,
    dataFlow: document.getElementById('view').dataset.flow,
    tutorCards: document.querySelectorAll('.ai-tutor-card').length,
    quizRails: document.querySelectorAll('.quiz-rail').length,
    aiBallDisplay: window.getComputedStyle(document.getElementById('ai-ball')).display,
  }));
  assert.equal(q3State.idx, 2, 'Jumped to question index 2');
  assert.equal(q3State.dataFlow, '1', 'Flow mode retained');
  assert.equal(q3State.tutorCards, 0);
  assert.equal(q3State.quizRails, 0);
  assert.equal(q3State.aiBallDisplay, 'none');

  // 4. Pause and Resume Timer
  const pauseBtn = page.locator('#btn-pause');
  await pauseBtn.click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => store.state.timing?.running), false, 'Timer should be paused');
  assert.equal(await page.evaluate(() => window.getComputedStyle(document.getElementById('ai-ball')).display), 'none');

  await pauseBtn.click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => store.state.timing?.running), true, 'Timer should resume');
});

// =========================================================================
// TEST 3: R1 Full Exam Completion Flow to Result Screen Purity
// =========================================================================
test('Empirical R1-3: Completing an entire Flow mode quiz and submitting cleanly transitions to results with zero residuals', async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await startQuizDirect(page, { backMode: false });

  // Q1: Click Option 0 -> automatically advances to Q2
  await page.locator('.option').first().click();
  await page.waitForTimeout(300);

  // Q2: Click Option 0 -> automatically advances to Q3
  await page.locator('.option').first().click();
  await page.waitForTimeout(300);

  // Q3: Click Option 0 -> last question, automatically triggers submitExam()
  await page.locator('.option').first().click();
  await page.waitForTimeout(1000);

  // Verify result page rendered
  const resultState = await page.evaluate(() => {
    const view = document.getElementById('view');
    const isResult = view.querySelector('.result-box, .result-header, .res-score, #btn-retry-wrong, .review-head') !== null
      || view.innerHTML.includes('交卷')
      || view.innerHTML.includes('成绩')
      || view.innerHTML.includes('正确率')
      || store.state.attemptCompleted === true;
    const tutorCards = document.querySelectorAll('.ai-tutor-card').length;
    const quizRails = document.querySelectorAll('.quiz-rail').length;
    const dataFlow = view.dataset.flow;
    return { isResult, tutorCards, quizRails, dataFlow };
  });

  assert.equal(resultState.isResult, true, 'Exam completed and transitioned to review/results view');
  assert.equal(resultState.tutorCards, 0, 'No tutor cards on results page');
  assert.equal(resultState.quizRails, 0, 'No quiz rail on results page');
});

// =========================================================================
// TEST 4: R2 Dual Cards Across All Entrypoints (#cp-mode, #cbm-mode, #paper-mode)
// =========================================================================
test('Empirical R2-1: Dual cards in Custom Practice, Batch Practice, and Paper Config dialogs exhibit rock-solid selection, ARIA, and keyboard mechanics', async () => {
  await page.goto(`${BASE_URL}/`);
  await setupExamGoal(page);
  await page.waitForLoadState('networkidle');

  // Entrypoint A: Custom Practice Modal (#cp-mode)
  await page.evaluate(() => window.openCustomPractice('公务员·行测'));
  let modal = page.locator('.sheet-overlay');
  await modal.waitFor({ state: 'visible' });

  const cpGroup = modal.locator('#cp-mode');
  const cpPractice = cpGroup.locator('.mode-card[data-mode="practice"]');
  const cpRecite = cpGroup.locator('.mode-card[data-mode="recite"]');

  // Verify ARIA semantics
  assert.equal(await cpGroup.getAttribute('role'), 'radiogroup');
  assert.equal(await cpPractice.getAttribute('role'), 'radio');
  assert.equal(await cpRecite.getAttribute('role'), 'radio');

  // Rapid keyboard arrow navigation stress: 50 cycles
  await cpPractice.focus();
  for (let i = 0; i < 50; i++) {
    await page.keyboard.press('ArrowDown');
  }
  // 50 is even: starting from practice, 50 cycles lands on practice
  assert.equal(await cpPractice.getAttribute('aria-checked'), 'true');
  assert.equal(await cpRecite.getAttribute('aria-checked'), 'false');

  // ArrowUp once to recite
  await page.keyboard.press('ArrowUp');
  assert.equal(await cpRecite.getAttribute('aria-checked'), 'true');
  assert.equal(await cpPractice.getAttribute('aria-checked'), 'false');

  // Save with recite
  await modal.locator('#btn-cp-save').click();
  await modal.waitFor({ state: 'detached' });

  // Verify persistence
  const savedCfg = await page.evaluate(() => JSON.parse(localStorage.getItem('custom_practice_cfg') || '{}'));
  assert.equal(savedCfg.mode, 'recite');

  // Entrypoint B: Batch Practice Modal (#cbm-mode)
  await page.evaluate((bId) => window.customPractice(bId, '深度实证批次'), batchId);
  modal = page.locator('.sheet-overlay');
  await modal.waitFor({ state: 'visible' });

  const cbmGroup = modal.locator('#cbm-mode');
  const cbmPractice = cbmGroup.locator('.mode-card[data-mode="practice"]');
  const cbmRecite = cbmGroup.locator('.mode-card[data-mode="recite"]');

  // Toggle back and forth with space/enter
  await cbmRecite.focus();
  await page.keyboard.press('Space');
  assert.equal(await cbmRecite.getAttribute('aria-checked'), 'true');

  await cbmPractice.focus();
  await page.keyboard.press('Enter');
  assert.equal(await cbmPractice.getAttribute('aria-checked'), 'true');
  assert.equal(await cbmRecite.getAttribute('aria-checked'), 'false');

  // Close modal via close button
  await modal.locator('.sheet-close').click();
  await modal.waitFor({ state: 'detached' });

  // Entrypoint C: Smart Paper Config (#paper-mode)
  await page.evaluate(() => window.openPaperConfig());
  modal = page.locator('.sheet-overlay');
  await modal.waitFor({ state: 'visible' });

  const paperGroup = modal.locator('#paper-mode');
  const pPractice = paperGroup.locator('.mode-card[data-mode="practice"]');
  const pRecite = paperGroup.locator('.mode-card[data-mode="recite"]');

  assert.equal(await pPractice.getAttribute('aria-checked'), 'true');
  await pRecite.click();
  assert.equal(await pRecite.getAttribute('aria-checked'), 'true');
  assert.equal(await pPractice.getAttribute('aria-checked'), 'false');

  await modal.locator('.sheet-close').click();
  await modal.waitFor({ state: 'detached' });
});

// =========================================================================
// TEST 5: R2 Responsive Grid Breakpoint (580px) & Visual Inspection
// =========================================================================
test('Empirical R2-2: Dual cards container transitions from 2-column grid to 1-column stack below 580px breakpoint without clipping', async () => {
  await page.goto(`${BASE_URL}/`);
  await setupExamGoal(page);

  // Set wide viewport (800px)
  await page.setViewportSize({ width: 800, height: 700 });
  await page.evaluate(() => window.openCustomPractice('公务员·行测'));
  let modal = page.locator('.sheet-overlay');
  await modal.waitFor({ state: 'visible' });

  const wideGrid = await page.evaluate(() => {
    const group = document.querySelector('#cp-mode');
    const cs = window.getComputedStyle(group);
    return {
      gridTemplateColumns: cs.gridTemplateColumns,
      scrollWidth: group.scrollWidth,
      clientWidth: group.clientWidth,
    };
  });
  // In wide viewport: 2 columns
  const cols = wideGrid.gridTemplateColumns.trim().split(/\s+/);
  assert.equal(cols.length, 2, 'Wide viewport should display 2 grid columns');
  assert.equal(wideGrid.scrollWidth <= wideGrid.clientWidth, true, 'No horizontal scroll in wide modal');

  // Resize viewport to narrow mobile (420px)
  await page.setViewportSize({ width: 420, height: 700 });
  await page.waitForTimeout(200);

  const narrowGrid = await page.evaluate(() => {
    const group = document.querySelector('#cp-mode');
    const cs = window.getComputedStyle(group);
    return {
      gridTemplateColumns: cs.gridTemplateColumns,
      scrollWidth: group.scrollWidth,
      clientWidth: group.clientWidth,
    };
  });
  const narrowCols = narrowGrid.gridTemplateColumns.trim().split(/\s+/);
  assert.equal(narrowCols.length, 1, 'Narrow viewport (<580px) should display 1 column');
  assert.equal(narrowGrid.scrollWidth <= narrowGrid.clientWidth, true, 'No horizontal scroll in narrow modal');

  await modal.locator('.sheet-close').click();
  await modal.waitFor({ state: 'detached' });
});

// =========================================================================
// TEST 6: Rapid Back-to-Back Cross-Mode Cycling Stress (10 cycles)
// =========================================================================
test('Empirical R1-4: Rapid 10x alternating cross-mode session cycling guarantees zero residual state leakage', async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(BASE_URL);
  await setupExamGoal(page);

  for (let cycle = 0; cycle < 10; cycle++) {
    const isRecite = cycle % 2 === 1;
    await page.evaluate(({ qs, bm }) => {
      window.enterQuiz(qs, '常识判断', 'custom', null, null, null, bm);
    }, { qs: STRESS_QUESTIONS, bm: isRecite });
    await page.waitForTimeout(100);

    const state = await page.evaluate((bm) => {
      const v = document.getElementById('view');
      const cards = document.querySelectorAll('.ai-tutor-card').length;
      const rails = document.querySelectorAll('.quiz-rail').length;
      const aiBall = document.getElementById('ai-ball');
      const aiBallDisplay = aiBall ? window.getComputedStyle(aiBall).display : 'none';
      return {
        dataFlow: v.dataset.flow,
        backMode: store.state.backMode,
        cards,
        rails,
        aiBallDisplay,
      };
    }, isRecite);

    if (isRecite) {
      assert.equal(state.dataFlow, '0');
      assert.equal(state.backMode, true);
      assert.equal(state.cards, 1, `Cycle ${cycle}: Recite mode must mount 1 .ai-tutor-card`);
    } else {
      assert.equal(state.dataFlow, '1');
      assert.equal(state.backMode, false);
      assert.equal(state.cards, 0, `Cycle ${cycle}: Flow mode must mount 0 .ai-tutor-card`);
      assert.equal(state.rails, 0, `Cycle ${cycle}: Flow mode must have 0 .quiz-rail`);
      assert.equal(state.aiBallDisplay, 'none');
    }
  }
});
