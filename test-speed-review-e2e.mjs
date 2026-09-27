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
  diagnosis: '你提到先把百分数转成小数再乘，可以对照 796 ÷ 8，检查是否减少了中间计算步骤。', drillMethod: 'percent_fraction',
};
const noShortcutReview = {
  status: 'no_shortcut', methodName: '', recognition: '普通两位数加法，用按位相加即可，不需要引入新公式。',
  steps: ['先算 37 + 40 = 77。', '再加剩余的 8，得到 85。'],
  whyCorrect: '把 48 拆成 40 与 8，加法结合律保证结果不变。',
  applicability: '适用于本题的两位数加法。', caution: '注意个位进位，不能为省步骤漏算。',
  diagnosis: '仅凭用时无法判断慢因；可检查是否卡在进位或反复验算。', drillMethod: null,
};
const reasoningFixtures = [
  { category: '判断推理', expectedLabel: '文字判断', expectedSource: 'source', prompt: '甲、乙、丙三人排队，甲不在最后，乙在丙前。以下哪种顺序满足全部条件？', options: ['甲乙丙', '丙甲乙', '乙丙甲', '丙乙甲'], methodName: '逐项核对排队条件', steps: ['排除甲在最后的乙丙甲。', '排除乙在丙后的丙甲乙和丙乙甲，甲乙丙满足全部条件。'], whyCorrect: '甲乙丙中甲不在最后且乙在丙前，其他选项均违反至少一个条件。' },
  { category: '', expectedLabel: '定义判断', expectedSource: 'structure', prompt: '公共物品是指能够供多人同时使用，且无法轻易排除他人使用的物品。根据上述定义，下列属于公共物品的是？', options: ['开放街道的照明', '个人餐盒', '会员私用储物柜', '售票影院的座位'], methodName: '核对定义的两个条件', steps: ['提取多人共用和难以排除他人两个条件。', '街道照明同时满足两条件；餐盒、私用储物柜和售票座位都能排除他人使用。'], whyCorrect: '按题目给出的定义逐项判断，只有开放街道照明满足两个必要条件。' },
  { category: '', expectedLabel: '类比推理', expectedSource: 'structure', prompt: '剪刀：裁剪', options: ['锅铲：炒菜', '纸张：剪刀', '衣服：裁剪', '裁剪：剪刀'], methodName: '保持工具与用途的顺序', steps: ['剪刀是用于裁剪的工具，关系为工具到用途。', '锅铲用于炒菜且顺序一致；其他选项的关系或方向不同。'], whyCorrect: '锅铲与炒菜复现题干的工具与用途关系，且前后顺序一致。' },
  { category: '', expectedLabel: '逻辑判断', expectedSource: 'structure', prompt: '所有参加培训的员工都已通过资格审核。小王参加了培训。由此可以推出哪项？', options: ['小王已通过资格审核', '所有通过审核的人都参加培训', '小王未通过审核', '未参加培训的人都未通过审核'], methodName: '沿充分条件正向推导', steps: ['把条件写成参加培训推出通过审核。', '小王参加培训，因此小王通过审核；不能反向推导。'], whyCorrect: '小王满足题目给定的充分条件，正向应用即可推出通过审核。' },
].map((item) => ({ ...item, answer: 'A', answer_index: 0, analysis: item.whyCorrect }));
// Reproduce the real provider's verbose internal-field disclaimer. The UI must
// replace it when the learner has supplied no account of their solving process.
const reasoningReview = (item) => ({ status: 'method', methodName: item.methodName, recognition: `先明确本题的${item.expectedLabel}结构。`, steps: item.steps, whyCorrect: item.whyCorrect, applicability: '适用于本题给出的完整文字条件和选项。', caution: '只使用题目给出的条件，不添加常识假设或颠倒关系。', diagnosis: 'timing.assisted 为 null，userApproach 为空，无法判断是否独立作答。仅凭 solveMs 不能判断用户能力、速度或掌握程度，也不能排除应用外辅助。不要据此推测用户卡点或宣称已经提速。', drillMethod: null });
const noProcessDiagnosis = '仅凭用时无法确定慢因。对照下面的解题步骤，找出与你当时做法不同的一步。';
async function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
async function api(path, body, method = 'POST') {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
}
before(async () => {
  provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const matchingReasoning = reasoningFixtures.find((item) => JSON.stringify(requests.at(-1).messages).includes(item.prompt));
    res.writeHead(200, { 'content-type': 'application/json' });
    const content = upstreamMode === 'valid' ? JSON.stringify(matchingReasoning ? reasoningReview(matchingReasoning) : review)
      : upstreamMode === 'no_shortcut' ? JSON.stringify(noShortcutReview) : '并非结构化结果';
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
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
    { prompt: '所有鲸都是哺乳动物。蓝鲸是鲸。可推出什么？', options: ['蓝鲸是哺乳动物', '所有哺乳动物是蓝鲸', '鲸不是哺乳动物', '无法推出'], answer: 'A', answer_index: 0, category: '逻辑判断' },
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

async function openPractice(page, batchName = '提速复盘验收测试') {
  await page.goto(base);
  await page.locator('.custom-entry').click();
  await page.locator('.custom-batch').filter({ hasText: batchName }).getByRole('button', { name: '刷题', exact: true }).click();
  await page.locator('#cbm-count').fill('0');
  await page.locator('#btn-cbm-start').click();
  await page.locator('.q-progress-text').waitFor();
}

// A complete temporary import/practice/history flow exercises persisted category
// metadata. These are synthetic questions, not a human usability study.
async function finishPractice(page) {
  const count = await page.evaluate(() => store.state.questions.length);
  for (let index = 0; index < count; index++) {
    await page.waitForFunction((expected) => store.state.idx === expected, index);
    await page.evaluate(() => { ensureAnswer(store.state.idx).costMs = 180000; });
    await page.locator('button.option').first().click();
  }
  await waitForReview(page, count);
  return page.evaluate(() => store.state.attemptId);
}

async function waitForReview(page, count) {
  await page.locator('.review-card').last().waitFor();
  assert.equal(await page.locator('.review-card').count(), count);
  // Unsupported-only papers deliberately have no .speed-summary to wait for.
  // Wait for the real lazy module and its render callback before checking absence.
  await page.evaluate(async () => {
    await import('/speed-review-ui.mjs');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

const eligibilityFixture = ({ prompt, category = '', options = ['选项甲', '选项乙', '选项丙', '选项丁'], answer = 'A', ...extra }) => ({
  prompt, category, options, answer, answer_index: answer ? 0 : -1,
  analysis: `验收题库解析：${prompt}。`, ...extra,
});

const supportedFixtures = [
  eligibilityFixture({ prompt: '数量正例：计算 796 × 12.5% 的值。', category: '数量关系', options: ['99.5', '95.5', '100.5', '98.5'] }),
  eligibilityFixture({ prompt: '资料正例：某厂本年产量 132 件，同比增长 10%，上年产量多少件？', category: '资料分析', options: ['120', '122', '125', '130'] }),
  eligibilityFixture({ prompt: '言语正例：政治常识的学习需要理解，不能只记结论。这段话的主旨是什么？', category: '言语理解', options: ['学习需要理解', '只需记结论', '无需学习', '否定一切结论'] }),
  eligibilityFixture({ prompt: '逻辑正例：所有鲸都是哺乳动物，蓝鲸是鲸，可推出什么？', category: '逻辑判断', options: ['蓝鲸是哺乳动物', '所有哺乳动物是蓝鲸', '鲸不是哺乳动物', '无法推出'] }),
];
const unsupportedFixtures = [
  eligibilityFixture({ prompt: '常识负例：蒸发时物质从周围吸收还是放出热量？', category: '常识判断' }),
  eligibilityFixture({ prompt: '政治负例：下列哪项属于政治理论基础知识？', category: '政治理论' }),
  eligibilityFixture({ prompt: '图形负例：观察下列图形，选择能填入问号处的选项。', category: '判断推理/图形推理' }),
  eligibilityFixture({ prompt: '未知负例：这道题没有可靠的题型元数据。' }),
  eligibilityFixture({ prompt: '缺答案负例：计算 18 加 25 的结果。', category: '数量关系', answer: '' }),
  eligibilityFixture({ prompt: '字母占位负例：选择图形规律对应的选项。', category: '数量关系', options: ['A. A', 'B. B', 'C. C', 'D. D'] }),
  eligibilityFixture({ prompt: '题图缺失负例：【本题原卷含题目图片，当前导入文件未包含图片】', category: '数量关系' }),
  eligibilityFixture({ prompt: '材料缺图负例：依据材料回答增长率。', category: '资料分析', material: '【共享材料含图片，当前导入文件未包含图片】' }),
  eligibilityFixture({ prompt: '选项缺图负例：选择满足条件的选项。', category: '数量关系', options: ['（原卷图形选项，图片未随导入提供）', '选项乙', '选项丙', '选项丁'] }),
  eligibilityFixture({ prompt: '父判断图形操作负例：将下列图形分为两组，每组包含三个图形。', category: '判断推理' }),
  eligibilityFixture({ prompt: '分类冲突负例：下列选项中哪个成立？', category: '数量关系/言语理解' }),
];

async function assertCapabilityEntrance(page, supported, unsupported) {
  assert.equal(await page.locator('.speed-card').count(), supported.length, '只为可以分析的题渲染方法模块');
  assert.equal(await page.locator('.speed-toggle').count(), supported.length);
  for (const question of supported) {
    const card = page.locator('.review-card').filter({ has: page.locator('.q-content').filter({ hasText: question.prompt }) });
    assert.equal(await card.locator('.speed-toggle').textContent(), '分析解题方法');
    const capability = (await card.locator('.speed-capability').textContent()).trim();
    const label = question.expectedLabel || question.category;
    assert.match(capability, new RegExp(label), '入口前显示已识别题型');
    assert.ok(capability.length > label.length + 4, '题型旁包含本类可分析的方法方向');
    if (question.expectedSource) {
      assert.equal(await card.locator('.speed-origin').count(), question.expectedSource === 'structure' ? 1 : 0);
      if (question.expectedSource === 'structure') assert.equal(await card.locator('.speed-origin').textContent(), '题面识别');
    }
    assert.doesNotMatch(capability, /已提速|秒杀|已验证快解/, '可分析不得变成已经发现捷径的承诺');
  }
  for (const question of unsupported) {
    const card = page.locator('.review-card').filter({ has: page.locator('.q-content').filter({ hasText: question.prompt }) });
    assert.equal(await card.count(), 1, question.prompt);
    assert.equal(await card.locator('.speed-card, .speed-toggle, .speed-generate').count(), 0, `${question.prompt} 不暴露无效方法入口`);
    const analysis = card.locator('.answer-box').filter({ hasText: `验收题库解析：${question.prompt}` });
    assert.equal(await analysis.isVisible(), true, '不适用方法分析的题仍可正常查看题库解析');
    assert.equal(await card.getByRole('button', { name: 'AI 解析本题', exact: true }).isVisible(), true, '普通解析入口保留');
    assert.equal(await card.locator('.review-time').isVisible(), true, '普通用时信息保留');
  }
  assert.equal(await page.getByText('本题以知识辨析为主，首版暂不生成自动快解。', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '页面无横向溢出');
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
  assert.match(await page.locator('.speed-ranking-title').textContent(), /1 道/);
  await page.getByLabel('统一参考秒数').fill('300'); await page.locator('.speed-controls').getByRole('button', { name: '应用', exact: true }).click();
  assert.match(await page.locator('.speed-ranking-title').textContent(), /暂无/);
  await page.getByRole('button', { name: '按题型恢复' }).click();
  await page.locator('.speed-ranking-links button').first().click();
  const panel = page.locator('.speed-panel').first();
  await panel.getByLabel('做题卡点').selectOption('计算步骤较多');
  await panel.getByLabel('原解题方法').fill('我先把百分数转成小数再乘。');
  await panel.getByRole('button', { name: 'AI 分析本题方法' }).click();
  await panel.locator('.speed-result-title').waitFor();
  assert.equal(await panel.locator('.speed-result-title').textContent(), review.methodName);
  assert.equal(await panel.locator('.speed-explanation').filter({ hasText: '用时线索' }).locator('p').textContent(), review.diagnosis, '用户描述了原解法时保留针对该过程的模型建议');
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
  assert.match(await page.locator('.speed-ranking-title').textContent(), /1 道/);
  await page.locator('.speed-toggle').first().click();
  await page.locator('.speed-generate').first().click();
  await page.locator('.speed-result-title').first().waitFor();
  assert.equal(await page.locator('.speed-explanation').filter({ hasText: '用时线索' }).first().locator('p').textContent(), noProcessDiagnosis, '历史回看未重填自述时不能沿用先前的个性诊断');
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
  assert.match(await page.locator('.speed-ranking-title').textContent(), /暂无/);
  const attemptId = await page.evaluate(() => store.state.attemptId);
  const saved = await api(`/api/attempts/${encodeURIComponent(attemptId)}`, null, 'GET');
  assert.equal(saved.records[0].assisted, true, '辅助状态随作答快照保存');
  await page.evaluate((id) => openAttemptReview(id), attemptId); await page.locator('.speed-summary').waitFor();
  assert.match(await page.locator('.speed-ranking-title').textContent(), /暂无/);
  assert.equal(await page.evaluate(() => store.state.answers[0].assisted), true);
  await page.close();
});

test('混合卷仅推荐可分析慢题，题型与方法方向在点击前可见；历史保持同样资格', async () => {
  const batchName = '方法入口混合卷负例验收';
  await api('/api/custom/import', { name: batchName, questions: [...supportedFixtures, ...unsupportedFixtures] });
  const page = await context.newPage();
  const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
  const callsBefore = requests.length;
  let methodCalls = 0;
  page.on('request', (request) => { if (request.url() === base + '/api/ai/speed-review') methodCalls++; });
  await openPractice(page, batchName);
  const attemptId = await finishPractice(page);
  await assertCapabilityEntrance(page, supportedFixtures, unsupportedFixtures);
  assert.match(await page.locator('.speed-ranking-title').textContent(), /4 道/);
  const links = await page.locator('.speed-ranking-links button').allTextContents();
  assert.equal(links.length, 3);
  links.forEach((text) => assert.match(text, /第 [1-4] 题/, '常识等不支持题即使用时更长也不进入方法推荐'));
  await page.locator('.speed-summary').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, 'capability-mixed-mobile.png') });
  const knowledge = page.locator('.review-card').filter({ has: page.locator('.q-content').filter({ hasText: unsupportedFixtures[0].prompt }) });
  await knowledge.scrollIntoViewIfNeeded();
  await knowledge.screenshot({ path: join(screenshots, 'capability-knowledge-no-entry-mobile.png') });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.locator('.speed-summary').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, 'capability-mixed-desktop.png') });
  await page.reload(); await page.locator('.custom-entry').waitFor();
  await page.evaluate((id) => openAttemptReview(id), attemptId);
  await waitForReview(page, supportedFixtures.length + unsupportedFixtures.length);
  await assertCapabilityEntrance(page, supportedFixtures, unsupportedFixtures);
  assert.match(await page.locator('.speed-ranking-title').textContent(), /4 道/);
  assert.equal(methodCalls, 0, '查看成绩与历史资格不应自动发起方法请求');
  assert.equal(requests.length, callsBefore, '不调用模型也能在入口前排除已知不支持题');
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('父判断与无细类历史无需补标签即可分析；结构识别明确标注来源且返回对应题型的方法', async () => {
  const batchName = '旧分类与结构识别验收';
  const imported = await api('/api/custom/import', { name: batchName, questions: reasoningFixtures });
  const rawBefore = await api(`/api/custom/questions?batch_id=${imported.id}`, null, 'GET');
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const callsBefore = requests.length;
  await openPractice(page, batchName);
  const attemptId = await finishPractice(page);
  await assertCapabilityEntrance(page, reasoningFixtures, []);
  assert.match(await page.locator('.speed-ranking-title').textContent(), /4 道/);
  const savedBefore = await api(`/api/attempts/${encodeURIComponent(attemptId)}`, null, 'GET');
  for (const [index, item] of reasoningFixtures.entries()) {
    assert.equal(savedBefore.records[index].question.category, item.category);
    assert.equal(savedBefore.records[index].question.subCategory, undefined, '旧快照形状没有细类字段也必须可用');
  }
  await page.reload(); await page.locator('.custom-entry').waitFor();
  await page.evaluate((id) => openAttemptReview(id), attemptId);
  await waitForReview(page, reasoningFixtures.length);
  await assertCapabilityEntrance(page, reasoningFixtures, []);
  assert.equal(requests.length, callsBefore, '分类与入口展示不应消耗模型请求');
  for (const [index, item] of reasoningFixtures.entries()) {
    const card = page.locator('.review-card').filter({ has: page.locator('.q-content').filter({ hasText: item.prompt }) });
    await card.locator('.speed-toggle').click();
    await card.locator('.speed-generate').click();
    await card.locator('.speed-result-title').waitFor();
    assert.equal(await card.locator('.speed-result-title').textContent(), item.methodName);
    assert.equal(await card.locator('.speed-explanation').filter({ hasText: '用时线索' }).locator('p').textContent(), noProcessDiagnosis, '空自述必须显示固定的两句可操作提示');
    assert.ok((await card.locator('.speed-result').textContent()).includes(item.steps[0]));
    assert.doesNotMatch(await card.locator('.speed-result').textContent(), /百分数转分数|首版暂不生成|本题以知识辨析|timing\.assisted|assisted|null|userApproach|solveMs|不能判断用户能力/);
    assert.equal(await card.locator('.speed-drill').count(), 0, '文字判断不能套用数学基础练习');
    assert.ok(JSON.stringify(requests.at(-1).messages).includes(item.prompt));
    if (index < 2) {
      await card.locator('.speed-capability').evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 90));
      await page.screenshot({ path: join(screenshots, index === 0 ? 'capability-broad-history-mobile.png' : 'capability-inferred-definition-history-mobile.png') });
    }
  }
  assert.equal(requests.length, callsBefore + reasoningFixtures.length, '仅用户主动展开并生成的四题发起请求');
  assert.deepEqual((await api(`/api/attempts/${encodeURIComponent(attemptId)}`, null, 'GET')).records, savedBefore.records);
  const rawAfter = await api(`/api/custom/questions?batch_id=${imported.id}`, null, 'GET');
  assert.deepEqual(rawAfter.questions.map(({ category, fingerprint, revision }) => ({ category, fingerprint, revision })), rawBefore.questions.map(({ category, fingerprint, revision }) => ({ category, fingerprint, revision })));
  assert.deepEqual(errors, []);
  await page.close();
});

test('导入题目编辑保留已存在的细类路径及任意来源分类', async () => {
  const batchName = '编辑分类保留验收';
  const categories = ['判断推理/定义判断', '国考真题/判断推理/定义判断'];
  const imported = await api('/api/custom/import', { name: batchName, questions: categories.map((category, index) => ({ ...reasoningFixtures[1], category, prompt: `编辑样本${index}：${reasoningFixtures[1].prompt}` })) });
  const rows = (await api(`/api/custom/questions?batch_id=${imported.id}`, null, 'GET')).questions;
  const page = await context.newPage();
  await page.goto(base); await page.locator('.custom-entry').waitFor();
  for (const question of rows) {
    await page.evaluate(({ question, name }) => customEditQuestion(question, name), { question, name: batchName });
    await page.locator('#eq-category').waitFor();
    assert.equal(await page.locator('#eq-category').inputValue(), question.category);
    assert.equal(await page.locator('#eq-category option:checked').textContent(), question.category);
    await page.locator('#eq-cancel').click();
  }
  await page.close();
});

test('全不支持卷及其历史没有提速模块，也不影响普通题目用时和已有解析', async () => {
  const batchName = '全部不适用方法入口验收';
  const questions = unsupportedFixtures.map((question) => {
    const prompt = `整卷负例：${question.prompt}`;
    return { ...question, prompt, analysis: `验收题库解析：${prompt}。` };
  });
  await api('/api/custom/import', { name: batchName, questions });
  const page = await context.newPage();
  const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
  const callsBefore = requests.length;
  await openPractice(page, batchName);
  const attemptId = await finishPractice(page);
  await assertCapabilityEntrance(page, [], questions);
  assert.equal(await page.locator('.speed-summary, .speed-ranking, .speed-panel').count(), 0, '整卷无可用能力时不显示空模块或改名后的假入口');
  await page.locator('.review-toolbar').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, 'capability-all-unsupported-mobile.png') });
  await page.reload(); await page.locator('.custom-entry').waitFor();
  await page.evaluate((id) => openAttemptReview(id), attemptId);
  await waitForReview(page, questions.length);
  await assertCapabilityEntrance(page, [], questions);
  assert.equal(await page.locator('.speed-summary, .speed-ranking, .speed-panel').count(), 0, '历史快照不能重新出现失效入口');
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.locator('.review-toolbar').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, 'capability-all-unsupported-history-desktop.png') });
  assert.equal(requests.length, callsBefore);
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('可分析题没有额外捷径时仍展示本题具体稳妥解法，不能退成不支持提示', async () => {
  const batchName = '常规方法结果验收';
  await api('/api/custom/import', { name: batchName, questions: [eligibilityFixture({
    prompt: '常规算法验收：计算 37 + 48。', category: '数量关系', options: ['85', '75', '86', '84'],
  })] });
  const page = await context.newPage();
  await openPractice(page, batchName);
  await finishPractice(page);
  await page.getByRole('button', { name: '分析解题方法', exact: true }).click();
  upstreamMode = 'no_shortcut';
  try {
    await page.locator('.speed-generate').click();
    await page.locator('.speed-result-title').waitFor();
    assert.equal(await page.locator('.speed-result-title').textContent(), '本题的稳妥解法');
    const result = await page.locator('.speed-result').textContent();
    assert.match(result, /37 \+ 40 = 77/);
    assert.match(result, /得到 85/);
    assert.doesNotMatch(result, /不支持|暂不生成|先巩固基础/);
    assert.equal(await page.locator('.speed-drill').count(), 0);
    assert.equal(await page.locator('.speed-toggle').count(), 1, '支持题的常规方法结果不应移除合法入口');
  } finally {
    upstreamMode = 'valid';
    await page.close();
  }
});

test('共享材料持有者缺图时，空材料小问在成绩与历史中都不恢复方法入口', async () => {
  const batchName = '共享缺图材料快照验收';
  const marker = '【共享材料含图片，当前导入文件未包含图片】';
  const questions = [
    eligibilityFixture({ prompt: '共享缺图小问一：根据材料选择正确的增长率。', category: '资料分析', material_id: 'missing-shared-group', material: marker }),
    eligibilityFixture({ prompt: '共享缺图小问二：根据同一材料选择正确的基期。', category: '资料分析', material_id: 'missing-shared-group', material: '' }),
  ];
  await api('/api/custom/import', { name: batchName, questions });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const callsBefore = requests.length;
  await openPractice(page, batchName);
  assert.equal(await page.evaluate(() => store.state.questions[1].material), marker, '空材料小问继承出题时真实显示的材料');
  const attemptId = await finishPractice(page);
  await assertCapabilityEntrance(page, [], questions);
  assert.equal(await page.locator('.speed-summary').count(), 0);
  const saved = await api(`/api/attempts/${encodeURIComponent(attemptId)}`, null, 'GET');
  const second = saved.records.find((record) => record.question.prompt === questions[1].prompt);
  assert.ok(second);
  assert.equal(second.question.material, marker, '快照必须保留继承的缺图材料，不能只保存本行空material');
  await page.reload(); await page.locator('.custom-entry').waitFor();
  await page.evaluate((id) => openAttemptReview(id), attemptId);
  await waitForReview(page, questions.length);
  await assertCapabilityEntrance(page, [], questions);
  assert.equal(await page.locator('.speed-summary').count(), 0);
  assert.equal(await page.evaluate(() => store.state.questions[1].material), marker);
  await page.locator('.review-card').nth(1).screenshot({ path: join(screenshots, 'capability-shared-missing-history-mobile.png') });
  assert.equal(requests.length, callsBefore, '确定缺失共享图片时，不发起模型请求');
  assert.deepEqual(errors, []);
  await page.close();
});

test('完整文字共享材料保留至空材料小问历史，历史方法请求携带同一材料', async () => {
  const batchName = '共享文字材料快照验收';
  const material = '共享材料验收标记：乙厂全年产量为 796 万件，其中出口量占全年产量的 12.5%。';
  const questions = [
    eligibilityFixture({ prompt: '共享文字小问一：乙厂全年产量为多少万件？', category: '资料分析', material_id: 'text-shared-group', material, options: ['796', '795', '799', '798'] }),
    eligibilityFixture({ prompt: '共享文字小问二：乙厂出口量为多少万件？', category: '资料分析', material_id: 'text-shared-group', material: '', options: ['99.5', '95.5', '100.5', '98.5'] }),
  ];
  await api('/api/custom/import', { name: batchName, questions });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await openPractice(page, batchName);
  const attemptId = await finishPractice(page);
  await assertCapabilityEntrance(page, questions, []);
  const saved = await api(`/api/attempts/${encodeURIComponent(attemptId)}`, null, 'GET');
  const second = saved.records.find((record) => record.question.prompt === questions[1].prompt);
  assert.ok(second);
  assert.equal(second.question.material, material);
  await page.reload(); await page.locator('.custom-entry').waitFor();
  await page.evaluate((id) => openAttemptReview(id), attemptId);
  await waitForReview(page, questions.length);
  await assertCapabilityEntrance(page, questions, []);
  const card = page.locator('.review-card').filter({ has: page.locator('.q-content').filter({ hasText: questions[1].prompt }) });
  assert.match(await card.locator('.mat-body').textContent(), /共享材料验收标记/);
  const callsBefore = requests.length;
  await card.locator('.speed-toggle').click();
  await card.locator('.speed-generate').click();
  await card.locator('.speed-result-title').waitFor();
  assert.equal(await card.locator('.speed-result-title').textContent(), review.methodName);
  assert.equal(requests.length, callsBefore + 1);
  assert.ok(JSON.stringify(requests.at(-1)).includes(material), '历史API必须发送已冻结的共享材料，不可丢失后依赖模型猜测');
  assert.deepEqual(errors, []);
  await page.close();
});
