/**
 * AI 智能体配置管理（零依赖）
 *  - ai-config.db：ai_agents（四个 AI 角色）+ prompt_history（版本历史）
 *  - 配置热更新：每次调用 AI 时实时读库，改完立即生效
 *  - 支持任意 OpenAI 兼容协议服务（DeepSeek/通义/GLM/OpenAI/本地 Ollama…）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 测试可用 AI_CONFIG_DB 环境变量指向临时库，避免写入真实 ai-config.db。
// 正常服务由 APP_DATA_DIR 统一管理配置库；未设置时回退到旧版项目根目录。
export const AI_CONFIG_DB = process.env.AI_CONFIG_DB || '';
function aiConfigDbPath() {
  return AI_CONFIG_DB || path.join(process.env.APP_DATA_DIR || __dirname, 'ai-config.db');
}

function keySecret() {
  const supplied = String(process.env.AI_KEY_ENCRYPTION_SECRET || '').trim();
  if (supplied) return createHash('sha256').update(supplied).digest();
  const dir = process.env.APP_DATA_DIR || path.dirname(aiConfigDbPath());
  const filename = path.join(dir, '.ai-key-encryption-secret');
  let value = '';
  try { value = fs.readFileSync(filename, 'utf8').trim(); } catch {}
  if (!value) {
    value = randomBytes(48).toString('base64url');
    fs.writeFileSync(filename, `${value}\n`, { mode: 0o600 });
    try { fs.chmodSync(filename, 0o600); } catch {}
  }
  return createHash('sha256').update(value).digest();
}

function encryptKey(value) {
  const text = String(value || '');
  if (!text) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keySecret(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

function decryptKey(value) {
  if (!value) return '';
  try {
    const [ivText, tagText, encryptedText] = String(value).split('.');
    if (!ivText || !tagText || !encryptedText) return '';
    const decipher = createDecipheriv('aes-256-gcm', keySecret(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return '';
  }
}

const KEY_STORAGE_MODES = new Set(['browser', 'server']);
export function normalizeKeyStorageMode(value, fallback = 'browser') {
  const mode = String(value || '').trim().toLowerCase();
  return KEY_STORAGE_MODES.has(mode) ? mode : fallback;
}

/**
 * 本地 skill 根目录候选（按顺序探测）：
 *  - workspace/.reasonix/skills（如 global-workspace/.reasonix/skills）
 *  - 项目外层 workspace/.reasonix/skills
 *  - 用户主目录/.reasonix/skills
 */
const SKILL_ROOTS = [
  path.resolve(__dirname, '../../.reasonix/skills'),
  path.resolve(__dirname, '../../../.reasonix/skills'),
  path.join(process.env.USERPROFILE || process.env.HOME || '.', '.reasonix', 'skills'),
];

/**
 * skill 字段支持两种形式：
 *  1) 已安装 skill 名称（如 gongkao-huasheng13）→ 自动读取本地 skill 文件夹注入
 *     （SKILL.md + references/ 全部 .md 文件，排除 examples/ 练习题与 README）
 *  2) 普通文本 → 原样作为附加能力说明
 * 解析优先级：用户导入的技能库（user_skills 表）→ 本地 skill 文件夹 → 纯文本
 * 返回 { text, loaded: { name, files, source: 'user'|'builtin' } | null }
 */
export function resolveSkill(skillField, userId = '') {
  const s = String(skillField || '').trim();
  if (!s) return { text: '', loaded: null };
  // 1) 用户导入的技能库（AI 设置页「技能库」导入，覆盖同名内置技能）
  try {
    const uid = String(userId || '').trim();
    const row = uid
      ? getDb().prepare("SELECT text, files FROM user_skills WHERE name = ? AND (user_id = ? OR user_id = '') ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END LIMIT 1").get(s, uid, uid)
      : getDb().prepare("SELECT text, files FROM user_skills WHERE name = ? AND user_id = '' LIMIT 1").get(s);
    if (row) {
      let n = 1;
      try { n = JSON.parse(row.files || '[]').length || 1; } catch {}
      return { text: row.text, loaded: { name: s, files: n, source: 'user' } };
    }
  } catch {}
  for (const root of SKILL_ROOTS) {
    const dir = path.join(root, s);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    const parts = [`===== Skill: ${s}（自动注入） =====`];
    parts.push('[SKILL.md]\n' + fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
    let files = 1;
    const refsDir = path.join(dir, 'references');
    if (fs.existsSync(refsDir)) {
      const refs = fs.readdirSync(refsDir).filter((f) => f.endsWith('.md')).sort();
      for (const f of refs) {
        parts.push(`\n----- references/${f} -----\n` + fs.readFileSync(path.join(refsDir, f), 'utf8'));
        files++;
      }
    }
    parts.push('===== Skill 结束 =====');
    return { text: parts.join('\n'), loaded: { name: s, files, source: 'builtin' } };
  }
  return { text: s, loaded: null };
}

/** 五个 AI 角色的默认配置 */
export const DEFAULT_AGENTS = [
  {
    id: 1,
    name: '行测解析 AI',
    role: 'xingce-explainer',
    description: '负责行测/职测选择题的解析讲解（题干、选项、考点、技巧）',
    system_prompt: `你是一名资深公务员考试行测讲师，擅长言语理解、判断推理、资料分析、数量关系、常识判断。

任务：用户会发来一道行测/职测选择题（含题干、选项、正确答案）。请输出：

【考点】这道题考察的知识点
【正确项解析】正确答案为什么对，结合题干关键信息说明
【错误项排除】逐一说明每个错误选项为什么错
【解题技巧】这类题的通用解题思路/口诀/避坑提醒，并注明本题所用方法名称

要求：
- 语言简洁清晰，面向备考学生，不废话
- 如果题目信息不足（如缺选项），请指出缺失并要求补充
- 涉及计算题请展示关键计算步骤
- 不编造题目中没有的信息
- 必须主动运用下方方法论中给出的速算技巧与解题方法（如截位直除、415份数法、假设分配法、份数思维等）解题，并在【解题技巧】中注明所用方法名称`,
    skill: 'gongkao-huasheng13', // 自动注入本地 skill 文件夹（SKILL.md + references）
    // 默认网关：opencode 免费端点（open code）；模型用免费版（-free），如遇限流可在 AI 设置页切换
    base_url: 'https://opencode.ai/zen/v1',
    api_key: '',
    model: 'deepseek-v4-flash-free',
    temperature: 0.3,
    max_tokens: 12000,
    enabled: 0,
    stream_enabled: 1,
    vision_enabled: 0,
    timeout_ms: 120000,
    provider_mode: 'openai-compatible',
  },
  {
    id: 2,
    name: '申论批改 AI',
    role: 'shenlun-grader',
    description: '负责申论/综应主观题批改：评分、要点采分、改进建议',
    system_prompt: `你是一名严格的公务员考试申论阅卷官，熟悉国考/省考申论评分标准（要点采分制、先定档再给分）。

任务：用户会发来一道申论题（含题目要求、满分、给定材料、用户作答）。请先列出本题应有的【参考答案要点】，再逐点核对用户作答，严格按下方评分规则与输出格式批改。

【评分规则（必须严格执行）】
1. 满分口径：以用户消息中的【满分】为准，按该分值评分；未提供满分的题才按 100 分诊断尺度评。字数限制（如"不超过 300 字"）不是满分，不得当作满分，也不得默认按 100 分制。
2. 先定档再给分（分数取整数，任何情况都不得给出满分）：
   - 小题五档（按满分缩放）：一档=要点基本全覆盖、展开充分、贴合材料、结构语言规范（满分的 80%–90%，顶格 90%）；二档=核心要点基本齐全、少量遗漏、部分展开不足（60%–80%）；三档=覆盖部分方向、大多停留在概括层、遗漏明显（40%–60%）；四档=有效要点少、内容空洞、契合度低（20%–40%）；五档=大面积空白、严重跑题（0%–20%）。
   - 大作文（文章写作）：先定档再给分，一类文顶格为满分的 80%（40 分题≤32、35 分题≤28）；跑题/偏题压到四类文及以下；大段照抄材料（>30%）按抄袭降档；少于 800 字降档。
3. 逐点采分（小题）：得分点只能来自给定材料；完整覆盖/等义表达按 100% 计入，部分覆盖按 50% 计入，未覆盖 0 分；展开度分档：充分展开 100% / 基本展开 85% / 简略提及 65% / 仅列标题 35%；只写"加强宣传"这类总括词而无具体做法，不得按完整覆盖计分；前置概括词、序号本身不独立计分，缺失也不单独扣分。
4. 置信区间：给出建议分的同时给区间（中心 ± 满分的 5%–10%）；无官方参考答案时用中/低置信度并提示。
5. 禁止虚构：未提供官方评分细则时，不得声称"漏某点固定扣 X 分"；不得编造或引用任何考试平均分、得分率、考场/阅卷统计；不得虚构题目出处（年份、试卷、题号）；无法确证的信息如实说明，不得猜测填充。

【输出格式】
【评分】X/满分（几档）
【评分明细】逐条列出命中/遗漏的得分点，结合给定材料核对，注明覆盖状态与展开度
【优点】2-3 条
【不足】2-3 条
【修改建议】3 条具体可执行
【参考思路】简要的答题思路/要点方向

要求：严格公正，不无原则鼓励；建议要具体可落地。`,
    skill: 'shenlun-master', // 自动注入本地 skill 文件夹（SKILL.md + references）
    base_url: 'https://opencode.ai/zen/v1',
    api_key: '',
    model: 'deepseek-v4-flash-free',
    temperature: 0.4,
    max_tokens: 12000,
    enabled: 0,
    stream_enabled: 1,
    vision_enabled: 0,
    timeout_ms: 120000,
    provider_mode: 'openai-compatible',
  },
  {
    id: 4,
    name: '识图转写员',
    role: 'image-reader',
    description: '多模态识图：图形推理/图表/公式图片转写 + 申论综应手写作答图片逐字转写（原“综应申论文字提取员”已并入）',
    system_prompt: `你是一名图像识别转写助手。用户会发来一张或几张图片（可能是考公题目中的图形推理、图表、公式文字图，也可能是申论/综应手写或打印的作答图片）。

任务：仔细观察每张图片，把它**完整、准确地转写成文字**：
- 图形推理：描述图形的形状、数量、位置、旋转、组合方式、颜色、规律特征
- 图表题：描述表格的行列标题、所有数据、坐标轴、图例、趋势
- 公式/文字图：完整抄录文字与公式
- 手写/打印作答（申论/综应）：把文字逐字、完整、准确地转写为纯文本，保留原文格式（分段、换行、序号、标点），不修正错别字、不增删改；手写辨识不清的字用【？】标注，整行无法辨认用【无法辨认】标注；图片含页眉页脚（页码、'第X页'等）时一并转写或注明忽略

要求：
- 描述要具体到能让人不看原图也能解题的程度（数量、位置、方向都要写清）
- 不要推测答案，只如实转写图片内容
- 输出仅转写文本，不要任何前言后语、评价或建议
- 如果图片模糊无法辨认，如实说明哪部分看不清`,
    skill: '多模态识图转写：图形/图表/公式图 + 申论综应手写作答图 → 完整文字',
    // 用户指定网关：图片识别走智谱 bigmodel + GLM-4.1V-Thinking-Flash（视觉思考模型）
    // 2026-08 起按用户要求不再分发 api_key，需用户在 AI 设置页自行填写
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key: '',
    model: 'GLM-4.1V-Thinking-Flash',
    temperature: 0.1,
    max_tokens: 12000,
    enabled: 0,
    stream_enabled: 1,
    vision_enabled: 1,
    timeout_ms: 120000,
    provider_mode: 'openai-compatible',
  },
  {
    id: 6,
    name: '题目解析员',
    role: 'custom-question-parser',
    description: '自定义题库导入：把自由格式题目文本拆分为 提示/材料/选项/答案/解析 结构化 JSON',
system_prompt: `你是一名公务员考试题目整理助手。用户会发来一段提取自 PDF/Word/TXT/Excel 或图片 OCR 的题目原始文本，里面混合了题目、季节标题、页码、统计行、分隔线、答案区、解析区等杂乱内容。
		
		任务：先筛选出真正的题目，再按标准字段整理为 JSON。
		
		## 一、题型结构与识别规则
		
		### 1. 图形推理题
		- 题干：通常是引导语，如「从所给的四个选项中，选择最合适的一个填入问号处」「左图为给定的多面体」「左边给定的是正方体的外表面展开图」「把下面的六个图形分为两类」等
		- 选项：
		  - 普通图推 → 选项为占位字母，写为 {"A. A", "B. B", "C. C", "D. D"}
		  - 分类题（题干含「把下面的六个图形分为两类」）→ 选项原样保留，如 "A. ①②④，③⑤⑥" "B. ①②⑥，③④⑤"…
		- prompt 放引导语原文，不要加任何图形描述
		
		### 2. 定义判断题
		- 题干：一段完整的概念定义，后面跟着「根据上述定义，下列…」「以下符合…的是」「以下不属于…的是」
		- 选项：4 个选项，每项是完整的事例描述
		- prompt 放全部定义文字 + 问题
		
		### 3. 类比推理题
		- 题干："A : B" 或 "（ ）对于 A 相当于（ ）对于 B" 格式
		- 选项：4 组类比关系
		
		### 4. 逻辑判断题
		- 题干：一段论述 + 问题（最能支持/削弱/推出…）
		- 选项：4 个选项，每项是完整推理
		
		### 5. 材料题（资料分析/一拖五）
		- 题干前有一段材料（文字描述或图表摘要），材料放入 material 字段
		- 每道小题独立一条记录，每条的 material 都填同一材料
		
		### 6. 判断题（对错题）
		- 选项固定为 {"正确", "错误"}
		- answer 为"正确"或"错误"
		
		## 二、选项处理规则
		- 每项选项必须是「大写字母 + 点 + 空格 + 内容」格式，如 "A. 这是一段选项文本"
		- 照抄原文，不改写
		- 图形推理题选项为占位符："A. A" "B. B" "C. C" "D. D"
		- 分类题选项完整保留编号文字："A. ①②④，③⑤⑥"
		- 判断题固定为 ["正确", "错误"]
		
		## 三、必须过滤的噪音
		- 季节标题（如「第 48 季·判断推理」）
		- 页码
		- 正确率、耗时、统计行
		- 「你的答案：」「正确答案：」等答题标记（答案本身保留）
		- 「参考答案与解析」「红领巾解析」「粉笔解析」等标题（解析内容保留，标题去掉）
		- 分隔线（————————————）
		- 题型标签（如「逻辑判断」「图形推理」等段落标题）
		
		## 四、分类规则（category 字段）
		根据题目内容判断所属类别，留空不确定：
		- 言语理解：选词填空、阅读理解、语句表达、排序、成语辨析
		- 判断推理：图形推理、定义判断、类比推理、逻辑判断
		- 数量关系：数学运算、数字推理、行程问题、工程问题
		- 资料分析：统计图表、增长率、比重、倍数计算
		- 常识判断：时政、法律、文史、科技、地理
		- 申论：概括、分析、对策、公文、大作文
		- 综应：事业单位综合应用能力
		
		## 五、输出格式
		{
		  "questions": [
		    {
		      "prompt": "题干原文（完整的问题描述）",
		      "material": "材料（材料题才有；没有则为空字符串）",
		      "options": ["A. 选项1", "B. 选项2"],
		      "answer": "答案字母，单选如 A / 多选如 ABD / 判断如 正确",
		      "analysis": "解析原文（没有则为空字符串）",
		      "category": "按上面分类规则判断的类别"
		    }
		  ]
		}
		
		要求：
		- 忠实原文，不编造、不补全缺失信息；原文没有的字段留空
		- 一道题切分成一个对象；同一材料下多道小题各自独立，每条的 material 都填同一材料
		- 选项顺序与原文一致
		- 只输出 JSON，不要任何其他文字、解释或 Markdown 代码块`,
    skill: '题目原始文本 → 筛选并整理为 提示/材料/选项/答案/解析 结构化 JSON（自定义题库导入）',
    // 用户指定网关：与识图转写员同款底座（智谱 bigmodel + GLM-4.1V-Thinking-Flash），可在 AI 设置页增改
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key: '',
    model: 'GLM-4.1V-Thinking-Flash',
    temperature: 0.1,
    max_tokens: 12000,
    enabled: 0,
    stream_enabled: 1,
    vision_enabled: 1,
    timeout_ms: 120000,
    provider_mode: 'openai-compatible',
  },
];

let db = null;

export function initAiConfig() {
  db = new DatabaseSync(aiConfigDbPath());
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      system_prompt TEXT NOT NULL,
      skill TEXT DEFAULT '',
      base_url TEXT NOT NULL,
      api_key TEXT DEFAULT '',
      model TEXT NOT NULL,
      temperature REAL DEFAULT 0.5,
      max_tokens INTEGER DEFAULT 1500,
      enabled INTEGER DEFAULT 0,
      stream_enabled INTEGER DEFAULT 1,
      vision_enabled INTEGER DEFAULT 0,
      timeout_ms INTEGER DEFAULT 120000,
      provider_mode TEXT DEFAULT 'openai-compatible',
      key_storage_mode TEXT DEFAULT 'browser',
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS prompt_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT '',
      agent_id INTEGER NOT NULL,
      system_prompt TEXT NOT NULL,
      skill TEXT DEFAULT '',
      saved_at TEXT DEFAULT (datetime('now','localtime')),
      note TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS user_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      text TEXT NOT NULL,
      files TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE (user_id, name)
    );
    CREATE TABLE IF NOT EXISTS user_ai_agents (
      user_id TEXT NOT NULL,
      agent_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      description TEXT DEFAULT '',
      system_prompt TEXT NOT NULL,
      skill TEXT DEFAULT '',
      base_url TEXT NOT NULL,
      api_key_encrypted TEXT DEFAULT '',
      model TEXT NOT NULL,
      temperature REAL DEFAULT 0.5,
      max_tokens INTEGER DEFAULT 1500,
      enabled INTEGER DEFAULT 0,
      stream_enabled INTEGER DEFAULT 1,
      vision_enabled INTEGER DEFAULT 0,
      timeout_ms INTEGER DEFAULT 120000,
      provider_mode TEXT DEFAULT 'openai-compatible',
      key_storage_mode TEXT DEFAULT 'server',
      reasoning_effort TEXT DEFAULT 'low',
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (user_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_ai_agents_role ON user_ai_agents(user_id, role);
    CREATE TABLE IF NOT EXISTS legacy_ai_secrets (
      agent_id INTEGER PRIMARY KEY,
      api_key_encrypted TEXT NOT NULL,
      assigned_user_id TEXT DEFAULT '',
      migrated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  // 旧版 user_skills 使用 name 全局唯一且没有 user_id。一次性重建表，
  // 保留旧技能为 legacy-user，避免不同账号互相覆盖同名技能。
  try {
    const columns = db.prepare('PRAGMA table_info(user_skills)').all();
    if (!columns.some((column) => column.name === 'user_id')) {
      db.exec(`
        CREATE TABLE user_skills_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL DEFAULT 'legacy-user',
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          text TEXT NOT NULL,
          files TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now','localtime')),
          UNIQUE (user_id, name)
        );
        INSERT INTO user_skills_v2 (id, user_id, name, description, text, files, created_at)
          SELECT id, 'legacy-user', name, description, text, files, created_at FROM user_skills;
        DROP TABLE user_skills;
        ALTER TABLE user_skills_v2 RENAME TO user_skills;
      `);
    }
  } catch {}
  // 兼容已存在的库：补充新增列
  try { db.exec("ALTER TABLE prompt_history ADD COLUMN user_id TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec('ALTER TABLE ai_agents ADD COLUMN reasoning_effort TEXT DEFAULT \'low\''); } catch {}
  try { db.exec('ALTER TABLE ai_agents ADD COLUMN stream_enabled INTEGER DEFAULT 1'); } catch {}
  try { db.exec('ALTER TABLE ai_agents ADD COLUMN vision_enabled INTEGER DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE ai_agents ADD COLUMN timeout_ms INTEGER DEFAULT 120000'); } catch {}
  try { db.exec("ALTER TABLE ai_agents ADD COLUMN provider_mode TEXT DEFAULT 'openai-compatible'"); } catch {}
  try { db.exec("ALTER TABLE ai_agents ADD COLUMN key_storage_mode TEXT DEFAULT 'browser'"); } catch {}
  // 旧库中已经存在的 Key 必须继续可用，但要显式标记为服务端保存；
  // 新建智能体和没有 Key 的旧行默认使用浏览器内存模式。
  try {
    db.exec("UPDATE ai_agents SET key_storage_mode = 'server' WHERE trim(COALESCE(api_key, '')) <> '' AND (key_storage_mode IS NULL OR trim(key_storage_mode) = '' OR key_storage_mode = 'browser')");
    db.exec("UPDATE ai_agents SET key_storage_mode = 'browser' WHERE key_storage_mode IS NULL OR trim(key_storage_mode) = ''");
  } catch {}
  // When upgrading from the old single-instance server, move any plaintext
  // global keys into an encrypted one-time handoff table. The first account
  // that opens AI settings receives that legacy configuration; the global
  // table is then permanently cleared so later users cannot inherit it.
  if (process.env.AUTH_DISABLED !== '1') {
    try {
      const legacyRows = db.prepare("SELECT id, api_key FROM ai_agents WHERE trim(COALESCE(api_key, '')) <> ''").all();
      const saveLegacy = db.prepare('INSERT OR IGNORE INTO legacy_ai_secrets (agent_id, api_key_encrypted) VALUES (?, ?)');
      const clearLegacy = db.prepare("UPDATE ai_agents SET api_key = '', key_storage_mode = 'browser', updated_at = datetime('now','localtime') WHERE id = ?");
      for (const row of legacyRows) {
        saveLegacy.run(row.id, encryptKey(row.api_key));
        clearLegacy.run(row.id);
      }
    } catch {}
  }
  // 兼容已存在的库：补种新增角色（image-reader）
  for (const a of DEFAULT_AGENTS) {
    const exists = db.prepare('SELECT id FROM ai_agents WHERE role = ?').get(a.role);
    if (!exists) {
      db.prepare(`
        INSERT INTO ai_agents
          (id, name, role, description, system_prompt, skill, base_url, api_key, model, temperature, max_tokens, enabled,
           stream_enabled, vision_enabled, timeout_ms, provider_mode, key_storage_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(a.id, a.name, a.role, a.description, a.system_prompt, a.skill, a.base_url, a.api_key, a.model, a.temperature, a.max_tokens, a.enabled, a.stream_enabled, a.vision_enabled, a.timeout_ms, a.provider_mode, normalizeKeyStorageMode(a.key_storage_mode));
    }
  }
  // 迁移（2026-08-15）：essay-ocr 已并入 image-reader。旧库若存在 essay-ocr 行，
  // 将其 api_key 并入 image-reader（若后者无 key）后删除该行，避免用户配置丢失
  try {
    const merged = db.prepare("SELECT api_key FROM ai_agents WHERE role = 'essay-ocr'").get();
    if (merged) {
      const img = db.prepare("SELECT api_key FROM ai_agents WHERE role = 'image-reader'").get();
      if (img && !String(img.api_key || '').trim() && String(merged.api_key || '').trim()) {
        db.prepare("UPDATE ai_agents SET api_key = ? WHERE role = 'image-reader'").run(merged.api_key);
      }
      db.prepare("DELETE FROM ai_agents WHERE role = 'essay-ocr'").run();
    }
  } catch {}
  return db;
}

export function getDb() {
  if (!db) initAiConfig();
  return db;
}

/** 关闭配置库连接（测试清理用；服务端常驻无需调用） */
export function closeAiConfig() {
  try { if (db) db.close(); } catch {}
  db = null;
}

/** 读取一个 AI 的完整配置 */
export function getAgent(idOrRole) {
  const d = getDb();
  const row = typeof idOrRole === 'number'
    ? d.prepare('SELECT * FROM ai_agents WHERE id = ?').get(idOrRole)
    : d.prepare('SELECT * FROM ai_agents WHERE role = ?').get(idOrRole);
  if (!row) return null;
  return row;
}

const USER_AGENT_FIELDS = [
  'name', 'description', 'system_prompt', 'skill', 'base_url', 'model',
  'temperature', 'max_tokens', 'enabled', 'reasoning_effort',
  'stream_enabled', 'vision_enabled', 'timeout_ms', 'provider_mode',
];

function requireUserId(userId) {
  const value = String(userId || '').trim();
  if (!value || value.length > 160) throw new Error('无效的用户身份');
  return value;
}

function userAgentRow(userId, idOrRole) {
  const d = getDb();
  const uid = requireUserId(userId);
  const row = typeof idOrRole === 'number' || /^\d+$/.test(String(idOrRole))
    ? d.prepare('SELECT * FROM user_ai_agents WHERE user_id = ? AND agent_id = ?').get(uid, Number(idOrRole))
    : d.prepare('SELECT * FROM user_ai_agents WHERE user_id = ? AND role = ?').get(uid, String(idOrRole));
  return row || null;
}

/**
 * Lazily clone the global role templates into a user's private AI profile.
 * Any pre-auth global server key is handed to only the first user who opens
 * the profile, then marked assigned and never reused by later users.
 */
export function ensureUserAgents(userId) {
  const d = getDb();
  const uid = requireUserId(userId);
  const templates = d.prepare("SELECT * FROM ai_agents WHERE role <> 'progress-coach' ORDER BY id").all();
  const claimable = d.prepare("SELECT 1 FROM legacy_ai_secrets WHERE COALESCE(assigned_user_id, '') = '' LIMIT 1").get();
  const insert = d.prepare(`
    INSERT OR IGNORE INTO user_ai_agents
      (user_id, agent_id, name, role, description, system_prompt, skill, base_url,
       api_key_encrypted, model, temperature, max_tokens, enabled, stream_enabled,
       vision_enabled, timeout_ms, provider_mode, key_storage_mode, reasoning_effort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const legacyRows = claimable
    ? d.prepare("SELECT agent_id, api_key_encrypted FROM legacy_ai_secrets WHERE COALESCE(assigned_user_id, '') = ''").all()
    : [];
  const legacyMap = new Map(legacyRows.map((r) => [Number(r.agent_id), String(r.api_key_encrypted || '')]));
  for (const a of templates) {
    insert.run(
      uid, a.id, a.name, a.role, a.description, a.system_prompt, a.skill, a.base_url,
      legacyMap.get(Number(a.id)) || '', a.model, a.temperature, a.max_tokens, a.enabled,
      a.stream_enabled, a.vision_enabled, a.timeout_ms, a.provider_mode,
      // Authenticated web profiles default to encrypted per-user persistence.
      // Existing rows are left untouched so a user's explicit browser-only choice remains respected.
      'server',
      a.reasoning_effort || 'low',
    );
  }
  if (legacyRows.length) {
    d.prepare("UPDATE legacy_ai_secrets SET assigned_user_id = ?, migrated_at = datetime('now','localtime') WHERE COALESCE(assigned_user_id, '') = ''")
      .run(uid);
  }
  return uid;
}

function toUserAgent(row, { includeKey = true } = {}) {
  if (!row) return null;
  const key = includeKey && normalizeKeyStorageMode(row.key_storage_mode) === 'server'
    ? decryptKey(row.api_key_encrypted)
    : '';
  const agent = { ...row, id: Number(row.agent_id), api_key: key };
  delete agent.agent_id;
  delete agent.api_key_encrypted;
  return agent;
}

function sanitizeUserAgent(agent) {
  const row = { ...agent };
  const key = String(row.api_key || '');
  row.key_storage_mode = normalizeKeyStorageMode(row.key_storage_mode, key ? 'server' : 'browser');
  if (row.key_storage_mode === 'server' && key) {
    row.api_key_masked = key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '****';
  } else {
    row.api_key_masked = '';
  }
  row.api_key = '';
  try { row.skill_loaded = resolveSkill(row.skill, row.user_id).loaded; } catch { row.skill_loaded = null; }
  delete row.user_id;
  return row;
}

/** Read one fully materialized private agent. Only server-side callers receive api_key. */
export function getUserAgent(userId, idOrRole) {
  ensureUserAgents(userId);
  return toUserAgent(userAgentRow(userId, idOrRole));
}

/** List a user's agents without ever returning a raw API key. */
export function listUserAgents(userId) {
  ensureUserAgents(userId);
  const d = getDb();
  return d.prepare('SELECT * FROM user_ai_agents WHERE user_id = ? ORDER BY agent_id')
    .all(requireUserId(userId))
    .map((row) => sanitizeUserAgent(toUserAgent(row)));
}

/** Update a user's complete role profile; the encrypted key is never returned. */
export function updateUserAgent(userId, id, fields = {}) {
  const d = getDb();
  const uid = ensureUserAgents(userId);
  const curRow = userAgentRow(uid, Number(id));
  if (!curRow) return { error: 'AI 不存在' };
  const cur = toUserAgent(curRow);
  const sets = [];
  const vals = [];
  for (const key of USER_AGENT_FIELDS) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(key === 'enabled' || key === 'stream_enabled' || key === 'vision_enabled'
        ? (fields[key] ? 1 : 0)
        : fields[key]);
    }
  }

  let mode = normalizeKeyStorageMode(cur.key_storage_mode, cur.api_key ? 'server' : 'browser');
  if (fields.key_storage_mode !== undefined) mode = normalizeKeyStorageMode(fields.key_storage_mode);
  else if (String(fields.api_key || '').trim()) mode = 'server';
  if (fields.key_storage_mode !== undefined || mode !== normalizeKeyStorageMode(cur.key_storage_mode, cur.api_key ? 'server' : 'browser')) {
    sets.push('key_storage_mode = ?');
    vals.push(mode);
  }

  if (mode === 'browser') {
    sets.push('api_key_encrypted = ?');
    vals.push('');
  } else if (String(fields.api_key || '').trim() && fields.api_key !== 'sk-****') {
    sets.push('api_key_encrypted = ?');
    vals.push(encryptKey(String(fields.api_key).trim()));
  }
  if (!sets.length) return { error: '没有可更新的字段' };
  sets.push("updated_at = datetime('now','localtime')");
  vals.push(uid, Number(id));
  d.prepare(`UPDATE user_ai_agents SET ${sets.join(', ')} WHERE user_id = ? AND agent_id = ?`).run(...vals);

  const promptChanged = (fields.system_prompt !== undefined && fields.system_prompt !== cur.system_prompt)
    || (fields.skill !== undefined && fields.skill !== cur.skill);
  if (promptChanged) {
    d.prepare('INSERT INTO prompt_history (user_id, agent_id, system_prompt, skill, note) VALUES (?, ?, ?, ?, ?)')
      .run(uid, Number(id), cur.system_prompt, cur.skill, fields.note || '自动保存旧版');
  }
  return { ok: true, agent: sanitizeUserAgent(toUserAgent(userAgentRow(uid, Number(id)))), promptChanged };
}

/** 列出全部（api_key 脱敏；附 skill_loaded 供前端显示自动注入状态） */
export function listAgents(maskKey = true) {
  const rows = getDb().prepare('SELECT * FROM ai_agents ORDER BY id').all();
  return rows
    // 历史遗留的「学习进度顾问」（progress-coach）已下线，隐藏不出现在设置页（2026-08-17）
    .filter((r) => r.role !== 'progress-coach')
    .map((r) => {
      r.key_storage_mode = normalizeKeyStorageMode(r.key_storage_mode, String(r.api_key || '').trim() ? 'server' : 'browser');
      if (maskKey && r.key_storage_mode === 'server' && r.api_key) {
        const k = String(r.api_key);
        r.api_key_masked = k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '****';
        r.api_key = '';
      } else {
        // 浏览器模式绝不从服务端响应任何 Key 内容，即使旧库异常残留。
        r.api_key = '';
        r.api_key_masked = '';
      }
      try { r.skill_loaded = resolveSkill(r.skill).loaded; } catch { r.skill_loaded = null; }
      return r;
    });
}

/** 更新配置（只更新传入的字段；prompt/skill 变化时自动存历史） */
export function updateAgent(id, fields) {
  const d = getDb();
  const cur = d.prepare('SELECT * FROM ai_agents WHERE id = ?').get(id);
  if (!cur) return { error: 'AI 不存在' };

  const allowed = ['name', 'description', 'system_prompt', 'skill', 'base_url', 'model', 'temperature', 'max_tokens', 'enabled', 'reasoning_effort', 'stream_enabled', 'vision_enabled', 'timeout_ms', 'provider_mode'];
  const sets = [];
  const vals = [];
  // 兼容旧 API：显式发送 api_key 但没有 storage mode，视为用户主动选择服务端保存。
  // 新版设置页始终显式发送 key_storage_mode，默认不会走这条兼容分支。
  let mode = normalizeKeyStorageMode(cur.key_storage_mode, String(cur.api_key || '').trim() ? 'server' : 'browser');
  if (fields.key_storage_mode !== undefined) mode = normalizeKeyStorageMode(fields.key_storage_mode);
  else if (String(fields.api_key || '').trim()) mode = 'server';
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(k === 'enabled' ? (fields[k] ? 1 : 0) : fields[k]);
    }
  }
  if (fields.key_storage_mode !== undefined || mode !== normalizeKeyStorageMode(cur.key_storage_mode, String(cur.api_key || '').trim() ? 'server' : 'browser')) {
    sets.push('key_storage_mode = ?');
    vals.push(mode);
  }
  if (mode === 'browser') {
    // 切到浏览器模式时立即擦除服务端旧 Key；传入的 api_key 永远不落库。
    sets.push('api_key = ?');
    vals.push('');
  } else if (String(fields.api_key || '').trim()) {
    sets.push('api_key = ?');
    vals.push(String(fields.api_key).trim());
  }
  if (!sets.length) return { error: '没有可更新的字段' };
  sets.push("updated_at = datetime('now','localtime')");
  vals.push(id);
  d.prepare(`UPDATE ai_agents SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  // 版本历史：prompt 或 skill 变化时存旧版
  const newPrompt = fields.system_prompt !== undefined ? fields.system_prompt : cur.system_prompt;
  const newSkill = fields.skill !== undefined ? fields.skill : cur.skill;
  const promptChanged = newPrompt !== cur.system_prompt || newSkill !== cur.skill;
  if (promptChanged) {
    d.prepare('INSERT INTO prompt_history (agent_id, system_prompt, skill, note) VALUES (?, ?, ?, ?)')
      .run(id, cur.system_prompt, cur.skill, fields.note || '自动保存旧版');
  }
  return { ok: true, agent: getAgent(id), promptChanged };
}

/** 版本历史 */
export function getHistory(id, limit = 20, userId = '') {
  const uid = String(userId || '').trim();
  return uid
    ? getDb().prepare('SELECT * FROM prompt_history WHERE user_id = ? AND agent_id = ? ORDER BY id DESC LIMIT ?').all(uid, id, limit)
    : getDb().prepare('SELECT * FROM prompt_history WHERE user_id = \'\' AND agent_id = ? ORDER BY id DESC LIMIT ?').all(id, limit);
}

// ---------- 用户技能库（AI 设置页「技能库」导入，双端同构：App 端 IndexedDB） ----------

const SKILL_MAX_TEXT = 2 * 1024 * 1024;

/** 技能列表（不含 text 全文；附 inUse：被哪些智能体引用） */
export function listUserSkills() {
  return listUserSkillsForUser('');
}

function listUserSkillsForUser(userId = '') {
  const d = getDb();
  const uid = String(userId || '').trim();
  const rows = uid
    ? d.prepare("SELECT id, user_id, name, description, files, created_at FROM user_skills WHERE user_id IN (?, '') ORDER BY id").all(uid)
    : d.prepare("SELECT id, user_id, name, description, files, created_at FROM user_skills WHERE user_id = '' ORDER BY id").all();
  return rows
    .map((r) => {
      let files = [];
      try { files = JSON.parse(r.files || '[]'); } catch {}
      const inUse = uid
        ? d.prepare("SELECT name, role FROM user_ai_agents WHERE user_id = ? AND skill = ?").all(uid, r.name).map((a) => a.name)
        : d.prepare("SELECT name, role FROM ai_agents WHERE skill = ?").all(r.name).map((a) => a.name);
      const out = { ...r, files, inUse };
      delete out.user_id;
      return out;
    });
}

/** 列出某个账号可见的技能：账号私有技能优先，同时允许使用内置/旧版技能。 */
export function listUserSkillsFor(userId) {
  return listUserSkillsForUser(String(userId || '').trim());
}

/** 新增/覆盖技能；同名 = 覆盖。返回 { ok, name, replaced, referenced } */
export function addUserSkill({ userId = '', name, description = '', text, files = [] }) {
  const d = getDb();
  const uid = String(userId || '').trim();
  const n = String(name || '').trim();
  if (!n) return { error: '技能名不能为空' };
  if (n.length > 100) return { error: '技能名过长（≤100 字符）' };
  const t = String(text || '').trim();
  if (!t) return { error: '技能内容不能为空' };
  if (t.length > SKILL_MAX_TEXT) return { error: '技能内容过大（>2MB），请精简后重试' };
  const filesJson = JSON.stringify(Array.isArray(files) ? files : []);
  const exists = d.prepare('SELECT id FROM user_skills WHERE user_id = ? AND name = ?').get(uid, n);
  if (exists) {
    d.prepare("UPDATE user_skills SET description = ?, text = ?, files = ?, created_at = datetime('now','localtime') WHERE user_id = ? AND name = ?")
      .run(String(description || ''), t, filesJson, uid, n);
  } else {
    d.prepare('INSERT INTO user_skills (user_id, name, description, text, files) VALUES (?, ?, ?, ?, ?)')
      .run(uid, n, String(description || ''), t, filesJson);
  }
  const referenced = uid
    ? !!d.prepare('SELECT id FROM user_ai_agents WHERE user_id = ? AND skill = ?').get(uid, n)
    : !!d.prepare('SELECT id FROM ai_agents WHERE skill = ?').get(n);
  return { ok: true, name: n, replaced: !!exists, referenced };
}

/** 删除技能（被引用智能体的 skill 字段保留原值，解析回落纯文本） */
export function deleteUserSkill(name, userId = '') {
  const n = String(name || '').trim();
  if (!n) return { error: '缺少技能名' };
  const uid = String(userId || '').trim();
  const res = getDb().prepare('DELETE FROM user_skills WHERE user_id = ? AND name = ?').run(uid, n);
  return { ok: res.changes > 0 };
}

const DEFAULT_AI_TIMEOUT_MS = 120000;
const MIN_AI_TIMEOUT_MS = 1000;
const MAX_AI_TIMEOUT_MS = 600000;

function agentTimeoutMs(agent, override) {
  const n = Number(override ?? agent?.timeout_ms ?? DEFAULT_AI_TIMEOUT_MS);
  if (!Number.isFinite(n)) return DEFAULT_AI_TIMEOUT_MS;
  return Math.min(MAX_AI_TIMEOUT_MS, Math.max(MIN_AI_TIMEOUT_MS, Math.round(n)));
}

function chatUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function containsImageContent(messages) {
  return messages.some((m) => Array.isArray(m.content)
    && m.content.some((part) => part && (part.type === 'image_url' || part.type === 'input_image')));
}

export function buildAgentMessages(agent, inputMessages, userContent) {
  const messages = [{ role: 'system', content: String(agent.system_prompt || '') }];
  // skill 字段：支持本地 skill 名称自动注入（SKILL.md + references）或普通附加说明；
  // 与 system_prompt 内容相同时只发一遍，避免重复浪费 token。
  const skillRes = resolveSkill(agent.skill, agent.user_id);
  if (skillRes.text && skillRes.text.trim() !== String(agent.system_prompt || '').trim()) {
    messages.push({ role: 'system', content: skillRes.loaded ? skillRes.text : `附加能力：${skillRes.text}` });
  }
  const supplied = Array.isArray(inputMessages) && inputMessages.length
    ? inputMessages
    : [{ role: 'user', content: userContent }];
  for (const message of supplied) {
    const role = String(message?.role || '').toLowerCase();
    if (!['user', 'assistant'].includes(role)) continue;
    if (message.content == null || message.content === '') continue;
    messages.push({ role, content: message.content });
  }
  return messages;
}

function requestScope(outerSignal, timeoutMs) {
  const controller = new AbortController();
  const state = { timedOut: false, externallyAborted: false };
  const onOuterAbort = () => {
    state.externallyAborted = true;
    controller.abort(outerSignal.reason);
  };
  if (outerSignal) {
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort(new Error('AI request timeout'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    state,
    cleanup() {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    },
  };
}

function mockContent(messages, agent) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const text = typeof last?.content === 'string'
    ? last.content.replace(/\s+/g, ' ').trim().slice(0, 80)
    : '当前消息';
  return `【本地 Mock】已收到${agent.name || agent.role || 'AI'}的请求：${text || '当前消息'}`;
}

function invalidResponseMessage(response, text) {
  const status = response?.status || 200;
  const contentType = String(response?.headers?.get?.('content-type') || '未知').split(';')[0];
  if (/^<!doctype\s+html|^<html[\s>]/i.test(String(text || '').trim())) {
    return `API 返回异常：状态 ${status}，网关返回了 HTML 页面（Content-Type: ${contentType}）。请检查 Base URL，通常应填写到 /v1 或供应商的 API 根路径。`;
  }
  return `API 返回异常：状态 ${status}，网关没有返回 OpenAI-compatible JSON（Content-Type: ${contentType}）。请检查 Base URL、路径和网关协议。`;
}

function parseSseText(text, onDelta) {
  let content = '';
  let usage = null;
  let done = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') { done = true; break; }
    let data;
    try { data = JSON.parse(payload); } catch { continue; }
    const delta = data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.message?.content ?? '';
    if (delta) { content += delta; onDelta?.(delta); }
    if (data?.usage) usage = data.usage;
  }
  return { content, usage, done };
}

async function readSseResponse(response, onDelta) {
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  // 一些兼容网关在 stream=true 时仍返回完整 JSON；兼容这种实现并按一次 delta 发出。
  if (!contentType.includes('text/event-stream') || !response.body?.getReader) {
    const text = await response.text();
    const trimmed = text.trim();
    if (contentType.includes('text/event-stream') || /^data:\s*/m.test(trimmed)) {
      return parseSseText(text, onDelta);
    }
    let data;
    try { data = JSON.parse(trimmed); } catch { return { error: invalidResponseMessage(response, text) }; }
    const content = data?.choices?.[0]?.message?.content || '';
    if (content) onDelta?.(content);
    return { data, content, usage: data?.usage || null };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage = null;
  const consumeLine = (line) => {
    if (!line.startsWith('data:')) return false;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return payload === '[DONE]';
    let data;
    try { data = JSON.parse(payload); } catch { return false; }
    const delta = data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.message?.content ?? '';
    if (delta) { content += delta; onDelta?.(delta); }
    if (data?.usage) usage = data.usage;
    return false;
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) if (consumeLine(line)) return { content, usage };
    if (done) break;
  }
  if (buffer) consumeLine(buffer);
  return { content, usage };
}

/**
 * 调用 LLM（OpenAI-compatible /chat/completions）。
 * options.messages 可传 user/assistant 多轮消息；options.stream/onDelta 用于 SSE；
 * options.signal 由 HTTP 层传入，客户端断开时会取消上游请求；options.mock 只用于本地测试。
 */
export async function callAgentMessages(agent, inputMessages, options = {}) {
  const mock = options.mock === true || String(agent.provider_mode || '').toLowerCase() === 'mock' || process.env.AI_MOCK === '1';
  if (!mock && normalizeKeyStorageMode(agent.key_storage_mode, String(agent.api_key || '').trim() ? 'server' : 'browser') === 'browser') {
    return { error: '当前 AI 配置为“仅浏览器保存”，请由浏览器直连模型服务', browserOnly: true };
  }
  if (!mock && !agent.api_key) return { error: '该 AI 未配置 api_key，请到 AI 设置页填写' };
  const url = chatUrl(agent.base_url);
  if (!mock && !url) return { error: '未配置 base_url' };
  const messages = buildAgentMessages(agent, inputMessages, options.userContent);
  if (containsImageContent(messages) && Number(agent.vision_enabled) === 0) {
    return { error: '当前 AI 未启用视觉输入，请在 AI 设置中打开“支持视觉输入”' };
  }
  const stream = options.stream === true;
  if (stream && Number(agent.stream_enabled) === 0) {
    return { error: '当前 AI 未启用流式输出，请在 AI 设置中打开“启用流式回答”' };
  }
  const body = {
    model: agent.model,
    messages,
    temperature: agent.temperature ?? 0.5,
    max_tokens: agent.max_tokens ?? 1500,
    stream,
  };
  if (agent.reasoning_effort !== 'off') body.reasoning_effort = agent.reasoning_effort || 'low';
  if (mock) {
    const content = mockContent(messages, agent);
    if (stream && options.onDelta) {
      for (const part of content.match(/.{1,12}/gs) || [content]) options.onDelta(part);
    }
    return { content, model: agent.model || 'mock', mock: true, usage: null };
  }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${agent.api_key}` };
  const scope = requestScope(options.signal, agentTimeoutMs(agent, options.timeoutMs));
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: scope.signal });
    if (!response.ok && body.reasoning_effort) {
      const text = await response.text().catch(() => '');
      if (response.status === 400 || response.status === 422 || /reasoning_effort|Unknown parameter|Unsupported parameter/i.test(text)) {
        delete body.reasoning_effort;
        response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: scope.signal });
      } else {
        return { error: `API 错误 ${response.status}：${text.slice(0, 300)}` };
      }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { error: `API 错误 ${response.status}：${text.slice(0, 300)}` };
    }
    if (stream) {
      const result = await readSseResponse(response, options.onDelta);
      if (result.error) return { error: result.error };
      if (!result.content) return { error: 'API 返回异常（流式响应无内容）' };
      return { ...result, model: agent.model || '', mock: false };
    }
    const parsed = await readSseResponse(response);
    if (parsed.error) return { error: parsed.error };
    if (!parsed.data && parsed.content) return { content: parsed.content, model: agent.model || '', mock: false, usage: parsed.usage || null };
    const data = parsed.data || {};
    const msg = data?.choices?.[0]?.message;
    const content = msg?.content;
    if (!content) {
      const reason = data?.choices?.[0]?.finish_reason;
      if (reason === 'length' && msg?.reasoning_content) {
        return { error: '回答超长被截断：该模型会先“思考”再回答，思维链吃光了 max_tokens。请在 AI 设置里把“最大输出长度”调大到 4000 以上（当前 ' + (agent.max_tokens ?? 1500) + '）' };
      }
      return { error: 'API 返回异常（无内容，finish_reason=' + reason + ')' };
    }
    return { content, model: agent.model || '', mock: false, usage: data?.usage || null };
  } catch (e) {
    if (scope.state.timedOut) return { error: `AI 请求超时（${agentTimeoutMs(agent, options.timeoutMs)}ms），请检查网关或调大超时`, timedOut: true };
    if (scope.state.externallyAborted || options.signal?.aborted) return { error: 'AI 请求已取消', cancelled: true };
    return { error: `网络请求失败：${e.message}` };
  } finally {
    scope.cleanup();
  }
}

/** 兼容原有单轮调用方。 */
export async function callAgent(agent, userContent, options = {}) {
  return callAgentMessages(agent, [{ role: 'user', content: userContent }], options);
}
