#!/usr/bin/env node
// 从原始 HTML 恢复已导入题目的空白下划线。默认只预览，--apply 才写入。
// node scripts/repair-gkzhenti-blanks.mjs --db=/path/to/practice.db [--cache=data/gkzhenti] [--paper-id=...] [--apply]
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseGkzhentiPaper } from '../public/lib/gkzhenti-adapter.js';
import { customQuestionFingerprint } from '../public/lib/custom-bank.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIELDS = ['prompt', 'material', 'options'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function blankRepairsFromHtml(paperHtml, paperId) {
  // 去掉 u 标签重现旧导入行为，避免根据普通空格猜测空缺的位置。
  const oldQuestions = parseGkzhentiPaper({ paperHtml: paperHtml.replace(/<\/?u\b[^>]*>/gi, ''), paperId }).questions;
  const newQuestions = parseGkzhentiPaper({ paperHtml, paperId }).questions;
  const oldById = new Map(oldQuestions.map((q) => [q.external_id, q]));
  const repairs = new Map();
  for (const question of newQuestions) {
    const old = oldById.get(question.external_id);
    if (!old) throw new Error(`题目结构发生变化：${question.external_id}`);
    const changes = {};
    for (const field of FIELDS) {
      if (!same(old[field], question[field])) changes[field] = { before: old[field], after: question[field] };
    }
    if (Object.keys(changes).length) repairs.set(question.external_id, changes);
  }
  if (oldQuestions.length !== newQuestions.length) throw new Error(`试卷题数发生变化：${paperId}`);
  return repairs;
}

export async function loadBlankRepairs(cacheDir, paperId = '') {
  const repairs = new Map();
  const entries = await readdir(cacheDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || (paperId && entry.name !== paperId)) continue;
    let html;
    try { html = await readFile(join(cacheDir, entry.name, 'paper.html'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const [id, changes] of blankRepairsFromHtml(html, entry.name)) repairs.set(id, changes);
  }
  return repairs;
}

function repairedRow(row, changes) {
  const updated = { ...row, options: JSON.parse(row.options || '[]') };
  let changed = false;
  for (const [field, change] of Object.entries(changes)) {
    if (same(updated[field], change.after)) continue;
    // 用户编辑过的字段不覆盖；允许其他无关字段（解析、答案等）已被修改。
    if (!same(updated[field], change.before)) return null;
    updated[field] = change.after;
    changed = true;
  }
  if (!changed) return row;
  updated.fingerprint = customQuestionFingerprint({ ...updated, images: JSON.parse(row.images || '[]') });
  updated.options = JSON.stringify(updated.options);
  return updated;
}

export async function repairDatabase(dbPath, repairs, { apply = false, backupDir = join(dirname(dbPath), 'blank-repair-backups') } = {}) {
  // 预览必须只读；应用时在事务内重新检查，避免覆盖计划生成后的编辑。
  if (!(await stat(dbPath)).isFile()) throw new Error('数据库路径不是现有文件');
  const db = new DatabaseSync(dbPath, { readOnly: !apply });
  db.exec('PRAGMA busy_timeout = 5000');
  let inTransaction = false;
  try {
    if (apply) { db.exec('BEGIN IMMEDIATE'); inTransaction = true; }
    const rows = db.prepare("SELECT * FROM custom_questions WHERE is_current = 1 AND external_id LIKE 'gkzhenti:%'").all();
    const pending = [];
    const skipped = [];
    let alreadyFixed = 0;
    for (const row of rows) {
      const changes = repairs.get(row.external_id);
      if (!changes) continue;
      const updated = repairedRow(row, changes);
      if (!updated) skipped.push({ id: row.id, external_id: row.external_id, reason: 'content_changed' });
      else if (updated === row) alreadyFixed++;
      else pending.push({ before: row, after: updated });
    }
    let backupPath = '';
    if (apply && pending.length) {
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      backupPath = join(backupDir, `gkzhenti-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.json`);
      await writeFile(backupPath, JSON.stringify({ database: resolve(dbPath), changes: pending }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      const update = db.prepare('UPDATE custom_questions SET prompt = ?, material = ?, options = ?, fingerprint = ? WHERE id = ? AND user_id = ? AND is_current = 1');
      for (const { after } of pending) {
        const result = update.run(after.prompt, after.material, after.options, after.fingerprint, after.id, after.user_id);
        if (Number(result.changes) !== 1) throw new Error(`修复写入数量异常：${after.id}`);
      }
    }
    if (inTransaction) { db.exec('COMMIT'); inTransaction = false; }
    return {
      mode: apply ? 'applied' : 'preview',
      sourceQuestionsWithBlanks: repairs.size,
      affectedQuestions: pending.length,
      affectedBatches: new Set(pending.map(({ before }) => before.batch_id)).size,
      alreadyFixed,
      skipped,
      backupPath,
      sample: pending.slice(0, 3).map(({ before, after }) => ({
        id: before.id, external_id: before.external_id,
        changes: Object.fromEntries(FIELDS.filter((field) => !same(before[field], after[field])).map((field) => [field, { before: before[field], after: after[field] }])),
      })),
    };
  } catch (error) {
    if (inTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

async function main() {
  const value = (name, fallback = '') => process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) || fallback;
  const dbPath = value('--db');
  if (!dbPath) throw new Error('请用 --db=... 明确指定 practice.db；默认只预览，--apply 才写入。');
  const repairs = await loadBlankRepairs(resolve(value('--cache', join(ROOT, 'data/gkzhenti'))), value('--paper-id'));
  const result = await repairDatabase(resolve(dbPath), repairs, { apply: process.argv.includes('--apply') });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
