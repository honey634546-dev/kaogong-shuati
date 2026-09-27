import { analyzeTiming, getReference, generateDrill, DRILL_METHOD_LABELS } from './speed-review-core.mjs';

const node = (tag, className, text) => {
  const out = document.createElement(tag);
  if (className) out.className = className;
  if (text != null) out.textContent = text;
  return out;
};
const seconds = (ms) => `${Math.max(0, Math.round(ms / 1000))} 秒`;
const requestBody = (question, answer, attemptId, index, historical, timing, reason, approach) => ({
  attemptId, questionId: question.id, questionUid: question.questionUid || '',
  submissionKey: answer.submissionKey || (attemptId && !historical ? `${attemptId}:final:${index}:${question.id}` : ''),
  questionRevision: question.revision || 1,
  questionData: {
    content: question.content || question.prompt || '', contentHtml: question.contentHtml || '',
    material: question.material || '', materialHtml: question.materialHtml || '',
    options: question.options || [], answer: question.answer, answerIndex: question.answerIndex,
    answerStatus: question.answerStatus ?? question.answer_status ?? '',
    analysis: question.analysis || '', chapter: question.chapter || '', category: question.category || '', images: question.images || [],
  },
  selected: answer.selected, correct: answer.correct, timing: { ...timing, assisted: typeof answer.assisted === 'boolean' ? answer.assisted : null },
  userReason: reason, userApproach: approach,
});

/** Results-only controller; every request/result belongs to this mounted review. */
export function mountSpeedReview({ view, cards, questions, answers, attemptId, historical = false, api }) {
  if (!view.isConnected || view.querySelector('.speed-summary')) return;
  const lifecycle = new AbortController();
  const observer = new MutationObserver(() => {
    if (!summary.isConnected) { lifecycle.abort(); observer.disconnect(); }
  });
  const summary = node('section', 'card speed-summary');
  summary.setAttribute('aria-label', '提速复盘');
  summary.append(node('div', 'speed-eyebrow', '做完，再找到更省力的方法'));
  summary.append(node('h2', '', '提速复盘'));
  summary.append(node('p', 'speed-muted', '先关注做对但用时较长的题；做错的题先理清思路。用时只提供线索，不能直接说明你为什么慢。'));
  const controls = node('div', 'speed-controls');
  const label = node('label', '', '练习参考用时');
  const reference = node('input', 'speed-reference');
  reference.type = 'number'; reference.min = '10'; reference.max = '1800';
  reference.placeholder = '按题型'; reference.setAttribute('aria-label', '统一参考秒数');
  label.append(reference, document.createTextNode(' 秒 / 题'));
  const apply = node('button', 'btn btn-ghost btn-sm', '应用');
  const reset = node('button', 'btn btn-ghost btn-sm', '按题型恢复');
  controls.append(label, apply, reset); summary.append(controls);
  summary.append(node('p', 'speed-muted speed-small', '初始参考：数量 120 秒、资料 / 判断 90 秒、言语 75 秒、常识 / 政治 30 秒、其他 90 秒。可自行调整；这是练习目标，并非考生平均用时。'));
  const ranking = node('div', 'speed-ranking'); ranking.setAttribute('aria-live', 'polite');
  summary.append(ranking);
  view.querySelector('.review-toolbar')?.before(summary);
  observer.observe(view, { childList: true });
  let override;
  const sessions = [];
  const update = () => {
    const entries = sessions.map((session) => {
      const timing = analyzeTiming(session.question, session.answer, override);
      session.timing = timing;
      const target = timing.referenceSeconds || getReference(session.question).seconds;
      session.badge.textContent = timing.eligible
        ? `${timing.slow ? '用时较长 · ' : ''}${seconds(timing.solveMs)} / 参考 ${target} 秒`
        : '计时或作答信息不足，暂不判断快慢';
      session.badge.classList.toggle('is-slow', Boolean(timing.slow));
      session.detail.textContent = (timing.caveats || []).join(' ');
      return session;
    }).filter((session) => session.timing.slow && session.timing.eligible)
      .sort((a, b) => b.timing.ratio - a.timing.ratio);
    ranking.replaceChildren(node('p', 'speed-ranking-title', entries.length
      ? `${entries.length} 道题超过练习参考用时，先看这 ${Math.min(3, entries.length)} 道`
      : '当前没有可确定超过参考用时的已答题。你仍可逐题查看是否有更简洁的方法。'));
    const links = node('div', 'speed-ranking-links');
    entries.slice(0, 3).forEach((session) => {
      const button = node('button', 'btn btn-ghost btn-sm', `第 ${session.index + 1} 题 · ${session.answer.correct ? '答对' : '答错'} · ${seconds(session.timing.solveMs)}`);
      button.onclick = () => {
        if (session.card.style.display === 'none') view.querySelector('.rv-tab[data-f="all"]')?.click();
        session.open();
        session.card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      links.append(button);
    });
    ranking.append(links);
  };
  apply.onclick = () => {
    if (reference.value !== '' && (!reference.checkValidity() || !Number.isFinite(reference.valueAsNumber))) {
      reference.reportValidity(); return;
    }
    override = reference.value === '' ? undefined : reference.valueAsNumber;
    update();
  };
  reset.onclick = () => { reference.value = ''; override = undefined; update(); };

  cards.forEach((card, index) => {
    const question = questions[index]; const answer = answers[index] || {};
    const section = node('section', 'speed-card');
    const badge = node('div', 'speed-time');
    const toggle = node('button', 'btn btn-ghost speed-toggle', '提速复盘');
    toggle.setAttribute('aria-expanded', 'false');
    const panel = node('div', 'speed-panel'); panel.hidden = true;
    panel.id = `speed-panel-${index}`; toggle.setAttribute('aria-controls', panel.id);
    const detail = node('p', 'speed-muted speed-small'); panel.append(detail);
    const reasonLabel = node('label', 'speed-field', '当时主要卡在哪里？（可选）');
    const reason = node('select'); reason.setAttribute('aria-label', '做题卡点');
    ['', '读题或找材料', '没想到方法', '计算步骤较多', '选项之间纠结', '中途被打断'].forEach((text) => {
      const option = node('option', '', text || '暂不确定'); option.value = text; reason.append(option);
    });
    reasonLabel.append(reason);
    const approachLabel = node('label', 'speed-field', '你当时怎么做的？（可选）');
    const approach = node('textarea'); approach.maxLength = 1200; approach.rows = 2;
    approach.placeholder = '例如：先列方程，再逐个代入选项。没有填写时，AI 只分析本题方法。';
    approach.setAttribute('aria-label', '原解题方法'); approachLabel.append(approach);
    const generate = node('button', 'btn btn-primary speed-generate', 'AI 分析本题方法');
    const cancel = node('button', 'btn btn-ghost btn-sm', '取消'); cancel.hidden = true;
    const actions = node('div', 'action-row'); actions.append(generate, cancel);
    const result = node('div', 'speed-result'); result.setAttribute('aria-live', 'polite');
    panel.append(reasonLabel, approachLabel, actions, result);
    section.append(badge, toggle, panel); card.append(section);
    const session = { card, question, answer, index, badge, detail, timing: null,
      open() { panel.hidden = false; toggle.setAttribute('aria-expanded', 'true'); } };
    sessions.push(session);
    toggle.onclick = () => { panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden)); };
    const cache = new Map(); let running; let clearDrill = () => {};
    cancel.onclick = () => running?.abort();
    const show = (response) => {
      clearDrill(); clearDrill = () => {};
      result.replaceChildren();
      if (!response.review) {
        result.append(node('p', 'speed-error', response.notice || response.error || '本次未获得可靠的复盘，请稍后重试。'));
        return;
      }
      const review = response.review;
      result.append(node('div', 'speed-result-title', review.status === 'method' ? review.methodName : review.status === 'no_shortcut' ? '先巩固基础与常规方法' : '信息不足，暂不推荐快解'));
      result.append(node('p', 'speed-muted speed-small', response.mock ? '演示响应 · 未调用真实模型' : response.model ? 'AI 方法建议 · 需要结合题目核对' : '复盘提示 · 本次未调用模型'));
      const field = (title, value) => {
        if (!value) return;
        const block = node('div', 'speed-explanation');
        block.append(node('strong', '', title), node('p', '', value)); result.append(block);
      };
      field('用时线索', review.diagnosis);
      field('看到什么，想到这个方法', review.recognition);
      if (review.steps?.length) {
        const block = node('div', 'speed-explanation'); block.append(node('strong', '', '具体怎么做'));
        const steps = node('ol'); review.steps.forEach((step) => steps.append(node('li', '', step)));
        block.append(steps); result.append(block);
      }
      field('为什么这样做仍然正确', review.whyCorrect);
      field('适用于哪些情况', review.applicability);
      field('什么时候不能套用', review.caution);
      if (review.status === 'method' && review.drillMethod && DRILL_METHOD_LABELS[review.drillMethod]) {
        clearDrill = mountDrill(result, review.drillMethod, lifecycle.signal);
      } else if (review.status === 'method') {
        result.append(node('p', 'speed-muted speed-small', '本题暂没有经过验算的配套练习。下次独立做同类新题时，再观察准确率与用时。'));
      }
    };
    generate.onclick = async () => {
      if (running) return;
      const body = requestBody(question, answer, attemptId, index, historical, session.timing, reason.value, approach.value.trim());
      const key = JSON.stringify(body);
      if (cache.has(key)) { show(cache.get(key)); return; }
      const request = new AbortController(); running = request;
      const stop = () => request.abort(); lifecycle.signal.addEventListener('abort', stop, { once: true });
      generate.disabled = true; cancel.hidden = false; reason.disabled = true; approach.disabled = true;
      result.replaceChildren(node('p', 'speed-muted', '正在核对本题方法与适用条件…'));
      try {
        const response = await api('/api/ai/speed-review', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: request.signal,
        });
        if (request.signal.aborted) throw new DOMException('已取消', 'AbortError');
        if (!section.isConnected) return;
        if (response.review) cache.set(key, response);
        show(response);
      } catch (error) {
        if (section.isConnected) result.replaceChildren(node('p', 'speed-error', error.name === 'AbortError' ? '已取消，可重新分析。' : `分析未完成：${error.message || '请稍后重试'}`));
      } finally {
        lifecycle.signal.removeEventListener('abort', stop); running = null;
        generate.disabled = false; cancel.hidden = true; reason.disabled = false; approach.disabled = false;
      }
    };
  });
  update();
}

function mountDrill(container, method, lifecycleSignal) {
  const area = node('section', 'speed-drill');
  area.append(node('strong', '', `基础方法练习 · ${DRILL_METHOD_LABELS[method]}`));
  area.append(node('p', 'speed-muted speed-small', '用一道新题检查基础方法，并不代表原题难度。题目由固定模板生成并验算，作答后才显示答案，不计入原卷成绩。'));
  const start = node('button', 'btn btn-ghost', '独立练一道新题');
  const body = node('div', 'speed-drill-body'); area.append(start, body); container.append(area);
  let cleanup = () => {};
  const baseSeed = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const usedExercises = new Set(); let sequence = 0;
  start.onclick = () => {
    cleanup();
    let exercise, exerciseKey;
    for (let attempt = 0; attempt < 100; attempt++) {
      exercise = generateDrill(method, `${baseSeed}-${sequence++}`);
      exerciseKey = JSON.stringify([exercise.prompt, exercise.options]);
      if (!usedExercises.has(exerciseKey)) break;
    }
    usedExercises.add(exerciseKey);
    start.textContent = '再练一道新题';
    body.replaceChildren(node('p', 'speed-drill-prompt', exercise.prompt));
    let elapsed = 0; let began = document.hidden ? null : performance.now(); let done = false;
    const stamp = () => { if (began != null) { elapsed += Math.max(0, performance.now() - began); began = null; } };
    const visibility = () => { if (document.hidden) stamp(); else if (!done) began = performance.now(); };
    document.addEventListener('visibilitychange', visibility);
    cleanup = () => {
      document.removeEventListener('visibilitychange', visibility);
      lifecycleSignal.removeEventListener('abort', cleanup);
    };
    lifecycleSignal.addEventListener('abort', cleanup, { once: true });
    const options = node('div', 'speed-drill-options');
    exercise.options.forEach((option, index) => {
      const button = node('button', 'btn btn-ghost speed-drill-option', `${'ABCD'[index]}  ${option}`);
      button.onclick = () => {
        if (done) return; done = true; stamp(); cleanup();
        options.querySelectorAll('button').forEach((entry, i) => { entry.disabled = true; if (i === exercise.answerIndex) entry.classList.add('is-correct'); });
        const correct = index === exercise.answerIndex;
        const feedback = node('div', 'speed-drill-feedback'); feedback.setAttribute('role', 'status');
        feedback.append(node('strong', '', `${correct ? '答对了' : '这次还没做对'} · 用时 ${seconds(elapsed)}`));
        feedback.append(node('p', '', `正确答案：${'ABCD'[exercise.answerIndex]}。${exercise.explanation}`));
        feedback.append(node('p', 'speed-muted speed-small', correct
          ? '本题答对。单次结果尚不能证明掌握或提速，之后还需观察同类新题的准确率和用时。'
          : '先把方法和适用条件弄清楚，再练习速度。'));
        body.append(feedback);
      };
      options.append(button);
    });
    body.append(options);
  };
  return () => cleanup();
}
