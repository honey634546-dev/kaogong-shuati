#!/usr/bin/env node
/**
 * Synthetic speed-review evaluation. Offline is the default and makes no API calls.
 * Live mode uses an existing enabled server profile through a READ-ONLY SQLite
 * connection; no profile initialization, migrations, saves, or key creation occur.
 *
 * node scripts/evaluate-speed-review.mjs
 * node scripts/evaluate-speed-review.mjs --live --ids=SR01,SR02,SR14,SR20 --out=docs/speed-review/evaluation-pilot.json
 * node scripts/evaluate-speed-review.mjs --live --out=docs/speed-review/evaluation-live.json
 * Optional: --db=/absolute/ai-config.db --user=<owner-id> --concurrency=2
 * Reports contain synthetic questions/model output; never credentials or endpoints.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildSpeedReviewPrompt, normalizeSpeedReview, insufficientSpeedReview, conservativeSpeedReview, createSpeedReviewAgent } from '../public/speed-review-core.mjs';
import { callAgent } from '../lib/ai-agents.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const getArg = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const live = args.includes('--live');
const ids = new Set(String(getArg('ids', '')).split(',').filter(Boolean));
const out = path.resolve(root, getArg('out', `docs/speed-review/evaluation-${live ? 'live' : 'offline'}.json`));
const suite = JSON.parse(fs.readFileSync(path.join(root, 'docs/speed-review/evaluation-cases.json'), 'utf8'));
const cases = suite.cases.filter((item) => !ids.size || ids.has(item.id));
assert.ok(cases.length, 'No evaluation cases selected');
for (const id of ids) assert.ok(cases.some((item) => item.id === id), `Unknown evaluation id ${id}`);

function prove(proof) {
  if (!proof) return { status: 'manual_reasoning_required' };
  const o = proof.operands;
  let actual;
  switch (proof.operation) {
    case 'multiply': actual = o.reduce((a, b) => a * b, 1); break;
    case 'divide': actual = o[0] / o[1]; break;
    case 'add': actual = o.reduce((a, b) => a + b, 0); break;
    case 'weightedRate': actual = proof.values.reduce((sum, value, i) => sum + value * proof.rates[i], 0) / proof.values.reduce((a, b) => a + b, 0); break;
    case 'successiveRate': actual = (proof.rates.reduce((v, r) => v * (1 + r / 100), 1) - 1) * 100; break;
    case 'cooperation': actual = 1 / proof.days.reduce((sum, n) => sum + 1 / n, 0); break;
    case 'roundTripSpeed': actual = 2 / (1 / proof.speeds[0] + 1 / proof.speeds[1]); break;
    case 'union': actual = proof.counts[0] + proof.counts[1] - proof.counts[2]; break;
    case 'mixRatio': actual = (proof.rates[1] - proof.rates[2]) / (proof.rates[2] - proof.rates[0]); break;
    case 'factorialProduct': actual = proof.values.reduce((a, n) => a * Array.from({ length: n }, (_, i) => i + 1).reduce((x, y) => x * y, 1), 1); break;
    default: throw new Error(`Unknown proof operation: ${proof.operation}`);
  }
  assert.ok(Math.abs(actual - proof.value) < 1e-9, `Synthetic oracle mismatch: ${actual} vs ${proof.value}`);
  return { status: 'verified', value: actual, operation: proof.operation };
}

function inputFor(item) {
  return {
    question: item.question,
    selected: item.attempt.selected,
    correct: item.attempt.correct,
    timing: {
      solveMs: item.attempt.answerTime * 1000,
      analysisMs: item.attempt.analysisTime * 1000,
      referenceSeconds: item.attempt.answerTime < 30 ? 60 : 75,
      quality: item.attempt.timingQuality,
      interrupted: Boolean(item.attempt.interrupted),
    },
    userReason: item.attempt.interrupted ? '这道题中途离开过，时间包含中断' : '',
    userApproach: '',
  };
}

function getConnection() {
  const dbFile = path.resolve(root, getArg('db', 'data/ai-config.db'));
  assert.ok(fs.existsSync(dbFile), 'No existing AI configuration database');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let rows;
  try {
    const owner = getArg('user', '');
    rows = db.prepare(`SELECT role, model, base_url, api_key_encrypted, enabled,
      temperature, max_tokens, reasoning_effort, provider_mode, key_storage_mode,
      stream_enabled, vision_enabled FROM user_ai_agents
      WHERE role='xingce-explainer' AND enabled=1 AND key_storage_mode='server'
      AND length(trim(api_key_encrypted)) > 0 ${owner ? 'AND user_id=?' : ''}`)
      .all(...(owner ? [owner] : []));
  } finally { db.close(); }
  assert.equal(rows.length, 1, 'Exactly one enabled server profile is required; use --user to disambiguate');
  const row = rows[0];
  assert.notEqual(row.provider_mode, 'mock', 'Live evaluation cannot use a mock provider');
  const secretText = String(process.env.AI_KEY_ENCRYPTION_SECRET || '').trim()
    || fs.readFileSync(path.join(path.dirname(dbFile), '.ai-key-encryption-secret'), 'utf8').trim();
  assert.ok(secretText, 'Existing encryption secret is required');
  const secret = createHash('sha256').update(secretText).digest();
  const [iv, tag, ciphertext] = String(row.api_key_encrypted).split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', secret, iv);
  decipher.setAuthTag(tag);
  const apiKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  assert.ok(apiKey, 'Existing provider key could not be decrypted');
  return createSpeedReviewAgent({ ...row, api_key: apiKey, timeout_ms: 60000 });
}

const connection = live ? getConnection() : null;
function safeError(error) {
  let text = String(error?.message || error || 'Unknown error');
  if (connection?.api_key) text = text.split(connection.api_key).join('[REDACTED]');
  if (connection?.base_url) text = text.split(connection.base_url).join('[REDACTED_ENDPOINT]');
  return text.replace(/https?:\/\/[^\s"<>]+/g, '[REDACTED_URL]').slice(0, 1200);
}
const report = {
  version: 1, generatedAt: new Date().toISOString(), mode: live ? 'real-provider' : 'offline',
  provenance: {
    casesSha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'docs/speed-review/evaluation-cases.json'))).digest('hex'),
    coreSha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'public/speed-review-core.mjs'))).digest('hex'),
  },
  model: connection?.model || null,
  settings: connection ? { role: connection.role, temperature: connection.temperature, reasoningEffort: connection.reasoning_effort, maxTokens: connection.max_tokens, timeoutMs: 60000, concurrency: Math.min(2, Math.max(1, Number(getArg('concurrency', 2)) || 2)) } : null,
  evidenceBoundary: 'Synthetic offline/oracle and real-provider checks do not establish learning improvement. Schema validity alone is not quality approval. Each live response requires an independent reasoning review.',
  cases: [],
};
report.scopeGuardChecks = [
  { name: '明确常识分类', question: { subject: '常识判断' }, expected: 'no_shortcut' },
  { name: '明确政治理论分类', question: { category: '政治理论' }, expected: 'no_shortcut' },
  { name: '言语题干提及知识不误拦截', question: { category: '言语理解', content: '这段材料介绍常识与政治理论。' }, expected: null },
  { name: '未知题型不以题干关键词分类', question: { content: '判断这条常识是否属于政治理论。' }, expected: null },
].map((probe) => {
  const result = conservativeSpeedReview(probe.question);
  assert.equal(result?.status ?? null, probe.expected, probe.name);
  if (result) assert.equal(result.drillMethod, null);
  return { name: probe.name, expected: probe.expected, actual: result?.status ?? null, status: 'passed' };
});
function save() {
  report.cases.sort((a, b) => a.id.localeCompare(b.id));
  report.summary = {
    total: report.cases.length,
    arithmeticOraclesVerified: report.cases.filter((x) => x.oracle?.status === 'verified').length,
    providerResponses: report.cases.filter((x) => x.provider === 'completed').length,
    schemaPasses: report.cases.filter((x) => x.schema === 'passed').length,
    deterministicSkips: report.cases.filter((x) => x.provider === 'skipped').length,
    scopeRestrictions: report.cases.filter((x) => x.scopeGuard).length,
    failures: report.cases.filter((x) => x.error).length,
    qualityDecision: live ? 'pending_manual_review' : 'offline_contract_only',
  };
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
}
async function evaluate(item) {
  const record = { id: item.id, category: item.category, oracle: prove(item.expected.proof), expected: item.expected };
  try {
    const prompt = buildSpeedReviewPrompt(inputFor(item));
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.includes(item.question.prompt), 'Prompt must include original question');
    record.prompt = { status: 'built', length: prompt.length };
    const scopeGuard = conservativeSpeedReview(item.question);
    assert.equal(Boolean(scopeGuard), item.productScope === 'knowledge_no_shortcut', 'Product scope must match the declared case expectation');
    if (scopeGuard) {
      record.scopeGuard = normalizeSpeedReview(scopeGuard);
      assert.equal(record.scopeGuard.status, 'no_shortcut');
      assert.equal(record.scopeGuard.drillMethod, null);
    }
    if (item.skipProviderReason) {
      record.deterministicFallback = normalizeSpeedReview(insufficientSpeedReview(item.skipProviderReason));
      assert.equal(record.deterministicFallback.status, 'insufficient');
      assert.equal(record.deterministicFallback.drillMethod, null);
    }
    if (!live) {
      record.provider = 'not_requested';
    } else if (scopeGuard) {
      record.provider = 'skipped'; record.reason = '首版常识/政治理论范围限制，使用产品确定性 no_shortcut，不请求模型。';
    } else if (item.skipProviderReason) {
      record.provider = 'skipped'; record.reason = item.skipProviderReason;
    } else {
      const started = Date.now();
      const response = await callAgent(connection, prompt, { timeoutMs: 60000 });
      record.elapsedMs = Date.now() - started;
      if (response.error) throw new Error(response.error);
      assert.equal(response.mock, false, 'Live response must be from real provider');
      record.provider = 'completed';
      record.model = response.model;
      record.usage = response.usage || null;
      record.rawContent = response.content;
      record.normalized = normalizeSpeedReview(response.content);
      record.schema = 'passed';
      record.semanticReview = { status: 'pending', mathematicalOrLogicalCorrectness: 'pending', forcedShortcut: 'pending', unsupportedSlowCause: 'pending', applicabilityBoundary: 'pending', note: 'Read the actual answer before assigning pass/fail; do not count valid JSON as pedagogical correctness.' };
    }
  } catch (error) {
    record.error = safeError(error);
    if (record.provider === 'completed') record.schema = 'failed';
    else record.provider = 'failed';
  }
  report.cases.push(record); save();
  console.log(`${item.id} ${record.provider}${record.schema ? ` / schema ${record.schema}` : ''}${record.error ? ` / ${record.error}` : ''}`);
}
let index = 0;
const workers = Array.from({ length: live ? report.settings.concurrency : 1 }, async () => {
  while (index < cases.length) await evaluate(cases[index++]);
});
await Promise.all(workers);
console.log(JSON.stringify({ output: path.relative(root, out), ...report.summary }));
if (report.summary.failures) process.exitCode = 1;
