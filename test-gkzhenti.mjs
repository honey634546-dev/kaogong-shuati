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
import { selectEntries } from './scripts/import-gkzhenti.mjs';

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
  } finally {
    process.argv = original;
  }
});

test('公开真题库：答案页解析支持判断题答案', () => {
  const answers = parseAnswerPage('<div>1、正确</div><div>2、错误</div>');
  assert.equal(answers.get(1), '正确');
  assert.equal(answers.get(2), '错误');
});
