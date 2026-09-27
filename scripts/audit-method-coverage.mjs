#!/usr/bin/env node
/** Read-only local coverage audit. Exports aggregates only; never calls AI. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getSpeedReviewCapability } from '../public/speed-review-core.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name, fallback = '') => process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const db = new DatabaseSync(path.resolve(root, arg('db', 'data/practice.db')), { readOnly: true });
const owner = arg('user');
const rows = db.prepare(`SELECT * FROM custom_questions WHERE is_current=1 ${owner ? 'AND user_id=?' : ''} ORDER BY id`).all(...(owner ? [owner] : []));
db.close();
assert.ok(rows.length, 'No current questions');
assert.equal(new Set(rows.map((row) => row.user_id)).size, 1, 'Use --user to audit one owner at a time');
// The audited six source papers have no shared-material groups. Do not silently
// undercount grouped banks by evaluating raw rows without practice-time hydration.
assert.ok(rows.every((row) => !String(row.material_id || '').trim()), 'Grouped material requires a hydrated practice snapshot audit');
const before = JSON.stringify(rows);
const question = (row) => ({ ...row, id: `custom-${row.id}`, type: 'custom', answerIndex: row.answer_index });
const capabilities = new Map(rows.map((row) => [row.id, getSpeedReviewCapability(question(row))]));
assert.equal(JSON.stringify(rows), before, 'Classification must not rewrite source records');
const count = (items, key) => items.reduce((result, item) => { const value = key(item); result[value] = (result[value] || 0) + 1; return result; }, {});
const values = [...capabilities.values()];
const judgmentRows = rows.filter((row) => String(row.category).split(/[/\\>›»|]+/).map((part) => part.trim()).at(-1) === '判断推理');
const judgment = judgmentRows.map((row) => capabilities.get(row.id));
const report = {
  generatedAt: new Date().toISOString(),
  source: 'Read-only current local custom question records. No identities or question text exported; no provider calls.',
  provenance: {
    coreSha256: hash(fs.readFileSync(path.join(root, 'public/speed-review-core.mjs'))),
    classifierSha256: hash(fs.readFileSync(path.join(root, 'public/lib/question-method-classifier.mjs'))),
  },
  total: values.length,
  eligible: values.filter((item) => item.available).length,
  eligibleByCategory: count(values.filter((item) => item.available), (item) => item.label),
  eligibleByClassificationSource: count(values.filter((item) => item.available), (item) => item.classificationSource),
  rejectedByCode: count(values.filter((item) => !item.available), (item) => item.code),
  parentJudgment: {
    total: judgment.length, eligible: judgment.filter((item) => item.available).length,
    eligibleByCategory: count(judgment.filter((item) => item.available), (item) => item.label),
    rejectedByCode: count(judgment.filter((item) => !item.available), (item) => item.code),
    rejectedWithExplicitMissingImage: judgmentRows.filter((row) => !capabilities.get(row.id).available
      && /【本题原卷含题目图片，当前导入文件未包含图片】|【共享材料含图片，当前导入文件未包含图片】|（原卷图形选项，图片未随导入提供）/.test([row.prompt, row.material, row.options].join('\n'))).length,
  },
  sourceRecordsUnchanged: true,
  meaning: 'Input qualification for candidate method analysis, not verified shortcuts or proven learning gains. Structural labels may abstain while complete parent judgment text remains usable.',
};
const holdoutPath = arg('holdout');
if (holdoutPath) {
  const raw = fs.readFileSync(path.resolve(root, holdoutPath), 'utf8');
  const labels = JSON.parse(raw);
  const seen = new Set();
  const comparisons = labels.map((label) => {
    const row = rows.find((item) => item.id === label.id && item.question_uid === label.sourceUID);
    assert.ok(row && !seen.has(row.id), 'Blind labels must map uniquely to current source identities');
    seen.add(row.id);
    const capability = capabilities.get(row.id);
    return { expected: label.label, ...capability };
  });
  const fine = comparisons.filter((item) => ['定义判断', '类比推理', '逻辑判断', '图形推理'].includes(item.category));
  const text = comparisons.filter((item) => item.expected !== '图形推理');
  report.blindHoldout = {
    labelFileSha256: hash(raw), size: labels.length,
    procedure: 'Separate agent labeled 36 unique local questions before viewing classifier outputs; six per source paper, deduplicated across papers. Agent labels are independent of predictions, not expert ground truth. No private text was sent to a provider.',
    expectedByCategory: count(comparisons, (item) => item.expected),
    fineLabelsAssigned: fine.length, fineLabelsCorrect: fine.filter((item) => item.category === item.expected).length,
    retainedParentLabels: comparisons.filter((item) => item.category === '判断推理').length,
    matrix: count(comparisons, (item) => `${item.expected} → ${item.category || '未知'}`),
    textQuestions: text.length, textEligible: text.filter((item) => item.available).length,
    visualQuestions: comparisons.length - text.length,
    visualIneligible: comparisons.filter((item) => item.expected === '图形推理' && !item.available).length,
    limitation: 'Small bank-specific agent-labeled holdout; no general classifier accuracy claim. Do not tune to missed holdout labels and then report them as fresh validation.',
  };
}
const out = path.resolve(root, arg('out', 'docs/speed-review/classification-data-audit-v1.json'));
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
