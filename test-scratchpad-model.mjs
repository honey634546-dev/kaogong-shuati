import assert from 'node:assert/strict';
import './public/scratchpad.js';
const { createSessionStore, questionKey } = globalThis.ExamScratchpad;

const firstQuestions = [
  { id: 'a', revision: 1 },
  { id: 'b', revision: 1 },
  { id: 'a', revision: 1 },
  { id: 'a', revision: 2 },
  { id: 'group', revision: 1, groupIndex: 0 },
  { id: 'group', revision: 1, groupIndex: 1 },
];
const store = createSessionStore();

const a = store.bind(firstQuestions, 0, firstQuestions[0]);
assert.equal(store.bind(firstQuestions, 0, firstQuestions[0]), a, '同题重新渲染应恢复原草稿页');
a.ops.push({ type: 'stroke', points: [{ x: 1, y: 2 }] });
assert.notEqual(store.bind(firstQuestions, 1, firstQuestions[1]), a, '切题应使用独立草稿页');
assert.notEqual(store.bind(firstQuestions, 2, firstQuestions[2]), a, '同题重复出现也按题组位置隔离');
assert.notEqual(store.bind(firstQuestions, 3, firstQuestions[3]), a, '题目版本变化应使用独立草稿页');
assert.notEqual(store.bind(firstQuestions, 4, firstQuestions[4]), store.bind(firstQuestions, 5, firstQuestions[5]), '材料组子题应各自保存');
assert.equal(questionKey({ question_uid: 'uid-a', question_revision: 3 }, 9), 'uid-a@3:item-9', '优先使用稳定题目身份、版本和本次题组位置');
assert.equal(store.bind(firstQuestions, 0, firstQuestions[0]), a, '返回原题后应保留本次练习中的笔迹');

const newQuestions = firstQuestions.slice();
assert.notEqual(store.bind(newQuestions, 0, newQuestions[0]), a, '新的题组即使包含相同题目也必须清空旧草稿');
store.clear();
assert.equal(store.size, 0, '清理练习会话应释放全部草稿');

console.log('scratchpad model: 6 assertions passed');
