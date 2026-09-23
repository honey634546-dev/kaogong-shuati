import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndexUrl,
  buildPaperUrl,
  extractQuestionText,
  htmlToText,
  isBlockedPage,
  paperIdFromUrl,
  parseAnswerPage,
  parseGkzhentiPaper,
  parseIndexPayload,
  subjectForClass,
  titleFromHtml,
} from './public/lib/gkzhenti-adapter.js';
import { safeFilePart, selectEntries } from './scripts/import-gkzhenti.mjs';
import { XINGCE_REGIONS } from './scripts/import-gkzhenti-recent-regions.mjs';
import { blankRepairsFromHtml, repairDatabase } from './scripts/repair-gkzhenti-blanks.mjs';
import { customQuestionFingerprint } from './public/lib/custom-bank.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('公开真题库：索引 URL、试卷 ID 和科目映射稳定', () => {
  assert.equal(
    buildIndexUrl({ cls: '行测', province: '浙江' }),
    'https://gwy.gkzhenti.cn/api/json?cls=%E8%A1%8C%E6%B5%8B&province=%E6%B5%99%E6%B1%9F',
  );
  assert.equal(paperIdFromUrl('https://gwy.gkzhenti.cn/paper/1775360736959'), '1775360736959');
  assert.equal(buildPaperUrl('123', { kind: 'answer' }), 'https://gwy.gkzhenti.cn/answer/123');
  assert.equal(subjectForClass('事业单位-综合应用'), '事业编·综应');
  assert.equal(subjectForClass('行测'), '行测');
});

test('公开真题库：索引 JSON 只保留可识别的试卷行', () => {
  const entries = parseIndexPayload([
    { No: 'https://gwy.gkzhenti.cn/paper/123', Title: '2026 浙江行测', Source: 'fenbi' },
    { No: '', Title: '缺少链接' },
    { id: '456', title: '兼容简化字段', source: '网友上传' },
  ]);
  assert.deepEqual(entries, [
    { paperId: '123', paperUrl: 'https://gwy.gkzhenti.cn/paper/123', title: '2026 浙江行测', source: 'fenbi' },
    { paperId: '456', paperUrl: '', title: '兼容简化字段', source: '网友上传' },
  ]);
});

test('公开真题库：HTML 转文本保留换行并解码实体，不接受黑名单页', () => {
  const html = '<nav>首页</nav><main><h1>2026&nbsp;测试卷</h1><div>1、题干 &amp; 说明<br>A. 甲</div></main>';
  const text = htmlToText(html);
  assert.match(text, /2026 测试卷/);
  assert.match(text, /1、题干 & 说明/);
  assert.match(extractQuestionText(html), /^1、\s*题干/);
  assert.equal(titleFromHtml('<title>测试卷&nbsp;- 公开真题库</title>'), '测试卷 - 公开真题库');
  assert.equal(isBlockedPage('因监测到恶意爬虫行为被列入临时黑名单'), true);
  assert.equal(isBlockedPage('<html><body>1、正常题目</body></html>'), false);
});

test('公开真题库：空白下划线在去除 HTML 前转成填空线', () => {
  for (const content of ['', '   ', '\u00a0\u00a0', '\u3000\u3000', '&nbsp;&#160;&#xA0;', '&amp;nbsp;', '<span> &nbsp; </span>', '<u>\u00a0\u00a0</u>']) {
    assert.equal(htmlToText(`甲<u>${content}</u>乙`), '甲____乙', content);
  }
  assert.equal(htmlToText('第一空<u> </u>，第二空<u>&nbsp;</u>。'), '第一空____，第二空____。');
  assert.equal(htmlToText('普通 空格，<u>画线文字</u>，<u>____</u>。'), '普通 空格，画线文字，____。');
  assert.equal(htmlToText('<u><img src="formula.png"></u>'), '');
});

test('公开真题库：河南 2026 宋史题的材料填空线保留到富文本渲染', async () => {
  const paperHtml = `<div class="row"><div class="col-xs-1 left">1</div><div class="col-xs-11 right">
    <p>“比上有余，比下不足”这八个字大致概括了宋史史料的数量特征。由于“比上有余”，治宋史者无“巧妇无米”、“<u>\u00a0\u00a0\u00a0\u00a0</u>”之感；因为“比下不足”，治宋史者无“老虎吃天，无处下手”之叹。</p>
    <p>填入画横线部分最恰当的一项是：</p>
    <div class="col-xs-3">A、黔驴技穷</div><div class="col-xs-3">B、山穷水尽</div>
    <div class="col-xs-3">C、顾此失彼</div><div class="col-xs-3">D、青黄不接</div>
  </div></div>`;
  const parsed = parseGkzhentiPaper({ paperHtml, answerHtml: '<div>1、B</div>', paperId: '1775360735848', cls: '行测', province: '河南' });
  const question = parsed.questions[0];
  assert.equal(question.prompt, '填入画横线部分最恰当的一项是：');
  assert.match(question.material, /“巧妇无米”、“____”之感/);
  assert.equal(question.external_id, 'gkzhenti:1775360735848:1');
  assert.equal(question.answer_index, 1);
  await import('./public/rich-text.js');
  const html = globalThis.renderRichText(question.material);
  assert.equal((html.match(/class="rt-blank"/g) || []).length, 1);
});

test('公开真题库：题干、选项、共享材料和文本回退路径均保留填空线', () => {
  const paperHtml = `<div class="row"><div class="sub2title">（一）</div><p>材料<u> </u>。</p></div>
    <div class="row"><div class="left">1</div><div class="right"><p>题干<u> </u>？</p>
    <div class="col-xs-6">A、选项<u> </u></div><div class="col-xs-6">B、乙</div></div></div>`;
  const question = parseGkzhentiPaper({ paperHtml, paperId: 'blank-fields' }).questions[0];
  assert.equal(question.prompt, '题干____？');
  assert.equal(question.material, '材料____。');
  assert.equal(question.options[0], 'A. 选项____');
  const fallback = parseGkzhentiPaper({ paperHtml: '<div>1、回退<u>&nbsp;</u>？</div><div>A. 甲</div><div>B. 乙</div>', paperId: 'blank-fallback' });
  assert.equal(fallback.questions[0].prompt, '回退____？');
});

test('公开真题库：旧数据修复可预览、备份、幂等，并保留题目身份和学习记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gkzhenti-blank-repair-'));
  const dbPath = join(dir, 'practice.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE custom_questions (
      id INTEGER PRIMARY KEY, user_id TEXT, batch_id INTEGER, external_id TEXT,
      question_uid TEXT, revision INTEGER, is_current INTEGER, prompt TEXT, material TEXT,
      options TEXT, answer TEXT, answer_index INTEGER, analysis TEXT, category TEXT,
      images TEXT, fingerprint TEXT
    );
    CREATE TABLE practice_records (question_id INTEGER, question_snapshot TEXT);
    CREATE TABLE notes (question_id INTEGER, content TEXT);`);
    const html = '<div>1、第一空<u>&nbsp;</u>，第二空<u>&nbsp;</u>？</div><div>A. 甲</div><div>B. 乙</div>';
    const repairs = blankRepairsFromHtml(html, 'repair-test');
    const change = repairs.get('gkzhenti:repair-test:1').prompt;
    const insert = db.prepare('INSERT INTO custom_questions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [id, prompt, current] of [[1, change.before, 1], [2, '用户自行修改的题干', 1], [3, change.after, 1], [4, change.before, 0]]) {
      insert.run(id, 'owner-a', 9, 'gkzhenti:repair-test:1', `stable-${id}`, 2, current,
        prompt, '', '["A. 甲","B. 乙"]', 'B', 1, '人工补充的解析', '自定义分类', '[]', `old-${id}`);
    }
    db.prepare('INSERT INTO practice_records VALUES (?, ?)').run(1, JSON.stringify({ prompt: change.before }));
    db.prepare('INSERT INTO notes VALUES (?, ?)').run(1, '保留学习笔记');
    const all = () => db.prepare('SELECT * FROM custom_questions ORDER BY id').all().map((row) => ({ ...row }));
    const before = all();
    const records = db.prepare('SELECT * FROM practice_records').all();
    const notes = db.prepare('SELECT * FROM notes').all();

    const preview = await repairDatabase(dbPath, repairs);
    assert.equal(preview.mode, 'preview');
    assert.equal(preview.affectedQuestions, 1);
    assert.equal(preview.alreadyFixed, 1);
    assert.deepEqual(preview.skipped.map((row) => row.id), [2]);
    assert.deepEqual(all(), before, '预览不能改数据');

    const applied = await repairDatabase(dbPath, repairs, { apply: true });
    assert.equal(applied.affectedQuestions, 1);
    const backup = JSON.parse(await readFile(applied.backupPath, 'utf8'));
    assert.deepEqual(backup.changes[0].before, before[0]);
    const after = all();
    assert.equal(after[0].prompt, change.after);
    const fingerprint = customQuestionFingerprint({ ...after[0], options: JSON.parse(after[0].options), images: [] });
    assert.equal(after[0].fingerprint, fingerprint);
    assert.deepEqual({ ...after[0], prompt: before[0].prompt, fingerprint: before[0].fingerprint }, before[0]);
    assert.deepEqual(after.slice(1), before.slice(1), '跳过人工修改、已修复以及历史版本');
    assert.deepEqual(db.prepare('SELECT * FROM practice_records').all(), records);
    assert.deepEqual(db.prepare('SELECT * FROM notes').all(), notes);

    const repeated = await repairDatabase(dbPath, repairs, { apply: true });
    assert.equal(repeated.affectedQuestions, 0);
    assert.equal(repeated.backupPath, '');
    assert.equal(repeated.alreadyFixed, 2);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('公开真题库：独立答案页按题号回填题目', () => {
  const paperHtml = `
    <html><head><title>2026 测试行测</title></head><body>
      <nav>首页 搜题 用户中心</nav>
      <main>
        <h1>2026 测试行测</h1>
        <div>1、全班有40名学生，其中25%参加英语小组，参加人数是？</div>
        <div>A. 5名</div><div>B. 10名</div><div>C. 15名</div><div>D. 20名</div>
        <div>2、下列说法正确的是？</div>
        <div>A. 甲</div><div>B. 乙</div><div>C. 丙</div><div>D. 丁</div>
      </main>
      <footer>公开真题库 浙ICP备2026012934号-1</footer>
    </body></html>`;
  const answerHtml = '<div>2026 测试行测（答案）</div><div>1、B</div><div>2. C</div>';
  const parsed = parseGkzhentiPaper({
    paperHtml,
    answerHtml,
    paperId: '123',
    title: '2026 测试行测',
    cls: '行测',
    province: '浙江',
    source: 'fenbi',
  });
  assert.equal(parsed.questions.length, 2);
  assert.equal(parsed.answerCount, 2);
  assert.equal(parsed.questions[0].prompt, '全班有40名学生，其中25%参加英语小组，参加人数是？');
  assert.equal(parsed.questions[0].answer, 'B');
  assert.equal(parsed.questions[0].answer_index, 1);
  assert.equal(parsed.questions[1].answer_index, 2);
  assert.equal(parsed.questions[1].analysis, '');
  assert.equal(parsed.questions[0].answer_status, 'unconfirmed');
  assert.equal(parsed.questions[0].external_id, 'gkzhenti:123:1');
  assert.equal(parsed.questions[1].question_uid, 'gkzhenti:123:2');
});

test('公开真题库：整卷页 left/right 布局还原全部题号', () => {
  const paperHtml = `
    <div id="printcontent">
      <div class="row"><div class="col-xs-1 left">1</div><div class="col-xs-11 right"><p>第一道题？</p><div class="col-xs-3">A、甲</div><div class="col-xs-3">B、乙</div></div></div>
      <div class="row"><div class="col-xs-1 left">2</div><div class="col-xs-11 right"><p>第二道题？</p><div class="col-xs-3">A、丙</div><div class="col-xs-3">B、丁</div></div></div>
    </div>`;
  const parsed = parseGkzhentiPaper({ paperHtml, answerHtml: '<div>1、A</div><div>2、B</div>', paperId: 'layout-1', cls: '行测' });
  assert.equal(parsed.questions.length, 2);
  assert.equal(parsed.questions[0].prompt, '第一道题？');
  assert.equal(parsed.questions[1].prompt, '第二道题？');
  assert.equal(parsed.questions[0].answer_index, 0);
  assert.equal(parsed.questions[1].answer_index, 1);
});

test('公开真题库：材料里的 A、B/C、D 不会被误认成选项', () => {
  const paperHtml = `
    <div class="row"><div class="col-xs-1 left">87</div><div class="col-xs-11 right">
      <p>某商店现有歌手甲的专辑A、B各一张，歌手乙的专辑C、D各一张。已知：（1）A和C不相邻。</p>
      <p>如果C在2号货架，那么以下哪项可能为真？</p>
      <div class="col-xs-3">A、B在1号货架</div><div class="col-xs-3">B、B在5号货架</div>
      <div class="col-xs-3">C、D在5号货架</div><div class="col-xs-3">D、D在6号货架</div>
    </div></div>`;
  const parsed = parseGkzhentiPaper({ paperHtml, answerHtml: '<div>87、A</div>', paperId: 'material-options', cls: '行测' });
  const question = parsed.questions[0];
  assert.equal(question.prompt, '如果C在2号货架，那么以下哪项可能为真？');
  assert.match(question.material, /专辑A、B各一张/);
  assert.equal(question.options.length, 4);
  assert.deepEqual(question.options.map((option) => option[0]), ['A', 'B', 'C', 'D']);
  assert.equal(question.answer_index, 0);
});

test('公开真题库：图片选项保留选项字母和判分索引', () => {
  const paperHtml = `
    <div class="row"><div class="col-xs-1 left">52</div><div class="col-xs-11 right">
      <p>选择正确的图形选项。</p>
      <div class="col-xs-6">A、9</div><div class="col-xs-6">B、16</div>
      <div class="col-xs-6">C、<img src="choice-c.png"></div><div class="col-xs-6">D、<img src="choice-d.png"></div>
    </div></div>`;
  const parsed = parseGkzhentiPaper({ paperHtml, answerHtml: '<div>52、D</div>', paperId: 'image-options', cls: '行测' });
  const question = parsed.questions[0];
  assert.equal(question.options.length, 4);
  assert.equal(question.options[2], 'C. （原卷图形选项，图片未随导入提供）');
  assert.equal(question.options[3], 'D. （原卷图形选项，图片未随导入提供）');
  assert.equal(question.answer_index, 3);
  assert.equal(question.image_missing, true);
});

test('公开真题库：独立资料块归到后续题目，图片缺失有明确提示且不伪装成解析', () => {
  const paperHtml = `
    <div class="row"><div class="col-xs-12 subtitle">一、资料分析。按资料作答。</div></div>
    <div class="row"><div class="col-xs-12 sub2title">（一）</div><div class="col-xs-12">统计材料描述<img src="/chart.png"></div></div>
    <div class="row"><div class="col-xs-1 left">1</div><div class="col-xs-11 right"><p>根据资料，结果是？</p><div>A、甲</div><div>B、乙</div></div></div>`;
  const parsed = parseGkzhentiPaper({ paperHtml, answerHtml: '<div>1、B</div>', paperId: 'material-1', cls: '行测', province: '浙江' });
  assert.equal(parsed.questions.length, 1);
  assert.match(parsed.questions[0].material, /统计材料描述/);
  assert.match(parsed.questions[0].material, /共享材料含图片/);
  assert.match(parsed.questions[0].prompt, /结果是/);
  assert.doesNotMatch(parsed.questions[0].prompt, /图片.*未包含/);
  assert.equal(parsed.questions[0].analysis, '');
  assert.equal(parsed.questions[0].category, '行测/浙江/资料分析');
  assert.equal(parsed.imageMissingCount, 1);
});

test('公开真题库：答案缺失时保留题目但标记 missing', () => {
  const parsed = parseGkzhentiPaper({
    paperHtml: '<main><div>1、这道题没有答案页？</div><div>A. 是</div><div>B. 否</div></main>',
    answerHtml: '',
    paperId: '999',
    cls: '行测',
  });
  assert.equal(parsed.questions.length, 1);
  assert.equal(parsed.questions[0].answer, '');
  assert.equal(parsed.questions[0].answer_index, -1);
  assert.equal(parsed.questions[0].answer_status, 'missing');
});

test('公开真题库：筛选默认只取一份，--all 才允许全量', () => {
  const entries = [
    { paperId: '1', title: '2026 浙江行测', source: 'fenbi' },
    { paperId: '2', title: '2025 浙江行测', source: '网友上传' },
  ];
  const original = process.argv;
  try {
    process.argv = ['node', 'import-gkzhenti.mjs', '--year-from=2025'];
    assert.equal(selectEntries(entries).length, 1);
    process.argv = ['node', 'import-gkzhenti.mjs', '--all', '--year-from=2025'];
    assert.equal(selectEntries(entries).length, 2);
    process.argv = ['node', 'import-gkzhenti.mjs', '--all', '--year-from=2025', '--require-year'];
    assert.equal(selectEntries([
      ...entries,
      { paperId: '3', title: '未标年份的行测试卷', source: '网友上传' },
    ]).length, 2);
  } finally {
    process.argv = original;
  }
});

test('公开真题库：近年行测地区扫描范围不重复且覆盖站点公布的 35 个入口', () => {
  assert.equal(XINGCE_REGIONS.length, 35);
  assert.equal(new Set(XINGCE_REGIONS).size, XINGCE_REGIONS.length);
  assert.ok(XINGCE_REGIONS.includes('国考'));
  assert.ok(XINGCE_REGIONS.includes('广州'));
});

test('公开真题库：缓存文件名保留中文地区名，地区索引不会碰撞', () => {
  assert.equal(safeFilePart('行测-浙江'), '行测-浙江');
  assert.equal(safeFilePart('行测/广州'), '行测-广州');
  assert.equal(safeFilePart(''), 'unknown');
});

test('公开真题库：答案页解析支持判断题答案', () => {
  const answers = parseAnswerPage('<div>1、正确</div><div>2、错误</div>');
  assert.equal(answers.get(1), '正确');
  assert.equal(answers.get(2), '错误');
});
