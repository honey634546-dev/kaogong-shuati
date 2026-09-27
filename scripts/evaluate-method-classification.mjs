#!/usr/bin/env node
/**
 * Original synthetic definition/analogy/text-reasoning admission checks.
 * Offline by default. Live makes at most six calls, concurrency two, 60 s each,
 * no retry. Uses existing server profile read-only; no user question is sent.
 * node scripts/evaluate-method-classification.mjs
 * node scripts/evaluate-method-classification.mjs --live
 * Optional --ids=MC01,MC05 --revision=natural-copy-v2
 * --db=/absolute/ai-config.db --user=<owner-id> --out=/new/report.json
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildSpeedReviewPrompt, normalizeSpeedReview, getSpeedReviewCapability, createSpeedReviewAgent } from '../public/speed-review-core.mjs';
import { callAgent } from '../lib/ai-agents.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const live = args.includes('--live');
const getArg = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const suiteFile = path.join(root, 'docs/speed-review/classification-method-cases.json');
const suite = JSON.parse(fs.readFileSync(suiteFile, 'utf8'));
const ids = new Set(String(getArg('ids', '')).split(',').filter(Boolean));
const cases = suite.cases.filter((item) => !ids.size || ids.has(item.id));
for (const id of ids) assert.ok(cases.some((item) => item.id === id), `Unknown case ${id}`);
assert.ok(cases.length, 'No cases selected');
const out = path.resolve(root, getArg('out', `docs/speed-review/classification-method-evaluation-${live ? 'live' : 'offline'}-v1.json`));
assert.ok(suite.cases.length > 0 && suite.cases.length <= 6, 'This run permits at most six predeclared synthetic cases');
if (live) assert.ok(!fs.existsSync(out), 'Live evidence already exists; do not overwrite or resample failed cases without a new explicit evaluation plan');
for (const item of cases) {
  assert.equal(item.source, '原创合成，不含真实用户题');
  assert.ok(item.question.options.length >= 2);
  assert.ok(item.question.options[item.expected.answer.charCodeAt(0) - 65]);
  assert.equal(item.question.answer, item.expected.answer);
  assert.ok(item.expected.standardReasoning && item.expected.boundaries.length);
}

function readExistingProfile() {
  const dbFile = path.resolve(root, getArg('db', 'data/ai-config.db'));
  assert.ok(fs.existsSync(dbFile), 'Existing AI configuration database required');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const owner = getArg('user', '');
  let rows;
  try {
    rows = db.prepare(`SELECT role,model,base_url,api_key_encrypted,enabled,temperature,max_tokens,
      reasoning_effort,provider_mode,key_storage_mode,stream_enabled,vision_enabled
      FROM user_ai_agents WHERE role='xingce-explainer' AND enabled=1
      AND key_storage_mode='server' AND length(trim(api_key_encrypted))>0
      ${owner ? 'AND user_id=?' : ''}`).all(...(owner ? [owner] : []));
  } finally { db.close(); }
  assert.equal(rows.length, 1, 'Exactly one configured server profile required; use --user to disambiguate');
  const row = rows[0];
  assert.notEqual(row.provider_mode, 'mock', 'Live mode cannot use mock provider');
  const text = String(process.env.AI_KEY_ENCRYPTION_SECRET || '').trim()
    || fs.readFileSync(path.join(path.dirname(dbFile), '.ai-key-encryption-secret'), 'utf8').trim();
  assert.ok(text, 'Existing encryption secret required');
  const key = createHash('sha256').update(text).digest();
  const [iv, tag, encrypted] = String(row.api_key_encrypted).split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const apiKey = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  assert.ok(apiKey, 'Existing provider key could not be decrypted');
  return createSpeedReviewAgent({ ...row, api_key: apiKey, timeout_ms: 60000 });
}
const profile = live ? readExistingProfile() : null;
function safeError(error) {
  let message = String(error?.message || error || 'Unknown error');
  for (const secret of [profile?.api_key, profile?.base_url].filter(Boolean)) message = message.split(secret).join('[REDACTED]');
  return message.replace(/https?:\/\/[^\s"<>]+/g, '[REDACTED_URL]').slice(0, 1200);
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const report = {
  version: 1, generatedAt: new Date().toISOString(), mode: live ? 'real-provider' : 'offline',
  selectedCases: cases.map((item) => item.id),
  provenance: {
    casesSha256: sha256(fs.readFileSync(suiteFile)),
    coreSha256: sha256(fs.readFileSync(path.join(root, 'public/speed-review-core.mjs'))),
    classifierSha256: sha256(fs.readFileSync(path.join(root, 'public/lib/question-method-classifier.mjs'))),
  },
  settings: profile ? { role: profile.role, model: profile.model, temperature: profile.temperature, maxTokens: profile.max_tokens, reasoningEffort: profile.reasoning_effort, concurrency: 2, timeoutMs: 60000, retries: 0 } : null,
  evidenceBoundary: 'Six original synthetic cases are a limited admission probe, not real-user usability or learning validation. Schema validity is separate from independent semantic review. Failed first responses remain in this report.',
  cases: [],
};
if (getArg('revision', '') === 'natural-copy-v2') {
  assert.deepEqual(cases.map((item) => item.id), ['MC01', 'MC05'], 'This corrective run is limited to the two predeclared cases');
  report.targetedPlan = {
    priorReport: 'classification-method-evaluation-live-v1.json',
    change: 'Natural Chinese output, no debug fields or unrequested guess/assistance disclaimers; diagnosis generally one or two sentences. Unproven alternative causes remain possibilities.',
    checks: [
      'MC01 retains all four defining conditions and answer A; no assisted/userReason/userApproach/null/false debugging language.',
      'MC05 keeps answer B and distinguishes possible alternative causes from proven causes; no claim that longer hours necessarily caused sales growth.',
      'Both diagnoses are concise natural Chinese, normally one or two sentences, without automatic guesses or assistance disclaimers.',
      'Strict schema remains unchanged; each case is called once, no retry, old failures preserved.',
    ],
    attemptsPerCase: 1,
  };
}
function save() {
  report.cases.sort((a, b) => a.id.localeCompare(b.id));
  report.summary = {
    total: report.cases.length,
    available: report.cases.filter((c) => c.capability?.available).length,
    providerCalls: report.cases.filter((c) => c.providerAttempted).length,
    providerResponses: report.cases.filter((c) => c.provider === 'completed').length,
    schemaPasses: report.cases.filter((c) => c.schema === 'passed').length,
    failures: report.cases.filter((c) => c.error).length,
    qualityDecision: live ? 'pending_independent_semantic_review' : 'offline_contract_only',
  };
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
}
async function evaluate(item) {
  const record = { id: item.id, family: item.family, sourceCategory: item.question.category, expected: item.expected };
  try {
    const before = JSON.stringify(item.question);
    record.capability = getSpeedReviewCapability(item.question);
    assert.equal(record.capability.available, item.expected.capabilityAvailable, 'Text method case must be available');
    const prompt = buildSpeedReviewPrompt({ question: item.question, ...item.input });
    assert.ok(prompt.includes(item.question.prompt), 'Original synthetic question must be in prompt');
    assert.equal(JSON.stringify(item.question), before, 'Capability and prompt construction must not mutate source category or question');
    record.sourceUnchanged = true;
    record.prompt = { length: prompt.length, sha256: sha256(prompt) };
    if (!live) record.provider = 'not_requested';
    else {
      record.providerAttempted = true;
      const start = Date.now();
      const response = await callAgent(profile, prompt, { timeoutMs: 60000 });
      record.elapsedMs = Date.now() - start;
      if (response.error) throw new Error(response.error);
      assert.equal(response.mock, false);
      record.provider = 'completed';
      record.model = response.model;
      record.usage = response.usage || null;
      record.rawContent = response.content;
      record.normalized = normalizeSpeedReview(response.content);
      record.schema = 'passed';
      record.semanticReview = { status: 'pending', note: 'Independently compare standard answer, all defining conditions, negation, relation direction, hierarchy and method boundaries. Do not equate JSON validity with quality.' };
    }
  } catch (error) {
    record.error = safeError(error);
    if (record.provider === 'completed') record.schema = 'failed';
    else record.provider = 'failed';
  }
  report.cases.push(record); save();
  console.log(`${item.id}: ${record.provider}${record.schema ? ` / ${record.schema}` : ''}${record.error ? ` / ${record.error}` : ''}`);
}
let index = 0;
await Promise.all(Array.from({ length: live ? 2 : 1 }, async () => {
  while (index < cases.length) await evaluate(cases[index++]);
}));
console.log(JSON.stringify({ output: path.relative(root, out), ...report.summary }));
if (report.summary.failures) process.exitCode = 1;
