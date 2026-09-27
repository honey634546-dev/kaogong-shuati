/** Pure, conservative method routing. Labels describe question structure, never verified shortcuts. */
const ALIASES = Object.freeze({
  数量关系: '数量关系', 数学运算: '数量关系', 资料分析: '资料分析', 资料计算: '资料分析',
  言语理解: '言语理解', 言语理解与表达: '言语理解', 片段阅读: '言语理解', 逻辑填空: '言语理解', 语句表达: '言语理解',
  判断推理: '判断推理', 逻辑判断: '逻辑判断', 图形推理: '图形推理', 类比推理: '类比推理', 定义判断: '定义判断', 数字推理: '数字推理',
  常识判断: '常识判断', 常识: '常识判断', 政治理论: '政治理论', 政治常识: '政治理论',
  申论: '申论', 综应: '综应', 综合应用能力: '综应',
});
const PARENT = Object.freeze({
  逻辑判断: '判断推理', 图形推理: '判断推理', 类比推理: '判断推理', 定义判断: '判断推理', 数字推理: '数量关系',
});
const FOCUS = Object.freeze({
  数量关系: '比较列式、代入与计算步骤，检查是否有更省步骤的解法。',
  资料分析: '核对文字材料、统计口径与列式，比较估算或精算方法。',
  言语理解: '梳理文段或语境，比较选项依据与排除顺序。',
  判断推理: '依据本题的条件和选项比较解法，再判断适合整理条件、核对定义还是比较关系。',
  逻辑判断: '梳理条件关系与推导顺序，核对每一步能否成立。',
  定义判断: '拆出定义的必要条件，逐项核对选项，注意设问要求属于还是不属于。',
  类比推理: '比较词语间的关系、顺序与层级，用同一种关系逐项检验选项。',
});

const plain = (value) => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|#160|#x[aA]0);/g, ' ').replace(/[\t\r ]+/g, ' ').trim();
const stemOf = (q) => plain(q.content || q.prompt || q.contentHtml || '');
function optionsOf(q) {
  let options = q.options;
  if (typeof options === 'string') { try { options = JSON.parse(options); } catch { return []; } }
  return Array.isArray(options) ? options.map((option) => plain(option).replace(/^[A-Z][.．、:：)）]\s*/i, '').trim()) : [];
}

/** Only explicit requests to inspect/manipulate depicted figures, not a lone topical word. */
export function hasQuestionFigureDependency(q = {}) {
  const stem = stemOf(q);
  return /(?:如图所示|下图所示|观察下(?:列|面)图形|根据下图|由下图可知)/.test(stem)
    || /(?:从|在)所给.{0,18}(?:选择|选出).{0,24}(?:填入|替代).{0,12}问号.{0,24}(?:图形|规律)/.test(stem)
    || /(?:将|把)(?:下列|下面|以下|所给)(?:的)?.{0,12}图形.{0,12}分为/.test(stem)
    || /(?:左|右)图为给定的多面体|(?:左|右)边给定的是(?:正方体|立方体|长方体)的(?:外表面)?展开图/.test(stem)
    || /(?:图形|图案|立体图|平面图).{0,18}(?:折叠|展开|拼合|拼接|旋转后)/.test(stem);
}

function sourceCategory(q) {
  const found = new Set();
  for (const key of ['category', 'subCategory', 'sub_category', 'categoryName', 'module', 'type']) {
    if (typeof q[key] !== 'string') continue;
    for (const token of q[key].split(/[/\\>›»|]+/).map((part) => part.trim())) {
      if (Object.hasOwn(ALIASES, token)) found.add(ALIASES[token]);
    }
  }
  const customBatch = q.type === 'custom' || /^custom-/.test(String(q.id || q.questionId || ''));
  if (!found.size && !customBatch && typeof q.chapter === 'string' && Object.hasOwn(ALIASES, q.chapter.trim())) found.add(ALIASES[q.chapter.trim()]);
  if (Number.isFinite(Number(q.type)) && Number(q.type) >= 20) found.add('申论');
  const specific = [...found].filter((category) => ![...found].some((other) => PARENT[other] === category));
  return { category: specific.length === 1 ? specific[0] : '', conflict: specific.length > 1 };
}

// Delimited short Chinese terms are structural evidence only when every option has the same arity.
function wordTuple(text) {
  const parts = text.replace(/[。．]$/, '').split(/[:：]/).map((part) => part.trim());
  if (![2, 3].includes(parts.length)) return null;
  if (!parts.every((part) => /^[\p{Script=Han}·]{1,14}$/u.test(part)
    && !/^[零〇一二三四五六七八九十百千万亿两点分秒时比倍成之]+$/.test(part)
    && !/^(?:百分之|千分之)/.test(part)
    && !/^[零〇一二三四五六七八九十百千万两]+(?:秒钟|分钟|小时|个月|年|月|周|天|日)$/.test(part)
    && !/^(?:凌晨|清晨|早晨|早上|上午|中午|下午|傍晚|晚上|夜间)?[零〇一二三四五六七八九十两]+(?:点|时)/.test(part))) return null;
  return parts;
}

function structureCategory(q) {
  const stem = stemOf(q);
  const options = optionsOf(q);
  if (hasQuestionFigureDependency(q)) return { category: '图形推理', reason: '题干明确要求观察或变换图形，文字信息不足以完成该操作。' };
  const end = stem.replace(/[。！？?！\s]+$/, '');
  const lastBoundary = Math.max(end.lastIndexOf('。'), end.lastIndexOf('！'), end.lastIndexOf('？'), end.lastIndexOf('?'), end.lastIndexOf('\n'));
  const query = end.slice(lastBoundary + 1).trim();
  const context = [plain(q.material || q.materialHtml), end.slice(0, lastBoundary + 1)].filter(Boolean).join('\n');
  const definitionQuestion = /^(?:根据|依据)(?:上述|以上|该|这[一项个]?|以下)?(?:的)?定义[，,：:\s]*(?:下列|以下|哪个|哪一)/.test(query);
  const definitionContext = /(?:^|[。；;\n])\s*[^。！？\n]{2,40}(?:是指|指的是|定义为)[^。！？\n]{8,}(?:[。；;]|$)/.test(context);
  if (definitionQuestion && definitionContext && options.length >= 2) return { category: '定义判断', reason: '题目提供完整定义段，并在设问中明确要求根据该定义判断选项。' };
  const tuple = wordTuple(stem);
  if (tuple && options.length >= 2 && options.every((option) => wordTuple(option)?.length === tuple.length)) return { category: '类比推理', reason: '题干与全部选项均为相同项数的词语关系组，未包含数字比例或时间格式。' };
  const analogousForm = /^[\p{Script=Han}·（）()\s]{0,24}对于[\p{Script=Han}·（）()\s]{1,24}相当于[\p{Script=Han}·（）()\s]{1,24}对于[\p{Script=Han}·（）()\s]{0,24}[。．]?$/u.test(stem);
  if (analogousForm && options.length >= 2 && options.every((option) => wordTuple(option)?.length === 2)) return { category: '类比推理', reason: '题干使用“对于…相当于…对于…”关系结构，全部选项为对应的双词组。' };
  const logicalQuery = /^(?:以下|下列|由此|据此|根据(?:以上|上述)|如果(?:以上|上述)|上述)[^。！？\n]{0,120}(?:支持|削弱|推出|推断|质疑|反驳|前提|假设)/.test(query);
  if (logicalQuery && context.replace(/\s/g, '').length >= 16 && options.length >= 2) return { category: '逻辑判断', reason: '题目先给出完整论述或条件，再明确要求支持、削弱或推导结论。' };
  return null;
}

export function classifyQuestionMethod(question = {}) {
  const q = question && typeof question === 'object' && !Array.isArray(question) ? question : {};
  const source = sourceCategory(q);
  const result = (category, classificationSource, classificationReason) => ({
    category, label: category === '判断推理' ? '文字判断' : category,
    focus: FOCUS[category] || '', supported: Object.hasOwn(FOCUS, category), classificationSource, classificationReason,
});
  if (source.conflict) return result('', 'conflict', '逐题分类元数据指向不兼容的题型，暂不自动选择分析方法。');
  // Reliable fine labels and explicit non-judgment subjects outrank inferred structure.
  if (source.category && source.category !== '判断推理') return result(source.category, 'source', '依据题库提供的逐题分类。');
  const inferred = structureCategory(q);
  if (inferred) return result(inferred.category, 'structure', inferred.reason);
  if (source.category === '判断推理') return result('判断推理', 'source', '题库标注为判断推理；未确定细类，按本题完整文字条件和选项分析。');
  return result('', 'unknown', '现有分类与题目结构不足以确定合适的分析方向。');
}
