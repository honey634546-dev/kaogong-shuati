import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./public/rich-text.js', import.meta.url), 'utf8');
const context = { window: {}, globalThis: {}, console };
vm.runInNewContext(source, context, { filename: 'public/rich-text.js' });
const renderRichText = context.window.renderRichText;

test('富文本渲染：解析结构、公式和 Markdown', () => {
  const html = renderRichText(`【正确项解析】
全班有40名学生，其中25%参加英语小组：

[
40\\times25%=40\\times\\frac14=10（名）
]

因此正确项为 **B**，另一个比例是 $12.5\%$。

- **A项**：5名
- **B项**：10名，正确。

| 项目 | 数值 |
| --- | --- |
| 总人数 | 40 |`);

  assert.match(html, /rt-section-heading/);
  assert.match(html, /40×25%/);
  assert.match(html, /12\.5%/);
  assert.match(html, /rt-frac/);
  assert.match(html, /<strong>B<\/strong>/);
  assert.match(html, /<ul class="rt-list">/);
  assert.match(html, /<table class="rt-table">/);
});

test('富文本渲染：兼容行内公式、上下标和代码块', () => {
  const sample = [
    '行内公式 \\(x^2+y_1=\\frac{a+b}{c}\\)，以及：',
    '',
    '```text',
    '价格 $100，不应被当成公式',
    '```',
  ].join('\\n');
  const html = renderRichText(sample);

  assert.match(html, /rt-math-inline/);
  assert.match(html, /<sup>2<\/sup>/);
  assert.match(html, /<sub>1<\/sub>/);
  assert.match(html, /rt-code-block/);
  assert.match(html, /价格 \$100，不应被当成公式/);

  const inline = renderRichText('比例为 \\(12.5\\%\\)', { inline: true });
  assert.match(inline, /rt-inline-content/);
  assert.match(inline, /12\.5%/);
});

test('富文本渲染：不执行 AI 返回的 HTML/危险链接', () => {
  const html = renderRichText('<script>alert(1)</script> [危险](javascript:alert(1))');
  assert.doesNotMatch(html, /<script|onclick|javascript:/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /危险/);
});
