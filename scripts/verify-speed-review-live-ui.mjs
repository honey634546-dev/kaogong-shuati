#!/usr/bin/env node
/**
 * Opt-in, one-request real-provider UI verification using synthetic questions.
 * node scripts/verify-speed-review-live-ui.mjs --live
 * Optional: --db=/absolute/ai-config.db --user=<owner-id>
 * Original credentials are read-only and decrypted only in memory. The temporary
 * loopback app uses a disposable account and encrypted per-user key storage.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { createSpeedReviewAgent } from '../public/speed-review-core.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const arg = (name, fallback = '') => args.find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
if (!args.includes('--live')) {
  console.log('未运行真实模型。显式加 --live 可执行一次合成题 UI 验收；原配置只读，临时凭据库会清理。');
  process.exit(0);
}
const outputDir = join(root, 'docs/speed-review');
const report = {
  version: 1, generatedAt: new Date().toISOString(), mode: 'real-provider-ui', status: 'running',
  evidenceBoundary: 'One synthetic question with an explicitly injected 160-second timer and automated answers verifies the actual provider-to-UI flow. It does not measure human learning, independence or speed improvement.',
  model: null, timings: {}, review: null, drill: null, pageErrors: [],
  appRequests: 0, screenshots: [], cleanup: { serverStopped: false, temporaryCredentialDatabaseRemoved: false },
};
let connection, app, browser, dataDir, base, cookie = '';

function safeError(error) {
  let message = String(error?.message || error || 'Unknown error');
  for (const secret of [connection?.api_key, connection?.base_url, cookie].filter(Boolean)) message = message.split(secret).join('[REDACTED]');
  return message.replace(/https?:\/\/[^\s"<>]+/g, '[REDACTED_URL]').slice(0, 1800);
}
function readConnection() {
  const filename = resolve(root, arg('db', 'data/ai-config.db'));
  const db = new DatabaseSync(filename, { readOnly: true });
  let rows;
  try {
    const owner = arg('user');
    rows = db.prepare(`SELECT role, model, base_url, api_key_encrypted, enabled, temperature,
      max_tokens, reasoning_effort, provider_mode, key_storage_mode, stream_enabled,
      vision_enabled, timeout_ms FROM user_ai_agents
      WHERE role='xingce-explainer' AND enabled=1 AND key_storage_mode='server'
      AND length(trim(api_key_encrypted)) > 0 ${owner ? 'AND user_id=?' : ''}`)
      .all(...(owner ? [owner] : []));
  } finally { db.close(); }
  assert.equal(rows.length, 1, '需要唯一启用的服务端行测账号配置；可用 --user 选择');
  const row = rows[0];
  assert.notEqual(row.provider_mode, 'mock', '真实验收不能使用 Mock');
  const secretText = String(process.env.AI_KEY_ENCRYPTION_SECRET || '').trim()
    || fs.readFileSync(join(dirname(filename), '.ai-key-encryption-secret'), 'utf8').trim();
  const [iv, tag, encrypted] = row.api_key_encrypted.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secretText).digest(), iv);
  decipher.setAuthTag(tag);
  const apiKey = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  assert.ok(apiKey, '凭据解密失败');
  return createSpeedReviewAgent({ ...row, api_key: apiKey });
}
async function freePort() {
  const probe = http.createServer();
  const port = await new Promise((resolvePort, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', () => resolvePort(probe.address().port)); });
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}
async function api(path, body, method = 'POST') {
  const response = await fetch(base + path, {
    method, headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`临时验收接口 ${path} 返回 ${response.status}：${value.error || '请求失败'}`);
  return { value, response };
}

try {
  connection = readConnection();
  report.model = connection.model;
  report.settings = { maxTokens: connection.max_tokens, reasoningEffort: connection.reasoning_effort, temperature: connection.temperature, timeoutMs: connection.timeout_ms };
  report.provenance = { coreSha256: createHash('sha256').update(fs.readFileSync(join(root, 'public/speed-review-core.mjs'))).digest('hex') };
  dataDir = await mkdtemp(join(tmpdir(), 'exam-speed-live-ui-'));
  fs.chmodSync(dataDir, 0o700);
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  // AUTH_DISABLED would use the legacy unencrypted profile table. Keep auth enabled
  // here so the real-flow check also exercises encrypted per-account credentials.
  app = spawn(process.execPath, ['server.mjs', String(port)], { cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', AUTH_DISABLED: '0', AI_MOCK: '0', APP_DATA_DIR: dataDir,
      AI_CONFIG_DB: join(dataDir, 'ai-config.db'), BETTER_AUTH_SECRET: randomBytes(48).toString('hex'),
      BETTER_AUTH_URL: base, AI_KEY_ENCRYPTION_SECRET: randomBytes(48).toString('hex') }, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(ready, '临时服务未启动');
  const account = await api('/api/auth/sign-up/email', { name: '提速验收测试账号', email: `live-ui-${Date.now()}@example.com`, password: randomBytes(24).toString('hex') });
  cookie = account.response.headers.get('set-cookie')?.split(';')[0] || '';
  assert.ok(cookie, '测试账号没有会话');
  await api('/api/ai/agents/1', {
    api_key: connection.api_key, key_storage_mode: 'server', base_url: connection.base_url,
    model: connection.model, provider_mode: connection.provider_mode, enabled: 1,
    stream_enabled: 0, timeout_ms: connection.timeout_ms, max_tokens: connection.max_tokens,
    reasoning_effort: connection.reasoning_effort, temperature: connection.temperature,
  }, 'PUT');
  const temporaryDb = new DatabaseSync(join(dataDir, 'ai-config.db'), { readOnly: true });
  try {
    const stored = temporaryDb.prepare('SELECT api_key_encrypted FROM user_ai_agents WHERE user_id=? AND agent_id=1').get(account.value.user.id);
    assert.ok(stored?.api_key_encrypted && !stored.api_key_encrypted.includes(connection.api_key), '临时 Key 应只以密文保存');
  } finally { temporaryDb.close(); }
  await api('/api/custom/import', { name: '真实模型提速验收（合成题）', visibility: 'private', questions: [
    { prompt: '计算 796 × 12.5% 的值。', options: ['99.5', '95.5', '100.5', '98.5'], answer: 'A', answer_index: 0, analysis: '12.5%=1/8，796÷8=99.5。', category: '数量关系' },
    { prompt: '某单位有 360 名员工，其中技术人员占 25%。技术人员有多少名？', options: ['90', '80', '100', '120'], answer: 'A', answer_index: 0, analysis: '25%=1/4，360÷4=90。', category: '数量关系' },
  ] });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const equals = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, equals), value: cookie.slice(equals + 1), url: base, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  page.on('pageerror', (e) => report.pageErrors.push(safeError(e)));
  page.on('request', (request) => { if (request.url() === base + '/api/ai/speed-review') report.appRequests++; });
  await page.goto(base);
  await page.locator('.custom-entry').click();
  await page.locator('[data-act="practice"]').first().click();
  await page.locator('#btn-cbm-start').click();
  await page.locator('.q-progress-text').waitFor();
  await page.evaluate(() => { ensureAnswer(0).costMs = 160000; });
  await page.locator('.option').first().click();
  await page.locator('.q-progress-text').filter({ hasText: '2' }).waitFor();
  await page.locator('.option').first().click();
  await page.locator('.speed-summary').waitFor();
  assert.match(await page.locator('.speed-ranking-title').textContent(), /1 道/);
  assert.equal(await page.locator('.speed-toggle').first().textContent(), '分析解题方法');
  assert.equal(await page.locator('.speed-type').first().textContent(), '数量关系');
  assert.equal(await page.locator('.speed-origin').count(), 0, '本例使用来源分类，不应误标为题面识别');
  assert.equal(report.appRequests, 0, '显示方法入口和参考用时不应自动调用模型');
  report.capability = { label: await page.locator('.speed-type').first().textContent(), focus: await page.locator('.speed-focus').first().textContent(), source: 'source' };
  report.timings = { injectedSolveMs: 160000, uiTimingBadge: await page.locator('.speed-time').first().textContent() };
  await page.locator('.speed-ranking-links button').first().click();
  const panel = page.locator('.speed-panel').first();
  await panel.getByLabel('做题卡点').selectOption('计算步骤较多');
  await panel.getByLabel('原解题方法').fill('先把 12.5% 转成小数，再做 796 × 0.125，计算步骤比较多。');
  const resultPromise = page.waitForResponse((response) => response.url() === base + '/api/ai/speed-review', { timeout: Math.max(180000, Number(connection.timeout_ms) + 15000) });
  const started = Date.now();
  await panel.getByRole('button', { name: 'AI 分析本题方法' }).click();
  const result = await (await resultPromise).json();
  report.timings.providerAndServerElapsedMs = Date.now() - started;
  assert.equal(result.mock, false, '响应必须来自真实模型');
  assert.equal(result.review?.status, 'method', result.notice || '本例需要成功的方法建议');
  report.review = result.review;
  assert.equal(result.review.drillMethod, 'percent_fraction');
  assert.match(JSON.stringify(result.review), /99\.5/);
  await panel.locator('.speed-result-title').waitFor();
  assert.equal(await panel.locator('.speed-result-title').textContent(), result.review.methodName);
  await mkdir(outputDir, { recursive: true });
  await panel.locator('.speed-result-title').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(outputDir, 'live-mobile.png') });
  report.screenshots.push({ path: 'live-mobile.png', width: 390, height: 844 });
  await panel.getByRole('button', { name: '独立练一道新题' }).click();
  assert.equal(await panel.locator('.speed-drill-feedback').count(), 0, '作答前不应出现答案');
  const prompt = await panel.locator('.speed-drill-prompt').textContent();
  const numbers = prompt.match(/共\s*(\d+)\s*件.*占\s*([\d.]+)%/);
  assert.ok(numbers, '基础练习题型应可独立验算');
  const expected = Number(numbers[1]) * Number(numbers[2]) / 100;
  const options = await panel.locator('.speed-drill-option').allTextContents();
  const selectedIndex = options.findIndex((text) => Math.abs(Number(text.replace(/^[A-D]\s*/, '')) - expected) < 1e-9);
  assert.ok(selectedIndex >= 0, '新题应包含数学验算得到的正确选项');
  await panel.locator('.speed-drill-option').nth(selectedIndex).click();
  const feedback = await panel.locator('.speed-drill-feedback').textContent();
  assert.match(feedback, /答对了/);
  assert.equal(await panel.locator('.speed-drill-option:not(:disabled)').count(), 0);
  report.drill = { prompt, expected, selectedIndex, correct: true, answerHiddenUntilSubmission: true, feedback };
  await page.setViewportSize({ width: 1360, height: 900 });
  await panel.locator('.speed-result-title').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(outputDir, 'live-desktop.png') });
  report.screenshots.push({ path: 'live-desktop.png', width: 1360, height: 900 });
  assert.equal(report.appRequests, 1, '仅执行一次真实模型 UI 请求');
  assert.equal(report.pageErrors.length, 0, '页面不应报错');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = safeError(error); process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch (error) { report.cleanup.browserError = safeError(error); }
  if (app && app.exitCode == null) {
    app.kill('SIGTERM');
    await new Promise((resolveExit) => app.once('exit', resolveExit));
  }
  report.cleanup.serverStopped = !app || app.exitCode !== null || app.signalCode !== null;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  report.cleanup.temporaryCredentialDatabaseRemoved = !dataDir || !fs.existsSync(dataDir);
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'live-ui.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, model: report.model, appRequests: report.appRequests, pageErrors: report.pageErrors.length, cleanup: report.cleanup, report: 'docs/speed-review/live-ui.json', ...(report.error ? { error: report.error } : {}) }));
}
