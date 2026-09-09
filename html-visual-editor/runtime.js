/* =============================================================
   HTML 可视化编辑器 —— 编辑运行时（注入到目标页面内运行）
   原则：只修改 ①文字节点的文本内容 ②元素的行内 style 属性
        （颜色/字体/translate/绝对定位），绝不改动页面结构、
        样式表、图片与动画。
   交互：页面上只有高亮层与提示气泡（不拦截点击），
        颜色/字体/坐标等控件全部位于外壳顶栏，不会遮挡页面元素。
   注：本文件在外壳页面加载时，仅暴露自身源码供注入使用。
   ============================================================= */
(function () {
  'use strict';

  var current = document.currentScript;
  var SELF_SOURCE = (current && current.textContent) || '';
  if (window.top === window.self) {
    window.__HVE_RUNTIME_SOURCE__ = SELF_SOURCE;
    return;
  }
  if (window.__HVE_RUNTIME__) return;

  /* ==================== 注入样式（仅高亮/标签/提示 + 拖拽光标） ==================== */
  var CSS = [
    '#hve-overlay{position:fixed;z-index:2147483000;pointer-events:none;box-sizing:border-box;border:2px solid #3b82f6;background:rgba(59,130,246,.08);display:none}',
    '#hve-overlay.hve-selected{border-color:#f59e0b;background:rgba(245,158,11,.10)}',
    '#hve-tag{position:absolute;top:-22px;left:-2px;background:#3b82f6;color:#fff;font:600 11px/18px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:0 6px;border-radius:4px 4px 0 0;white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.3)}',
    '#hve-overlay.hve-selected #hve-tag{background:#f59e0b}',
    '#hve-toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483003;display:none;background:rgba(17,24,39,.92);color:#fff;font-size:13px;padding:9px 16px;border-radius:8px;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:70vw;pointer-events:none}',
    'body.hve-dragmode, body.hve-dragmode *{cursor:grab !important}',
    'body.hve-dragging, body.hve-dragging *{cursor:grabbing !important}'
  ].join('\n');

  /* ==================== 工具 ==================== */

  function elementPath(el) {
    var segs = [];
    var node = el;
    while (node && node.parentNode && node.tagName !== 'BODY') {
      var p = node.parentNode;
      var idx = 0;
      for (var c = p.firstElementChild; c; c = c.nextElementSibling) {
        if (c === node) break;
        idx++;
      }
      segs.unshift(idx);
      node = p;
    }
    return segs;
  }

  function byPath(path) {
    var node = document.body;
    for (var i = 0; i < path.length; i++) {
      node = node.children[path[i]];
      if (!node) return null;
    }
    return node;
  }

  function sig(el) {
    var t = el.tagName.toLowerCase();
    var id = el.id ? '#' + el.id : '';
    var cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return t + id + cls;
  }

  function pageX() { return window.scrollX || document.documentElement.scrollLeft || 0; }
  function pageY() { return window.scrollY || document.documentElement.scrollTop || 0; }

  function parseTranslate(v) {
    if (!v || v === 'none') return null;
    var parts = String(v).trim().split(/\s+/);
    var x = parseFloat(parts[0]);
    if (isNaN(x)) return null;
    var y = parts.length > 1 ? parseFloat(parts[1]) : 0;
    return { x: x, y: isNaN(y) ? 0 : y };
  }
  function parseNum(v) { var f = parseFloat(v); return isNaN(f) ? null : f; }

  function setInline(el, prop, v) {
    if (v === '' || v === null || v === undefined) el.style.removeProperty(prop);
    else el.style.setProperty(prop, v);
  }

  /* ==================== 状态 ==================== */

  var enabled = false;
  var dragMode = false;
  var posMode = 'translate';
  var selected = null;
  var hoverEl = null;
  var editingEl = null;
  var textBefore = '';
  var textHadCE = false;
  var onEditCb = null;
  var onSelectCb = null;
  var blobMap = {};     // blobURL -> 相对路径（由外壳注入，用于站内链接导航）
  var styleBase = {};   // 属性 -> 本次选中期间最近一次提交的基准行内值
  var listenersAttached = false;
  var overlay, tagChip, toastEl;
  var toastTimer = null;
  var dragWatch = null; // {pendingTarget, detail, startX, startY, started, d, lastNotify}
  // 这些交互元素不参与"点击即编辑文字"（编辑模式下也不触发其默认行为）
  var SKIP_TEXT_EDIT = { A: 1, BUTTON: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, IFRAME: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1, OBJECT: 1 };
  // 格式刷：吸取选中元素的行内样式，下一次点击元素时应用（Esc 取消，可撤销）
  var painterStyles = null;   // {prop: value}
  var painterDoneCb = null;

  var PAINTER_PROPS = ['color', 'background-color', 'border-color', 'border-width', 'border-style',
    'border-radius', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
    'font-family', 'opacity', 'box-shadow'];

  function copySelectedStyles() {
    if (!selected) return {};
    var out = {};
    PAINTER_PROPS.forEach(function (p) {
      var v = selected.style.getPropertyValue(p);
      if (v) out[p] = v;
    });
    return out;
  }

  function setPainter(styles) {
    painterStyles = (styles && Object.keys(styles).length) ? styles : null;
    if (!painterStyles && painterDoneCb) {
      try { painterDoneCb(); } catch (e) { /* 忽略 */ }
    }
  }

  function onPainterDone(cb) { painterDoneCb = cb; }

  function paintTo(el) {
    if (!painterStyles) return;
    Object.keys(painterStyles).forEach(function (prop) {
      var before = el.style.getPropertyValue(prop);
      var v = painterStyles[prop];
      if (before !== v) {
        el.style.setProperty(prop, v);
        emit({ kind: 'style', path: elementPath(el), sig: sig(el), prop: prop, before: before, after: v });
      }
    });
    painterStyles = null;
    toast('已应用格式刷样式（可撤销）');
    if (painterDoneCb) {
      try { painterDoneCb(); } catch (e) { /* 忽略 */ }
    }
  }

  /* ==================== UI 构建 ==================== */

  function ensureUI() {
    if (overlay) return;
    var st = document.createElement('style');
    st.id = 'hve-runtime-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);

    overlay = document.createElement('div');
    overlay.id = 'hve-overlay';
    overlay.className = 'hve-ui';
    tagChip = document.createElement('div');
    tagChip.id = 'hve-tag';
    overlay.appendChild(tagChip);

    toastEl = document.createElement('div');
    toastEl.id = 'hve-toast';
    toastEl.className = 'hve-ui';

    document.body.appendChild(overlay);
    document.body.appendChild(toastEl);

    if (!listenersAttached) {
      listenersAttached = true;
      document.addEventListener('mouseover', onMouseOver, true);
      document.addEventListener('mousedown', onMouseDown, true);
      document.addEventListener('dblclick', onDblClick, true);
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('auxclick', onAuxClick, true);
      document.addEventListener('contextmenu', onContextMenu, true);
      window.addEventListener('scroll', onViewportChange, true);
      window.addEventListener('resize', onViewportChange, true);
      document.addEventListener('mouseleave', function () {
        if (enabled && hoverEl) hideHover();
      }, true);
    }
  }

  function hideOverlay() { if (overlay) overlay.style.display = 'none'; }

  function positionOverlay(el, isSelected) {
    if (!overlay || !el || !el.isConnected) { hideOverlay(); return; }
    var r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    overlay.classList.toggle('hve-selected', !!isSelected);
    tagChip.textContent = sig(el) + (dragMode ? ' ｜ 按住拖动，Shift 锁定方向' : '');
  }

  function toast(msg) {
    ensureUI();
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, 2600);
  }

  /* ==================== 悬停 ==================== */

  function hideHover() {
    hoverEl = null;
    if (selected) positionOverlay(selected, true);
    else hideOverlay();
  }

  function onMouseOver(e) {
    if (!enabled || !overlay) return;
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('.hve-ui')) { if (hoverEl) hideHover(); return; }
    if (t === document.documentElement || t === document.body) { hideHover(); return; }
    if (editingEl && editingEl.contains(t)) { hideHover(); return; }
    // 拖拽模式：指针在选中元素内部时，预览/拖动的目标是整个选中元素
    if (dragMode && selected && selected !== t && selected.contains(t)) t = selected;
    hoverEl = t;
    positionOverlay(hoverEl, false);
  }

  /* ==================== 选中 ==================== */

  function selectElement(el) {
    if (el === document.documentElement || el === document.body) return;
    commitTextEdit();
    selected = el;
    hoverEl = null;
    styleBase = {};
    positionOverlay(el, true);
    notifySelect();
  }

  function notifySelect() {
    if (!onSelectCb) return;
    try {
      onSelectCb(selected ? {
        el: selected,
        sig: sig(selected),
        x: Math.round(selected.getBoundingClientRect().left + pageX()),
        y: Math.round(selected.getBoundingClientRect().top + pageY()),
        textOnly: !selected.querySelector('*')
      } : null);
    } catch (e) { /* 忽略 */ }
  }

  /* ==================== mousedown：选中 / 直接拖拽 ==================== */

  function onMouseDown(e) {
    if (!enabled || !overlay) return;
    if (e.button !== 0) return;
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('.hve-ui')) return;
    if (editingEl && editingEl.contains(t)) return; // 编辑文字时允许光标定位/选择
    e.preventDefault();
    e.stopPropagation();
    if (t === document.documentElement || t === document.body) return;
    if (dragMode) { beginDragWatch(e, t); return; }
    // 普通模式：文本元素单击即编辑；非文本（容器）元素再次单击同一元素逐级上溯
    var textOnly = !t.querySelector('*');
    var walkUp = e.detail === 1 && t === selected && !textOnly && !painterStyles &&
      t.parentElement && t.parentElement !== document.body;
    if (walkUp) selectElement(t.parentElement);
    else selectElement(t);
    if (painterStyles) { paintTo(selected); return; } // 格式刷：应用后不进入文字编辑
    // 链接/按钮/表单等交互元素：编辑模式下静默（不触发跳转或运行），也不自动进入文字编辑
    if (selected && !selected.querySelector('*') && !SKIP_TEXT_EDIT[selected.tagName]) startTextEdit();
  }

  /* ---- 拖拽模式：按住元素直接拖动，无任何确认 ---- */

  function beginDragWatch(e, t) {
    dragWatch = { pendingTarget: t, detail: e.detail, startX: e.clientX, startY: e.clientY, started: false, d: null };
    document.addEventListener('pointermove', onDragMove, true);
    document.addEventListener('pointerup', onDragUp, true);
    document.addEventListener('pointercancel', onDragUp, true);
  }

  function onDragMove(e) {
    if (!dragWatch) return;
    if (!dragWatch.started) {
      var dx0 = e.clientX - dragWatch.startX;
      var dy0 = e.clientY - dragWatch.startY;
      if (dx0 * dx0 + dy0 * dy0 < 9) return; // 3px 阈值区分点击与拖动
      var el = dragWatch.pendingTarget;
      if (!el || !el.isConnected || el === document.documentElement || el === document.body) {
        endDragWatch();
        return;
      }
      dragWatch.started = true;
      // 按下点位于选中元素内部时，拖动整个选中元素；否则拖动按下点命中的元素
      if (selected && selected !== el && selected.contains(el)) el = selected;
      selectElement(el);
      if (posMode === 'absolute') ensureAbsolute(el); // 静默转换（可撤销）
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } }
      var t = parseTranslate(el.style.translate) || { x: 0, y: 0 };
      dragWatch.d = {
        beforeTranslate: el.style.translate || '',
        origTx: t.x, origTy: t.y,
        beforeLeft: el.style.left || '', beforeTop: el.style.top || '',
        origLeft: parseNum(el.style.left) || 0, origTop: parseNum(el.style.top) || 0
      };
      document.body.classList.add('hve-dragging');
    }
    var d = dragWatch.d;
    var dx = e.clientX - dragWatch.startX;
    var dy = e.clientY - dragWatch.startY;
    // 按住 Shift 锁定方向：按当前偏移的主导轴向移动（横向或竖向）
    if (e.shiftKey) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    if (posMode === 'translate') {
      selected.style.translate = (d.origTx + dx) + 'px ' + (d.origTy + dy) + 'px';
    } else {
      selected.style.left = (d.origLeft + dx) + 'px';
      selected.style.top = (d.origTop + dy) + 'px';
    }
    positionOverlay(selected, true);
    var now = Date.now();
    if (!dragWatch.lastNotify || now - dragWatch.lastNotify > 80) {
      dragWatch.lastNotify = now;
      notifySelect(); // 外壳顶栏坐标实时更新
    }
  }

  function onDragUp() { endDragWatch(); }

  function endDragWatch() {
    if (!dragWatch) return;
    document.removeEventListener('pointermove', onDragMove, true);
    document.removeEventListener('pointerup', onDragUp, true);
    document.removeEventListener('pointercancel', onDragUp, true);
    document.body.classList.remove('hve-dragging');
    var w = dragWatch;
    dragWatch = null;
    if (!w.started) {
      // 无位移的单击：选中（再次单击同一元素逐级上溯）
      var t = w.pendingTarget;
      if (t && t.isConnected && t !== document.documentElement && t !== document.body) {
        if (w.detail === 1 && t === selected && t.parentElement && t.parentElement !== document.body) {
          selectElement(t.parentElement);
        } else {
          selectElement(t);
        }
        if (painterStyles) paintTo(selected);
      }
      return;
    }
    // 提交拖动记录（一条记录一次拖动）
    var el = selected;
    if (el && w.d) {
      if (posMode === 'translate') {
        if (w.d.beforeTranslate !== el.style.translate) {
          emit({ kind: 'translate', path: elementPath(el), sig: sig(el), before: w.d.beforeTranslate, after: el.style.translate });
        }
      } else {
        if (w.d.beforeLeft !== el.style.left || w.d.beforeTop !== el.style.top) {
          emit({
            kind: 'abs-pos', path: elementPath(el), sig: sig(el),
            before: { left: w.d.beforeLeft, top: w.d.beforeTop },
            after: { left: el.style.left, top: el.style.top }
          });
        }
      }
      notifySelect();
    }
  }

  /* ==================== 点击拦截（编辑时阻止页面交互 / 浏览时接管站内导航） ==================== */

  function onDocClick(e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('.hve-ui')) return;
    if (enabled) {
      if (editingEl && editingEl.contains(t)) return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = t.closest('a[href]');
    if (!a) return;
    var target = (a.getAttribute('target') || '').toLowerCase();
    if (target && target !== '_self') return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || /^(javascript:|mailto:|tel:)/i.test(href)) return;
    e.preventDefault(); // blob 链接导航会被浏览器阻断，改为外壳切换 iframe.src
    var top = window.parent;
    var path = blobMap[href];
    if (path) { top.__hve_navigateTo && top.__hve_navigateTo(path); return; }
    if (/^https?:/i.test(href)) { top.__hve_navigateExternal && top.__hve_navigateExternal(href); return; }
    top.__hve_navigateTo && top.__hve_navigateTo(href);
  }

  function onDblClick(e) {
    if (!enabled || editingEl || dragMode) return;
    var t = e.target;
    if (!(t instanceof Element) || t.closest('.hve-ui')) return;
    if (t === document.documentElement || t === document.body) return;
    selectElement(t);
    if (selected && !selected.querySelector('*') && !SKIP_TEXT_EDIT[selected.tagName]) startTextEdit();
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    if (editingEl) { e.preventDefault(); cancelTextEdit(); }
    else if (painterStyles) {
      painterStyles = null;
      toast('已取消格式刷');
      if (painterDoneCb) { try { painterDoneCb(); } catch (err) { /* 忽略 */ } }
    }
  }

  // 编辑模式下：中键点击与右键菜单也静默，避免链接另开标签页/页面菜单干扰
  function onAuxClick(e) {
    if (!enabled) return;
    var t = e.target;
    if (!(t instanceof Element) || t.closest('.hve-ui')) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onContextMenu(e) {
    if (!enabled) return;
    var t = e.target;
    if (!(t instanceof Element) || t.closest('.hve-ui')) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onViewportChange() {
    if (!enabled || !overlay) return;
    if (selected && selected.isConnected) positionOverlay(selected, true);
    else if (hoverEl && hoverEl.isConnected) positionOverlay(hoverEl, false);
    else hideOverlay();
  }

  /* ==================== 文字编辑 ==================== */

  function startTextEdit() {
    if (!selected || editingEl) return;
    var el = selected;
    editingEl = el;
    textBefore = el.innerHTML;
    textHadCE = el.hasAttribute('contenteditable');
    el.setAttribute('contenteditable', 'true');
    el.addEventListener('blur', onTextBlur);
    el.addEventListener('keydown', onTextKeydown);
    el.addEventListener('paste', onTextPaste);
    el.focus();
    var r = document.createRange();
    r.selectNodeContents(el);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    toast('正在编辑文字：直接输入替换全部内容，Esc 放弃');
  }

  function onTextKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); cancelTextEdit(); }
    // Enter 默认产生 <br>，属于允许的文本级结构，提交时统一校验
  }

  function onTextPaste(e) {
    e.preventDefault();
    var text = '';
    try { text = (e.clipboardData || window.clipboardData).getData('text/plain'); } catch (err) { /* 忽略 */ }
    try { document.execCommand('insertText', false, text); } catch (err) { /* 忽略 */ }
  }

  function onTextBlur() { setTimeout(commitTextEdit, 0); }

  function detachTextListeners(el) {
    el.removeEventListener('blur', onTextBlur);
    el.removeEventListener('keydown', onTextKeydown);
    el.removeEventListener('paste', onTextPaste);
  }

  function commitTextEdit() {
    if (!editingEl) return;
    var el = editingEl;
    editingEl = null;
    detachTextListeners(el);
    if (!textHadCE) el.removeAttribute('contenteditable');
    var after = el.innerHTML;
    // 结构校验：只允许文本节点、注释与 <br>，其余一律回滚，保护页面结构
    var ok = true;
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 || n.nodeType === 8) continue;
      if (n.nodeType === 1 && n.tagName === 'BR') continue;
      ok = false;
      break;
    }
    if (!ok) {
      el.innerHTML = textBefore;
      toast('检测到元素插入，已还原文字修改（仅支持纯文本编辑，结构不变）');
      return;
    }
    if (after !== textBefore) {
      emit({ kind: 'text', path: elementPath(el), sig: sig(el), before: textBefore, after: after });
    }
    if (selected === el) positionOverlay(el, true);
  }

  function cancelTextEdit() {
    if (!editingEl) return;
    var el = editingEl;
    editingEl = null;
    detachTextListeners(el);
    el.innerHTML = textBefore;
    if (!textHadCE) el.removeAttribute('contenteditable');
    toast('已取消文字编辑（元素保持选中）');
  }

  /* ==================== 颜色 / 字体（外壳顶栏调用） ==================== */

  function applyStyle(prop, value, commit) {
    if (!selected) return false;
    if (commit === false) {
      // 实时预览：首次改动时锁定基准（原始行内值），保证提交记录 before 准确
      if (!(prop in styleBase)) styleBase[prop] = selected.style.getPropertyValue(prop);
      selected.style.setProperty(prop, value);
      return true;
    }
    var before = (prop in styleBase) ? styleBase[prop] : selected.style.getPropertyValue(prop);
    selected.style.setProperty(prop, value);
    if (before !== value) {
      emit({ kind: 'style', path: elementPath(selected), sig: sig(selected), prop: prop, before: before, after: value });
    }
    styleBase[prop] = value;
    return true;
  }

  function clearStyle(prop) {
    if (!selected) return false;
    var before = selected.style.getPropertyValue(prop);
    if (before) {
      emit({ kind: 'style', path: elementPath(selected), sig: sig(selected), prop: prop, before: before, after: '' });
    }
    selected.style.removeProperty(prop);
    styleBase[prop] = '';
    return true;
  }

  /* ==================== 位置（坐标应用 / 直接拖拽） ==================== */

  function absOrigin(el) {
    var op = el.offsetParent || document.documentElement;
    if (op === document.documentElement) return { x: 0, y: 0 };
    var r = op.getBoundingClientRect();
    var cs = getComputedStyle(op);
    return {
      x: r.left + pageX() + (parseFloat(cs.borderLeftWidth) || 0) - (op.scrollLeft || 0),
      y: r.top + pageY() + (parseFloat(cs.borderTopWidth) || 0) - (op.scrollTop || 0)
    };
  }

  function ensureAbsolute(el) {
    if (getComputedStyle(el).position === 'absolute') return;
    var r = el.getBoundingClientRect();
    var before = {
      position: el.style.position, left: el.style.left, top: el.style.top,
      width: el.style.width, height: el.style.height, margin: el.style.margin
    };
    var o = absOrigin(el);
    var left = Math.round(r.left + pageX() - o.x);
    var top = Math.round(r.top + pageY() - o.y);
    el.style.position = 'absolute';
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.width = Math.round(r.width) + 'px';
    el.style.height = Math.round(r.height) + 'px';
    el.style.margin = '0';
    el.setAttribute('data-hve-abs', '1');
    emit({
      kind: 'abs-enter', path: elementPath(el), sig: sig(el), before: before,
      after: { position: 'absolute', left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height, margin: '0' }
    });
    toast('已原位转为绝对定位（可撤销），继续拖动即可移动');
  }

  function setTranslate(el, nx, ny) {
    var before = el.style.translate || '';
    var after = nx + 'px ' + ny + 'px';
    if (after === before) return;
    el.style.translate = after;
    emit({ kind: 'translate', path: elementPath(el), sig: sig(el), before: before, after: after });
  }

  function applyCoords(x, y) {
    if (!selected || isNaN(x) || isNaN(y)) return false;
    if (posMode === 'translate') {
      var r = selected.getBoundingClientRect();
      var curT = parseTranslate(selected.style.translate) || { x: 0, y: 0 };
      var nx = Math.round(curT.x + x - (r.left + pageX()));
      var ny = Math.round(curT.y + y - (r.top + pageY()));
      setTranslate(selected, nx, ny);
    } else {
      ensureAbsolute(selected);
      var o = absOrigin(selected);
      var left = Math.round(x - o.x);
      var top = Math.round(y - o.y);
      var before = { left: selected.style.left, top: selected.style.top };
      selected.style.left = left + 'px';
      selected.style.top = top + 'px';
      emit({
        kind: 'abs-pos', path: elementPath(selected), sig: sig(selected),
        before: before, after: { left: selected.style.left, top: selected.style.top }
      });
    }
    positionOverlay(selected, true);
    notifySelect();
    return true;
  }

  /* ==================== 重置（无确认，可撤销） ==================== */

  function resetSelected() {
    if (!selected) return false;
    var el = selected;
    var props = ['color', 'background-color', 'border-color', 'font-size', 'font-weight',
      'font-style', 'line-height', 'letter-spacing', 'font-family', 'translate',
      'opacity', 'box-shadow', 'border-width', 'border-style', 'border-radius'];
    if (el.hasAttribute('data-hve-abs')) props.push('position', 'left', 'top', 'width', 'height', 'margin');
    var before = [];
    props.forEach(function (p) {
      var v = el.style.getPropertyValue(p);
      if (v) before.push({ prop: p, value: v });
    });
    if (!before.length) { toast('该元素没有可重置的修改'); return false; }
    before.forEach(function (it) { el.style.removeProperty(it.prop); });
    el.removeAttribute('data-hve-abs');
    emit({ kind: 'reset', path: elementPath(el), sig: sig(el), before: before, after: [] });
    positionOverlay(el, true);
    notifySelect();
    toast('已重置该元素（可撤销）');
    return true;
  }

  /* ==================== 编辑记录 ==================== */

  function emit(rec) {
    if (onEditCb) {
      try { onEditCb(rec); } catch (e) { /* 忽略回调异常 */ }
    }
  }

  function applyProps(el, map) {
    ['position', 'left', 'top', 'width', 'height', 'margin'].forEach(function (p) {
      setInline(el, p, map && map[p]);
    });
  }

  function applyRecord(rec, dir) {
    var el = byPath(rec.path);
    if (!el || sig(el) !== rec.sig) return false;
    var v = dir === 'undo' ? rec.before : rec.after;
    switch (rec.kind) {
      case 'text':
        el.innerHTML = v;
        break;
      case 'style':
        setInline(el, rec.prop, v);
        break;
      case 'translate':
        el.style.translate = v || '';
        break;
      case 'abs-enter':
        applyProps(el, v);
        if (v && v.position === 'absolute') el.setAttribute('data-hve-abs', '1');
        else el.removeAttribute('data-hve-abs');
        break;
      case 'abs-pos':
        el.style.left = (v && v.left) || '';
        el.style.top = (v && v.top) || '';
        break;
      case 'reset': {
        var list = dir === 'undo' ? v : rec.before;
        list.forEach(function (it) {
          setInline(el, it.prop, dir === 'undo' ? it.value : '');
        });
        var hadAbs = rec.before.some(function (it) { return it.prop === 'position'; });
        if (dir === 'undo' && hadAbs) el.setAttribute('data-hve-abs', '1');
        else el.removeAttribute('data-hve-abs');
        break;
      }
      default:
        return false;
    }
    if (selected === el) positionOverlay(el, true);
    return true;
  }

  /* ==================== 对外接口 ==================== */

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) {
      commitTextEdit();
      selected = null;
      hoverEl = null;
      hideOverlay();
      document.body.classList.remove('hve-dragmode', 'hve-dragging');
      if (painterStyles) {
        painterStyles = null;
        if (painterDoneCb) { try { painterDoneCb(); } catch (e) { /* 忽略 */ } }
      }
      notifySelect();
    } else if (dragMode) {
      document.body.classList.add('hve-dragmode');
    }
  }

  function setDragMode(on) {
    dragMode = !!on;
    document.body.classList.toggle('hve-dragmode', !!(enabled && dragMode));
    if (overlay && selected) positionOverlay(selected, true);
  }

  function setPosMode(m) {
    posMode = m === 'absolute' ? 'absolute' : 'translate';
  }

  function onEdit(cb) { onEditCb = cb; }
  function onSelect(cb) { onSelectCb = cb; }
  function setBlobMap(m) { blobMap = m || {}; }

  function editText() {
    if (!selected) return false;
    if (selected.querySelector('*')) {
      toast('该元素内部包含子元素，请点击内部具体的文字元素后再编辑');
      return false;
    }
    startTextEdit();
    return true;
  }

  function selectParent() {
    if (!selected) return false;
    var p = selected.parentElement;
    if (!p || p === document.body) { toast('已是最外层元素'); return false; }
    selectElement(p);
    return true;
  }

  function listChildren() {
    if (!selected) return [];
    var out = [];
    for (var i = 0; i < selected.children.length; i++) {
      var c = selected.children[i];
      out.push({ index: i, sig: sig(c), text: (c.textContent || '').trim().slice(0, 24) });
    }
    return out;
  }

  function selectChild(i) {
    if (!selected) return false;
    var c = selected.children[i];
    if (!c) return false;
    selectElement(c);
    return true;
  }

  function getSelected() { return selected || null; }

  function serialize() {
    commitTextEdit();
    hideOverlay();
    var clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('#hve-runtime-style, #hve-runtime-injected, #hve-overlay, #hve-toast')
      .forEach(function (n) { n.remove(); });
    clone.querySelectorAll('[data-hve-abs]').forEach(function (el) { el.removeAttribute('data-hve-abs'); });
    var cloneBody = clone.querySelector('body');
    if (cloneBody) {
      cloneBody.classList.remove('hve-dragmode', 'hve-dragging');
      if (cloneBody.getAttribute('class') === '') cloneBody.removeAttribute('class');
    }
    return '<!DOCTYPE html>\n' + clone.outerHTML;
  }

  // 初始化：立即创建 UI 并挂载全局监听（元素默认隐藏）。
  // 点击接管在编辑模式关闭时也要生效（站内链接导航），不能等到首次开启编辑模式
  if (document.body) ensureUI();
  else document.addEventListener('DOMContentLoaded', ensureUI);

  window.__HVE_RUNTIME__ = {
    setEnabled: setEnabled,
    setDragMode: setDragMode,
    setPosMode: setPosMode,
    onEdit: onEdit,
    onSelect: onSelect,
    setBlobMap: setBlobMap,
    applyRecord: applyRecord,
    serialize: serialize,
    editText: editText,
    selectParent: selectParent,
    listChildren: listChildren,
    selectChild: selectChild,
    applyStyle: applyStyle,
    clearStyle: clearStyle,
    applyCoords: applyCoords,
    resetSelected: resetSelected,
    getSelected: getSelected,
    copySelectedStyles: copySelectedStyles,
    setPainter: setPainter,
    onPainterDone: onPainterDone,
    get posMode() { return posMode; }
  };

  try { document.dispatchEvent(new Event('hve-ready')); } catch (e) { /* 忽略 */ }
})();
