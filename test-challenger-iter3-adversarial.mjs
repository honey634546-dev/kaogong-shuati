// test-challenger-iter3-adversarial.mjs — Adversarial Stress & Verification Harness for Iteration 3
// Challenger 2: Rigorous empirical validation of leak fix, multi-day aggregation, and boundary conditions

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
const PORT = 8950 + Math.floor(Math.random() * 100);
const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'kaogong-challenger-iter3-'));
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server, browser, context, page;

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

function getPdb() {
  const pdbPath = path.join(DATA_DIR, 'practice.db');
  return new DatabaseSync(pdbPath);
}

function clearRecords() {
  const pdb = getPdb();
  pdb.exec(`DELETE FROM practice_records WHERE user_id = 'legacy-test-user'`);
  pdb.close();
}

function insertRecordAt(dateStr, isCorrect = 1) {
  const pdb = getPdb();
  const stmt = pdb.prepare(`
    INSERT INTO practice_records
      (user_id, question_id, subject, chapter, question_type, selected, is_correct, created_at, cost_ms)
    VALUES ('legacy-test-user', 9999, '常识判断', '法律常识', 0, 'A', ?, ?, 30000)
  `);
  stmt.run(isCorrect, dateStr);
  pdb.close();
}

// -------------------------------------------------------------
// Test 1: Direct Backend API Contract for /api/records/stats
// -------------------------------------------------------------
test('Backend API: days=1, days=7, days=0, from=... 隔离与精度校验', async () => {
  clearRecords();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const yDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayStr = `${yDate.getFullYear()}-${pad(yDate.getMonth() + 1)}-${pad(yDate.getDate())}`;

  // Insert 5 yesterday records, 3 today records
  for (let i = 0; i < 5; i++) {
    insertRecordAt(`${yesterdayStr} 15:00:00`, 1);
  }
  for (let i = 0; i < 3; i++) {
    insertRecordAt(`${todayStr} 10:00:00`, 1);
  }

  // 1. days=1 query must return strictly today's records (3)
  const resDays1 = await fetch(`${BASE_URL}/api/records/stats?days=1`);
  const dataDays1 = await resDays1.json();
  assert.equal(dataDays1.total, 3, `days=1 必须精确返回今日的 3 题，实际返回: ${dataDays1.total}`);

  // 2. days=2 query must return yesterday + today (8)
  const resDays2 = await fetch(`${BASE_URL}/api/records/stats?days=2`);
  const dataDays2 = await resDays2.json();
  assert.equal(dataDays2.total, 8, `days=2 必须精确返回昨今两日的 8 题，实际返回: ${dataDays2.total}`);

  // 3. days=0 (all time) must return 8
  const resDays0 = await fetch(`${BASE_URL}/api/records/stats`);
  const dataDays0 = await resDays0.json();
  assert.equal(dataDays0.total, 8, `全量统计必须返回 8 题，实际返回: ${dataDays0.total}`);

  // 4. from=todayStr must return 3
  const resFrom = await fetch(`${BASE_URL}/api/records/stats?from=${todayStr}`);
  const dataFrom = await resFrom.json();
  assert.equal(dataFrom.total, 3, `from=today 必须返回 3 题，实际返回: ${dataFrom.total}`);
});

// -------------------------------------------------------------
// Test 2: Midnight Boundary Condition (23:59:59 yesterday vs 00:00:01 today)
// -------------------------------------------------------------
test('Boundary Stress: 跨零点临界时间作答记录归属隔离验证', async () => {
  clearRecords();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const yDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayStr = `${yDate.getFullYear()}-${pad(yDate.getMonth() + 1)}-${pad(yDate.getDate())}`;

  // Record 1: 1 second before midnight yesterday
  insertRecordAt(`${yesterdayStr} 23:59:59`, 1);
  // Record 2: 1 second after midnight today
  insertRecordAt(`${todayStr} 00:00:01`, 1);

  await page.goto(BASE_URL);
  await page.locator('.today-week').waitFor({ timeout: 10000 });

  const gaugeVal = (await page.locator('.gauge-val').textContent()).trim();
  assert.equal(gaugeVal, '1', `今日（00:00:01 后）刷题数应严格为 1，实际: ${gaugeVal}`);

  const bars = page.locator('.trend-bars-row .trend-bar-col');
  const todayBar = bars.nth(6);
  const yestBar = bars.nth(5);

  const todayTitle = await todayBar.getAttribute('title');
  const yestTitle = await yestBar.getAttribute('title');

  assert.ok(todayTitle.includes('1 题'), `今日柱条应显示 1 题，实际: ${todayTitle}`);
  assert.ok(yestTitle.includes('1 题'), `昨天柱条应显示 1 题，实际: ${yestTitle}`);

  const totalTag = await page.locator('.week-total-tag').textContent();
  assert.ok(totalTag.includes('2 道'), `近7天总题数应为 2 道，实际: ${totalTag}`);
});

// -------------------------------------------------------------
// Test 3: Complex Multi-Day Asymmetric Distribution & Historical Clipping
// -------------------------------------------------------------
test('Multi-Day Stress: 非对称分布、空档日、超期历史数据截断与走势柱图高度比例', async () => {
  clearRecords();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');

  // Insert historical records outside 7 days (-10 days: 100 questions)
  const d10 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 10);
  const d10Str = `${d10.getFullYear()}-${pad(d10.getMonth() + 1)}-${pad(d10.getDate())} 12:00:00`;
  for (let c = 0; c < 100; c++) {
    insertRecordAt(d10Str, 1);
  }

  // 7-day window distribution:
  // Offset 6 (6 days ago): 10
  // Offset 5 (5 days ago): 0
  // Offset 4 (4 days ago): 20
  // Offset 3 (3 days ago): 0
  // Offset 2 (2 days ago): 40
  // Offset 1 (yesterday):  80
  // Offset 0 (today):      15
  const counts = [10, 0, 20, 0, 40, 80, 15];
  for (let offset = 6; offset >= 0; offset--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 12:00:00`;
    const count = counts[6 - offset];
    for (let c = 0; c < count; c++) {
      insertRecordAt(dateStr, 1);
    }
  }

  await page.goto(BASE_URL);
  await page.locator('.today-week').waitFor({ timeout: 10000 });

  // 1. Check Hero Gauge
  const gaugeVal = (await page.locator('.gauge-val').textContent()).trim();
  assert.equal(gaugeVal, '15', `今日战力仪表盘应精确显示 15 题，实际: ${gaugeVal}`);

  // 2. Check 7 Bars
  const bars = page.locator('.trend-bars-row .trend-bar-col');
  assert.equal(await bars.count(), 7);

  const barTitles = [];
  const barHeights = [];
  for (let i = 0; i < 7; i++) {
    const bar = bars.nth(i);
    const title = await bar.getAttribute('title');
    const fill = bar.locator('.trend-bar-fill');
    const height = await fill.evaluate((el) => el.style.height);
    barTitles.push(title);
    barHeights.push(parseInt(height, 10));
  }

  // Max count is 80 (yesterday, index 5).
  // Yesterday should have height 100%.
  assert.ok(barTitles[5].includes('80 题'), `昨日柱条应为 80 题: ${barTitles[5]}`);
  assert.equal(barHeights[5], 100, `昨日柱条（最大值 80）高度应为 100%`);

  // Today (index 6) has 15 questions. 15 / 80 = 18.75% -> max(8, round(18.75)) = 19%
  assert.ok(barTitles[6].includes('15 题'), `今日柱条应为 15 题: ${barTitles[6]}`);
  assert.ok(barHeights[6] >= 18 && barHeights[6] <= 20, `今日柱条高度应约为 19%，实际: ${barHeights[6]}%`);

  // Empty days (index 1 and index 3) should have height 8% and .is-empty
  assert.ok(barTitles[1].includes('0 题'), `空档日 index 1 应为 0 题: ${barTitles[1]}`);
  assert.equal(barHeights[1], 8, `空档日 index 1 高度应为 8%`);
  assert.ok(barTitles[3].includes('0 题'), `空档日 index 3 应为 0 题: ${barTitles[3]}`);
  assert.equal(barHeights[3], 8, `空档日 index 3 高度应为 8%`);

  // 3. Check Week Total Tag:
  // Expected sum = 10 + 0 + 20 + 0 + 40 + 80 + 15 = 165
  // Must NOT include the 100 questions from 10 days ago (total would be 265 if leaked)
  // Must NOT duplicate yesterday's 80 onto today (total would be 245 if leaked)
  const totalTag = await page.locator('.week-total-tag').textContent();
  assert.ok(totalTag.includes('165 道'), `近 7 天总计必须精确为 165 道，实际渲染: ${totalTag}`);
});

// -------------------------------------------------------------
// Test 4: Pure 0-Practice Day with Heavy Historical Activity
// -------------------------------------------------------------
test('Zero-Day Stress: 历史大量作答而今日零作答下仪表盘与柱条状态严密校验', async () => {
  clearRecords();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');

  // Insert 50 records yesterday, 0 today
  const yDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayStr = `${yDate.getFullYear()}-${pad(yDate.getMonth() + 1)}-${pad(yDate.getDate())} 20:00:00`;
  for (let c = 0; c < 50; c++) {
    insertRecordAt(yesterdayStr, 1);
  }

  await page.goto(BASE_URL);
  await page.locator('.today-week').waitFor({ timeout: 10000 });

  const gaugeVal = (await page.locator('.gauge-val').textContent()).trim();
  assert.equal(gaugeVal, '0', `今日零作答时 gauge-val 必须为 0，实际: ${gaugeVal}`);

  const todayBar = page.locator('.trend-bars-row .trend-bar-col.is-today');
  const todayTitle = await todayBar.getAttribute('title');
  const isEmpty = await todayBar.evaluate((el) => el.classList.contains('is-empty'));
  const fillHeight = await todayBar.locator('.trend-bar-fill').evaluate((el) => el.style.height);

  assert.ok(todayTitle.includes('0 题'), `今日柱条必须显示 0 题，实际: ${todayTitle}`);
  assert.equal(isEmpty, true, `今日柱条必须具备 .is-empty 类`);
  assert.equal(fillHeight, '8%', `今日柱条必须呈现基线 8% 高度`);

  const totalTag = await page.locator('.week-total-tag').textContent();
  assert.ok(totalTag.includes('50 道'), `近 7 天总计应为 50 道，实际: ${totalTag}`);
});
