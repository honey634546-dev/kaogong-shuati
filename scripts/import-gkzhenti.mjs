#!/usr/bin/env node

/**
 * 以低频、可恢复的方式导入公开真题库（gwy.gkzhenti.cn）。
 *
 * 重要边界：
 * - 站点的 /api/json 只提供试卷索引；题目和答案分别来自 /paper/:id、/answer/:id。
 * - 默认每次网络请求至少间隔 61 秒，遇到站点黑名单页立即停止，不做重试、代理或绕过。
 * - 原始 HTML、索引和规范化 JSON 只写入 data/（已被 .gitignore 忽略）。
 * - 站点没有在页面上声明可自由再分发许可；不要把下载的整套题库提交到仓库或公开发布。
 *
 * 示例：
 *   npm run import:gkzhenti -- --cls=行测 --province=浙江 --limit=1 --no-import
 *   GKZHENTI_IMPORT_COOKIE='better-auth.session_token=...' npm run import:gkzhenti -- --cls=行测 --province=国考 --limit=3
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  GKZHENTI_ORIGIN,
  buildIndexUrl,
  buildPaperUrl,
  isBlockedPage,
  parseGkzhentiPaper,
  parseIndexPayload,
  titleFromHtml,
} from '../public/lib/gkzhenti-adapter.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.GKZHENTI_DATA_DIR || join(ROOT, 'data', 'gkzhenti');
const SOURCE_BASE_URL = process.env.GKZHENTI_BASE_URL || GKZHENTI_ORIGIN;
const IMPORT_BASE_URL = process.env.IMPORT_BASE_URL || process.env.PUBLIC_DATA_BASE_URL || 'http://127.0.0.1:3210';
const IMPORT_COOKIE = process.env.GKZHENTI_IMPORT_COOKIE || process.env.IMPORT_COOKIE || '';
const REFRESH = process.argv.includes('--refresh');
const DRY_RUN = process.argv.includes('--dry-run');
const NO_IMPORT = DRY_RUN || process.argv.includes('--no-import');
const AUTH_DISABLED = process.env.AUTH_DISABLED === '1';
const MIN_DELAY_MS = Math.max(61_000, Number(value('--min-delay-ms', process.env.GKZHENTI_MIN_DELAY_MS || 61_000)) || 61_000);
const RATE_LIMIT_STATE_PATH = join(DATA_DIR, '.last-network-request-at');

let lastNetworkRequestAt = 0;

function hasFlag(name) {
  return process.argv.includes(name);
}

function value(name, fallback = '') {
  const prefix = `${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function safeFilePart(valueToClean) {
  return String(valueToClean ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function readCached(path) {
  if (!await exists(path)) return null;
  return readFile(path, 'utf8');
}

async function waitForSiteRateLimit() {
  const persistedValue = Number((await readCached(RATE_LIMIT_STATE_PATH) || '').trim()) || 0;
  lastNetworkRequestAt = Math.max(lastNetworkRequestAt, persistedValue);
  const remaining = MIN_DELAY_MS - (Date.now() - lastNetworkRequestAt);
  if (remaining > 0) {
    console.log(`遵守站点限频：等待 ${Math.ceil(remaining / 1000)} 秒`);
    await sleep(remaining);
  }
}

async function recordNetworkRequestStart() {
  lastNetworkRequestAt = Date.now();
  // 跨进程持久化冷却时间，避免脚本重启后立即发出下一条请求。
  await writeFile(RATE_LIMIT_STATE_PATH, `${lastNetworkRequestAt}\n`, { mode: 0o600 });
}

async function fetchText(url, cachePath, label, { validate } = {}) {
  if (!REFRESH) {
    const cached = await readCached(cachePath);
    if (cached != null) return cached;
  }
  await mkdir(dirname(cachePath), { recursive: true });
  await waitForSiteRateLimit();
  await recordNetworkRequestStart();
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      // Fetch Headers 只接受 ByteString；使用 ASCII 标识避免 Node 在发请求前报错。
      'user-agent': 'StudyQuizImporter/1.0 (+personal-study)',
    },
  });
  const body = await response.text();
  if (isBlockedPage(body)) {
    throw new Error(`${label} 被站点限流/临时黑名单拦截；已停止，不会重试。请等待站点允许的冷却时间后再运行，或使用站点提供的导出方式。`);
  }
  if (!response.ok) throw new Error(`${label} 下载失败：HTTP ${response.status}`);
  if (validate && !validate(body)) throw new Error(`${label} 响应不是预期格式；未缓存，也未导入。`);
  await writeFile(cachePath, body);
  return body;
}

async function fetchJson(url, cachePath) {
  const body = await fetchText(url, cachePath, '试卷索引', {
    validate: (raw) => {
      try { JSON.parse(raw); return true; } catch { return false; }
    },
  });
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('试卷索引响应不是有效 JSON；未把错误页写入题库。');
  }
}

function yearsInTitle(title) {
  return [...String(title ?? '').matchAll(/20\d{2}/g)].map((match) => Number(match[0]));
}

function selectEntries(entries) {
  const yearFrom = Number(value('--year-from', 0)) || 0;
  const yearTo = Number(value('--year-to', 9999)) || 9999;
  const contains = value('--contains', '').trim();
  let selected = entries.filter((entry) => {
    const years = yearsInTitle(entry.title);
    const yearOk = !years.length || years.some((year) => year >= yearFrom && year <= yearTo);
    const textOk = !contains || `${entry.title} ${entry.source}`.includes(contains);
    return yearOk && textOk;
  });
  if (!hasFlag('--all')) {
    const limit = Math.max(1, Number(value('--limit', 1)) || 1);
    selected = selected.slice(0, limit);
  }
  return selected;
}

async function requestAppJson(pathname, payload) {
  const headers = { 'content-type': 'application/json' };
  if (IMPORT_COOKIE) headers.cookie = IMPORT_COOKIE;
  const response = await fetch(`${IMPORT_BASE_URL}${pathname}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  let body = {};
  try { body = JSON.parse(raw); } catch {}
  if (!response.ok) {
    const error = new Error(body.error || `本地题库 API 失败：HTTP ${response.status}`);
    Object.assign(error, body, { status: response.status });
    throw error;
  }
  return body;
}

async function importBatch(batch) {
  if (!AUTH_DISABLED && !IMPORT_COOKIE) {
    throw new Error('当前服务已启用登录。需要导入时请设置 GKZHENTI_IMPORT_COOKIE，或先用 --no-import 只生成本地 JSON；不要把 Cookie 写入仓库。');
  }
  const payload = { name: batch.name, subject: batch.subject, questions: batch.questions };
  const preview = await requestAppJson('/api/custom/import/preview', payload);
  if (preview.conflicts?.length) throw new Error(`${batch.name} 存在 ${preview.conflicts.length} 个导入冲突；未写入，请先人工确认。`);
  const result = await requestAppJson('/api/custom/import', payload);
  return { ...result, preview };
}

function usage() {
  console.log([
    '公开真题库导入器',
    '',
    '  --cls=行测              科目，默认行测',
    '  --province=国考         地区，默认国考',
    '  --limit=1               默认只处理 1 份试卷；--all 才处理筛选后的全部',
    '  --year-from=2020        按标题年份筛选',
    '  --year-to=2026',
    '  --contains=回忆版       按标题/来源筛选',
    '  --no-import              只抓取、解析并写入 data/gkzhenti，不调用本地导入 API',
    '  --dry-run                同 --no-import',
    '  --refresh                忽略本地缓存；仍然遵守每次请求至少 61 秒',
    '  --min-delay-ms=61000     不能低于 61000',
    '',
    '环境变量：GKZHENTI_IMPORT_COOKIE、IMPORT_BASE_URL、GKZHENTI_DATA_DIR、GKZHENTI_BASE_URL',
  ].join('\n'));
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) { usage(); return; }
  const cls = value('--cls', '行测');
  const province = value('--province', '国考');
  const indexKey = `${safeFilePart(cls)}-${safeFilePart(province)}`;
  const indexUrl = buildIndexUrl({ baseUrl: SOURCE_BASE_URL, cls, province });
  const indexPath = join(DATA_DIR, `index-${indexKey}.json`);
  await mkdir(DATA_DIR, { recursive: true });
  const payload = await fetchJson(indexUrl, indexPath);
  const entries = selectEntries(parseIndexPayload(payload));
  if (!entries.length) throw new Error('没有符合筛选条件的试卷。');
  console.log(`索引得到 ${entries.length} 份待处理试卷（${cls}/${province}）`);

  const summaries = [];
  for (const entry of entries) {
    const paperUrl = buildPaperUrl(entry.paperId, { baseUrl: SOURCE_BASE_URL });
    const answerUrl = buildPaperUrl(entry.paperId, { baseUrl: SOURCE_BASE_URL, kind: 'answer' });
    const dir = join(DATA_DIR, safeFilePart(entry.paperId));
    const paperHtml = await fetchText(paperUrl, join(dir, 'paper.html'), `${entry.title} 题目页`);
    const answerHtml = await fetchText(answerUrl, join(dir, 'answer.html'), `${entry.title} 答案页`);
    const parsed = parseGkzhentiPaper({
      paperHtml,
      answerHtml,
      paperId: entry.paperId,
      title: entry.title || titleFromHtml(paperHtml),
      cls,
      province,
      source: entry.source,
    });
    if (!parsed.questions.length) throw new Error(`${entry.title} 未解析出题目，已保留原始缓存，未导入。`);
    const questions = parsed.questions.map(({ source_url, source_label, number, ...question }) => question);
    const batch = {
      name: parsed.title || entry.title,
      subject: parsed.subject,
      source: 'gkzhenti',
      license: '未声明（请核对授权后再公开再分发）',
      source_url: paperUrl,
      answer_url: answerUrl,
      source_label: entry.source,
      questions,
    };
    const normalizedPath = join(dir, 'normalized.json');
    await writeFile(normalizedPath, JSON.stringify(batch, null, 2) + '\n');
    const summary = {
      paperId: entry.paperId,
      name: batch.name,
      questions: questions.length,
      answerable: questions.filter((question) => question.answer_index >= 0 || question.answer).length,
      withAnalysis: questions.filter((question) => question.analysis).length,
      imageMissing: questions.filter((question) => question.image_missing).length,
      normalizedPath,
    };
    if (!NO_IMPORT) {
      const result = await importBatch(batch);
      summary.imported = result.count;
      summary.batchId = result.id;
    }
    summaries.push(summary);
    console.log(JSON.stringify(summary));
  }
  const total = summaries.reduce((sum, item) => sum + item.questions, 0);
  console.log(`完成：${total} 题，${summaries.length} 份试卷${NO_IMPORT ? '（仅本地规范化，未写入应用题库）' : '已导入'}`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  main().catch((error) => {
    console.error(`公开真题库导入失败：${error.message}`);
    process.exitCode = 1;
  });
}

export { selectEntries };
