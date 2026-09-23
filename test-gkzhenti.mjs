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
