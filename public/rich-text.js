/*
 * Lightweight Markdown + math renderer for AI and study content.
 *
 * This intentionally stays dependency-free so the local-first app does not
 * need a CDN or a large Markdown/LaTeX bundle. It supports the formats the
 * model is instructed to emit: headings, section labels, lists, tables,
 * fenced code, emphasis, links, and common TeX operators/fractions.
 */
(function (root) {
  'use strict';

  const TOKEN_PREFIX = '\uE000RT';
  const TOKEN_SUFFIX = '\uE001';
  const INLINE_TOKEN_PREFIX = '\uE100RT';
  const INLINE_TOKEN_SUFFIX = '\uE101';

  const MATH_SYMBOLS = {
    times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓',
    le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠',
    approx: '≈', cong: '≅', equiv: '≡', propto: '∝',
    in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆',
    supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩',
    parallel: '∥', perp: '⊥', therefore: '∴', because: '∵',
    to: '→', rightarrow: '→', leftarrow: '←',
    leftrightarrow: '↔', Longrightarrow: '⟹', longrightarrow: '⟶',
    cdots: '⋯', dots: '…', ldots: '…', vdots: '⋮', ddots: '⋱',
    infinity: '∞', infty: '∞', degree: '°',
    '%': '%', '{': '{', '}': '}', '#': '#', '&': '&',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
    theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ',
    phi: 'φ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ',
    Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Omega: 'Ω',
  };

  const MATH_SPACES = new Set([',', ';', ':', '!', ' ']);

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function tokenFor(index) {
    return `${TOKEN_PREFIX}${index}${TOKEN_SUFFIX}`;
  }

  function inlineTokenFor(index) {
    return `${INLINE_TOKEN_PREFIX}${index}${INLINE_TOKEN_SUFFIX}`;
  }

  function restoreTokens(text, tokens) {
    const tokenRe = new RegExp(`${escapeRegExp(TOKEN_PREFIX)}(\\d+)${escapeRegExp(TOKEN_SUFFIX)}`, 'g');
    const inlineRe = new RegExp(`${escapeRegExp(INLINE_TOKEN_PREFIX)}(\\d+)${escapeRegExp(INLINE_TOKEN_SUFFIX)}`, 'g');
    return String(text)
      .replace(tokenRe, (_, i) => tokens[Number(i)] || '')
      .replace(inlineRe, (_, i) => tokens.inline?.[Number(i)] || '');
  }

  function readGroup(input, start) {
    if (input[start] !== '{') return null;
    let depth = 1;
    for (let i = start + 1; i < input.length; i++) {
      if (input[i] === '\\') { i++; continue; }
      if (input[i] === '{') depth++;
      else if (input[i] === '}' && --depth === 0) {
        return { value: input.slice(start + 1, i), end: i + 1 };
      }
    }
    return { value: input.slice(start + 1), end: input.length };
  }

  function readMathArg(input, start) {
    let i = start;
    while (/\s/.test(input[i] || '')) i++;
    if (input[i] === '{') return readGroup(input, i);
    if (input[i] === '\\') {
      const begin = i;
      i++;
      if (/[A-Za-z]/.test(input[i] || '')) while (/[A-Za-z]/.test(input[i] || '')) i++;
      else if (i < input.length) i++;
      return { value: input.slice(begin, i), end: i };
    }
    if (i >= input.length) return { value: '', end: i };
    // TeX treats a superscript/subscript argument as one token when it is not
    // grouped. A surrogate pair is kept intact for emoji/rare symbols.
    const size = input.codePointAt(i) > 0xffff ? 2 : 1;
    return { value: input.slice(i, i + size), end: i + size };
  }

  function readCommand(input, start) {
    let i = start + 1;
    if (i >= input.length) return { name: '', end: i };
    if (/[A-Za-z]/.test(input[i])) {
      const begin = i;
      while (/[A-Za-z]/.test(input[i] || '')) i++;
      return { name: input.slice(begin, i), end: i };
    }
    return { name: input[i], end: i + 1 };
  }

  function mathHtml(value) {
    const input = String(value ?? '').trim();
    let html = '';
    for (let i = 0; i < input.length;) {
      const ch = input[i];
      if (ch === '\\') {
        const command = readCommand(input, i);
        const name = command.name;
        i = command.end;
        if (name === '') continue;
        if (name === '\\') { html += '<br>'; continue; }
        if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
          const numerator = readMathArg(input, i);
          const denominator = readMathArg(input, numerator.end);
          i = denominator.end;
          html += `<span class="rt-frac"><span>${mathHtml(numerator.value)}</span><span>${mathHtml(denominator.value)}</span></span>`;
          continue;
        }
        if (name === 'sqrt') {
          const arg = readMathArg(input, i);
          i = arg.end;
          html += `<span class="rt-root"><span class="rt-root-symbol">√</span><span class="rt-root-body">${mathHtml(arg.value)}</span></span>`;
          continue;
        }
        if (name === 'text' || name === 'textrm' || name === 'mathrm' || name === 'operatorname') {
          const arg = readMathArg(input, i);
          i = arg.end;
          html += `<span class="rt-math-text">${mathHtml(arg.value)}</span>`;
          continue;
        }
        if (name === 'mathbf' || name === 'boldsymbol') {
          const arg = readMathArg(input, i);
          i = arg.end;
          html += `<strong>${mathHtml(arg.value)}</strong>`;
          continue;
        }
        if (name === 'overline' || name === 'bar') {
          const arg = readMathArg(input, i);
          i = arg.end;
          html += `<span class="rt-overline">${mathHtml(arg.value)}</span>`;
          continue;
        }
        if (name === 'left' || name === 'right' || name === 'displaystyle' || name === 'textstyle') continue;
        if (name === 'quad' || name === 'qquad') {
          html += '<span class="rt-math-space">&nbsp;</span>';
          if (name === 'qquad') html += '<span class="rt-math-space">&nbsp;</span>';
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(MATH_SYMBOLS, name)) {
          html += escapeHtml(MATH_SYMBOLS[name]);
          continue;
        }
        if (MATH_SPACES.has(name)) {
          html += name === ' ' ? '&thinsp;' : '';
          continue;
        }
        // Unknown commands remain visible instead of silently disappearing;
        // this makes unsupported model output diagnosable and readable.
        html += escapeHtml(`\\${name}`);
        continue;
      }
      if (ch === '^' || ch === '_') {
        const arg = readMathArg(input, i + 1);
        i = arg.end;
        html += ch === '^' ? `<sup>${mathHtml(arg.value)}</sup>` : `<sub>${mathHtml(arg.value)}</sub>`;
        continue;
      }
      if (ch === '{') {
        const group = readGroup(input, i);
        if (group) { html += mathHtml(group.value); i = group.end; continue; }
      }
      if (/\s/.test(ch)) html += ' ';
      else html += escapeHtml(ch);
      i++;
    }
    return html.replace(/ {2,}/g, ' ');
  }

  function normalizeBracketMath(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '[') {
        let end = i + 1;
        while (end < lines.length && lines[end].trim() !== ']') end++;
        if (end < lines.length) {
          out.push('$$', ...lines.slice(i + 1, end), '$$');
          i = end;
          continue;
        }
      }
      // Some gateways/model templates use a trailing backslash as a Markdown
      // hard-break marker. It should not become a lonely visible character.
      out.push(lines[i].replace(/\\+\s*$/, ''));
    }
    return out.join('\n');
  }

  function stashMath(text, tokens, expression, display) {
    return text.replace(expression, (_, value) => {
      const index = tokens.length;
      const content = mathHtml(value);
      tokens.push(display
        ? `<div class="rt-math-block" role="math">${content}</div>`
        : `<span class="rt-math-inline" role="math">${content}</span>`);
      return tokenFor(index);
    });
  }

  function extractSpecialBlocks(text, tokens) {
    let source = normalizeBracketMath(text);
    // Protect fenced code before looking for `$...$` or `\[...\]`; code
    // examples often contain those characters literally.
    source = source.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, language, code) => {
      const index = tokens.length;
      const lang = language ? `<span class="rt-code-lang">${escapeHtml(language)}</span>` : '';
      tokens.push(`<pre class="rt-code-block">${lang}<code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
      return tokenFor(index);
    });
    source = stashMath(source, tokens, /\$\$([\s\S]*?)\$\$/g, true);
    source = stashMath(source, tokens, /\\\[([\s\S]*?)\\\]/g, true);
    source = stashMath(source, tokens, /\\\(([\s\S]*?)\\\)/g, false);
    // Keep ordinary currency text intact unless it has a matching pair on the
    // same line. This covers the common inline `$...$` math form.
    source = stashMath(source, tokens, /(?<!\$)\$([^\n$]+?)\$(?!\$)/g, false);
    return source;
  }

  function safeUrl(raw) {
    const value = String(raw || '').trim();
    if (/^https?:\/\//i.test(value)) return value;
    return '';
  }

  function renderInline(value, tokens) {
    const inline = [];
    let source = escapeHtml(String(value ?? ''));
    const saveInline = (html) => {
      const index = inline.length;
      inline.push(html);
      return inlineTokenFor(index);
    };
    // Protect inline code before applying emphasis rules.
    source = source.replace(/`([^`\n]+)`/g, (_, code) => saveInline(`<code class="rt-inline-code">${code}</code>`));
    // Question banks commonly encode fill-in blanks as "____" or "\\_\\_".
    // Protect them before Markdown emphasis; otherwise the __...__ rule can
    // consume all text between two blanks and make a multi-blank question
    // appear to have only one line.
    source = source.replace(/(?:\\_){2,}|_{2,}/g, () => saveInline('<span class="rt-blank" aria-label="填空线"></span>'));
    source = source.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    source = source.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
    source = source.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    source = source.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
    source = source.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>');
    source = source.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, (_, label, url) => {
      const safe = safeUrl(url);
      return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer noopener">${label}</a>` : label;
    });
    source = source.replace(/ {2}\n/g, '<br>');
    source = source.replace(/\n/g, '<br>');
    const allTokens = [...tokens];
    allTokens.inline = inline;
    return restoreTokens(source, allTokens);
  }

  function splitTableRow(line) {
    let value = String(line).trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|')) value = value.slice(0, -1);
    return value.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
  }

  function isTableSeparator(line) {
    const cells = splitTableRow(line);
    return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function isTableHeader(lines, index) {
    return index + 1 < lines.length && /\|/.test(lines[index]) && isTableSeparator(lines[index + 1]);
  }

  function isSectionLine(line) {
    return /^\s*(?:\d+[.)]\s*)?【[^】]{1,40}】/.test(line);
  }

  function isBlockStart(lines, index) {
    const line = lines[index] || '';
    return !line.trim()
      || /^\s*#{1,3}\s+/.test(line)
      || isSectionLine(line)
      || /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)
      || /^\s*>/.test(line)
      || /^\s*(?:---+|\*\*\*+)\s*$/.test(line)
      || /^\uE000RT\d+\uE001$/.test(line.trim())
      || isTableHeader(lines, index);
  }

  function renderBlocks(source, tokens) {
    const lines = String(source).split('\n');
    const html = [];
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const tokenMatch = line.trim().match(/^\uE000RT(\d+)\uE001$/);
      if (tokenMatch) {
        html.push(tokens[Number(tokenMatch[1])] || '');
        i++;
        continue;
      }
      if (isTableHeader(lines, i)) {
        const headers = splitTableRow(lines[i]);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && /\|/.test(lines[i])) rows.push(splitTableRow(lines[i++]));
        html.push(`<div class="rt-table-wrap"><table class="rt-table"><thead><tr>${headers.map((c) => `<th>${renderInline(c, tokens)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, n) => `<td>${renderInline(row[n] || '', tokens)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      const heading = line.match(/^\s*(#{1,3})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        html.push(`<h${level} class="rt-heading">${renderInline(heading[2], tokens)}</h${level}>`);
        i++;
        continue;
      }
      const section = line.match(/^\s*(?:\d+[.)]\s*)?【([^】]{1,40})】\s*(.*)$/);
      if (section) {
        html.push(`<div class="rt-section-heading"><span>${escapeHtml(section[1])}</span>${section[2] ? `<strong>${renderInline(section[2], tokens)}</strong>` : ''}</div>`);
        i++;
        continue;
      }
      if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
        html.push('<hr class="rt-rule">');
        i++;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
        html.push(`<blockquote class="rt-quote">${renderBlocks(quoted.join('\n'), tokens)}</blockquote>`);
        continue;
      }
      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        const items = [];
        const matcher = unordered ? /^\s*[-*+]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/;
        while (i < lines.length) {
          const item = lines[i].match(matcher);
          if (!item) break;
          items.push(`<li>${renderInline(item[1], tokens)}</li>`);
          i++;
        }
        html.push(`<${ordered ? 'ol' : 'ul'} class="rt-list">${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      const paragraph = [line];
      i++;
      while (i < lines.length && !isBlockStart(lines, i)) paragraph.push(lines[i++]);
      html.push(`<p>${renderInline(paragraph.join('\n'), tokens)}</p>`);
    }
    return html.join('');
  }

  function renderRichText(value, options = {}) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const tokens = [];
    const source = extractSpecialBlocks(text, tokens);
    if (options.inline) {
      return `<span class="rt-inline-content">${renderInline(source, tokens)}</span>`;
    }
    const body = renderBlocks(source, tokens);
    const extra = options.className ? ` ${escapeHtml(options.className)}` : '';
    return `<div class="rt-content${extra}">${body}</div>`;
  }

  root.renderRichText = renderRichText;
  root.renderMathText = (value, display = false) => {
    const content = mathHtml(value);
    return display ? `<div class="rt-math-block" role="math">${content}</div>` : `<span class="rt-math-inline" role="math">${content}</span>`;
  };
})(typeof window !== 'undefined' ? window : globalThis);
