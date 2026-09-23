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

function removeNonContent(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(?:script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|svg)>/gi, '');
}

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
  let source = removeNonContent(html);
  // 原卷常用 <u>&nbsp;…</u> 表示填空，而非字面下划线。必须在剥标签和
  // 折叠空格之前保留这个语义；从内向外处理，兼容原卷重复嵌套的 <u>。
  // 只忽略文字包装标签，避免把下划线中的图片等内容误认成空白。
  let previous;
  do {
    previous = source;
    source = source.replace(/<u\b[^>]*>((?:(?!<u\b)[\s\S])*?)<\/u\s*>/gi, (_, inner) => {
      const text = decodeEntities(inner.replace(/<\/?(?:span|b|i|em|strong|font)\b[^>]*>/gi, ''));
      return /^[\s\u200b\u200c\u200d\ufeff]*$/.test(text) ? '____' : inner;
    });
  } while (source !== previous);
  source = source
    // 公开真题库整卷页把题号放在独立的「left」栏，题干在相邻的「right」栏；
    // 先把这个布局还原为通用解析器能识别的题号行，再剥除其他 HTML 标签。
    .replace(/<div\b[^>]*class=["'][^"']*\bleft\b[^"']*["'][^>]*>\s*(\d{1,4})\s*<\/div>/gi, '\n$1、')
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

function extractPaperRows(html) {
  const source = removeNonContent(html);
  const tags = [...source.matchAll(/<div\b[^>]*>|<\/div\s*>/gi)];
  const rows = [];
  let depth = 0;
  let rowStart = -1;
  let rowDepth = 0;
  for (const match of tags) {
    if (/^<div\b/i.test(match[0])) {
      const isRow = hasClassToken(match[0], 'row');
      if (isRow && rowStart < 0) {
        rowStart = match.index;
        rowDepth = depth + 1;
      }
      depth++;
    } else {
      if (rowStart >= 0 && depth === rowDepth) {
        rows.push(source.slice(rowStart, match.index + match[0].length));
        rowStart = -1;
        rowDepth = 0;
      }
      depth = Math.max(0, depth - 1);
    }
  }
  return rows;
}

function hasClassToken(html, token) {
  const classRe = /\bclass\s*=\s*(["'])(.*?)\1/gi;
  for (const match of String(html ?? '').matchAll(classRe)) {
    if (match[2].split(/\s+/).includes(token)) return true;
  }
  return false;
}

function questionNumberFromRow(row) {
  const match = String(row ?? '').match(/<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bleft\b[^"']*["'])[^>]*>\s*(\d{1,4})\s*<\/div>/i);
  return match ? Number(match[1]) : null;
}

function structuredQuestionFromRow(row) {
  const source = removeNonContent(row);
  const tags = [...source.matchAll(/<div\b[^>]*>|<\/div\s*>/gi)];
  const stack = [];
  const candidates = [];
  let order = 0;
  for (const match of tags) {
    if (/^<div\b/i.test(match[0])) {
      stack.push({ open: match[0], contentStart: match.index + match[0].length, depth: stack.length });
      continue;
    }
    const node = stack.pop();
    if (!node || !/\bcol-xs-\d+\b/.test(node.open)) continue;
    const inner = source.slice(node.contentStart, match.index);
    const text = htmlToText(inner).replace(/\s+/g, ' ').trim();
    const option = text.match(/^([A-H])\s*[、.．:：)）]\s*(.*)$/i);
    const optionText = option?.[2].trim();
    if (option && (optionText || /<img\b/i.test(inner))) {
      candidates.push({
        depth: node.depth,
        order: order++,
        label: option[1].toUpperCase(),
        text: optionText || '（原卷图形选项，图片未随导入提供）',
      });
    }
  }

  // 选项位于独立的 col-xs-* 节点中。按相同 DOM 深度寻找连续的 A、B、C…，
  // 避免题干材料里的「专辑 A、B」「选项 A、B」等文字被通用文本解析器误认成答案选项。
  let optionBlocks = [];
  const depths = [...new Set(candidates.map((candidate) => candidate.depth))].sort((a, b) => b - a);
  for (const depth of depths) {
    const sameDepth = candidates.filter((candidate) => candidate.depth === depth).sort((a, b) => a.order - b.order);
    let sequence = [];
    let best = [];
    for (const candidate of sameDepth) {
      const expected = String.fromCharCode(65 + sequence.length);
      if (candidate.label === 'A') sequence = [candidate];
      else if (sequence.length && candidate.label === expected) sequence.push(candidate);
      else sequence = [];
      if (sequence.length > best.length) best = sequence;
    }
    if (best.length >= 2) { optionBlocks = best; break; }
  }
  if (!optionBlocks.length) return null;

  const paragraphs = [...source.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)]
    .map((match) => htmlToText(match[1]).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!paragraphs.length) return null;

  let prompt = paragraphs.join('\n');
  let material = '';
  const lastParagraph = paragraphs.at(-1);
  const earlierParagraphs = paragraphs.slice(0, -1);
  // 仅当最后一段明显是问句、且前文没有已完成的问句时，才把前文拆成材料。
  // 其他多段题干（如「有几项？」后接①②③陈述）整体保留，避免误拆。
  if (earlierParagraphs.length && /[？?：:]$/.test(lastParagraph) && !earlierParagraphs.some((paragraph) => /[？?]$/.test(paragraph))) {
    material = earlierParagraphs.join('\n');
    prompt = lastParagraph;
  }
  return {
    prompt,
    material,
    options: optionBlocks.map((option) => `${option.label}. ${option.text}`),
  };
}

function sectionName(row) {
  const text = htmlToText(row).replace(/\s+/g, ' ').trim();
  const match = text.match(/^[一二三四五六七八九十\d]+、\s*([^。．]+)/);
  return match ? match[1].trim() : text;
}

function sharedMaterialFromRow(row) {
  const lines = htmlToText(row).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const materialLines = lines.filter((line) => !/^[（(][一二三四五六七八九十\d]+[）)]$/.test(line));
  const imageCount = [...String(row ?? '').matchAll(/<img\b/gi)].length;
  return { text: materialLines.join('\n').trim(), imageCount };
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
  const answers = parseAnswerPage(answerHtml);
  const paperKey = safeId(paperId);
  const rows = extractPaperRows(paperHtml);
  const hasStructuredRows = rows.some((row) => questionNumberFromRow(row) != null);
  let pendingMaterial = '';
  let pendingMaterialImages = 0;
  let currentSection = '';
  let questions;

  if (hasStructuredRows) {
    questions = [];
    for (const row of rows) {
      const number = questionNumberFromRow(row);
      if (number != null) {
        const structured = structuredQuestionFromRow(row);
        const rowQuestions = structured ? [] : parseTxt(htmlToText(row));
        const item = structured || rowQuestions.find((candidate) => candidate.num === number) || rowQuestions[0];
        if (!item || !item.prompt) continue;
        const answerRaw = answers.get(number) || '';
        const normalized = normalizeAnswer(answerRaw, item.options);
        const externalId = `gkzhenti:${paperKey}:${number}`;
        const ownImageCount = [...row.matchAll(/<img\b/gi)].length;
        const imageNote = ownImageCount
          ? '\n\n【本题原卷含题目图片，当前导入文件未包含图片】'
          : '';
        const material = [pendingMaterial, item.material, pendingMaterialImages ? '【共享材料含图片，当前导入文件未包含图片】' : '']
          .filter(Boolean).join('\n\n');
        questions.push({
          prompt: `${item.prompt}${imageNote}`,
          material,
          options: normalized.options,
          answer: normalized.answer,
          answer_index: normalized.answer_index,
          answer_status: normalized.answer_index >= 0 || normalized.answer ? 'unconfirmed' : 'missing',
          // 来源站的本试卷页没有逐题解析，不将章节标题或阅读材料伪装成解析。
          analysis: '',
          category: [cls, province, currentSection].filter(Boolean).join('/').slice(0, 100) || '公开真题库',
          external_id: externalId,
          question_uid: externalId,
          source_url: buildPaperUrl(paperId),
          source_label: source,
          number,
          image_missing: Boolean(ownImageCount || pendingMaterialImages),
        });
        continue;
      }

      if (hasClassToken(row, 'subtitle')) {
        currentSection = sectionName(row);
        pendingMaterial = '';
        pendingMaterialImages = 0;
      } else if (hasClassToken(row, 'sub2title')) {
        const material = sharedMaterialFromRow(row);
        pendingMaterial = material.text;
        pendingMaterialImages = material.imageCount;
      }
    }
  } else {
    const parsed = parseTxt(extractQuestionText(paperHtml));
    questions = parsed.map((item, index) => {
      const number = Number.isInteger(item.num) && item.num > 0 ? item.num : index + 1;
      const answerRaw = answers.get(number) || '';
      const normalized = normalizeAnswer(answerRaw, item.options);
      const externalId = `gkzhenti:${paperKey}:${number}`;
      return {
        prompt: item.prompt,
        material: item.material,
        options: normalized.options,
        answer: normalized.answer,
        answer_index: normalized.answer_index,
        answer_status: normalized.answer_index >= 0 || normalized.answer ? 'unconfirmed' : 'missing',
        analysis: '',
        category: [cls, province].filter(Boolean).join('/') || '公开真题库',
        external_id: externalId,
        question_uid: externalId,
        source_url: buildPaperUrl(paperId),
        source_label: source,
        number,
        image_missing: false,
      };
    });
  }
  return {
    paperId: String(paperId ?? ''),
    title: String(title || '').trim(),
    cls: String(cls || '').trim(),
    province: String(province || '').trim(),
    source: String(source || '').trim(),
    subject: subjectForClass(cls),
    answerCount: questions.filter((question) => question.answer_status !== 'missing').length,
    imageMissingCount: questions.filter((question) => question.image_missing).length,
    questions,
  };
}
