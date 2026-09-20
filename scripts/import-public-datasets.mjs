#!/usr/bin/env node

/**
 * 下载并导入公开中文公务员题库。
 *
 * 只做格式适配和导入，不补写数据源没有提供的解析。
 * C-Eval 的 Parquet 由 scripts/read-parquet.py 通过本机 pyarrow 转成记录，
 * 因而不需要把重型 Parquet 运行库塞进浏览器端。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  adaptPublicDataset,
  parseCsv,
  parseJsonLines,
  rowsToRecords,
} from '../public/lib/custom-parser.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.PUBLIC_DATA_DIR || join(ROOT, 'data', 'public-datasets');
const BASE_URL = process.env.PUBLIC_DATA_BASE_URL || 'http://127.0.0.1:3210';
const FORCE_DOWNLOAD = process.argv.includes('--refresh');
const DRY_RUN = process.argv.includes('--dry-run');
const NO_DOWNLOAD = process.argv.includes('--no-download');
const NO_IMPORT = process.argv.includes('--no-import') || DRY_RUN;

const JOBS = [
  {
    source: 'cmmlu', split: 'dev', name: 'CMMLU 公务员 · dev', format: 'csv',
    file: 'cmmlu/dev.csv',
    url: 'https://raw.githubusercontent.com/haonan-li/CMMLU/master/data/dev/chinese_civil_service_exam.csv',
  },
  {
    source: 'cmmlu', split: 'test', name: 'CMMLU 公务员 · test', format: 'csv',
    file: 'cmmlu/test.csv',
    url: 'https://raw.githubusercontent.com/haonan-li/CMMLU/master/data/test/chinese_civil_service_exam.csv',
  },
  {
    source: 'logiqa', split: 'train', name: 'LogiQA 2.0 中文 · train', format: 'jsonl',
    file: 'logiqa/train_zh.txt',
    url: 'https://raw.githubusercontent.com/csitfun/LogiQA2.0_Chinese/master/train_zh.txt',
  },
  {
    source: 'logiqa', split: 'dev', name: 'LogiQA 2.0 中文 · dev', format: 'jsonl',
    file: 'logiqa/dev_zh.txt',
    url: 'https://raw.githubusercontent.com/csitfun/LogiQA2.0_Chinese/master/dev_zh.txt',
  },
  {
    source: 'logiqa', split: 'test', name: 'LogiQA 2.0 中文 · test', format: 'jsonl',
    file: 'logiqa/test_zh.txt',
    url: 'https://raw.githubusercontent.com/csitfun/LogiQA2.0_Chinese/master/test_zh.txt',
  },
  {
    source: 'ceval', split: 'dev', name: 'C-Eval 公务员 · dev', format: 'parquet',
    file: 'ceval/dev.parquet',
    url: 'https://huggingface.co/datasets/ceval/ceval-exam/resolve/main/civil_servant/dev-00000-of-00001.parquet?download=true',
  },
  {
    source: 'ceval', split: 'val', name: 'C-Eval 公务员 · val', format: 'parquet',
    file: 'ceval/val.parquet',
    url: 'https://huggingface.co/datasets/ceval/ceval-exam/resolve/main/civil_servant/val-00000-of-00001.parquet?download=true',
  },
  {
    source: 'ceval', split: 'test', name: 'C-Eval 公务员 · test', format: 'parquet',
    file: 'ceval/test.parquet',
    url: 'https://huggingface.co/datasets/ceval/ceval-exam/resolve/main/civil_servant/test-00000-of-00001.parquet?download=true',
  },
];

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function download(job) {
  const target = join(DATA_DIR, job.file);
  if (!FORCE_DOWNLOAD && await exists(target)) return target;
  await mkdir(dirname(target), { recursive: true });
  const response = await fetch(job.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${job.name} 下载失败：HTTP ${response.status}`);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  return target;
}

function runPython(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.env.PYTHON || 'python3', args, { cwd: ROOT });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `Python 退出码 ${code}`));
      else resolvePromise(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

async function readRecords(job, path) {
  if (job.format === 'csv') return rowsToRecords(parseCsv(await readFile(path, 'utf8')));
  if (job.format === 'jsonl') {
    const rows = parseJsonLines(await readFile(path, 'utf8'));
    if (!rows) throw new Error(`${job.name} 不是有效 JSONL`);
    return rows;
  }
  const output = await runPython([join(ROOT, 'scripts', 'read-parquet.py'), path]);
  return JSON.parse(output);
}

async function requestJson(path, payload) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    Object.assign(error, body, { status: response.status });
    throw error;
  }
  return body;
}

async function importBatch(job, questions) {
  const payload = { name: job.name, subject: '行测', questions };
  let preview;
  try {
    preview = await requestJson('/api/custom/import/preview', payload);
  } catch (error) {
    if (error.status === 409) {
      throw new Error(`${job.name} 已存在内容冲突；如需建立新版本，请先确认数据源更新后再使用 conflict_mode=new_revision`);
    }
    throw error;
  }
  const result = await requestJson('/api/custom/import', payload);
  return { ...result, preview };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const summaries = [];
  for (const job of JOBS) {
    const rawPath = NO_DOWNLOAD ? join(DATA_DIR, job.file) : await download(job);
    if (!await exists(rawPath)) throw new Error(`找不到 ${rawPath}；去掉 --no-download 后重试`);
    const records = await readRecords(job, rawPath);
    const questions = adaptPublicDataset(records, { source: job.source, split: job.split });
    const answerable = questions.filter((question) => question.answer_index >= 0 && question.options.length >= 2);
    if (!questions.length || questions.length !== records.length) {
      throw new Error(`${job.name} 校验失败：原始 ${records.length} 条，适配后 ${questions.length} 题`);
    }
    const normalized = {
      name: job.name,
      source: job.source,
      split: job.split,
      license: 'CC BY-NC-SA 4.0',
      source_url: job.url,
      questions,
    };
    const normalizedPath = join(DATA_DIR, 'normalized', `${job.source}-${job.split}.json`);
    await mkdir(dirname(normalizedPath), { recursive: true });
    await writeFile(normalizedPath, JSON.stringify(normalized, null, 2) + '\n');
    const summary = { name: job.name, source: job.source, split: job.split, records: records.length, questions: questions.length, answerable: answerable.length, incomplete: questions.length - answerable.length, withAnalysis: questions.filter((q) => q.analysis).length };
    if (!NO_IMPORT) {
      const result = await importBatch(job, questions);
      summary.imported = result.count;
      summary.batchId = result.id;
    }
    summaries.push(summary);
    console.log(JSON.stringify(summary));
  }
  console.log(`完成：${summaries.reduce((sum, item) => sum + item.questions, 0)} 题，${summaries.length} 个模块${NO_IMPORT ? '（未写入）' : '已导入'}`);
}

main().catch((error) => {
  console.error(`公开题库导入失败：${error.message}`);
  process.exitCode = 1;
});
