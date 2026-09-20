// test-wp4-ai-local.mjs — 本地模式的多轮 chat 与离线 Mock 回归，不依赖私有题库 fixture。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const savedStorage = new Map();
global.localStorage = {
  getItem: (key) => savedStorage.get(key) ?? null,
  setItem: (key, value) => savedStorage.set(key, String(value)),
  removeItem: (key) => savedStorage.delete(key),
};
const defaults = JSON.parse(readFileSync(join(process.cwd(), 'public/ai-agents.default.json'), 'utf8'));
global.fetch = async (url) => {
  if (String(url).includes('ai-agents.default.json')) return { ok: true, status: 200, json: async () => defaults };
  return { ok: false, status: 404, json: async () => ({}) };
};

test('WP4 本地模式：多轮消息和离线 Mock 不依赖外网', async () => {
  const { createAiApi } = await import('./public/ai-local.js');
  const ai = await createAiApi({ request: async () => { throw new Error('mock 不应发网络请求'); }, tiku: null, query: null });
  await ai.updateAgent(1, { provider_mode: 'mock', stream_enabled: 1 });
  const result = await ai.chat({
    role: 'xingce-explainer',
    stream: true,
    messages: [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '上一轮回答' },
      { role: 'user', content: '继续解释' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.mock, true);
  assert.equal(result.streamed, false, '本地 handler 返回一次性结果，避免伪造 SSE');
  assert.match(result.content, /继续解释/);
});
