/* ===== 刷题草稿纸：练习会话内按题保存的透明手写层 ===== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ExamScratchpad = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PEN_COLOR = '#007aff';
  const PEN_WIDTH = 3;
  const ERASER_WIDTH = 28;

  function questionKey(question, index) {
    const id = question?.questionUid ?? question?.question_uid
      ?? question?.questionId ?? question?.id ?? `index-${index}`;
    const revision = question?.revision ?? question?.questionRevision
      ?? question?.question_revision ?? 1;
    const part = question?.groupIndex == null ? '' : `:part-${question.groupIndex}`;
    return `${String(id)}@${String(revision)}:item-${index}${part}`;
  }

  /** 只活在本次做题会话里的每题操作栈；不触碰 localStorage 或服务端。 */
  function createSessionStore() {
    let questionList = null;
    const pages = new Map();
    return {
      bind(list, index, question) {
        if (list !== questionList) {
          pages.clear();
          questionList = list;
        }
        const key = questionKey(question, index);
        if (!pages.has(key)) pages.set(key, { key, ops: [], undo: [], size: null, tool: 'pen' });
        return pages.get(key);
      },
      clear() {
        pages.clear();
        questionList = null;
      },
      get size() { return pages.size; },
    };
  }

  function createController({ isPaused = () => false, onBlocked = () => {} } = {}) {
    const session = createSessionStore();
    let currentPage = null;
    let overlay = null;
    let canvas = null;
    let context = null;
    let toolbar = null;
    let launcher = null;
    let signal = null;
    let activePointer = null;
    let fingerWriting = false;
    let lastPenAt = 0;
    let geometry = null;
    let pageLock = null;

    function removeLauncher() {
      launcher?.remove();
      launcher = null;
    }

    function close() {
      if (!overlay) return false;
      if (activePointer) finishPointer(null);
      signal?.abort();
      signal = null;
      overlay.remove();
      overlay = null;
      canvas = null;
      context = null;
      toolbar = null;
      geometry = null;
      if (pageLock) {
        const lock = pageLock;
        const returnFocus = launcher && document.contains(launcher) ? launcher : null;
        pageLock = null;
        document.documentElement.style.overflow = lock.htmlOverflow;
        document.documentElement.style.overscrollBehavior = lock.htmlOverscroll;
        document.body.style.position = lock.bodyPosition;
        document.body.style.top = lock.bodyTop;
        document.body.style.left = lock.bodyLeft;
        document.body.style.right = lock.bodyRight;
        document.body.style.width = lock.bodyWidth;
        document.body.style.overflow = lock.bodyOverflow;
        document.body.style.overscrollBehavior = lock.bodyOverscroll;
        const app = document.querySelector('#app');
        if (app) app.inert = lock.appInert;
        window.scrollTo(0, lock.scrollY);
        returnFocus?.focus({ preventScroll: true });
      }
      return true;
    }

    function clearSession() {
      close();
      removeLauncher();
      session.clear();
      currentPage = null;
      fingerWriting = false;
    }

    function bind(questionList, index, question, { enabled = true } = {}) {
      close();
      removeLauncher();
      currentPage = session.bind(questionList, index, question);
      if (enabled) mountLauncher();
      return currentPage;
    }

    function mountLauncher() {
      if (launcher || !currentPage) return;
      launcher = document.createElement('button');
      launcher.type = 'button';
      launcher.className = 'scratch-fab';
      launcher.setAttribute('aria-label', '打开草稿纸');
      launcher.title = '打开草稿纸';
      launcher.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 4 6 6M4 20l4-.8L20 7a2.8 2.8 0 0 0-4-4L4 15l-.8 5Z"/><path d="M12 6 18 12"/></svg><span>草稿纸</span>';
      launcher.addEventListener('click', () => {
        if (isPaused()) { onBlocked('已暂停，先点继续再操作'); return; }
        open();
      });
      document.body.appendChild(launcher);
    }

    function createToolButton(label, title, action, pressed = false) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `scratch-tool${pressed ? ' active' : ''}`;
      button.textContent = label;
      button.title = title;
      button.setAttribute('aria-label', title);
      if (pressed != null) button.setAttribute('aria-pressed', String(pressed));
      button.addEventListener('click', action);
      return button;
    }

    function canClear() {
      return !!currentPage?.ops.some((op) => op.type !== 'clear');
    }

    function updateToolbar() {
      if (!toolbar || !currentPage) return;
      toolbar.querySelectorAll('[data-tool]').forEach((button) => {
        const selected = button.dataset.tool === currentPage.tool;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      const undo = toolbar.querySelector('[data-action="undo"]');
      const clear = toolbar.querySelector('[data-action="clear"]');
      const finger = toolbar.querySelector('[data-action="finger"]');
      if (undo) undo.disabled = currentPage.undo.length === 0;
      if (clear) clear.disabled = !canClear();
      if (finger) {
        finger.classList.toggle('active', fingerWriting);
        finger.setAttribute('aria-pressed', String(fingerWriting));
        finger.textContent = `手指${fingerWriting ? '开' : '关'}`;
        finger.title = fingerWriting ? '关闭手指书写' : '允许单指书写';
        finger.setAttribute('aria-label', finger.title);
      }
    }

    function rememberOperation(operation) {
      currentPage.undo.push(currentPage.ops);
      currentPage.ops = [...currentPage.ops, operation];
      drawAll();
      updateToolbar();
    }

    function undo() {
      if (!currentPage?.undo.length) return;
      currentPage.ops = currentPage.undo.pop();
      drawAll();
      updateToolbar();
    }

    function eraseAll() {
      if (!canClear()) return;
      rememberOperation({ type: 'clear' });
    }

    function drawOperation(op) {
      if (op.type === 'clear') {
        context.clearRect(0, 0, currentPage.size.width, currentPage.size.height);
        return;
      }
      if (!op.points?.length) return;
      context.save();
      context.globalCompositeOperation = op.type === 'erase' ? 'destination-out' : 'source-over';
      context.strokeStyle = PEN_COLOR;
      context.fillStyle = PEN_COLOR;
      context.lineWidth = op.type === 'erase' ? ERASER_WIDTH : PEN_WIDTH;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      const first = op.points[0];
      if (op.points.length === 1) {
        context.beginPath();
        context.arc(first.x, first.y, context.lineWidth / 2, 0, Math.PI * 2);
        context.fill();
      } else {
        context.beginPath();
        context.moveTo(first.x, first.y);
        for (let i = 1; i < op.points.length; i++) context.lineTo(op.points[i].x, op.points[i].y);
        context.stroke();
      }
      context.restore();
    }

    function drawAll() {
      if (!context || !geometry || !currentPage) return;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      const { scale, offsetX, offsetY, dpr } = geometry;
      context.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offsetX, dpr * offsetY);
      for (const op of currentPage.ops) drawOperation(op);
      if (activePointer) drawOperation({ type: activePointer.tool, points: activePointer.points });
      context.setTransform(1, 0, 0, 1, 0, 0);
      if (scale < 0.999) {
        context.strokeStyle = 'rgba(0,122,255,.24)';
        context.lineWidth = 1;
        context.strokeRect(offsetX + .5, offsetY + .5,
          currentPage.size.width * scale - 1, currentPage.size.height * scale - 1);
      }
    }

    function resizeCanvas() {
      if (!canvas || !currentPage) return;
      const width = Math.max(1, window.innerWidth);
      const height = Math.max(1, window.innerHeight);
      if (!currentPage.size) currentPage.size = { width, height };
      const dpr = window.devicePixelRatio || 1;
      const scale = Math.min(width / currentPage.size.width, height / currentPage.size.height);
      const offsetX = (width - currentPage.size.width * scale) / 2;
      const offsetY = (height - currentPage.size.height * scale) / 2;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      geometry = { width, height, dpr, scale, offsetX, offsetY };
      drawAll();
    }

    function pointFromEvent(event) {
      const x = (event.clientX - geometry.offsetX) / geometry.scale;
      const y = (event.clientY - geometry.offsetY) / geometry.scale;
      if (x < 0 || y < 0 || x > currentPage.size.width || y > currentPage.size.height) return null;
      return { x, y };
    }

    function drawSegment(tool, from, to) {
      if (!context || !geometry) return;
      context.save();
      context.setTransform(geometry.dpr * geometry.scale, 0, 0, geometry.dpr * geometry.scale,
        geometry.dpr * geometry.offsetX, geometry.dpr * geometry.offsetY);
      context.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
      context.strokeStyle = PEN_COLOR;
      context.fillStyle = PEN_COLOR;
      context.lineWidth = tool === 'erase' ? ERASER_WIDTH : PEN_WIDTH;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      context.restore();
    }

    function finishPointer(event) {
      if (!activePointer) return;
      if (event && activePointer.id !== event.pointerId) return;
      const stroke = activePointer;
      activePointer = null;
      rememberOperation({ type: stroke.tool, points: stroke.points });
    }

    function open() {
      if (overlay || !currentPage || isPaused()) return;
      if (!currentPage.size) currentPage.size = { width: window.innerWidth, height: window.innerHeight };
      currentPage.tool = 'pen';

      const scrollY = window.scrollY;
      const app = document.querySelector('#app');
      pageLock = {
        scrollY,
        bodyPosition: document.body.style.position,
        bodyTop: document.body.style.top,
        bodyLeft: document.body.style.left,
        bodyRight: document.body.style.right,
        bodyWidth: document.body.style.width,
        bodyOverflow: document.body.style.overflow,
        bodyOverscroll: document.body.style.overscrollBehavior,
        htmlOverflow: document.documentElement.style.overflow,
        htmlOverscroll: document.documentElement.style.overscrollBehavior,
        appInert: app?.inert || false,
      };
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollY}px`;
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.style.width = '100%';
      document.body.style.overflow = 'hidden';
      document.body.style.overscrollBehavior = 'none';
      document.documentElement.style.overflow = 'hidden';
      document.documentElement.style.overscrollBehavior = 'none';
      if (app) app.inert = true;

      overlay = document.createElement('div');
      overlay.className = 'scratch-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', '透明草稿纸');
      overlay.setAttribute('aria-modal', 'true');
      toolbar = document.createElement('div');
      toolbar.className = 'scratch-toolbar';
      toolbar.setAttribute('role', 'toolbar');
      toolbar.setAttribute('aria-label', '草稿纸工具');

      const pen = createToolButton('笔', '使用蓝色笔书写', () => { currentPage.tool = 'pen'; updateToolbar(); }, true);
      pen.dataset.tool = 'pen';
      toolbar.appendChild(pen);
      const eraser = createToolButton('橡皮', '局部擦除', () => { currentPage.tool = 'erase'; updateToolbar(); }, false);
      eraser.dataset.tool = 'erase';
      toolbar.appendChild(eraser);
      const undoButton = createToolButton('撤销', '撤销上一步', undo, null);
      undoButton.dataset.action = 'undo';
      toolbar.appendChild(undoButton);
      const clearButton = createToolButton('清空', '清空当前草稿', eraseAll, null);
      clearButton.dataset.action = 'clear';
      toolbar.appendChild(clearButton);
      const finger = createToolButton('手指关', '允许单指书写', () => {
        fingerWriting = !fingerWriting;
        updateToolbar();
      });
      finger.dataset.action = 'finger';
      toolbar.appendChild(finger);
      const dismiss = createToolButton('收起', '收起草稿纸', close, null);
      dismiss.dataset.action = 'close';
      toolbar.appendChild(dismiss);

      canvas = document.createElement('canvas');
      canvas.className = 'scratch-canvas';
      canvas.setAttribute('aria-label', '触控笔书写区域');
      canvas.style.touchAction = 'none';
      context = canvas.getContext('2d');
      overlay.append(canvas, toolbar);
      document.body.appendChild(overlay);
      signal = new AbortController();
      const options = { signal: signal.signal };
      canvas.addEventListener('pointerdown', (event) => {
        if (activePointer || !['pen', 'mouse', 'touch'].includes(event.pointerType)) return;
        if (event.pointerType === 'touch' && (!fingerWriting || activePointer?.type === 'pen' || Date.now() - lastPenAt < 800)) return;
        if (event.pointerType === 'pen') lastPenAt = Date.now();
        const point = pointFromEvent(event);
        if (!point) return;
        event.preventDefault();
        event.stopPropagation();
        activePointer = { id: event.pointerId, type: event.pointerType,
          tool: currentPage.tool, points: [point] };
        try { canvas.setPointerCapture(event.pointerId); } catch {}
        drawAll();
      }, options);
      canvas.addEventListener('pointermove', (event) => {
        if (event.pointerType === 'pen') lastPenAt = Date.now();
        if (!activePointer || activePointer.id !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const samples = event.getCoalescedEvents?.() || [];
        for (const sample of (samples.length ? samples : [event])) {
          const point = pointFromEvent(sample);
          if (!point) continue;
          const previous = activePointer.points[activePointer.points.length - 1];
          activePointer.points.push(point);
          drawSegment(activePointer.tool, previous, point);
        }
      }, options);
      canvas.addEventListener('pointerup', finishPointer, options);
      canvas.addEventListener('pointercancel', finishPointer, options);
      canvas.addEventListener('lostpointercapture', finishPointer, options);
      overlay.addEventListener('touchstart', (event) => event.stopPropagation(), options);
      overlay.addEventListener('touchmove', (event) => event.stopPropagation(), options);
      overlay.addEventListener('touchend', (event) => event.stopPropagation(), options);
      overlay.addEventListener('pointerdown', (event) => event.stopPropagation(), options);
      window.addEventListener('resize', resizeCanvas, options);
      window.visualViewport?.addEventListener('resize', resizeCanvas, options);
      document.addEventListener('visibilitychange', () => { if (document.hidden) close(); }, options);
      resizeCanvas();
      updateToolbar();
      dismiss.focus({ preventScroll: true });
    }

    return {
      bind,
      open,
      close,
      isOpen: () => !!overlay,
      clearSession,
      startSession: clearSession,
    };
  }

  return { PEN_COLOR, PEN_WIDTH, ERASER_WIDTH, questionKey, createSessionStore, createController };
});
