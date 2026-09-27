import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'playwright-core';

const ROOT = new URL('.', import.meta.url).pathname;
const dataDir = await mkdtemp(join(tmpdir(), 'exam-speed-e2e-'));
const screenshots = join(ROOT, 'docs/speed-review/screenshots');
let app, provider, browser, context, base, upstreamMode = 'valid';
const requests = [];
const review = {
  status: 'method', methodName: '百分数转分数', recognition: '看到 12.5%，想到 1/8。',
  steps: ['把 796 × 12.5% 改写成 796 ÷ 8。', '先算 800 ÷ 8，再减去 4 ÷ 8，得到 99.5。'],
  whyCorrect: '12.5%=1/8，这是精确等价变形，结果为 99.5。',
  applicability: '百分数能准确转成简单分数时适用。', caution: '12.8% 不等于 1/8，不能直接套用。',
  diagnosis: '用时超过练习参考线，仅凭时间无法判断慢因。', drillMethod: 'percent_fraction',
};
async function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
async function api(path, body, method = 'POST') {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
}
before(async () => {
  provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: upstreamMode === 'valid' ? JSON.stringify(review) : '并非结构化结果' } }] }));
  });
  const providerPort = await listen(provider);
  const probe = http.createServer(); const appPort = await listen(probe); await new Promise((resolve) => probe.close(resolve));
  base = `http://127.0.0.1:${appPort}`;
  app = spawn(process.execPath, ['server.mjs', String(appPort)], { cwd: ROOT,
    env: { ...process.env, APP_DATA_DIR: dataDir, AI_CONFIG_DB: join(dataDir, 'ai-config.db'), AUTH_DISABLED: '1', HOST: '127.0.0.1' }, stdio: 'ignore' });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { try { if ((await fetch(base)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 60)); }
  assert.ok((await fetch(base)).ok);
  await api('/api/ai/agents/1', { api_key: 'synthetic-ui-test', key_storage_mode: 'server', base_url: `http://127.0.0.1:${providerPort}/v1`, model: 'ui-protocol-fixture', provider_mode: 'openai-compatible', enabled: 1, stream_enabled: 0, timeout_ms: 3000 }, 'PUT');
  await api('/api/custom/import', { name: '提速复盘验收测试', questions: [
    { prompt: '计算 796 × 12.5% 的值。', options: ['99.5', '95.5', '100.5', '98.5'], answer: 'A', answer_index: 0, analysis: '12.5%=1/8，796÷8=99.5。', category: '数量关系' },
    { prompt: '所有鲸都是哺乳动物。蓝鲸是鲸。可推出什么？', options: ['蓝鲸是哺乳动物', '所有哺乳动物是蓝鲸', '鲸不是哺乳动物', '无法推出'], answer: 'A', answer_index: 0, category: '判断推理' },
  ] });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await mkdir(screenshots, { recursive: true });
});
after(async () => {
  await browser?.close();
  if (app && app.exitCode == null) { app.kill(); await new Promise((r) => app.once('exit', r)); }
  await new Promise((r) => provider?.close(r)); await rm(dataDir, { recursive: true, force: true });
});

async function openPractice(page) {
  await page.goto(base);
  await page.locator('.custom-entry').click();
  await page.locator('[data-act="practice"]').first().click();
  await page.locator('#btn-cbm-start').click();
  await page.locator('.q-progress-text').waitFor();
}

test('完整练习→慢题→真实HTTP协议→新题独立作答→历史回看，手机与桌面布局', async () => {
  const page = await context.newPage(); const pageErrors = []; page.on('pageerror', (e) => pageErrors.push(e.message));
  await openPractice(page);
  // 测试夹具明确注入较长用时，无需让测试空等两分钟。
  await page.evaluate(() => { ensureAnswer(0).costMs = 160000; });
  await page.locator('.option').first().click();
  await page.locator('.q-progress-text').filter({ hasText: '2' }).waitFor();
  await page.locator('.option').first().click();
  await page.locator('.speed-summary').waitFor();
  assert.match(await page.locator('.speed-ranking-title').textContent(), /1 道题/);
  await page.getByLabel('统一参考秒数').fill('300'); await page.locator('.speed-controls').getByRole('button', { name: '应用', exact: true }).click();
  assert.match(await page.locator('.speed-ranking-title').textContent(), /没有/);
  await page.getByRole('button', { name: '按题型恢复' }).click();
  await page.locator('.speed-ranking-links button').first().click();
  const panel = page.locator('.speed-panel').first();
  await panel.getByLabel('做题卡点').selectOption('计算步骤较多');
  await panel.getByLabel('原解题方法').fill('我先把百分数转成小数再乘。');
  await panel.getByRole('button', { name: 'AI 分析本题方法' }).click();
  await panel.locator('.speed-result-title').waitFor();
  assert.equal(await panel.locator('.speed-result-title').textContent(), review.methodName);
  const upstream = JSON.stringify(requests.at(-1)); assert.match(upstream, /160\d{3}/); assert.match(upstream, /我先把百分数/);
  assert.equal(await panel.locator('.speed-drill-feedback').count(), 0);
  await panel.getByRole('button', { name: '独立练一道新题' }).click();
  assert.equal(await panel.locator('.speed-drill-feedback').count(), 0, '练习答案不可在作答前出现');
  assert.equal(await panel.locator('.speed-drill-option').count(), 4);
  await panel.locator('.speed-drill-option').first().click();
  assert.match(await panel.locator('.speed-drill-feedback').textContent(), /正确答案/);
  assert.equal(await panel.locator('.speed-drill-option:not(:disabled)').count(), 0);
  const firstPrompt = await panel.locator('.speed-drill-prompt').textContent();
  await panel.getByRole('button', { name: '再练一道新题' }).click();
  assert.notEqual(await panel.locator('.speed-drill-prompt').textContent(), firstPrompt, '再练必须换题，不能记住原答案');
  assert.equal(await panel.locator('.speed-drill-feedback').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '手机无横向溢出');
  await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(screenshots, 'mobile-review.png'), fullPage: true });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: join(screenshots, 'desktop-dark-review.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const id = await page.evaluate(() => store.state.attemptId);
  await page.reload(); await page.locator('.custom-entry').waitFor();
  await page.evaluate((attemptId) => openAttemptReview(attemptId), id);
  await page.locator('.speed-summary').waitFor();
  assert.match(await page.locator('.speed-ranking-title').textContent(), /1 道题/);
  await page.locator('.speed-toggle').first().click();
  await page.locator('.speed-generate').first().click();
  await page.locator('.speed-result-title').first().waitFor();
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  await page.close();
});

test('模型格式异常明确失败且可重试；隐藏页面排除逐题时间，考试钟继续', async () => {
  const page = await context.newPage(); await openPractice(page);
  const timing = await page.evaluate(async () => {
    // 模拟浏览器 visibilitychange；不把后台间隔记入逐题时间。
    const s = store.state; stampCost(s.idx); ensureAnswer(s.idx).costMs = 0;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 130)); syncTimer();
    const hiddenCost = ensureAnswer(s.idx).costMs; const wall = s.timing.elapsedMs;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 70)); stampCost(s.idx);
    return { hiddenCost, active: ensureAnswer(s.idx).costMs, wall };
  });
  assert.ok(timing.hiddenCost < 20); assert.ok(timing.active >= 50 && timing.active < 180); assert.ok(timing.wall >= 120);
  await page.locator('.option').first().click(); await page.locator('.q-progress-text').filter({ hasText: '2' }).waitFor();
  await page.locator('.option').first().click(); await page.locator('.speed-summary').waitFor();
  upstreamMode = 'invalid';
  await page.locator('.speed-toggle').first().click(); await page.locator('.speed-generate').first().click();
  await page.locator('.speed-result .speed-error').waitFor();
  assert.match(await page.locator('.speed-result .speed-error').textContent(), /格式/);
  assert.equal(await page.locator('.speed-drill').count(), 0);
  upstreamMode = 'valid';
  await page.locator('.speed-generate').first().click(); await page.locator('.speed-result-title').first().waitFor();
  await page.close();
});

test('先看解析再作答保留辅助标记，当前及历史均不列入慢题', async () => {
  const page = await context.newPage(); await openPractice(page);
  await page.evaluate(() => { ensureAnswer(0).costMs = 180000; });
  await page.getByRole('button', { name: '查看解析', exact: true }).click();
  assert.equal(await page.evaluate(() => store.state.answers[0].assisted), true);
  await page.locator('.option').first().click();
  await page.locator('.q-progress-text').filter({ hasText: '2' }).waitFor();
  await page.locator('.option').first().click(); await page.locator('.speed-summary').waitFor();
  assert.match(await page.locator('.speed-ranking-title').textContent(), /没有/);
  const attemptId = await page.evaluate(() => store.state.attemptId);
  const saved = await api(`/api/attempts/${encodeURIComponent(attemptId)}`, null, 'GET');
  assert.equal(saved.records[0].assisted, true, '辅助状态随作答快照保存');
  await page.evaluate((id) => openAttemptReview(id), attemptId); await page.locator('.speed-summary').waitFor();
  assert.match(await page.locator('.speed-ranking-title').textContent(), /没有/);
  assert.equal(await page.evaluate(() => store.state.answers[0].assisted), true);
  await page.close();
});
