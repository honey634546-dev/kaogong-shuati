// 公开真题库（gwy.gkzhenti.cn）适配器。
//
// 站点的题目页和答案页是分开的；本文件只做纯文本/结构化转换，网络请求和
// 频率控制放在 scripts/import-gkzhenti.mjs。原始 HTML 不进入 git，也不在这里
// 假定站点内容具有开放再分发许可。
import { normalizeAnswer, parseTxt } from './custom-parser.js';

export const GKZHENTI_ORIGIN = 'https://gwy.gkzhenti.cn';
const BLOCKED_PAGE_RE = /恶意爬虫|临时黑名单|永久黑名单|爬虫的频率要求/i;

const ENTITY_NAMES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  hellip: '…', middot: '·', ndash: '–', mdash: '—', laquo: '«', raquo: '»',
};

function decodeEntities(value) {
  let output = String(value ?? '');
  // 处理一次转义（例如 &amp;nbsp;）不会无限递归，也足够覆盖网页导出的常见形式。
  for (let pass = 0; pass < 2; pass++) {
    output = output.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (whole, token) => {
      const lower = String(token).toLowerCase();
      if (lower.startsWith('#x')) {
        const codePoint = Number.parseInt(lower.slice(2), 16);
        try { return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole; } catch { return whole; }
      }
      if (lower.startsWith('#')) {
        const codePoint = Number.parseInt(lower.slice(1), 10);
        try { return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole; } catch { return whole; }
      }
      return Object.hasOwn(ENTITY_NAMES, lower) ? ENTITY_NAMES[lower] : whole;
    });
  }
  return output;
}

/** 将站点 HTML 转为适合现有题目解析器的行文本。 */
export function htmlToText(html) {
  let source = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(?:script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|svg)>/gi, '');
  source = source
    .replace(/<(?:br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/?(?:address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  source = decodeEntities(source)
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n');
  const lines = source.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function isBlockedPage(body) {
  return BLOCKED_PAGE_RE.test(String(body ?? ''));
}

export function paperIdFromUrl(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/\/paper\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

export function buildIndexUrl({ baseUrl = GKZHENTI_ORIGIN, cls = '行测', province = '国考' } = {}) {
  const url = new URL('/api/json', baseUrl);
  url.searchParams.set('cls', cls);
  url.searchParams.set('province', province);
  return url.toString();
}

export function buildPaperUrl(paperId, { baseUrl = GKZHENTI_ORIGIN, kind = 'paper' } = {}) {
  const safeKind = kind === 'answer' ? 'answer' : 'paper';
  return new URL(`/${safeKind}/${encodeURIComponent(String(paperId))}`, baseUrl).toString();
}

function indexRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.list)) return payload.list;
  return [];
}

/** 解析 /api/json 返回的试卷索引，过滤掉没有可用 paper id 的行。 */
export function parseIndexPayload(payload) {
  return indexRows(payload).map((row, index) => {
    const paperUrl = String(row?.No ?? row?.no ?? row?.url ?? row?.Url ?? '').trim();
    const paperId = paperIdFromUrl(paperUrl) || String(row?.id ?? row?.ID ?? '').trim();
    if (!paperId) return null;
    return {
      paperId,
      paperUrl,
      title: String(row?.Title ?? row?.title ?? '').trim() || `未命名试卷 ${index + 1}`,
      source: String(row?.Source ?? row?.source ?? '').trim(),
    };
  }).filter(Boolean);
}

function questionStart(line) {
  return /^(?:第\s*)?1\s*[.、．)）]/.test(line)
    || /^1\s+(?:[\u4e00-\u9fff]|[A-Za-z])/.test(line);
}

function isSiteBoilerplate(line) {
  return /^(?:首页|整卷|行测分项|搜卷|搜题|公告|帮助|接口|用户中心|登录|注册|公开真题库|浙ICP备|版权所有|免责声明|网站地图)\s*$/.test(line)
    || /(?:浙ICP备|ICP备|版权所有|免责声明)/.test(line);
}

/** 只保留题号开始后的页面正文，避免导航/页脚污染第一题或最后一题。 */
export function extractQuestionText(htmlOrText) {
  const text = /<[^>]+>/.test(String(htmlOrText ?? '')) ? htmlToText(htmlOrText) : String(htmlOrText ?? '');
  const lines = text.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => !isSiteBoilerplate(line))
    // 站点题目页常见「1、题干」而现有通用解析器要求题号标点后有空格；
    // 只在题号后补一个解析用空格，不改变题干内容。
    .map((line) => line.replace(/^((?:第\s*)?\d{1,4}\s*[.、．)）])(?=\S)/, '$1 '));
  const start = lines.findIndex(questionStart);
  return (start >= 0 ? lines.slice(start) : lines).join('\n').trim();
}

export function titleFromHtml(html) {
  const raw = String(html ?? '');
  const match = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
    || raw.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)
    || raw.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  return match ? htmlToText(match[1]).replace(/\s+/g, ' ').trim() : '';
}

function answerValue(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^([A-Ha-h]{1,4}|正确|错误|对|错|√|×)(?:\s|$)/);
  return match ? match[1].toUpperCase() : '';
}

/** 解析答案页中的「1、C」「2. A」等独立答案行。 */
export function parseAnswerPage(html) {
  const text = htmlToText(html);
  const answers = new Map();
  const lineRe = /^\s*(\d{1,4})\s*[、.．)）:：]\s*([A-Ha-h]{1,4}|正确|错误|对|错|√|×)(?:\s|$)/;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(lineRe);
    if (!match) continue;
    const number = Number(match[1]);
    const answer = answerValue(match[2]);
    if (number > 0 && answer) answers.set(number, answer);
  }
  // 某些导出页面会把答案压成一行，行解析不足时再做保守的全局扫描。
  if (!answers.size) {
    const globalRe = /(?:^|\s)(\d{1,4})\s*[、.．)）:：]\s*([A-Ha-h]{1,4}|正确|错误|对|错|√|×)(?=\s|$)/g;
    for (const match of text.matchAll(globalRe)) {
      const number = Number(match[1]);
      const answer = answerValue(match[2]);
      if (number > 0 && answer) answers.set(number, answer);
    }
  }
  return answers;
}

export function subjectForClass(cls) {
  const value = String(cls ?? '').trim();
  if (/行测/.test(value)) return '行测';
  if (/申论/.test(value)) return '申论';
  if (/公基/.test(value)) return '事业编·公基';
  if (/职测/.test(value)) return '事业编·职测';
  if (/综合应用|综应/.test(value)) return '事业编·综应';
  return '自定义';
}

function safeId(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

/** 合并题目页与答案页，输出现有自定义题库导入协议。 */
export function parseGkzhentiPaper({ paperHtml, answerHtml = '', paperId, title = '', cls = '', province = '', source = '' } = {}) {
  const parsed = parseTxt(extractQuestionText(paperHtml));
  const answers = parseAnswerPage(answerHtml);
  const paperKey = safeId(paperId);
  const seenNumbers = new Map();
  const category = [cls, province].filter(Boolean).join('/') || '公开真题库';
  const questions = parsed.map((item, index) => {
    const number = Number.isInteger(item.num) && item.num > 0 ? item.num : index + 1;
    const occurrence = (seenNumbers.get(number) || 0) + 1;
    seenNumbers.set(number, occurrence);
    const suffix = occurrence > 1 ? `-${occurrence}` : '';
    const externalId = `gkzhenti:${paperKey}:${number}${suffix}`;
    const answerRaw = answers.get(number) || item.answer || '';
    const normalized = normalizeAnswer(answerRaw, item.options);
    const hasAnswer = normalized.answer_index >= 0 || Boolean(normalized.answer);
    return {
      prompt: item.prompt,
      material: item.material,
      options: normalized.options,
      answer: normalized.answer,
      answer_index: normalized.answer_index,
      answer_status: hasAnswer ? 'unconfirmed' : 'missing',
      analysis: item.analysis || '',
      category,
      external_id: externalId,
      question_uid: externalId,
      source_url: buildPaperUrl(paperId),
      source_label: source,
      number,
    };
  });
  return {
    paperId: String(paperId ?? ''),
    title: String(title || '').trim(),
    cls: String(cls || '').trim(),
    province: String(province || '').trim(),
    source: String(source || '').trim(),
    subject: subjectForClass(cls),
    answerCount: answers.size,
    questions,
  };
}
