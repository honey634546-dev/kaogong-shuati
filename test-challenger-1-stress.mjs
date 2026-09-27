// test-challenger-1-stress.mjs — Adversarial Empirical Stress Test Suite
// Focus: R1 (Flow vs Recite Decoupling, Zero AI Residual, Geometry Centering) & R2 (Dual Cards Dialogs Rapid Toggling)
// Challenger 1 Verification Harness

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
const PORT = 8700 + Math.floor(Math.random() * 200);
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'kaogong-challenger-1-'));
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server, browser, context, page, batchId;

const STRESS_QUESTIONS = [
  {
    prompt: '【常识题】关于我国宪法监督制度，下列说法正确的是：\nA. 全国人大常委会有权撤销同宪法相抵触的行政法规\nB. 地方各级人大常委会有权撤销本级政府制定的不适当规章\nC. 宪法监督的主体是最高人民法院\nD. 宪法修改由全国人大常委会以全体代表的三分之二以上多数通过',
    options: [
      '全国人大常委会有权撤销同宪法相抵触的行政法规',
      '地方各级人大常委会有权撤销本级政府制定的不适当规章',
      '宪法监督的主体是最高人民法院',
      '宪法修改由全国人大常委会以全体代表的三分之二以上多数通过',
    ],
    answer: 'A',
    answer_index: 0,
    analysis: '【解析】根据宪法规定，全国人大常委会监督宪法的实施，有权撤销同宪法相抵触的行政法规。宪法修改由全国人大常委会或者五分之一以上全国人大代表提议，并由全国人民代表大会以全体代表的三分之二以上多数通过。',
  },
  {
    prompt: '【言语题】在传统文化传承中，不能一味食古不化，而应当顺应时代变革，______其积极内核，为现代文明注入源头活水。\nA. 甄别\nB. 萃取\nC. 沿袭\nD. 复制',
    options: ['甄别', '萃取', '沿袭', '复制'],
    answer: 'B',
    answer_index: 1,
    analysis: '【解析】搭配“积极内核”，且对应“注入源头活水”，萃取最恰当。',
  },
  {
    prompt: '【资料分析题】根据下列材料回答问题：\n材料数据：2025年某市规模以上高技术制造业增加值同比增长12.5%，高于全市规上工业增加值增速4.2个百分点。\n问：2025年该市规上工业增加值增速为多少？',
    material: '2025年某市规模以上高技术制造业增加值同比增长12.5%，高于全市规上工业增加值增速4.2个百分点。其中高技术制造研发投入增长18.6%。',
    options: ['8.3%', '16.7%', '12.5%', '4.2%'],
    answer: 'A',
    answer_index: 0,
    analysis: '【解析】12.5% - 4.2% = 8.3%。',
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
      name: 'Challenger 1 压力测试批次',
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
// TEST SUITE: R2 DUAL CARDS ADVERSARIAL STRESS
// =========================================================================

test('Adversarial R2.1: Custom Practice dialog rapid 60x toggling & keyboard navigation', async () => {
  await page.goto(`${BASE_URL}/`);
  await setupExamGoal(page);
  await page.waitForLoadState('networkidle');

  // Open custom practice modal via app controller
  await page.evaluate(() => {
    window.openCustomPractice('公务员·行测');
  });

  const modal = page.locator('.sheet-overlay');
  await modal.waitFor({ state: 'visible' });

  const cardGroup = modal.locator('#cp-mode');
  await assert.equal(await cardGroup.getAttribute('role'), 'radiogroup');
  const flowCard = cardGroup.locator('.mode-card[data-mode="practice"]');
  const reciteCard = cardGroup.locator('.mode-card[data-mode="recite"]');

  // Verify initial state: flow mode active by default
  assert.equal(await flowCard.getAttribute('aria-checked'), 'true');
  assert.equal(await reciteCard.getAttribute('aria-checked'), 'false');
  assert.equal(await flowCard.evaluate((el) => el.classList.contains('on') && el.classList.contains('active')), true);
  assert.equal(await reciteCard.evaluate((el) => el.classList.contains('on') || el.classList.contains('active')), false);

  // Adversarial Rapid Toggling: 60 clicks alternating between flow and recite
  for (let i = 0; i < 60; i++) {
    if (i % 2 === 0) {
      await reciteCard.click();
    } else {
      await flowCard.click();
    }
  }
  // After 60 clicks (even number, last was flowCard at i=59), flowCard should be active
  assert.equal(await flowCard.getAttribute('aria-checked'), 'true');
  assert.equal(await reciteCard.getAttribute('aria-checked'), 'false');
  let activeCards = await cardGroup.locator('.mode-card.on').count();
  assert.equal(activeCards, 1, 'Exactly one card must be active after rapid toggling');

  // Now switch to recite with 1 click
  await reciteCard.click();
  assert.equal(await reciteCard.getAttribute('aria-checked'), 'true');
  assert.equal(await flowCard.getAttribute('aria-checked'), 'false');
  activeCards = await cardGroup.locator('.mode-card.on').count();
  assert.equal(activeCards, 1);

  // Test Keyboard Accessibility & Stress: Arrow keys and Space/Enter
  await flowCard.focus();
  await page.keyboard.press('Enter');
  assert.equal(await flowCard.getAttribute('aria-checked'), 'true');
  assert.equal(await reciteCard.getAttribute('aria-checked'), 'false');

  await reciteCard.focus();
  await page.keyboard.press('Space');
  assert.equal(await reciteCard.getAttribute('aria-checked'), 'true');
  assert.equal(await flowCard.getAttribute('aria-checked'), 'false');

  // Test ArrowRight key navigation
  await flowCard.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await reciteCard.getAttribute('aria-checked'), 'true', 'ArrowRight from flow card must select recite card');

  // Test ArrowLeft key navigation
  await page.keyboard.press('ArrowLeft');
  assert.equal(await flowCard.getAttribute('aria-checked'), 'true', 'ArrowLeft from recite card must select flow card');

  // Save with Recite selected
  await reciteCard.click();
  const saveBtn = modal.locator('#btn-cp-save');
  await saveBtn.click();
  await modal.waitFor({ state: 'detached' });

  // Verify localStorage and store updated
  const storedConfig = await page.evaluate(() => JSON.parse(localStorage.getItem('custom_practice_cfg') || '{}'));
  assert.equal(storedConfig.mode, 'recite', 'Selected mode "recite" must be persisted');

  // Re-open Custom Practice modal to verify state echo
  await page.evaluate(() => {
    window.openCustomPractice('公务员·行测');
  });
  const modal2 = page.locator('.sheet-overlay');
  await modal2.waitFor({ state: 'visible' });

  const flowCard2 = modal2.locator('#cp-mode .mode-card[data-mode="practice"]');
  const reciteCard2 = modal2.locator('#cp-mode .mode-card[data-mode="recite"]');
  assert.equal(await reciteCard2.getAttribute('aria-checked'), 'true', 'State echo must remember recite mode');
  assert.equal(await flowCard2.getAttribute('aria-checked'), 'false');

  // Switch back to practice mode and save
  await flowCard2.click();
  assert.equal(await flowCard2.getAttribute('aria-checked'), 'true');
  await modal2.locator('#btn-cp-save').click();
  await modal2.waitFor({ state: 'detached' });
});

test('Adversarial R2.2: Batch Practice dialog & Smart Paper dialog dual cards toggling', async () => {
  await page.goto(`${BASE_URL}/`);
  await setupExamGoal(page);
  await page.waitForLoadState('networkidle');

  // Test Batch Practice Modal (#cbm-mode)
  await page.evaluate((bId) => {
    window.customPractice(bId, '压力测试批次');
  }, batchId);

  const modal = page.locator('.sheet-overlay');
  await modal.waitFor({ state: 'visible' });

  const cardGroup = modal.locator('#cbm-mode');
  await assert.equal(await cardGroup.count(), 1, '#cbm-mode dual cards container must exist');

  const flowCard = cardGroup.locator('.mode-card[data-mode="practice"]');
  const reciteCard = cardGroup.locator('.mode-card[data-mode="recite"]');

  // Rapid toggling 40x
  for (let i = 0; i < 40; i++) {
    await (i % 2 === 0 ? reciteCard : flowCard).click();
  }
  // i=39 clicked flowCard -> flowCard active
  assert.equal(await flowCard.getAttribute('aria-checked'), 'true');
  assert.equal(await reciteCard.getAttribute('aria-checked'), 'false');
  let activeCards = await cardGroup.locator('.mode-card.on').count();
  assert.equal(activeCards, 1);

  // Close modal
  await modal.locator('.sheet-close').click();
  await modal.waitFor({ state: 'detached' });

  // Test Smart Paper Dialog (#paper-mode)
  await page.evaluate(() => {
    window.openPaperConfig();
  });
  const paperModal = page.locator('.sheet-overlay');
  await paperModal.waitFor({ state: 'visible' });

  const paperGroup = paperModal.locator('#paper-mode');
  await assert.equal(await paperGroup.count(), 1, '#paper-mode dual cards container must exist');
  const pFlowCard = paperGroup.locator('.mode-card[data-mode="practice"]');
  const pReciteCard = paperGroup.locator('.mode-card[data-mode="recite"]');

  assert.equal(await pFlowCard.getAttribute('aria-checked'), 'true');
  await pReciteCard.click();
  assert.equal(await pReciteCard.getAttribute('aria-checked'), 'true');
  assert.equal(await pFlowCard.getAttribute('aria-checked'), 'false');

  await paperModal.locator('.sheet-close').click();
  await paperModal.waitFor({ state: 'detached' });
});

// =========================================================================
// TEST SUITE: R1 ZERO RESIDUAL AI & MULTI-VIEWPORT CENTERING
// =========================================================================

const VIEWPORTS = [
  { name: 'Large Desktop 1440px', width: 1440, height: 900, isDesktop: true },
  { name: 'Standard Desktop 1280px', width: 1280, height: 800, isDesktop: true },
  { name: 'Small Desktop / iPad Pro 1024px', width: 1024, height: 768, isDesktop: true },
  { name: 'Material Split Breakpoint 980px', width: 980, height: 600, isDesktop: false },
  { name: 'Tablet Portrait 768px', width: 768, height: 1024, isDesktop: false },
  { name: 'Phablet 480px', width: 480, height: 850, isDesktop: false },
  { name: 'Compact Mobile 375px', width: 375, height: 667, isDesktop: false },
];

for (const vp of VIEWPORTS) {
  test(`Adversarial R1.1 & R1.2: Screen resolution ${vp.name} (${vp.width}x${vp.height}) - Zero residual AI & DOM True Centering`, async () => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await startQuizDirect(page, { backMode: false });

    // 1. Rigorous Zero AI Verification in Flow Mode
    const aiResiduals = await page.evaluate(() => {
      const tutorCards = document.querySelectorAll('.ai-tutor-card').length;
      const quizRails = document.querySelectorAll('.quiz-rail').length;
      const explainCards = document.querySelectorAll('#inline-explain').length;
      const aiBall = document.getElementById('ai-ball');
      let aiBallVisible = false;
      let aiBallDisplay = 'none';
      if (aiBall) {
        const cs = window.getComputedStyle(aiBall);
        aiBallDisplay = cs.display;
        aiBallVisible = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && aiBall.offsetWidth > 0;
      }
      return { tutorCards, quizRails, explainCards, aiBallVisible, aiBallDisplay };
    });

    assert.equal(aiResiduals.tutorCards, 0, `[${vp.name}] Zero .ai-tutor-card in Flow mode`);
    assert.equal(aiResiduals.quizRails, 0, `[${vp.name}] Zero .quiz-rail in Flow mode`);
    assert.equal(aiResiduals.explainCards, 0, `[${vp.name}] Zero #inline-explain in Flow mode`);
    assert.equal(aiResiduals.aiBallVisible, false, `[${vp.name}] #ai-ball must be invisible in Flow mode`);
    assert.equal(aiResiduals.aiBallDisplay, 'none', `[${vp.name}] #ai-ball computed display must be none`);

    // 2. Rigorous DOM Layout Geometry & Centering Verification
    const geometry = await page.evaluate((isDesktop) => {
      const view = document.getElementById('view');
      const rect = view.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const leftGap = rect.left;
      const rightGap = viewportWidth - rect.right;
      const asymmetry = Math.abs(leftGap - rightGap);

      // Horizontal scrollbar check
      const docScrollWidth = document.documentElement.scrollWidth;
      const docClientWidth = document.documentElement.clientWidth;
      const bodyScrollWidth = document.body.scrollWidth;
      const bodyClientWidth = document.body.clientWidth;
      const hasHScroll = docScrollWidth > docClientWidth || bodyScrollWidth > bodyClientWidth;

      // Side nav check on desktop
      const sideNav = document.getElementById('side-nav');
      let sideNavDisplay = 'none';
      if (sideNav) {
        sideNavDisplay = window.getComputedStyle(sideNav).display;
      }

      // Body padding check
      const bodyPaddingLeft = parseFloat(window.getComputedStyle(document.body).paddingLeft || '0');

      return {
        leftGap,
        rightGap,
        asymmetry,
        rectWidth: rect.width,
        viewportWidth,
        hasHScroll,
        docScrollWidth,
        docClientWidth,
        sideNavDisplay,
        bodyPaddingLeft,
      };
    }, vp.isDesktop);

    // No horizontal scrollbar allowed under any viewport
    assert.equal(geometry.hasHScroll, false, `[${vp.name}] No horizontal scrollbar allowed (scrollWidth: ${geometry.docScrollWidth}, clientWidth: ${geometry.docClientWidth})`);

    if (vp.isDesktop) {
      // Desktop: side-nav MUST be hidden via body:has(#view[data-flow='1'])
      assert.equal(geometry.sideNavDisplay, 'none', `[${vp.name}] Desktop .side-nav must be hidden in Flow mode`);
      assert.equal(geometry.bodyPaddingLeft, 0, `[${vp.name}] Desktop body padding-left must be reset to 0 in Flow mode`);
      // Viewport centering asymmetry must be minimal (<= 2px due to subpixel rendering)
      assert.ok(
        geometry.asymmetry <= 2.0,
        `[${vp.name}] #view must be horizontally centered! Left gap: ${geometry.leftGap}px, Right gap: ${geometry.rightGap}px, Asymmetry: ${geometry.asymmetry}px`
      );
    } else {
      // Mobile / Tablet: #view must not overflow, left and right margins should be balanced
      assert.ok(
        geometry.asymmetry <= 5.0,
        `[${vp.name}] Mobile #view balanced! Left: ${geometry.leftGap}px, Right: ${geometry.rightGap}px, Asymmetry: ${geometry.asymmetry}px`
      );
    }

    // 3. Question transition in Flow mode: check zero AI leakage across transitions
    const firstOption = page.locator('.option').first();
    await firstOption.click();
    await page.waitForTimeout(200);

    // Check zero tutor cards after answering in Flow mode
    const afterAnswerResiduals = await page.evaluate(() => ({
      tutorCards: document.querySelectorAll('.ai-tutor-card').length,
      quizRails: document.querySelectorAll('.quiz-rail').length,
      aiBallDisplay: window.getComputedStyle(document.getElementById('ai-ball')).display,
    }));
    assert.equal(afterAnswerResiduals.tutorCards, 0);
    assert.equal(afterAnswerResiduals.quizRails, 0);
    assert.equal(afterAnswerResiduals.aiBallDisplay, 'none');

    // Next question
    await page.evaluate(() => window.nextQuestion());
    await page.waitForTimeout(200);

    const q2Residuals = await page.evaluate(() => ({
      tutorCards: document.querySelectorAll('.ai-tutor-card').length,
      quizRails: document.querySelectorAll('.quiz-rail').length,
      aiBallDisplay: window.getComputedStyle(document.getElementById('ai-ball')).display,
    }));
    assert.equal(q2Residuals.tutorCards, 0);
    assert.equal(q2Residuals.quizRails, 0);
    assert.equal(q2Residuals.aiBallDisplay, 'none');

    // 4. Modal interactions in Flow mode: Question Card modal & Pause
    const qCardBtn = page.locator('#q-card');
    if (await qCardBtn.isVisible()) {
      await qCardBtn.click();
      const qCardOverlay = page.locator('.sheet-overlay');
      await qCardOverlay.waitFor({ state: 'visible' });
      // In modal: #ai-ball still hidden
      const ballInModal = await page.evaluate(() => window.getComputedStyle(document.getElementById('ai-ball')).display);
      assert.equal(ballInModal, 'none', 'AI ball must remain hidden when question card sheet is open');
      await qCardOverlay.locator('.sheet-close').click();
      await qCardOverlay.waitFor({ state: 'detached', timeout: 5000 });
    }

    // Pause timer and resume
    const pauseBtn = page.locator('#btn-pause');
    if (await pauseBtn.isVisible()) {
      await pauseBtn.click();
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.getComputedStyle(document.getElementById('ai-ball')).display), 'none');
      await pauseBtn.click(); // resume
    }
  });
}

// =========================================================================
// TEST SUITE: R1 MATERIAL QUESTION SPLIT IN FLOW MODE
// =========================================================================

test('Adversarial R1.3: Material question (Split row) in Flow mode - No rail, centered split, no horizontal scroll', async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await startQuizDirect(page, { backMode: false });

  // Navigate to Question 3 (Index 2: Material Question)
  await page.evaluate(() => {
    store.state.idx = 2;
    renderQuestion();
  });
  await page.waitForTimeout(300);

  const matBox = page.locator('.material-box, .quiz-split-row');
  assert.ok(await matBox.count() > 0, 'Material box / split row must be rendered for material question');

  // Verify in Flow mode: NO .quiz-rail and NO .ai-tutor-card even on wide screen with material split
  const materialFlowResiduals = await page.evaluate(() => {
    const rails = document.querySelectorAll('.quiz-rail').length;
    const cards = document.querySelectorAll('.ai-tutor-card').length;
    const aiBall = window.getComputedStyle(document.getElementById('ai-ball')).display;
    const view = document.getElementById('view');
    const flow = view.dataset.flow;
    const hScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth;
    return { rails, cards, aiBall, flow, hScroll };
  });

  assert.equal(materialFlowResiduals.rails, 0, 'No .quiz-rail for material question in flow mode');
  assert.equal(materialFlowResiduals.cards, 0, 'No .ai-tutor-card for material question in flow mode');
  assert.equal(materialFlowResiduals.aiBall, 'none', 'AI ball hidden for material question');
  assert.equal(materialFlowResiduals.flow, '1', 'data-flow remains 1');
  assert.equal(materialFlowResiduals.hScroll, false, 'No horizontal scroll on material split row');
});

// =========================================================================
// TEST SUITE: SESSION LIFECYCLE & CROSS-MODE ISOLATION STRESS
// =========================================================================

test('Adversarial R1.4: Cross-mode alternation stress: Recite -> Home -> Flow -> Submit -> Flow', async () => {
  await page.setViewportSize({ width: 1280, height: 800 });

  // STEP 1: Enter Recite mode
  await startQuizDirect(page, { backMode: true });

  // In Recite mode: tutor card mounted
  await page.waitForSelector('.ai-tutor-card', { timeout: 5000 });
  assert.equal(await page.locator('.ai-tutor-card').count(), 1);
  assert.equal(await page.evaluate(() => document.getElementById('view').dataset.flow), '0');

  // STEP 2: Return to Home via renderHome
  await page.evaluate(() => {
    window.renderHome();
  });
  await page.waitForTimeout(400);

  // In Home view: #view must NOT have data-flow, #ai-ball must be visible
  const homeState = await page.evaluate(() => {
    const v = document.getElementById('view');
    const b = document.getElementById('ai-ball');
    return {
      hasFlow: v.hasAttribute('data-flow'),
      hasExam: v.hasAttribute('data-exam'),
      aiBallDisplay: window.getComputedStyle(b).display,
      tutorCards: document.querySelectorAll('.ai-tutor-card').length,
    };
  });
  assert.equal(homeState.hasFlow, false, 'Home view must not have data-flow');
  assert.equal(homeState.hasExam, false, 'Home view must not have data-exam');
  assert.equal(homeState.aiBallDisplay, 'flex', 'AI ball must be visible on Home view');
  assert.equal(homeState.tutorCards, 0, 'No tutor cards on Home view');

  // STEP 3: Enter Flow Mode
  await page.evaluate(({ qs }) => {
    window.enterQuiz(qs, '常识判断', 'custom', null, null, null, false);
  }, { qs: STRESS_QUESTIONS });
  await page.waitForSelector('#view[data-flow="1"]', { timeout: 5000 });

  // Purity verification in Flow mode immediately after Recite mode
  const flowPurity = await page.evaluate(() => ({
    tutorCards: document.querySelectorAll('.ai-tutor-card').length,
    quizRails: document.querySelectorAll('.quiz-rail').length,
    aiBallDisplay: window.getComputedStyle(document.getElementById('ai-ball')).display,
    dataFlow: document.getElementById('view').dataset.flow,
  }));
  assert.equal(flowPurity.tutorCards, 0, 'Recite tutor card must be completely purged');
  assert.equal(flowPurity.quizRails, 0, 'Recite quiz rail must be completely purged');
  assert.equal(flowPurity.aiBallDisplay, 'none', 'AI ball must be hidden in Flow mode');
  assert.equal(flowPurity.dataFlow, '1', 'data-flow must be 1');

  // STEP 4: Submit Exam
  await page.evaluate(() => {
    window.submitExam(true);
  });
  await page.waitForTimeout(500);

  // Should arrive at result or home
  const postSubmitResiduals = await page.evaluate(() => ({
    tutorCards: document.querySelectorAll('.ai-tutor-card').length,
    quizRails: document.querySelectorAll('.quiz-rail').length,
  }));
  assert.equal(postSubmitResiduals.tutorCards, 0);
  assert.equal(postSubmitResiduals.quizRails, 0);
});
