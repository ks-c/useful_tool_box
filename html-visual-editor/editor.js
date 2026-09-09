/* =============================================================
   HTML 可视化编辑器 —— 外壳控制器
   负责：加载本地文件夹/文件 → 资源映射与引用重写 → 注入编辑运行时
         → 编辑记录撤销/重做 → 导出 / 保存回原文件
   ============================================================= */
(function () {
  'use strict';

  var iframe = document.getElementById('stage');
  var $id = function (id) { return document.getElementById(id); };

  var state = {
    fileMap: new Map(),      // path -> provider {handle} | {file} | {content}
    blobMap: new Map(),      // path -> blobURL
    blobInProgress: new Set(),
    protoRefs: [],           // 协议相对引用还原表 [从, 到]
    entryPath: null,
    entryName: 'page',
    entryProvider: null,
    runtimeSource: (typeof window.__HVE_RUNTIME_SOURCE__ === 'string' && window.__HVE_RUNTIME_SOURCE__) || '',
    runtimeSourcePromise: null,
    editMode: false,
    dragMode: false,
    posMode: 'translate',
    undoStack: [],
    redoStack: [],
    busy: false
  };

  var MIME_EXT = {
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain', '.xml': 'application/xml',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf'
  };

  /* ==================== 基础工具 ==================== */

  function extOf(p) { var m = /(\.[^.\\/]+)$/.exec(p); return m ? m[1].toLowerCase() : ''; }
  function dirOf(p) { var i = p.lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : ''; }
  function baseName(p) { var i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p; }
  function mimeOf(p) { return MIME_EXT[extOf(p)] || 'application/octet-stream'; }

  function relPath(fromDir, to) {
    if (!fromDir) return to;
    var a = fromDir.split('/'), b = to.split('/');
    while (a.length && b.length && a[0] === b[0]) { a.shift(); b.shift(); }
    return a.map(function () { return '..'; }).concat(b).join('/');
  }

  function normalizePath(fromDir, ref) {
    var base = 'http://x/' + (fromDir ? fromDir + '/' : '');
    var u = new URL(ref, base);
    var pn = u.pathname.slice(1);
    try { pn = decodeURIComponent(pn); } catch (e) { /* 保留原样 */ }
    return pn;
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var el = $id('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 2600);
  }

  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
  }

  function runtime() {
    var w = iframe.contentWindow;
    return (w && w.__HVE_RUNTIME__) ? w.__HVE_RUNTIME__ : null;
  }

  /* ==================== 文件提供者 ==================== */

  async function providerText(p) {
    var pr = state.fileMap.get(p);
    if (!pr) throw new Error('找不到文件: ' + p);
    if (pr.content !== undefined) return pr.content;
    if (pr.file) return await pr.file.text();
    return await pr.handle.getFile().then(function (f) { return f.text(); });
  }

  async function providerFile(p) {
    var pr = state.fileMap.get(p);
    if (!pr) throw new Error('找不到文件: ' + p);
    if (pr.file) return pr.file;
    if (pr.handle) return pr.handle.getFile();
    return new File([pr.content], baseName(p), { type: mimeOf(p) });
  }

  /* ==================== 引用重写 ==================== */

  // 异步正则替换（回调可 await）
  async function replaceAsync(str, re, fn) {
    var out = '', last = 0, m;
    var r = new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g');
    while ((m = r.exec(str)) !== null) {
      out += str.slice(last, m.index);
      out += await fn(m[0], m[1], m[2], m[3]);
      last = m.index + m[0].length;
      if (last === m.index) r.lastIndex += 1;
    }
    out += str.slice(last);
    return out;
  }

  // 保护内联 <script>…</script>（无 src）与 <base …>，避免误重写其内容；
  // 带 src 的外部脚本标签不做保护，使其 src 属性可被正常重写
  function protectBlocks(text) {
    var blocks = [];
    var out = text.replace(/<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script\s*>/gi, function (m) {
      blocks.push(m);
      return '\u0001HVE' + (blocks.length - 1) + '\u0001';
    });
    out = out.replace(/<base\b[^>]*>/gi, function (m) {
      blocks.push(m);
      return '\u0001HVE' + (blocks.length - 1) + '\u0001';
    });
    return { out: out, blocks: blocks };
  }
  function restoreBlocks(out, blocks) {
    return out.replace(/\u0001HVE(\d+)\u0001/g, function (m, i) { return blocks[Number(i)] || m; });
  }

  // 生成本地文件的 Blob URL（css/html 会先做内部引用重写）
  async function getRewrittenHtml(p) {
    var text = await providerText(p);
    return rewriteHtmlText(text, dirOf(p));
  }

  async function ensureBlob(p) {
    if (state.blobMap.has(p)) return state.blobMap.get(p);
    if (state.blobInProgress.has(p)) return null; // 防循环引用，保留原引用
    state.blobInProgress.add(p);
    var url;
    try {
      var ext = extOf(p);
      if (ext === '.css') {
        var text = await providerText(p);
        var out = await rewriteStyleUrlsAsync(text, dirOf(p));
        url = URL.createObjectURL(new Blob([out], { type: 'text/css' }));
      } else if (ext === '.html' || ext === '.htm') {
        var htmlOut = await getRewrittenHtml(p);
        url = URL.createObjectURL(new Blob([htmlOut], { type: 'text/html' }));
      } else {
        var f = await providerFile(p);
        url = URL.createObjectURL(f);
      }
      state.blobMap.set(p, url);
    } finally {
      state.blobInProgress.delete(p);
    }
    return url;
  }

  // 解析单个引用：返回改写后的 URL；无需改写时返回 null（保持原样）
  async function resolveRef(ref, fromDir) {
    if (!ref) return null;
    ref = String(ref).trim();
    if (!ref || /^(https?:|data:|blob:|javascript:|mailto:|tel:|#)/i.test(ref)) return null;
    if (ref.indexOf('//') === 0) {
      var abs = 'https:' + ref;
      state.protoRefs.push([abs, ref]);
      return abs;
    }
    var p = ref;
    var qi = p.search(/[?#]/);
    var suffix = qi >= 0 ? p.slice(qi) : '';
    if (qi >= 0) p = p.slice(0, qi);
    if (!p) return null;
    var decoded = p;
    try { decoded = decodeURIComponent(p); } catch (e) { /* 保留原样 */ }
    var absPath;
    try { absPath = normalizePath(fromDir, decoded); } catch (e) { return null; }
    if (!state.fileMap.has(absPath)) return null;
    var url = await ensureBlob(absPath);
    return url ? url + suffix : null;
  }

  async function rewriteStyleUrlsAsync(text, fromDir) {
    var out = await replaceAsync(text, /url\(\s*(['"]?)([^'"()]+)\1\s*\)/gi, async function (m, q, inner) {
      var url = await resolveRef(inner, fromDir);
      return url != null ? 'url(' + q + url + q + ')' : m;
    });
    out = await replaceAsync(out, /(@import\s+)(["'])([^"']+)\2/gi, async function (m, pre, q, inner) {
      var url = await resolveRef(inner, fromDir);
      return url != null ? pre + q + url + q : m;
    });
    return out;
  }

  async function rewriteSrcsetAsync(val, fromDir) {
    var parts = val.split(',').map(function (s) { return s.trim(); });
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var toks = parts[i].split(/\s+/);
      var url = await resolveRef(toks[0], fromDir);
      if (url != null) toks[0] = url;
      out.push(toks.join(' '));
    }
    return out.join(', ');
  }

  // 重写 HTML 文本中的相对引用（逐字节保留原文，仅替换 URL）
  async function rewriteHtmlText(text, fromDir) {
    // 若存在指向外部的 <base href>，浏览器会自行解析相对引用，跳过重写
    var baseM = /<base\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(text);
    var externalBase = false;
    var baseDir = fromDir;
    if (baseM && baseM[1]) {
      if (/^https?:\/\//i.test(baseM[1])) externalBase = true;
      else { try { baseDir = dirOf(normalizePath(fromDir, baseM[1])); } catch (e) { /* 忽略 */ } }
    }

    var prot = protectBlocks(text);
    var t = prot.out;

    if (!externalBase) {
      // 移除 CSP meta，保证编辑运行时脚本可注入
      t = await replaceAsync(t, /<meta\b[^>]*>/gi, function (m) {
        return /http-equiv\s*=\s*["']?\s*content-security-policy/i.test(m) ? '' : m;
      });

      var attrs = ['src', 'href', 'poster', 'data', 'cite', 'background'];
      for (var a = 0; a < attrs.length; a++) {
        var attr = attrs[a];
        var reDq = new RegExp('(\\b' + attr + '\\s*=\\s*")([^"]*)"', 'gi');
        var reSq = new RegExp('(\\b' + attr + "\\s*=\\s*')([^']*)'", 'gi');
        t = await replaceAsync(t, reDq, async function (m, pre, val) {
          var url = await resolveRef(val, baseDir);
          return url != null ? pre + url + '"' : m;
        });
        t = await replaceAsync(t, reSq, async function (m, pre, val) {
          var url = await resolveRef(val, baseDir);
          return url != null ? pre + url + "'" : m;
        });
      }

      t = await replaceAsync(t, /(\bsrcset\s*=\s*")([^"]*)"/gi, async function (m, pre, val) {
        return pre + (await rewriteSrcsetAsync(val, baseDir)) + '"';
      });
      t = await replaceAsync(t, /(\bsrcset\s*=\s*')([^']*)'/gi, async function (m, pre, val) {
        return pre + (await rewriteSrcsetAsync(val, baseDir)) + "'";
      });
      t = await replaceAsync(t, /(\bstyle\s*=\s*")([^"]*)"/gi, async function (m, pre, val) {
        return pre + (await rewriteStyleUrlsAsync(val, baseDir)) + '"';
      });
      t = await replaceAsync(t, /(\bstyle\s*=\s*')([^']*)'/gi, async function (m, pre, val) {
        return pre + (await rewriteStyleUrlsAsync(val, baseDir)) + "'";
      });
      t = await replaceAsync(t, /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, async function (m, open, body, close) {
        return open + (await rewriteStyleUrlsAsync(body, baseDir)) + close;
      });
    }

    return restoreBlocks(t, prot.blocks);
  }

  /* ==================== 入口加载 ==================== */

  function isHtmlPath(p) { return /\.html?$/i.test(p); }

  function sortHtmlPaths(paths) {
    return paths.slice().sort(function (a, b) {
      var ai = /(^|\/)index\.html?$/i.test(a) ? 0 : 1;
      var bi = /(^|\/)index\.html?$/i.test(b) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      var ad = a.split('/').length, bd = b.split('/').length;
      if (ad !== bd) return ad - bd;
      return a.localeCompare(b);
    });
  }

  function collectHtmlPaths() {
    var paths = [];
    state.fileMap.forEach(function (_, p) { if (isHtmlPath(p)) paths.push(p); });
    return sortHtmlPaths(paths);
  }

  async function loadEntry(path) {
    state.busy = true;
    toast('正在加载 ' + path + ' …');
    try {
      var html = await getRewrittenHtml(path);
      state.entryPath = path;
      state.entryName = baseName(path);
      state.entryProvider = state.fileMap.get(path) || null;
      clearStacks();
      $id('empty-state').hidden = true;
      iframe.hidden = false;
      writeIntoFrame(html);
      await ensureRuntime();
    } catch (err) {
      toast('加载失败：' + (err && err.message ? err.message : err));
      console.error(err);
    } finally {
      state.busy = false;
    }
  }

  // 把页面写入 about:blank iframe（继承父窗口 origin，file:// 下也同源可访问），
  // 页面内相对资源已全部改写为 Blob URL，无需服务器
  function writeIntoFrame(html) {
    var doc = iframe.contentDocument;
    if (!doc) throw new Error('无法访问编辑文档');
    doc.open();
    doc.write(html);
    doc.close();
  }

  function clearStacks() {
    state.undoStack = [];
    state.redoStack = [];
    updateStatus();
  }

  /* ==================== 文件夹 / 文件加载 ==================== */

  async function walkDirectory(dirHandle, base, out) {
    for await (var entry of dirHandle) {
      var p = base ? base + '/' + entry[0] : entry[0];
      if (entry[1].kind === 'file') out.push({ path: p, handle: entry[1] });
      else if (entry[1].kind === 'directory') await walkDirectory(entry[1], p, out);
    }
  }

  async function openFolder() {
    if (!window.showDirectoryPicker) {
      toast('当前浏览器不支持文件夹选择，请拖入文件夹，或使用 Chrome / Edge');
      return;
    }
    var dir;
    try { dir = await window.showDirectoryPicker(); } catch (e) { return; } // 用户取消
    var entries = [];
    try { await walkDirectory(dir, '', entries); } catch (e) { toast('读取文件夹失败：' + e.message); return; }
    state.fileMap.clear();
    state.blobMap.clear();
    state.protoRefs = [];
    entries.forEach(function (en) { state.fileMap.set(en.path, { handle: en.handle }); });
    pickEntry();
  }

  async function walkFileEntry(entry, base, out) {
    if (entry.isFile) {
      var file = await new Promise(function (res, rej) { entry.file(res, rej); });
      out.push({ path: base ? base + '/' + entry.name : entry.name, file: file });
    } else if (entry.isDirectory) {
      var reader = entry.createReader();
      var batch;
      do {
        batch = await new Promise(function (res, rej) { reader.readEntries(res, rej); });
        for (var i = 0; i < batch.length; i++) {
          await walkFileEntry(batch[i], base ? base + '/' + entry.name : entry.name, out);
        }
      } while (batch.length);
    }
  }

  function pickEntry() {
    var htmls = collectHtmlPaths();
    if (!htmls.length) { toast('没有找到 HTML 文件'); return; }
    if (htmls.length === 1) { loadEntry(htmls[0]); return; }
    showHtmlPicker(htmls);
  }

  function showHtmlPicker(htmls) {
    var list = $id('html-list');
    list.innerHTML = '';
    htmls.forEach(function (p) {
      var li = document.createElement('li');
      li.textContent = p;
      li.addEventListener('click', function () {
        hideModals();
        loadEntry(p);
      });
      list.appendChild(li);
    });
    $id('html-picker').hidden = false;
    $id('modal-mask').hidden = false;
  }

  function openSingleFile() {
    $id('file-input').click();
  }

  function handleFileInputChange(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    state.fileMap.clear();
    state.blobMap.clear();
    state.protoRefs = [];
    state.fileMap.set(file.name, { file: file });
    loadEntry(file.name);
  }

  /* ==================== 拖拽加载 ==================== */

  var dragDepth = 0;
  function showDrop() { dragDepth++; $id('drop-overlay').hidden = false; }
  function hideDrop() { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $id('drop-overlay').hidden = true; }

  async function handleDrop(e) {
    hideDrop();
    var files = [];
    var items = e.dataTransfer && e.dataTransfer.items;
    try {
      if (items && items.length && items[0].webkitGetAsEntry) {
        var roots = [];
        for (var i = 0; i < items.length; i++) {
          var en = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
          if (en) roots.push(en);
        }
        if (roots.length) {
          for (var j = 0; j < roots.length; j++) await walkFileEntry(roots[j], '', files);
        }
      }
    } catch (err) { /* 回退到 files 列表 */ }
    if (!files.length && e.dataTransfer && e.dataTransfer.files) {
      for (var k = 0; k < e.dataTransfer.files.length; k++) {
        var f = e.dataTransfer.files[k];
        files.push({ path: f.webkitRelativePath || f.name, file: f });
      }
    }
    if (!files.length) { toast('未能读取拖入的文件'); return; }
    state.fileMap.clear();
    state.blobMap.clear();
    state.protoRefs = [];
    files.forEach(function (it) { state.fileMap.set(it.path.replace(/\\/g, '/'), { file: it.file }); });
    var htmls = collectHtmlPaths();
    if (htmls.length === 1) loadEntry(htmls[0]);
    else if (htmls.length > 1) showHtmlPicker(htmls);
    else toast('拖入的内容中没有 HTML 文件');
  }

  /* ==================== 运行时注入 ==================== */

  function getRuntimeSource() {
    if (state.runtimeSource) return Promise.resolve(state.runtimeSource);
    if (state.runtimeSourcePromise) return state.runtimeSourcePromise;
    state.runtimeSourcePromise = fetch('runtime.js')
      .then(function (r) { return r.text(); })
      .then(function (t) { state.runtimeSource = t; return t; })
      .catch(function () { return ''; });
    return state.runtimeSourcePromise;
  }

  function syncSettings() {
    var r = runtime();
    if (!r) return;
    r.setEnabled(state.editMode);
    r.setDragMode(state.dragMode);
    r.setPosMode(state.posMode);
    // 同步 blob 映射，供运行时接管站内链接导航
    var m = {};
    state.blobMap.forEach(function (url, p) { m[url] = p; });
    r.setBlobMap(m);
  }

  // 站内导航：由运行时调用（blob 链接在浏览器中会被阻断；改为重写后写入 iframe）
  window.__hve_navigateTo = function (path) {
    var p = String(path || '').replace(/\\/g, '/');
    var resolved = p;
    if (!state.fileMap.has(resolved)) {
      try { resolved = normalizePath(dirOf(state.entryPath || ''), p); } catch (e) { /* 忽略 */ }
    }
    if (!state.fileMap.has(resolved)) { toast('目标页面不存在：' + p); return; }
    getRewrittenHtml(resolved).then(function (html) {
      clearStacks(); // 新文档，旧编辑记录失效
      writeIntoFrame(html);
      ensureRuntime();
    }).catch(function (err) { toast('加载失败：' + (err && err.message ? err.message : err)); });
  };

  // 外部链接：直接加载（跨域后无法继续编辑，状态栏会提示）
  window.__hve_navigateExternal = function (href) {
    iframe.src = href;
  };

  // 以 <script src> 方式把运行时加载进 iframe（file:// 与 http:// 均可用），
  // runtime.js 在 iframe 内执行时会自行初始化，无需读取其源码文本
  function injectRuntimeExternal(doc) {
    return new Promise(function (resolve) {
      var s = doc.createElement('script');
      s.id = 'hve-runtime-injected';
      s.src = new URL('runtime.js', location.href).href;
      s.onload = s.onerror = function () { resolve(); };
      (doc.head || doc.documentElement).appendChild(s);
    });
  }

  function stripCspMeta(doc) {
    doc.querySelectorAll('meta[http-equiv]').forEach(function (m) {
      if (/content-security-policy/i.test(m.getAttribute('http-equiv') || '')) m.remove();
    });
  }

  async function ensureRuntime() {
    var doc = iframe.contentDocument;
    var win = iframe.contentWindow;
    if (!doc || !win) return false;
    if (win.__HVE_RUNTIME__) { syncSettings(); return true; }
    var ok = false;
    // 方式1：<script src> 注入（file:// 与 http:// 通用）
    await injectRuntimeExternal(doc);
    if (win.__HVE_RUNTIME__) ok = true;
    // 方式2：页面自带 CSP meta 拦截时，移除后重试
    if (!ok) {
      stripCspMeta(doc);
      await injectRuntimeExternal(doc);
      if (win.__HVE_RUNTIME__) ok = true;
    }
    // 方式3：内联源码注入（http 下可用，作为兜底）
    if (!ok) {
      var src = await getRuntimeSource();
      if (src) {
        var s = doc.createElement('script');
        s.id = 'hve-runtime-injected';
        s.textContent = src;
        (doc.head || doc.documentElement).appendChild(s);
        if (win.__HVE_RUNTIME__) ok = true;
      }
    }
    if (!ok) { toast('编辑器运行时注入失败'); return false; }
    win.__HVE_RUNTIME__.onEdit(onRecord);
    win.__HVE_RUNTIME__.onSelect(onSelectInfo);
    win.__HVE_RUNTIME__.onPainterDone(function () {
      $id('btn-painter').classList.remove('active');
    });
    syncSettings();
    return true;
  }

  function currentDocName() {
    if (iframe.src) {
      for (var p of state.blobMap.keys()) {
        if (state.blobMap.get(p) === iframe.src) return baseName(p);
      }
    }
    return state.entryName;
  }

  /* ==================== 编辑记录 / 撤销 / 重做 ==================== */

  function onRecord(rec) {
    state.undoStack.push(rec);
    if (state.undoStack.length > 300) state.undoStack.shift();
    state.redoStack = [];
    updateStatus();
  }

  function doUndo() {
    var r = runtime();
    if (!r || !state.undoStack.length) return;
    var rec = state.undoStack.pop();
    if (r.applyRecord(rec, 'undo')) {
      state.redoStack.push(rec);
    } else {
      state.undoStack.push(rec);
      toast('目标元素已变化，无法撤销');
    }
    updateStatus();
  }

  function doRedo() {
    var r = runtime();
    if (!r || !state.redoStack.length) return;
    var rec = state.redoStack.pop();
    if (r.applyRecord(rec, 'redo')) {
      state.undoStack.push(rec);
    } else {
      state.redoStack.push(rec);
      toast('目标元素已变化，无法重做');
    }
    updateStatus();
  }

  /* ==================== 导出 / 保存 ==================== */

  function buildExportHtml() {
    var doc = iframe.contentDocument;
    if (!doc) return null;
    var r = runtime();
    var html = r ? r.serialize() : ('<!DOCTYPE html>\n' + doc.documentElement.outerHTML);
    return replaceBlobsBack(html);
  }

  function replaceBlobsBack(html) {
    var rev = new Map();
    state.blobMap.forEach(function (url, p) { if (!rev.has(url)) rev.set(url, p); });
    var entryDir = dirOf(state.entryPath || '');
    var out = html;
    rev.forEach(function (p, url) {
      out = out.split(url).join(encodeURI(relPath(entryDir, p)));
    });
    // 还原协议相对引用（//host/…）
    for (var i = 0; i < state.protoRefs.length; i++) {
      out = out.split(state.protoRefs[i][0]).join(state.protoRefs[i][1]);
    }
    return out;
  }

  function exportName() {
    var base = currentDocName().replace(/\.html?$/i, '');
    return (base || 'page') + '-edited.html';
  }

  function exportHtml() {
    var html = buildExportHtml();
    if (html === null) { toast('页面不可访问'); return; }
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), exportName());
    toast('已导出 ' + exportName());
  }

  async function saveBack() {
    var html = buildExportHtml();
    if (html === null) { toast('页面不可访问'); return; }
    // 优先写回原文件（文件夹模式）
    var pr = state.entryProvider;
    if (pr && pr.handle && pr.handle.createWritable) {
      try {
        var w = await pr.handle.createWritable();
        await w.write(html);
        await w.close();
        toast('已保存回原文件：' + state.entryName);
        return;
      } catch (err) { console.warn('写回失败，尝试其他方式', err); }
    }
    // 其次使用保存对话框
    if (window.showSaveFilePicker) {
      try {
        var h = await window.showSaveFilePicker({
          suggestedName: exportName(),
          types: [{ description: 'HTML 文档', accept: { 'text/html': ['.html'] } }]
        });
        var w2 = await h.createWritable();
        await w2.write(html);
        await w2.close();
        toast('已保存');
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // 用户取消
      }
    }
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), exportName());
    toast('当前环境不支持直接写回文件，已改为下载');
  }

  function exportJson() {
    var data = {
      page: state.entryPath || '',
      exportedAt: new Date().toISOString(),
      records: state.undoStack
    };
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }),
      (state.entryName || 'page').replace(/\.html?$/i, '') + '-修改记录.json');
    toast('已导出修改记录');
  }

  /* ==================== 状态与 UI ==================== */

  function updateStatus() {
    var hasPage = !!runtime();
    var edits = state.undoStack.length + state.redoStack.length;
    $id('status-file').textContent = hasPage ? ('已加载：' + currentDocName()) : '未加载页面';
    $id('status-edits').textContent = '修改：' + edits + ' 处';
    $id('status-mode').textContent = '位置方式：' + (state.posMode === 'translate' ? '平移' : '绝对定位');
    $id('btn-undo').disabled = !state.undoStack.length;
    $id('btn-redo').disabled = !state.redoStack.length;
    $id('btn-export-html').disabled = !hasPage;
    $id('btn-save-back').disabled = !hasPage;
    $id('btn-export-json').disabled = !edits;
  }

  function hideModals() {
    $id('modal-mask').hidden = true;
    $id('html-picker').hidden = true;
    $id('help-modal').hidden = true;
  }

  /* ==================== 事件绑定 ==================== */

  iframe.addEventListener('load', function () {
    // 站内导航走 writeIntoFrame（不触发 load）；此处覆盖外部导航/异常场景
    ensureRuntime().then(function (ok) {
      if (!ok) {
        $id('status-warn').hidden = false;
        $id('status-warn').textContent = '当前文档不可访问（可能跳转到了外部网站），请重新加载本地文件';
      } else {
        $id('status-warn').hidden = true;
      }
      updateStatus();
    });
  });

  $id('btn-open-folder').addEventListener('click', openFolder);
  $id('btn-open-file').addEventListener('click', openSingleFile);
  $id('file-input').addEventListener('change', handleFileInputChange);

  $id('chk-edit').addEventListener('change', function () {
    state.editMode = $id('chk-edit').checked;
    $id('stage-wrap').classList.toggle('hve-mode', state.editMode);
    if (!state.editMode) {
      // 关闭编辑时一并关闭拖拽
      $id('chk-drag').checked = false;
      state.dragMode = false;
    }
    var r = runtime();
    if (r) { r.setEnabled(state.editMode); r.setDragMode(state.dragMode); }
  });

  $id('chk-drag').addEventListener('change', function () {
    state.dragMode = $id('chk-drag').checked;
    if (state.dragMode && !$id('chk-edit').checked) {
      // 拖拽依赖编辑模式，自动开启
      $id('chk-edit').checked = true;
      state.editMode = true;
      $id('stage-wrap').classList.add('hve-mode');
    }
    var r = runtime();
    if (r) { r.setEnabled(state.editMode); r.setDragMode(state.dragMode); }
    if (state.dragMode) toast('拖拽已开启：按住页面元素直接拖动调整位置');
  });

  $id('sel-posmode').addEventListener('change', function () {
    state.posMode = $id('sel-posmode').value;
    var r = runtime();
    if (r) r.setPosMode(state.posMode);
    if (state.posMode === 'absolute') {
      toast('已切换为绝对定位：移动元素会脱离文档流（可撤销），拖动或应用坐标时生效');
    }
    updateStatus();
  });

  $id('btn-undo').addEventListener('click', doUndo);
  $id('btn-redo').addEventListener('click', doRedo);
  $id('btn-export-html').addEventListener('click', exportHtml);
  $id('btn-save-back').addEventListener('click', saveBack);
  $id('btn-export-json').addEventListener('click', exportJson);

  /* ==================== 选中元素信息与顶栏编辑组 ==================== */

  function onSelectInfo(info) {
    closePopovers();
    var group = $id('edit-group');
    if (!info) {
      group.setAttribute('data-disabled', '1');
      $id('elinfo').textContent = '未选中元素';
      $id('elinfo').title = '';
      return;
    }
    group.removeAttribute('data-disabled');
    $id('elinfo').textContent = info.sig;
    $id('elinfo').title = info.sig;
    $id('coord-x').value = info.x;
    $id('coord-y').value = info.y;
  }

  function rgbToHex(str) {
    if (!str) return null;
    var m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) < 1) return null;
    var h = function (n) { n = parseInt(n, 10); return (n < 16 ? '0' : '') + n.toString(16); };
    return '#' + h(m[1]) + h(m[2]) + h(m[3]);
  }

  $id('btn-edit-text').addEventListener('click', function () {
    var r = runtime();
    if (r) r.editText();
  });

  // 格式刷：吸取选中元素样式 → 点击目标元素应用（运行时内实现，Esc 取消）
  var painterBtn = $id('btn-painter');
  painterBtn.addEventListener('click', function () {
    var r = runtime();
    if (!r) return;
    if (painterBtn.classList.contains('active')) { r.setPainter(null); return; }
    var styles = r.copySelectedStyles();
    if (!styles || !Object.keys(styles).length) {
      toast('当前选中元素没有可复制的样式（请先为元素设置字体/背景/边框等样式）');
      return;
    }
    r.setPainter(styles);
    painterBtn.classList.add('active');
    toast('格式刷已激活：点击目标元素应用样式（Esc 取消）');
  });

  var POPOVERS = [
    { key: 'font', id: 'pop-font' },
    { key: 'bg', id: 'pop-bg' },
    { key: 'border', id: 'pop-border' },
    { key: 'children', id: 'pop-children' }
  ];

  function openPopover(which) {
    POPOVERS.forEach(function (k) { $id(k.id).hidden = k.key !== which; });
    if (which === 'font') prefillFontPopover();
    if (which === 'bg') prefillBgPopover();
    if (which === 'border') prefillBorderPopover();
    if (which === 'children') fillChildrenPopover();
  }
  function closePopovers() {
    POPOVERS.forEach(function (k) { $id(k.id).hidden = true; });
  }
  function isPopoverOpen() {
    return POPOVERS.some(function (k) { return !$id(k.id).hidden; });
  }
  function togglePopover(which) {
    openPopover(isPopoverOpen() && !$id(POPOVERS.find(function (k) { return k.key === which; }).id).hidden ? null : which);
  }

  $id('btn-font').addEventListener('click', function () { togglePopover('font'); });
  $id('btn-bg').addEventListener('click', function () { togglePopover('bg'); });
  $id('btn-border').addEventListener('click', function () { togglePopover('border'); });
  $id('btn-children').addEventListener('click', function () { togglePopover('children'); });

  // 取选中元素自身的行内样式（未设置的项留空，不使用继承的计算值）
  function selectedInlineStyle() {
    var r = runtime();
    var el = r && r.getSelected();
    return el ? el.style : null;
  }

  function fillColorRow(row, inlineValue) {
    var cur = inlineValue || '';
    var hex = rgbToHex(cur) || (/^#[0-9a-f]{3,8}$/i.test(cur) ? cur : null);
    row.querySelector('.pick').value = hex || '#000000';
    row.querySelector('.pop-val').textContent = cur || '（未设置）';
  }

  function prefillFontPopover() {
    var st = selectedInlineStyle();
    var g = function (p) { return st ? st.getPropertyValue(p) : ''; };
    fillColorRow($id('pop-font').querySelector('.pop-row[data-prop="color"]'), g('color'));
    var fsM = /^(-?\d*\.?\d+)(px|em|rem|%)?$/.exec(g('font-size'));
    $id('f-size').value = fsM ? fsM[1] : '';
    $id('f-size-unit').value = (fsM && fsM[2]) || 'px';
    var w = parseFloat(g('font-weight'));
    $id('f-weight').value = isNaN(w) ? '' : w;
    var lhM = /^(-?\d*\.?\d+)(px|em|rem|%)?$/.exec(g('line-height'));
    $id('f-lh').value = lhM ? lhM[1] : '';
    $id('f-lh-unit').value = (lhM && lhM[2]) || '';
    var lsM = /^(-?\d*\.?\d+)(px|em)?$/.exec(g('letter-spacing'));
    $id('f-ls').value = lsM ? lsM[1] : '';
    if (lsM && lsM[2]) $id('f-ls-unit').value = lsM[2];
    var fsStyle = g('font-style');
    $id('f-italic').checked = fsStyle === 'italic' || fsStyle === 'oblique';
    $id('f-family').value = g('font-family');
  }

  function prefillBgPopover() {
    var st = selectedInlineStyle();
    var g = function (p) { return st ? st.getPropertyValue(p) : ''; };
    fillColorRow($id('pop-bg').querySelector('.pop-row[data-prop="background-color"]'), g('background-color'));
    $id('bg-opacity').value = g('opacity');
    $id('bg-shadow').checked = !!g('box-shadow');
  }

  function prefillBorderPopover() {
    var st = selectedInlineStyle();
    var g = function (p) { return st ? st.getPropertyValue(p) : ''; };
    fillColorRow($id('pop-border').querySelector('.pop-row[data-prop="border-color"]'), g('border-color'));
    var wM = /^(-?\d*\.?\d+)(px)?$/.exec(g('border-width'));
    $id('b-width').value = wM ? wM[1] : '';
    var bs = g('border-style');
    $id('b-style').value = ['solid', 'dashed', 'dotted', 'double', 'none'].indexOf(bs) >= 0 ? bs : '';
    var rM = /^(-?\d*\.?\d+)(px|%)?$/.exec(g('border-radius'));
    $id('b-radius').value = rM ? rM[1] : '';
    if (rM && rM[2]) $id('b-radius-unit').value = rM[2];
  }

  function fillChildrenPopover() {
    var r = runtime();
    var list = r ? r.listChildren() : [];
    var ul = $id('children-list');
    ul.innerHTML = '';
    $id('children-empty').hidden = list.length > 0;
    list.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'child-item';
      li.textContent = item.sig + (item.text ? ' 「' + item.text + '」' : '');
      li.addEventListener('click', function () {
        var rr = runtime();
        if (rr) rr.selectChild(item.index);
        closePopovers();
      });
      ul.appendChild(li);
    });
  }

  // 取色行：input 实时预览，change 提交记录
  function bindColorRow(row) {
    var prop = row.getAttribute('data-prop');
    var pick = row.querySelector('.pick');
    var valEl = row.querySelector('.pop-val');
    pick.addEventListener('input', function () {
      var r = runtime();
      if (r) r.applyStyle(prop, pick.value, false);
      valEl.textContent = pick.value;
    });
    pick.addEventListener('change', function () {
      var r = runtime();
      if (r) r.applyStyle(prop, pick.value, true);
    });
  }
  document.querySelectorAll('#pop-font .pop-row[data-prop="color"], #pop-bg .pop-row[data-prop="background-color"], #pop-border .pop-row[data-prop="border-color"]')
    .forEach(bindColorRow);

  // 清除按钮（所有选项卡通用）
  document.querySelectorAll('#pop-font .pop-clear, #pop-bg .pop-clear, #pop-border .pop-clear').forEach(function (btn) {
    var prop = btn.getAttribute('data-prop');
    btn.addEventListener('click', function () {
      var r = runtime();
      if (!r) return;
      r.clearStyle(prop);
      var row = btn.closest('.pop-row');
      var val = row && row.querySelector('.pop-val');
      if (val) val.textContent = '（未设置）';
      var pick = row && row.querySelector('.pick');
      if (pick) pick.value = '#000000';
      toast('已清除 ' + prop + '（可撤销）');
    });
  });

  // 数字+单位字段：input 实时预览，change 提交记录
  function bindNumField(numEl, unitEl, prop, fmt) {
    var apply = function (commit) {
      var n = parseFloat(numEl.value);
      if (isNaN(n)) return;
      var v = fmt(n, unitEl ? unitEl.value : '');
      var r = runtime();
      if (r) r.applyStyle(prop, v, commit);
    };
    numEl.addEventListener('input', function () { apply(false); });
    numEl.addEventListener('change', function () { apply(true); });
    if (unitEl && unitEl.addEventListener) unitEl.addEventListener('change', function () { apply(true); });
  }
  bindNumField($id('f-size'), $id('f-size-unit'), 'font-size', function (n, u) { return Math.round(n * 100) / 100 + u; });
  bindNumField($id('f-lh'), $id('f-lh-unit'), 'line-height', function (n, u) { return n + u; });
  bindNumField($id('f-ls'), $id('f-ls-unit'), 'letter-spacing', function (n, u) { return n + u; });
  bindNumField($id('bg-opacity'), null, 'opacity', function (n) { return String(Math.min(1, Math.max(0, n))); });
  bindNumField($id('b-width'), $id('b-width-unit'), 'border-width', function (n) { return n + 'px'; });
  bindNumField($id('b-radius'), $id('b-radius-unit'), 'border-radius', function (n, u) { return n + u; });

  // 字重：自定义数值（1-1000），input 实时预览、change/回车提交
  (function () {
    var weightEl = $id('f-weight');
    var getW = function () {
      var n = parseFloat(weightEl.value);
      if (isNaN(n)) return null;
      return String(Math.min(1000, Math.max(1, Math.round(n))));
    };
    weightEl.addEventListener('input', function () {
      var v = getW();
      var r = runtime();
      if (v && r) r.applyStyle('font-weight', v, false);
    });
    weightEl.addEventListener('change', function () {
      var v = getW();
      if (v === null) return;
      weightEl.value = v;
      var r = runtime();
      if (r) r.applyStyle('font-weight', v, true);
    });
    weightEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); weightEl.blur(); }
    });
  })();

  $id('f-italic').addEventListener('change', function () {
    var r = runtime();
    if (!r) return;
    if ($id('f-italic').checked) r.applyStyle('font-style', 'italic', true);
    else r.clearStyle('font-style');
  });

  $id('bg-shadow').addEventListener('change', function () {
    var r = runtime();
    if (!r) return;
    if ($id('bg-shadow').checked) r.applyStyle('box-shadow', '0 4px 14px rgba(0, 0, 0, 0.25)', true);
    else r.clearStyle('box-shadow');
  });

  $id('b-style').addEventListener('change', function () {
    var r = runtime();
    if (r) r.applyStyle('border-style', $id('b-style').value, true);
  });

  (function () {
    var famEl = $id('f-family');
    famEl.addEventListener('input', function () {
      var v = famEl.value.trim();
      var r = runtime();
      if (v && r) r.applyStyle('font-family', v, false);
    });
    famEl.addEventListener('change', function () {
      var v = famEl.value.trim();
      var r = runtime();
      if (v && r) r.applyStyle('font-family', v, true);
    });
    famEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); famEl.blur(); }
    });
  })();

  // 坐标：应用按钮或回车
  function applyCoords() {
    var x = parseFloat($id('coord-x').value);
    var y = parseFloat($id('coord-y').value);
    if (isNaN(x) || isNaN(y)) { toast('请输入有效坐标'); return; }
    var r = runtime();
    if (r) r.applyCoords(x, y);
  }
  $id('btn-apply-coord').addEventListener('click', applyCoords);
  $id('coord-x').addEventListener('keydown', function (e) { if (e.key === 'Enter') applyCoords(); });
  $id('coord-y').addEventListener('keydown', function (e) { if (e.key === 'Enter') applyCoords(); });

  $id('btn-reset-el').addEventListener('click', function () {
    var r = runtime();
    if (r) r.resetSelected();
  });

  $id('btn-parent').addEventListener('click', function () {
    var r = runtime();
    if (r) r.selectParent();
  });

  // 点击顶栏其他区域关闭下拉面板
  document.addEventListener('click', function (e) {
    if (isPopoverOpen() && !e.target.closest('.popover-host') && !e.target.closest('.popover')) closePopovers();
  });

  $id('btn-help').addEventListener('click', function () {
    $id('help-modal').hidden = false;
    $id('modal-mask').hidden = false;
  });
  $id('btn-help-close').addEventListener('click', hideModals);
  $id('btn-picker-cancel').addEventListener('click', hideModals);
  $id('modal-mask').addEventListener('click', function (e) {
    if (e.target === $id('modal-mask')) hideModals();
  });

  window.addEventListener('dragover', function (e) {
    e.preventDefault();
    if (!$id('drop-overlay').hidden) return;
    showDrop();
  });
  window.addEventListener('dragleave', function () { hideDrop(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    handleDrop(e);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (isPopoverOpen()) closePopovers();
    if (!$id('modal-mask').hidden) hideModals();
    var r = runtime();
    if (r && $id('btn-painter').classList.contains('active')) r.setPainter(null);
  });

  /* ==================== SVG 图标（严肃风格线性图标） ==================== */

  var ICONS = {
    brackets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8l4 4-4 4M13.5 8h2.5M13.5 12h2.5M13.5 16h2.5"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20L10 4h4l6 16M7.2 13h9.6"/></svg>',
    move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/></svg>',
    type: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14M12 5v14M8 19h8"/></svg>',
    brush: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 3.5l6 6L9.3 20.7a2.8 2.8 0 0 1-4 0l-2-2a2.8 2.8 0 0 1 0-4z"/><path d="M12.5 5.5l6 6"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
    undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 2.6-6.4L3 9"/></svg>',
    redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M21 13a9 9 0 1 1-2.6-6.4L21 9"/></svg>',
    square: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 11l5 5 5-5M4 20h16"/></svg>',
    save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-6h8v6"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2.2c-.9.5-1.5 1-1.5 2.3"/><path d="M12 17h.01"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4L8 20l-5 1 1-5z"/></svg>',
    font: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20L10 4h4l5 16M7 13h10"/></svg>',
    droplet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z"/></svg>'
  };

  function applyIcons() {
    document.querySelectorAll('[data-icon]').forEach(function (el) {
      var name = el.getAttribute('data-icon');
      if (ICONS[name]) el.insertAdjacentHTML('afterbegin', ICONS[name]);
    });
  }

  /* ==================== 测试钩子（供自动化验证） ==================== */

  window.__hve_loadSite = function (map) {
    state.fileMap.clear();
    state.blobMap.clear();
    state.protoRefs = [];
    Object.keys(map).forEach(function (p) { state.fileMap.set(p.replace(/\\/g, '/'), { content: String(map[p]) }); });
    var htmls = collectHtmlPaths();
    if (htmls.length) loadEntry(htmls[0]);
  };

  window.__hve_exportHtmlString = function () {
    return Promise.resolve(buildExportHtml());
  };

  window.__hve_state = state;

  applyIcons();
  updateStatus();
})();
