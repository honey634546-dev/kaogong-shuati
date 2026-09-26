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
const port = 6100 + Math.floor(Math.random() * 250);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'kaogong-scratchpad-'));
const base = `http://127.0.0.1:${port}`;
let server, browser, context, page, batchId;

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('临时刷题服务未能启动');
}

async function api(url, options) {
  const response = await fetch(`${base}${url}`, options);
  const body = await response.json();
  assert.equal(response.ok, true, `${url}: ${JSON.stringify(body)}`);
  return body;
}

before(async () => {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
  server = spawn(process.execPath, ['server.mjs', String(port)], {
    cwd: ROOT,
    env: { ...process.env, APP_DATA_DIR: dataDir, AUTH_DISABLED: '1', HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  await waitForServer();
  const imported = await api('/api/custom/import', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '透明草稿纸 UI 测试',
      questions: [
        { prompt: `计算下面的问题。\n\n${'演算草稿测试题，滚动时也应能打开草稿纸。 '.repeat(110)}`, options: ['1', '2'], answer: 'B', answer_index: 1 },
        { prompt: '本题用于验证切题后的笔迹隔离。', options: ['正确', '错误'], answer: 'A', answer_index: 0 },
      ],
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
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
});

beforeEach(async () => { page = await context.newPage(); });
afterEach(async () => { await page?.close(); page = null; });

after(async () => {
  await browser?.close();
  if (server && server.exitCode == null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  await rm(dataDir, { recursive: true, force: true });
});

async function sampleInk(x, y) {
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('.scratch-canvas');
    const dpr = window.devicePixelRatio || 1;
    const pixel = canvas.getContext('2d').getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
    return pixel[3] > 0;
  }, { x, y });
}

async function dispatchStroke({ x1, y1, x2 = x1, y2 = y1, type = 'pen', id = 1 }) {
  return page.evaluate(({ x1, y1, x2, y2, type, id }) => {
    const canvas = document.querySelector('.scratch-canvas');
    const observed = [];
    for (const name of ['pointerdown', 'pointermove', 'pointerup']) {
      canvas.addEventListener(name, (event) => observed.push({ name, pointerType: event.pointerType,
        x: event.clientX, y: event.clientY, prevented: event.defaultPrevented }), { once: true });
    }
    const send = (name, x, y, buttons) => canvas.dispatchEvent(new PointerEvent(name, {
      pointerId: id, pointerType: type, isPrimary: true,
      clientX: x, clientY: y, buttons, bubbles: true, cancelable: true,
    }));
    send('pointerdown', x1, y1, 1);
    if (x1 !== x2 || y1 !== y2) send('pointermove', x2, y2, 1);
    send('pointerup', x2, y2, 0);
    return observed;
  }, { x1, y1, x2, y2, type, id });
}

async function openPractice() {
  await page.goto(base);
  await page.locator('.custom-entry').waitFor({ timeout: 15000 });
  await page.locator('.custom-entry').click();
  await page.locator(`[data-act="practice"]`).waitFor({ timeout: 10000 });
  await page.locator('[data-act="practice"]').click();
  await page.locator('#btn-cbm-start').click();
  await page.locator('.q-progress-text').waitFor({ timeout: 10000 });
}

test('透明草稿纸绘制、局部擦除、撤销、清空、手指开关与页面锁定', async () => {
  await openPractice();
  await page.evaluate(() => window.scrollTo(0, 260));
  const startScroll = await page.evaluate(() => window.scrollY);
  assert.ok(startScroll > 0, '长题目应可滚动');
  await page.getByRole('button', { name: '打开草稿纸' }).click();
  await page.locator('.scratch-overlay').waitFor();
  assert.equal(await page.locator('#app').evaluate((el) => el.inert), true, '打开时底层应用不可交互');
  assert.equal(await page.locator('body').evaluate((el) => getComputedStyle(el).position), 'fixed', '打开时锁定页面滚动');
  assert.equal(await page.getByRole('button', { name: '撤销上一步' }).isDisabled(), true, '空白草稿不可撤销');
  await page.screenshot({ path: '/tmp/exam-scratchpad-open.png' });

  const dispatched = await dispatchStroke({ x1: 90, y1: 300, x2: 210, y2: 300 });
  const initialInk = await sampleInk(150, 300);
  const canvasState = await page.evaluate(() => {
    const canvas = document.querySelector('.scratch-canvas');
    const context = canvas.getContext('2d');
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let inkPixels = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]) inkPixels++;
    const event = new PointerEvent('pointerdown', { pointerType: 'pen', pointerId: 2 });
    return { width: canvas.width, height: canvas.height, inkPixels, pointerType: event.pointerType };
  });
  assert.equal(initialInk, true, `触控笔笔划显示：${JSON.stringify({ canvasState, dispatched })}`);
  await page.getByRole('button', { name: '局部擦除' }).click();
  await dispatchStroke({ x1: 150, y1: 280, x2: 150, y2: 320 });
  assert.equal(await sampleInk(150, 300), false, '橡皮擦掉交叉点');
  assert.equal(await sampleInk(100, 300), true, '局部擦除保留未碰到的笔迹');
  await page.getByRole('button', { name: '撤销上一步' }).click();
  assert.equal(await sampleInk(150, 300), true, '撤销可恢复刚擦掉的笔迹');
  await page.getByRole('button', { name: '清空当前草稿' }).click();
  assert.equal(await sampleInk(100, 300), false, '清空立即擦除笔迹');
  await page.getByRole('button', { name: '撤销上一步' }).click();
  assert.equal(await sampleInk(100, 300), true, '清空可以撤销恢复');

  await page.getByRole('button', { name: '清空当前草稿' }).click();
  await dispatchStroke({ x1: 270, y1: 500, type: 'touch', id: 5 });
  assert.equal(await sampleInk(270, 500), false, '默认忽略手指触点');
  await page.getByRole('button', { name: '允许单指书写' }).click();
  await page.waitForTimeout(850); // 最近触控笔触点的短暂掌触忽略窗口结束
  await page.getByRole('button', { name: '使用蓝色笔书写' }).click();
  await dispatchStroke({ x1: 270, y1: 500, type: 'touch', id: 6 });
  assert.equal(await sampleInk(270, 500), true, '开启后接受单指书写');
  await page.keyboard.press('Escape');
  await page.locator('.scratch-overlay').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#app').evaluate((el) => el.inert), false, '关闭时恢复底层应用');
  assert.equal(await page.locator('body').evaluate((el) => getComputedStyle(el).position), 'static', '关闭时恢复页面布局');
  assert.equal(await page.evaluate(() => window.scrollY), startScroll, '关闭时恢复原滚动位置');

  await page.getByRole('button', { name: '打开草稿纸' }).click();
  assert.equal(await sampleInk(270, 500), true, '收起后再打开恢复该题草稿');
  await page.getByRole('button', { name: '收起草稿纸' }).click();
});

test('切题隔离草稿、返回恢复；横竖屏变化保留完整笔迹', async () => {
  await openPractice();
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.locator('.q-progress-text').waitFor();
  await page.getByRole('button', { name: '打开草稿纸' }).click();
  assert.match(await page.locator('.scratch-toolbar').evaluate((el) => getComputedStyle(el).color), /rgb\(255, 255, 255\)/, '深色主题工具栏使用清晰文字颜色');
  await dispatchStroke({ x1: 120, y1: 300, x2: 220, y2: 300 });
  assert.equal(await sampleInk(170, 300), true, 'A 题有笔迹');

  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForTimeout(100);
  assert.equal(await sampleInk(566, 292), true, '旋转窗口后按比例保留笔迹');
  await page.getByRole('button', { name: '收起草稿纸' }).click();
  await page.evaluate(() => window.nextQuestion());
  await page.locator('.q-progress-text').waitFor();
  await page.getByRole('button', { name: '打开草稿纸' }).click();
  assert.equal(await sampleInk(566, 292), false, 'B 题从空白草稿开始');
  await dispatchStroke({ x1: 330, y1: 360, x2: 400, y2: 360 });
  await page.getByRole('button', { name: '收起草稿纸' }).click();
  await page.evaluate(() => window.prevQuestion());
  await page.getByRole('button', { name: '打开草稿纸' }).click();
  assert.equal(await sampleInk(566, 292), true, '返回 A 题恢复原草稿');
  assert.equal(await sampleInk(360, 360), false, 'B 题笔迹没有串到 A 题');
  await page.getByRole('button', { name: '收起草稿纸' }).click();

  await page.evaluate(() => window.enterQuiz([
    { id: 'fresh', revision: 1, content: '新练习', options: ['A', 'B'], answer: '0', type: 1 },
  ], '自定义', 'custom', null, null, null, false));
  await page.getByRole('button', { name: '打开草稿纸' }).click();
  assert.equal(await sampleInk(566, 292), false, '开始全新题组后清除上一练习笔迹');

  await page.evaluate(() => window.pauseToggle());
  await page.locator('.scratch-overlay').waitFor({ state: 'detached' });
  const pausedTime = await page.locator('#timer-text').textContent();
  await page.waitForTimeout(650);
  assert.equal(await page.locator('#timer-text').textContent(), pausedTime, '暂停时关闭草稿并冻结计时');
  await page.getByRole('button', { name: '打开草稿纸' }).click();
  assert.equal(await page.locator('.scratch-overlay').count(), 0, '暂停期间不能再次打开草稿纸');
  assert.match(await page.locator('#toast').textContent(), /已暂停/, '暂停时提示先继续');
  await page.evaluate(() => window.pauseToggle());
  await page.getByRole('button', { name: '打开草稿纸' }).click();
  await dispatchStroke({ x1: 220, y1: 400, x2: 280, y2: 400 });
  await page.getByRole('button', { name: '收起草稿纸' }).click();

  await page.locator('#btn-auth-logout').click();
  await page.locator('.auth-card').waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.scratch-fab, .scratch-overlay').count(), 0, '退出账号后移除草稿入口和画布');
});

test('倒计时自动交卷会收起画布并清除草稿入口', async () => {
  await openPractice();
  await page.evaluate(() => window.enterQuiz([
    { id: 'countdown', revision: 1, content: '倒计时交卷草稿测试', options: ['A', 'B'], answer: '0', type: 1 },
  ], '自定义', 'quiz', null, null, 1, false));
  await page.getByRole('button', { name: '打开草稿纸' }).click();
  await dispatchStroke({ x1: 100, y1: 360, x2: 220, y2: 360 });
  await page.waitForFunction(() => document.querySelector('#app-title')?.textContent.includes('成绩与解析'), null, { timeout: 15000 });
  await page.locator('.scratch-overlay').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.scratch-fab').count(), 0, '自动交卷完成后清理本次练习草稿');
});
