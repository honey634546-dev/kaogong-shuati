import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptPublicDataset,
  parseCsv,
  parseExcel,
  parseJsonLines,
  rowsToRecords,
} from './public/lib/custom-parser.js';

test('公开题库适配：CMMLU CSV 的 Question/A-D/Answer 列可确定性导入', () => {
  const rows = parseCsv([
    ',Question,A,B,C,D,Answer',
    '0,"某题，含逗号？",甲,乙,丙,丁,D',
  ].join('\n'));
  const excel = parseExcel(rows);
  assert.equal(excel.fixedCols, true);
  assert.equal(excel.questions.length, 1);
  assert.equal(excel.questions[0].prompt, '某题，含逗号？');
  assert.equal(excel.questions[0].answer_index, 3);
  assert.deepEqual(excel.questions[0].options, ['A. 甲', 'B. 乙', 'C. 丙', 'D. 丁']);

  const adapted = adaptPublicDataset(rowsToRecords(rows), { source: 'cmmlu', split: 'dev' });
  assert.equal(adapted[0].question_uid, 'public:cmmlu:dev:0');
  assert.equal(adapted[0].external_id, 'cmmlu:dev:0');
  assert.equal(adapted[0].answer_index, 3);
});

test('公开题库适配：LogiQA JSONL 的 0-based answer 转为选项字母', () => {
  const rows = parseJsonLines(JSON.stringify({
    example_id: 123,
    text: '材料内容',
    question: '问题？',
    options: ['甲', 'B. 乙', '丙', '丁'],
    answer: 1,
  }));
  const [question] = adaptPublicDataset(rows, { source: 'logiqa', split: 'train' });
  assert.equal(question.material, '材料内容');
  assert.deepEqual(question.options, ['A. 甲', 'B. 乙', 'C. 丙', 'D. 丁']);
  assert.equal(question.answer, 'B');
  assert.equal(question.answer_index, 1);
  assert.equal(question.question_uid, 'public:logiqa:train:123');
});

test('公开题库适配：C-Eval explanation 映射为解析并保留稳定身份', () => {
  const [question] = adaptPublicDataset([{
    id: 7,
    question: 'C-Eval 题目',
    A: '甲', B: '乙', C: '丙', D: '丁',
    answer: 'A',
    explanation: '官方解析',
  }], { source: 'ceval', split: 'dev' });
  assert.equal(question.answer_index, 0);
  assert.equal(question.analysis, '官方解析');
  assert.equal(question.external_id, 'ceval:dev:7');
  assert.equal(question.failed, false);
});

test('公开题库适配：不完整 LogiQA 记录保留但禁止误判', () => {
  const [question] = adaptPublicDataset([{
    example_id: 8,
    text: '材料仍然存在',
    question: '',
    options: ['', '', '', 'D. 仅剩一个选项'],
    answer: 3,
  }], { source: 'logiqa', split: 'train' });
  assert.equal(question.prompt, '（原数据缺少题干）');
  assert.equal(question.options.length, 4);
  assert.equal(question.answer, '');
  assert.equal(question.answer_index, -1);
  assert.equal(question.answer_status, 'missing');
  assert.equal(question.failed, true);
});

test('公开题库适配：重复原始 ID 自动追加出现次数避免冲突', () => {
  const questions = adaptPublicDataset([
    { example_id: 9, question: '第一题', options: ['甲', '乙', '丙', '丁'], answer: 0 },
    { example_id: 9, question: '第二题', options: ['甲', '乙', '丙', '丁'], answer: 1 },
  ], { source: 'logiqa', split: 'train' });
  assert.equal(questions[0].external_id, 'logiqa:train:9');
  assert.equal(questions[1].external_id, 'logiqa:train:9-2');
  assert.notEqual(questions[0].question_uid, questions[1].question_uid);
});
