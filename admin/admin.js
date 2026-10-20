/*
 * 麦尼海塘后台
 * 在真实页面上点选修改：文字、图片、视频、链接；板块的上移、下移、复制、删除、插入；
 * 新建与删除页面、编辑导航、页面设置；一键发布到 GitHub（即网站），并可回到任意历史版本。
 *
 * 数据来源与发布：通过 GitHub REST API 读写 edwardchina2023-max/mainihaitang 的 main 分支。
 * 发布后 GitHub Pages 自动上线；仓库里的“自动整理”流程会补齐视频封面、SEO 与站点地图。
 */
(function () {
  "use strict";

  // ───────────────────────── 基本设置 ─────────────────────────
  var OWNER = "edwardchina2023-max";
  var REPO = "mainihaitang";
  var BRANCH = "main";
  var ORIGIN = "https://www.mainihaitang.com";
  var params = new URLSearchParams(location.search);
  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // 只在本机测试时允许改 API 地址，防止令牌被诱导发往别处
  var API = isLocal && params.get("api") ? params.get("api").replace(/\/$/, "") : "https://api.github.com";
  var TOKEN_KEY = "mani-admin-token";
  var DRAFT_PREFIX = "mani-admin-draft:";
  // 恢复历史版本时，始终保留这些路径的最新版本（否则后台自己会被“恢复”掉）
  var KEEP_ON_RESTORE = ["admin/", ".github/", "scripts/"];
  var BLOCK_TAGS = /^(DIV|P|SECTION|ARTICLE|ASIDE|HEADER|FOOTER|NAV|FIGURE|FIGCAPTION|UL|OL|LI|H[1-6]|BLOCKQUOTE|IMG|VIDEO|AUDIO|PICTURE|TABLE|FORM|DETAILS)$/;
  var TEXT_TAGS = /^(P|H[1-6]|SPAN|SMALL|STRONG|B|EM|I|A|LI|BLOCKQUOTE|FIGCAPTION|TIME|LABEL|SUMMARY|CITE|Q|DT|DD|TD|TH|BUTTON)$/;

  // ───────────────────────── 状态 ─────────────────────────
  var token = "";
  var headSha = "";
  var treeSha = "";
  var treeEntries = [];             // 仓库全部文件
  var pages = new Map();            // path → {path, sha, html, orig, isNew, deleted, globalEdit}
  var uploads = new Map();          // path → {blob, url, committed}
  var current = "";                 // 当前页面 path
  var selected = null;              // iframe 中被选中的元素
  var undoStacks = new Map();       // path → [body innerHTML]
  var textSnapshotTaken = false;
  var device = "desktop";
  var draftTimer = null;

  var $ = function (sel) { return document.querySelector(sel); };
  var frame = $("#frame");

  // ───────────────────────── 小工具 ─────────────────────────
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function toast(msg, bad) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.toggle("bad", !!bad);
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, bad ? 7000 : 4200);
  }
  function b64ToUtf8(b64) {
    var bin = atob(b64.replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }
  function blobToB64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(",")[1]); };
      r.onerror = function () { reject(new Error("读取文件失败")); };
      r.readAsDataURL(blob);
    });
  }
  function routeOf(path) { return path === "index.html" ? "/" : "/" + path.replace(/index\.html$/, ""); }
  function pathOf(route) {
    var r = route.replace(/^\//, "").replace(/[?#].*$/, "");
    if (r === "") return "index.html";
    return r.replace(/\/?$/, "/") + "index.html";
  }
  function titleOf(html) {
    var m = html.match(/<title>([^<]*)<\/title>/);
    var t = m ? m[1] : "";
    return t.replace(/｜麦尼海塘$/, "").replace(/\s·\s[A-Za-z].*$/, "") || "(未命名)";
  }
  function pageLabel(p) { return p.path === "index.html" ? "首页" : p.path === "404.html" ? "404 页面" : titleOf(p.html); }
  function confirmBox(title, html, okText, danger) {
    return new Promise(function (resolve) {
      openModal(title, html + '<div class="modal-actions"><button class="btn ghost" data-act="no">取消</button>' +
        '<button class="btn ' + (danger ? "danger" : "primary") + '" data-act="yes">' + esc(okText || "确定") + "</button></div>", function () { resolve(false); });
      $("#modal-body").querySelector('[data-act="no"]').onclick = function () { closeModal(true); resolve(false); };
      $("#modal-body").querySelector('[data-act="yes"]').onclick = function () { closeModal(true); resolve(true); };
    });
  }

  // ───────────────────────── GitHub API ─────────────────────────
  function gh(path, opts) {
    opts = opts || {};
    return fetch(API + path, {
      method: opts.method || "GET",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store"
    }).then(function (res) {
      if (res.ok) return res.status === 204 ? null : res.json();
      return res.json().catch(function () { return {}; }).then(function (data) {
        var msg = data && data.message ? data.message : res.statusText;
        var human = {
          401: "令牌无效或已过期，请重新登录。",
          403: "令牌没有写入权限，请确认 Contents 设为 Read and write。",
          404: "找不到仓库，或令牌没有授权 mainihaitang 仓库。",
          409: "仓库正在被其他操作更新，请稍后再试。",
          422: "GitHub 拒绝了这次写入：" + msg
        }[res.status];
        var err = new Error(human || "GitHub 返回错误（" + res.status + "）：" + msg);
        err.status = res.status;
        throw err;
      });
    });
  }
  var repoPath = "/repos/" + OWNER + "/" + REPO;

  function loadHead() {
    return gh(repoPath + "/git/ref/heads/" + BRANCH).then(function (ref) {
      return gh(repoPath + "/git/commits/" + ref.object.sha).then(function (c) {
        return { commit: ref.object.sha, tree: c.tree.sha };
      });
    });
  }
  function loadTree(sha) {
    return gh(repoPath + "/git/trees/" + sha + "?recursive=1").then(function (t) { return t.tree; });
  }
  function loadBlobText(sha) {
    return gh(repoPath + "/git/blobs/" + sha).then(function (b) { return b64ToUtf8(b.content); });
  }

  // ───────────────────────── 登录与载入 ─────────────────────────
  function showLogin(err) {
    $("#app").hidden = true;
    $("#login").hidden = false;
    $("#login-error").textContent = err || "";
  }

  $("#login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    token = $("#token-input").value.trim();
    var remember = $("#remember-input").checked;
    try {
      (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
      (remember ? sessionStorage : localStorage).removeItem(TOKEN_KEY);
    } catch (err) { /* 浏览器禁止存储时只在本次使用 */ }
    start();
  });

  $("#logout-btn").addEventListener("click", function () {
    if (countChanges() && !window.confirm("还有未发布的修改，确定退出吗？草稿会保留在这台设备上。")) return;
    try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch (err) {}
    location.reload();
  });

  function start() {
    $("#login").hidden = true;
    $("#app").hidden = false;
    $("#loading").hidden = false;
    $("#loading").textContent = "正在载入网站内容…";
    return loadAll().then(function () {
      restoreDrafts();
      var want = params.get("page");
      openPage(want && pages.has(want) ? want : "index.html");
    }).catch(function (err) {
      if (err.status === 401 || err.status === 404 || err.status === 403) showLogin(err.message);
      else { $("#loading").textContent = err.message; toast(err.message, true); }
    });
  }

  function loadAll() {
    return loadHead().then(function (h) {
      headSha = h.commit;
      treeSha = h.tree;
      return loadTree(h.tree);
    }).then(function (tree) {
      treeEntries = tree;
      var htmlEntries = tree.filter(function (e) {
        return e.type === "blob" && /\.html$/.test(e.path) && !/^(admin|scripts|\.github)\//.test(e.path);
      });
      pages = new Map();
      var done = 0;
      return Promise.all(htmlEntries.map(function (e) {
        return loadBlobText(e.sha).then(function (html) {
          pages.set(e.path, { path: e.path, sha: e.sha, html: html, orig: html, isNew: false, deleted: false, globalEdit: false });
          done++;
          $("#loading").textContent = "正在载入网站内容… " + done + " / " + htmlEntries.length;
        });
      }));
    }).then(function () {
      renderPageList();
    });
  }

  // ───────────────────────── 页面列表 ─────────────────────────
  function navOrder() {
    var home = pages.get("index.html");
    if (!home) return [];
    var nav = home.html.match(/<nav class="desktop-nav"[^>]*>([\s\S]*?)<\/nav>/);
    if (!nav) return [];
    var out = [];
    nav[1].replace(/href="([^"]+)"/g, function (_, href) { out.push(pathOf(href)); });
    return out;
  }
  function livePages() {
    return Array.from(pages.values()).filter(function (p) { return !p.deleted; });
  }
  function renderPageList() {
    var order = navOrder();
    var list = livePages();
    var main = ["index.html"].concat(order).filter(function (p, i, a) { return pages.has(p) && !pages.get(p).deleted && a.indexOf(p) === i; });
    var others = list.map(function (p) { return p.path; }).filter(function (p) { return main.indexOf(p) < 0; }).sort();
    var html = '<li class="group">导航里的栏目</li>' + main.map(item).join("") + '<li class="group">其他页面</li>' + others.map(item).join("");
    $("#page-list").innerHTML = html;
    $("#page-select").innerHTML = main.concat(others).map(function (p) {
      return '<option value="' + esc(p) + '"' + (p === current ? " selected" : "") + ">" + esc(pageLabel(pages.get(p))) + (isDirty(pages.get(p)) ? " ●" : "") + "</option>";
    }).join("");
    function item(path) {
      var p = pages.get(path);
      return '<li><button data-path="' + esc(path) + '" class="' + (path === current ? "is-on" : "") + '"><span>' + esc(pageLabel(p)) + "</span>" +
        (isDirty(p) ? '<span class="dot" title="有未发布的修改"></span>' : '<span class="path">' + esc(routeOf(path)) + "</span>") + "</button></li>";
    }
    updateCount();
  }
  $("#page-list").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-path]");
    if (b) openPage(b.dataset.path);
  });
  $("#page-select").addEventListener("change", function (e) { openPage(e.target.value); });

  function isDirty(p) { return !!p && (p.isNew || p.deleted || p.html !== p.orig); }
  function countChanges() {
    var n = 0;
    pages.forEach(function (p) { if (isDirty(p)) n++; });
    uploads.forEach(function (u) { if (!u.committed) n++; });
    return n;
  }
  function updateCount() {
    var n = countChanges();
    var c = $("#change-count");
    c.textContent = n;
    c.hidden = n === 0;
  }

  // ───────────────────────── 渲染与序列化 ─────────────────────────
  var EDITOR_CSS =
    "[data-admin-hover]{outline:2px dashed rgba(117,53,31,.55)!important;outline-offset:2px;cursor:pointer}" +
    "[data-admin-sel]{outline:2px solid #75351f!important;outline-offset:2px}" +
    "[contenteditable=true]{cursor:text;background:rgba(216,168,47,.14)!important}" +
    "html{scroll-behavior:auto!important}";

  function frameHtml(html) {
    // 去掉脚本，只保留页面本身；注入编辑高亮样式
    var out = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    // 刚上传的文件直接换成本地预览地址，避免编辑区先去网站上请求还不存在的文件
    uploads.forEach(function (u, key) {
      ["src", "poster"].forEach(function (attr) {
        out = out.split(attr + '="/' + key + '"').join(attr + '="' + u.url + '" data-admin-orig-' + attr + '="/' + key + '"');
      });
    });
    return out.replace("</head>", '<style data-admin-style>' + EDITOR_CSS + "</style></head>");
  }

  function openPage(path) {
    if (current && current !== path) serializeCurrent();
    current = path;
    selected = null;
    textSnapshotTaken = false;
    var p = pages.get(path);
    $("#loading").hidden = false;
    $("#loading").textContent = "正在打开 " + pageLabel(p) + "…";
    var scrollY = 0;
    frame.onload = function () {
      $("#loading").hidden = true;
      bindFrame();
      swapUploadUrls(frame.contentDocument);
      try { frame.contentWindow.scrollTo(0, scrollY); } catch (err) {}
      renderInspector();
    };
    frame.srcdoc = frameHtml(p.html);
    $("#live-link").href = ORIGIN + routeOf(path);
    try { history.replaceState(null, "", "?page=" + encodeURIComponent(path) + (isLocal && params.get("api") ? "&api=" + encodeURIComponent(params.get("api")) : "")); } catch (err) {}
    renderPageList();
    updateUndo();
  }

  function rerender() {
    var y = 0;
    try { y = frame.contentWindow.scrollY; } catch (err) {}
    var p = pages.get(current);
    frame.onload = function () {
      bindFrame();
      swapUploadUrls(frame.contentDocument);
      try { frame.contentWindow.scrollTo(0, y); } catch (err) {}
      selected = null;
      renderInspector();
    };
    frame.srcdoc = frameHtml(p.html);
  }

  // 换媒体地址：刚上传的文件直接用本地预览地址，原地址记在 data-admin-orig-*，保存时还原
  function setMediaSrc(el, attr, path) {
    var up = uploads.get(path.replace(/^\//, ""));
    if (up) { el.setAttribute("data-admin-orig-" + attr, path); el.setAttribute(attr, up.url); }
    else el.setAttribute(attr, path);
  }

  // 刚上传、还没上线的文件，在编辑区里用本地预览地址显示
  function swapUploadUrls(doc) {
    if (!doc) return;
    ["src", "poster"].forEach(function (attr) {
      doc.querySelectorAll("[" + attr + "]").forEach(function (el) {
        var v = el.getAttribute(attr);
        var key = v && v.replace(/^\//, "");
        if (key && uploads.has(key)) {
          el.setAttribute("data-admin-orig-" + attr, v);
          el.setAttribute(attr, uploads.get(key).url);
          if (el.tagName === "SOURCE" && el.parentElement && el.parentElement.load) el.parentElement.load();
        }
      });
    });
  }

  // 编辑区里的视频去掉播放控件（避免误点播放），保存时再恢复
  function prepEditorDoc(root) {
    root.querySelectorAll("video[controls]").forEach(function (v) {
      v.removeAttribute("controls");
      v.setAttribute("data-admin-had-controls", "");
    });
  }

  // 在一个不显示的文档里复制，复制品里的图片、视频不会去网络请求
  var INERT_DOC = document.implementation.createHTMLDocument("");
  function cleanClone(node) {
    var clone = INERT_DOC.importNode(node, true);
    if (clone.querySelectorAll) {
      clone.querySelectorAll("[data-admin-had-controls]").forEach(function (v) { v.setAttribute("controls", ""); });
      if (clone.hasAttribute && clone.hasAttribute("data-admin-had-controls")) clone.setAttribute("controls", "");
    }
    var all = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll("*")));
    all.forEach(function (el) {
      if (!el.attributes) return;
      Array.prototype.slice.call(el.attributes).forEach(function (a) {
        if (a.name.indexOf("data-admin-orig-") === 0) {
          el.setAttribute(a.name.slice("data-admin-orig-".length), a.value);
          el.removeAttribute(a.name);
        } else if (a.name.indexOf("data-admin-") === 0 || a.name === "contenteditable" || a.name === "spellcheck") {
          el.removeAttribute(a.name);
        } else if (a.name === "style" && !a.value.trim()) {
          el.removeAttribute(a.name); // 浏览器打字时可能留下空的 style=""
        }
      });
    });
    clone.querySelectorAll("[data-admin-style]").forEach(function (s) { s.remove(); });
    return clone;
  }

  function serializeCurrent() {
    var p = pages.get(current);
    var doc = frame.contentDocument;
    if (!p || !doc || !doc.body) return;
    var body = cleanClone(doc.body).outerHTML;
    var next = p.html.replace(/<body[\s\S]*<\/body>/, function () { return body; });
    if (next !== p.html) {
      p.html = next;
      scheduleDraft(p);
    }
  }

  function markDirty(global) {
    var p = pages.get(current);
    if (global) p.globalEdit = true;
    serializeCurrent();
    renderPageList();
  }

  // ───────────────────────── 草稿（防刷新丢失） ─────────────────────────
  function scheduleDraft(p) {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () { saveDraft(p); }, 800);
  }
  function saveDraft(p) {
    try {
      if (isDirty(p)) localStorage.setItem(DRAFT_PREFIX + p.path, JSON.stringify({ base: p.sha || null, html: p.html, isNew: p.isNew, deleted: p.deleted, globalEdit: p.globalEdit }));
      else localStorage.removeItem(DRAFT_PREFIX + p.path);
    } catch (err) { /* 存储已满或被禁用时忽略 */ }
  }
  function clearDrafts() {
    try {
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf(DRAFT_PREFIX) === 0) localStorage.removeItem(k); });
    } catch (err) {}
  }
  function restoreDrafts() {
    var found = [];
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf(DRAFT_PREFIX) !== 0) return;
        var path = k.slice(DRAFT_PREFIX.length);
        var d = JSON.parse(localStorage.getItem(k));
        var p = pages.get(path);
        if (d.isNew && !p) found.push({ path: path, d: d });
        else if (p && d.base === p.sha) found.push({ path: path, d: d });
        else localStorage.removeItem(k); // 网站已经更新过，草稿作废
      });
    } catch (err) { return; }
    if (!found.length) return;
    var names = found.map(function (f) { return f.d.isNew ? f.path : pageLabel(pages.get(f.path)); });
    if (window.confirm("这台设备上有上次没发布的修改（" + names.join("、") + "）。要恢复吗？")) {
      found.forEach(function (f) {
        var p = pages.get(f.path) || { path: f.path, sha: null, orig: "", isNew: true };
        p.html = f.d.html; p.deleted = !!f.d.deleted; p.globalEdit = !!f.d.globalEdit; p.isNew = !!f.d.isNew;
        pages.set(f.path, p);
      });
      renderPageList();
    } else {
      clearDrafts();
    }
  }

  // ───────────────────────── 撤销 ─────────────────────────
  function pushUndo() {
    var doc = frame.contentDocument;
    if (!doc) return;
    var stack = undoStacks.get(current) || [];
    stack.push(cleanClone(doc.body).innerHTML);
    if (stack.length > 60) stack.shift();
    undoStacks.set(current, stack);
    updateUndo();
  }
  function updateUndo() {
    var s = undoStacks.get(current);
    $("#undo-btn").disabled = !s || !s.length;
  }
  function undo() {
    var stack = undoStacks.get(current);
    if (!stack || !stack.length) return;
    var doc = frame.contentDocument;
    doc.body.innerHTML = stack.pop();
    prepEditorDoc(doc);
    swapUploadUrls(doc);
    selected = null;
    textSnapshotTaken = false;
    markDirty(false);
    renderInspector();
    updateUndo();
  }
  $("#undo-btn").addEventListener("click", undo);

  // ───────────────────────── 编辑区交互 ─────────────────────────
  function blockRoot(doc) {
    var main = doc.querySelector("main") || doc.body;
    var root = main;
    while (root.children.length === 1 && /^(ARTICLE|DIV)$/.test(root.firstElementChild.tagName)) root = root.firstElementChild;
    return root;
  }
  function isGlobalArea(el) { return !!(el && el.closest && el.closest("header.site-header, footer.site-footer")); }
  function hasOwnText(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  }
  function isTextEditable(el) {
    if (!el || !TEXT_TAGS.test(el.tagName)) return false;
    if (!hasOwnText(el)) return false;
    return !Array.prototype.some.call(el.querySelectorAll("*"), function (c) { return BLOCK_TAGS.test(c.tagName) && c.tagName !== "SPAN"; });
  }
  function selectable(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.tagName === "SOURCE" || el.tagName === "BR") return el.parentElement;
    if (/^(HTML|BODY|MAIN)$/.test(el.tagName)) return null;
    return el;
  }

  function bindFrame() {
    var doc = frame.contentDocument;
    var hovered = null;
    doc.addEventListener("mouseover", function (e) {
      var el = selectable(e.target);
      if (hovered && hovered !== el) hovered.removeAttribute("data-admin-hover");
      hovered = el;
      if (el && el !== selected) el.setAttribute("data-admin-hover", "");
    });
    doc.addEventListener("mouseout", function (e) {
      if (e.target && e.target.removeAttribute) e.target.removeAttribute("data-admin-hover");
    });
    doc.addEventListener("click", function (e) {
      var el = selectable(e.target);
      if (!el) return;
      if (el.isContentEditable && el === selected) return; // 正在打字，不打断
      e.preventDefault();
      e.stopPropagation();
      select(el);
    }, true);
    doc.addEventListener("submit", function (e) { e.preventDefault(); }, true);
    doc.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && /^[biu]$/i.test(e.key)) { e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !(selected && selected.isContentEditable)) { e.preventDefault(); undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); openPublish(); return; }
      if (e.key === "Escape") { select(null); return; }
      if (e.key === "Enter" && e.target.isContentEditable) {
        e.preventDefault();
        if (!doc.execCommand("insertLineBreak")) doc.execCommand("insertHTML", false, "<br>");
      }
    });
    doc.addEventListener("beforeinput", function (e) {
      if (e.target.isContentEditable && !textSnapshotTaken) { pushUndoFromText(); }
    });
    doc.addEventListener("input", function (e) {
      if (e.target.isContentEditable) markDirty(isGlobalArea(e.target));
    });
    doc.addEventListener("paste", function (e) {
      if (!e.target.isContentEditable) return;
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData("text/plain");
      doc.execCommand("insertText", false, text.replace(/\r\n?/g, "\n"));
    });
    ["dragover", "drop"].forEach(function (t) { doc.addEventListener(t, function (e) { e.preventDefault(); }); });
    prepEditorDoc(doc);
  }

  function pushUndoFromText() {
    // 文字修改前先记下一次快照，撤销时整段回到改之前
    pushUndo();
    textSnapshotTaken = true;
  }

  function select(el) {
    var doc = frame.contentDocument;
    if (el && doc && (el.contains(blockRoot(doc)) || el.closest("head"))) el = null;
    if (selected) {
      selected.removeAttribute("data-admin-sel");
      if (selected.isContentEditable) { selected.removeAttribute("contenteditable"); selected.removeAttribute("spellcheck"); }
    }
    selected = el;
    textSnapshotTaken = false;
    if (el) {
      el.removeAttribute("data-admin-hover");
      el.setAttribute("data-admin-sel", "");
      if (isTextEditable(el)) {
        el.setAttribute("contenteditable", "true");
        el.setAttribute("spellcheck", "false");
        el.focus();
      }
    }
    renderInspector();
    if (doc && !el) doc.getSelection().removeAllRanges();
  }

  // ───────────────────────── 属性面板 ─────────────────────────
  function kindOf(el) {
    var t = el.tagName;
    if (t === "IMG") return "图片";
    if (t === "VIDEO") return "视频";
    if (t === "AUDIO") return "音频";
    if (/^H[1-6]$/.test(t)) return "标题";
    if (t === "A") return "链接";
    if (t === "P") return "段落";
    if (t === "LI") return "列表项";
    if (t === "BLOCKQUOTE") return "引语";
    if (t === "FIGURE") return "图文组";
    if (t === "FIGCAPTION") return "图注";
    if (t === "NAV") return "导航";
    if (isBlock(el)) return "板块";
    if (t === "ARTICLE") return "卡片";
    if (t === "SPAN" || t === "SMALL" || t === "STRONG" || t === "B") return "文字";
    return "区域";
  }
  function isBlock(el) {
    var doc = frame.contentDocument;
    return el.parentElement === blockRoot(doc);
  }
  function ancestry(el) {
    var doc = frame.contentDocument;
    var root = blockRoot(doc);
    var chain = [];
    var n = el;
    while (n && n !== doc.body && n !== root && n.tagName !== "MAIN") { chain.push(n); n = n.parentElement; }
    return chain; // 从选中元素到板块
  }
  function snippet(el) {
    var t = (el.textContent || "").replace(/\s+/g, " ").trim();
    return t.length > 18 ? t.slice(0, 18) + "…" : t;
  }

  function renderInspector() {
    var box = $("#inspector-body");
    var p = pages.get(current);
    if (!selected) {
      box.innerHTML =
        '<p class="insp-kind">' + esc(pageLabel(p)) + "</p>" +
        '<p class="insp-hint">' + esc(routeOf(current)) + "</p>" +
        '<div class="empty"><p>在页面上点一下要改的地方：</p><ul>' +
        "<li>文字：点中后直接打字，回车换行。</li>" +
        "<li>图片和视频：点中后在这里更换。</li>" +
        "<li>板块：点中后可上移、下移、复制、删除，或插入新板块。</li>" +
        "<li>页眉、页脚的改动会同步到所有页面。</li></ul>" +
        '<p>改完点右上角“发布”。</p></div>' +
        '<div class="insp-section"><h3>整页操作</h3><div class="insp-row">' +
        '<button class="btn ghost small" data-op="append-block">在页面末尾加一个板块</button></div></div>';
      bindInspector();
      return;
    }
    var el = selected;
    var html = '<p class="insp-kind">' + kindOf(el) + "</p>";
    if (el.isContentEditable) html += '<p class="insp-hint">直接在页面上修改文字。回车换行，粘贴时会自动去掉格式。</p>';
    if (isGlobalArea(el)) html += '<p class="note">这里是页眉或页脚，改动发布时会同步到全站所有页面。</p>';

    // 图片
    if (el.tagName === "IMG") {
      html += '<div class="insp-section"><h3>图片</h3><img class="thumb" src="' + esc(el.getAttribute("src")) + '" alt="">' +
        '<div class="insp-row"><button class="btn primary small" data-op="upload-image">上传新图片</button>' +
        '<button class="btn ghost small" data-op="pick-image">从网站图库选择</button></div>' +
        '<label class="field" style="margin-top:10px"><span>图片说明（给读屏软件和搜索引擎）</span><input data-attr="alt" value="' + esc(el.getAttribute("alt") || "") + '"></label></div>';
    }
    // 视频
    if (el.tagName === "VIDEO") {
      var src = el.querySelector("source") ? el.querySelector("source").getAttribute("src") : el.getAttribute("src");
      html += '<div class="insp-section"><h3>视频</h3><p class="insp-hint">' + esc(src || "") + "</p>" +
        '<div class="insp-row"><button class="btn primary small" data-op="upload-video">上传新视频（MP4）</button>' +
        '<button class="btn ghost small" data-op="pick-video">从网站视频中选择</button></div>' +
        '<p class="insp-hint" style="margin-top:8px">发布后，网站会自动压缩视频并生成封面，通常需要几分钟。</p>' +
        '<label class="field"><span>视频说明</span><input data-attr="aria-label" value="' + esc(el.getAttribute("aria-label") || "") + '"></label></div>';
    }
    if (el.tagName === "AUDIO") {
      html += '<div class="insp-section"><h3>音频</h3><div class="insp-row"><button class="btn primary small" data-op="upload-audio">上传新音频</button></div></div>';
    }
    // 链接
    var a = el.closest("a");
    if (a) {
      var href = a.getAttribute("href") || "";
      var opts = livePages().map(function (pg) {
        var r = routeOf(pg.path);
        return '<option value="' + esc(r) + '"' + (r === href ? " selected" : "") + ">" + esc(pageLabel(pg)) + "（" + esc(r) + "）</option>";
      }).join("");
      html += '<div class="insp-section"><h3>链接</h3>' +
        '<label class="field"><span>跳转到站内页面</span><select data-op="link-page"><option value="">— 选择页面 —</option>' + opts + "</select></label>" +
        '<label class="field"><span>或填写网址</span><input data-link value="' + esc(href) + '"></label>' +
        '<label class="check"><input type="checkbox" data-link-blank' + (a.getAttribute("target") === "_blank" ? " checked" : "") + "> 在新窗口打开</label></div>";
    }
    // 结构
    var chain = ancestry(el);
    html += '<div class="insp-section"><h3>位置与结构</h3><ul class="crumbs">' +
      chain.slice().reverse().map(function (n, i, arr) {
        var depth = i;
        return '<li><button data-crumb="' + (chain.length - 1 - i) + '" class="' + (n === el ? "is-on" : "") + '" style="padding-left:' + (6 + depth * 10) + 'px">' +
          kindOf(n) + (snippet(n) ? "：" + esc(snippet(n)) : "") + "</button></li>";
      }).join("") + "</ul>" +
      '<div class="insp-row">' +
      '<button class="btn ghost small" data-op="up">上移</button>' +
      '<button class="btn ghost small" data-op="down">下移</button>' +
      '<button class="btn ghost small" data-op="dup">复制一份</button>' +
      '<button class="btn danger small" data-op="del">删除</button></div>';
    if (isBlock(el)) {
      html += '<div class="insp-row" style="margin-top:8px"><button class="btn ghost small" data-op="insert-before">在上面插入板块</button>' +
        '<button class="btn ghost small" data-op="insert-after">在下面插入板块</button></div>';
    } else {
      html += '<p class="insp-hint" style="margin-top:8px">要移动整个板块，先在上面的层级里点“板块”。</p>';
    }
    html += "</div>";
    box.innerHTML = html;
    bindInspector();
  }

  function bindInspector() {
    var box = $("#inspector-body");
    box.querySelectorAll("[data-crumb]").forEach(function (b) {
      b.onclick = function () { select(ancestry(selected)[Number(b.dataset.crumb)]); };
    });
    box.querySelectorAll("[data-op]").forEach(function (b) {
      var op = b.dataset.op;
      if (b.tagName === "SELECT") { b.onchange = function () { if (b.value) setLink(b.value); }; return; }
      b.onclick = function () { runOp(op); };
    });
    box.querySelectorAll("[data-attr]").forEach(function (inp) {
      inp.onfocus = function () { pushUndo(); };
      inp.oninput = function () { selected.setAttribute(inp.dataset.attr, inp.value); markDirty(isGlobalArea(selected)); };
    });
    var link = box.querySelector("[data-link]");
    if (link) {
      link.onfocus = function () { pushUndo(); };
      link.onchange = function () { setLink(link.value.trim(), true); };
    }
    var blank = box.querySelector("[data-link-blank]");
    if (blank) blank.onchange = function () {
      pushUndo();
      var a = selected.closest("a");
      if (blank.checked) { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener"); }
      else { a.removeAttribute("target"); a.removeAttribute("rel"); }
      markDirty(isGlobalArea(a));
    };
  }

  function setLink(href, already) {
    if (!already) pushUndo();
    var a = selected.closest("a");
    a.setAttribute("href", href);
    markDirty(isGlobalArea(a));
    renderInspector();
  }

  function runOp(op) {
    var el = selected;
    var doc = frame.contentDocument;
    if (el && /^(up|down|dup|del)$/.test(op) && el.matches("header.site-header, footer.site-footer")) {
      return toast("页眉和页脚是全站共用的，不能整体移动或删除；可以修改里面的内容");
    }
    switch (op) {
      case "up":
        var prev = el.previousElementSibling;
        if (!prev) return toast("已经在最上面了");
        pushUndo(); el.parentElement.insertBefore(el, prev); break;
      case "down":
        var next = el.nextElementSibling;
        if (!next) return toast("已经在最下面了");
        pushUndo(); el.parentElement.insertBefore(next, el); break;
      case "dup":
        pushUndo();
        var copy = cleanClone(el);
        copy.querySelectorAll("[data-sss]").forEach(function (n) { n.removeAttribute("data-sss"); });
        if (copy.removeAttribute) copy.removeAttribute("data-sss");
        el.after(copy);
        prepEditorDoc(copy.parentElement);
        swapUploadUrls(doc);
        markDirty(isGlobalArea(el));
        select(copy);
        copy.scrollIntoView({ block: "nearest" });
        return;
      case "del":
        var global = isGlobalArea(el);
        pushUndo(); el.remove(); selected = null; markDirty(global); renderInspector(); return;
      case "insert-before": return openLibrary(el, "before");
      case "insert-after": return openLibrary(el, "after");
      case "append-block": return openLibrary(null, "end");
      case "upload-image": return pickFile("image/*", replaceImage);
      case "pick-image": return openMediaPicker("image", function (path) { replaceImagePath("/" + path); });
      case "upload-video": return pickFile("video/mp4", replaceVideo);
      case "pick-video": return openMediaPicker("video", function (path) { setVideoSrc("/" + path); });
      case "upload-audio": return pickFile("audio/*", replaceAudio);
    }
    markDirty(isGlobalArea(el));
    el.scrollIntoView({ block: "nearest" });
    renderInspector();
  }

  // ───────────────────────── 板块库 ─────────────────────────
  function blocksOf(html) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    return Array.prototype.slice.call(blockRoot(doc).children);
  }
  function blockLabel(b) {
    var h = b.querySelector("h1, h2, h3");
    var eyebrow = b.querySelector("p");
    var text = (h && h.textContent.trim()) || (eyebrow && eyebrow.textContent.trim()) || b.textContent.trim();
    text = text.replace(/\s+/g, " ");
    return text.length > 28 ? text.slice(0, 28) + "…" : text || "（无文字板块）";
  }
  function openLibrary(anchor, where) {
    serializeCurrent();
    var groups = livePages().map(function (pg) {
      var blocks = blocksOf(pg.html);
      if (!blocks.length) return "";
      return '<div class="lib-group"><h3>' + esc(pageLabel(pg)) + "</h3>" + blocks.map(function (b, i) {
        var counts = [];
        var imgs = b.querySelectorAll("img").length, vids = b.querySelectorAll("video").length;
        if (imgs) counts.push(imgs + " 张图");
        if (vids) counts.push(vids + " 段视频");
        return '<button class="lib-item" data-page="' + esc(pg.path) + '" data-i="' + i + '"><span>' + esc(blockLabel(b)) + "</span><small>" + counts.join("，") + "</small></button>";
      }).join("") + "</div>";
    }).join("");
    openModal("插入板块", '<p class="insp-hint">从网站现有的板块里选一个样式，复制一份插进来，再在页面上改成新内容。</p>' + groups);
    $("#modal-body").querySelectorAll(".lib-item").forEach(function (b) {
      b.onclick = function () {
        var src = blocksOf(pages.get(b.dataset.page).html)[Number(b.dataset.i)];
        var html = src.outerHTML.replace(/\sdata-sss="[^"]*"/g, "");
        closeModal();
        insertBlock(html, anchor, where);
      };
    });
  }
  function insertBlock(html, anchor, where) {
    var doc = frame.contentDocument;
    pushUndo();
    var tpl = doc.createElement("template");
    tpl.innerHTML = html;
    var node = tpl.content.firstElementChild;
    if (where === "before") anchor.before(node);
    else if (where === "after") anchor.after(node);
    else blockRoot(doc).appendChild(node);
    prepEditorDoc(node);
    swapUploadUrls(doc);
    markDirty(false);
    select(node);
    node.scrollIntoView({ block: "start" });
    toast("已插入板块，现在可以逐项修改文字和图片");
  }

  // ───────────────────────── 上传与图库 ─────────────────────────
  function pickFile(accept, cb) {
    var input = $("#file-input");
    input.value = "";
    input.accept = accept;
    input.onchange = function () { if (input.files[0]) cb(input.files[0]); };
    input.click();
  }
  function slugName(name) {
    var base = name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return (base || "file").slice(0, 40);
  }
  function uploadPath(name, ext) {
    var d = new Date();
    var ym = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0");
    return "media/uploads/" + ym + "/" + slugName(name) + "-" + Date.now().toString(36) + "." + ext;
  }
  function addUpload(path, blob) {
    uploads.set(path, { blob: blob, url: URL.createObjectURL(blob), committed: false });
    updateCount();
  }
  function compressImage(file) {
    if (/svg|gif/.test(file.type)) return Promise.resolve({ blob: file, ext: file.type.indexOf("svg") >= 0 ? "svg" : "gif" });
    return createImageBitmap(file).then(function (bmp) {
      var max = 1600;
      var scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      return new Promise(function (resolve) {
        canvas.toBlob(function (b) {
          if (b && b.type === "image/webp") resolve({ blob: b, ext: "webp" });
          else canvas.toBlob(function (j) { resolve({ blob: j, ext: "jpg" }); }, "image/jpeg", 0.85);
        }, "image/webp", 0.82);
      });
    });
  }
  function replaceImage(file) {
    if (!/^image\//.test(file.type)) return toast("请选择图片文件", true);
    var target = selected;
    toast("正在压缩图片…");
    compressImage(file).then(function (r) {
      var path = uploadPath(file.name, r.ext);
      addUpload(path, r.blob);
      selected = target;
      replaceImagePath("/" + path);
      toast("图片已替换（" + Math.round(r.blob.size / 1024) + " KB），发布后上线");
    }).catch(function () { toast("这张图片无法读取，请换一张试试", true); });
  }
  function replaceImagePath(path) {
    var img = selected;
    pushUndo();
    img.removeAttribute("data-admin-orig-src");
    img.removeAttribute("srcset");
    setMediaSrc(img, "src", path);
    markDirty(isGlobalArea(img));
    renderInspector();
  }
  function replaceVideo(file) {
    if (file.type !== "video/mp4") return toast("请先把视频导出为 MP4 格式再上传", true);
    if (file.size > 95 * 1024 * 1024) return toast("视频超过 95 MB，请先压缩或剪短", true);
    var path = uploadPath(file.name, "mp4");
    addUpload(path, file);
    setVideoSrc("/" + path);
    toast("视频已替换，发布后网站会自动压缩并生成封面");
  }
  function setVideoSrc(path) {
    var v = selected;
    pushUndo();
    var s = v.querySelector("source");
    if (s) { s.removeAttribute("data-admin-orig-src"); setMediaSrc(s, "src", path); }
    else { v.removeAttribute("data-admin-orig-src"); setMediaSrc(v, "src", path); }
    v.removeAttribute("poster");
    v.removeAttribute("data-admin-orig-poster");
    if (v.load) v.load();
    markDirty(false);
    renderInspector();
  }
  function replaceAudio(file) {
    var a = selected;
    var ext = (file.name.split(".").pop() || "m4a").toLowerCase();
    var path = uploadPath(file.name, ext);
    addUpload(path, file);
    pushUndo();
    var s = a.querySelector("source");
    setMediaSrc(s || a, "src", "/" + path);
    if (s && a.load) a.load();
    markDirty(false);
    renderInspector();
  }
  function openMediaPicker(kind, cb) {
    var re = kind === "image" ? /\.(webp|jpe?g|png|gif|svg)$/i : /\.mp4$/i;
    var files = treeEntries.filter(function (e) { return e.type === "blob" && /^media\//.test(e.path) && !/^media\/posters\//.test(e.path) && re.test(e.path); })
      .map(function (e) { return e.path; });
    uploads.forEach(function (u, path) { if (re.test(path) && files.indexOf(path) < 0) files.unshift(path); });
    var body = '<div class="media-grid">' + files.map(function (f) {
      var url = uploads.has(f) ? uploads.get(f).url : "/" + f;
      var inner = kind === "image" ? '<img loading="lazy" src="' + esc(url) + '" alt="">' :
        '<img loading="lazy" src="/media/posters/' + esc(f.slice(6, -4).replace(/\//g, "-")) + '.webp" alt="" onerror="this.replaceWith(document.createTextNode(\'' + esc(f.split("/").pop()) + '\'))">';
      return '<button data-path="' + esc(f) + '" title="' + esc(f) + '">' + inner + "</button>";
    }).join("") + "</div>";
    openModal(kind === "image" ? "从网站图库选择图片" : "从网站视频中选择", body);
    $("#modal-body").querySelectorAll("[data-path]").forEach(function (b) {
      b.onclick = function () { closeModal(); cb(b.dataset.path); };
    });
  }

  // ───────────────────────── 弹窗 ─────────────────────────
  var modalOnClose = null;
  function openModal(title, html, onClose) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    $("#modal").hidden = false;
    modalOnClose = onClose || null;
  }
  function closeModal(silent) {
    $("#modal").hidden = true;
    var cb = modalOnClose;
    modalOnClose = null;
    if (!silent && cb) cb();
  }
  $("#modal-close").addEventListener("click", function () { closeModal(); });
  $("#modal").addEventListener("click", function (e) { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !$("#modal").hidden) closeModal();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && !$("#app").hidden) { e.preventDefault(); openPublish(); }
  });

  // ───────────────────────── 设备切换 ─────────────────────────
  document.querySelectorAll("[data-device]").forEach(function (b) {
    b.addEventListener("click", function () {
      device = b.dataset.device;
      document.querySelectorAll("[data-device]").forEach(function (x) { x.classList.toggle("is-on", x === b); });
      $("#frame-wrap").classList.toggle("mobile", device === "mobile");
    });
  });

  // ───────────────────────── 页面设置 ─────────────────────────
  function headMeta(html, attr, key) {
    var m = html.match(new RegExp("<meta " + attr + '="' + key + '" content="([^"]*)"'));
    return m ? m[1] : "";
  }
  function setHeadMeta(html, attr, key, value) {
    var re = new RegExp("<meta " + attr + '="' + key + '" content="[^"]*"(\\s*/?)>');
    var tag = "<meta " + attr + '="' + key + '" content="' + esc(value) + '"/>';
    return re.test(html) ? html.replace(re, function () { return tag; }) : html.replace("</head>", function () { return tag + "</head>"; });
  }
  function unescapeAttr(s) {
    var t = document.createElement("textarea");
    t.innerHTML = s;
    return t.value;
  }
  function applySettings(p, title, desc, image) {
    var h = p.html;
    h = h.replace(/<title>[^<]*<\/title>/, function () { return "<title>" + esc(title) + "</title>"; });
    h = setHeadMeta(h, "property", "og:title", title);
    h = setHeadMeta(h, "name", "twitter:title", title);
    h = setHeadMeta(h, "name", "description", desc);
    h = setHeadMeta(h, "property", "og:description", desc);
    h = setHeadMeta(h, "name", "twitter:description", desc);
    if (image) {
      h = setHeadMeta(h, "property", "og:image", image);
      h = setHeadMeta(h, "name", "twitter:image", image);
    }
    p.html = h;
  }

  $("#settings-btn").addEventListener("click", function () {
    serializeCurrent();
    var p = pages.get(current);
    var title = unescapeAttr((p.html.match(/<title>([^<]*)<\/title>/) || [])[1] || "");
    var desc = unescapeAttr(headMeta(p.html, "name", "description"));
    var image = unescapeAttr(headMeta(p.html, "property", "og:image"));
    var canDelete = current !== "index.html" && current !== "404.html";
    openModal("页面设置：" + pageLabel(p),
      '<label class="field"><span>浏览器标题（也是分享卡片的标题）</span><input id="set-title" value="' + esc(title) + '"></label>' +
      '<label class="field"><span>页面描述（搜索结果与分享卡片里的一两句话）</span><textarea id="set-desc">' + esc(desc) + "</textarea></label>" +
      '<label class="field"><span>分享图片</span><input id="set-image" value="' + esc(image) + '"></label>' +
      '<div class="insp-row"><button class="btn ghost small" id="set-image-up">上传分享图</button><button class="btn ghost small" id="set-image-pick">从图库选择</button></div>' +
      '<p class="insp-hint" style="margin-top:12px">网址：' + esc(ORIGIN + routeOf(current)) + "</p>" +
      '<div class="modal-actions">' + (canDelete ? '<button class="btn danger" id="set-delete" style="margin-right:auto">删除这个页面</button>' : "") +
      '<button class="btn primary" id="set-save">保存设置</button></div>');
    $("#set-image-up").onclick = function () {
      pickFile("image/*", function (file) {
        compressImage(file).then(function (r) {
          var path = uploadPath(file.name, r.ext);
          addUpload(path, r.blob);
          $("#set-image").value = ORIGIN + "/" + path;
        });
      });
    };
    $("#set-image-pick").onclick = function () {
      var keep = { title: $("#set-title").value, desc: $("#set-desc").value };
      openMediaPicker("image", function (path) {
        $("#settings-btn").click();
        $("#set-title").value = keep.title; $("#set-desc").value = keep.desc;
        $("#set-image").value = ORIGIN + "/" + path;
      });
    };
    $("#set-save").onclick = function () {
      applySettings(p, $("#set-title").value.trim(), $("#set-desc").value.trim(), $("#set-image").value.trim());
      closeModal(true);
      saveDraft(p);
      renderPageList();
      toast("页面设置已更新，发布后生效");
    };
    if (canDelete) $("#set-delete").onclick = function () { deletePage(current); };
  });

  function inboundLinks(path) {
    var route = routeOf(path);
    var hits = [];
    livePages().forEach(function (pg) {
      if (pg.path === path) return;
      var body = pg.html.replace(/<nav class="desktop-nav"[\s\S]*?<\/nav>|<nav aria-label="移动端主导航">[\s\S]*?<\/nav>|<div class="footer-links">[\s\S]*?<\/div>/g, "");
      if (body.indexOf('href="' + route + '"') >= 0 || body.indexOf('href="' + route + '#') >= 0) hits.push(pageLabel(pg));
    });
    return hits;
  }
  function deletePage(path) {
    var hits = inboundLinks(path);
    if (hits.length) {
      openModal("还不能删除", '<p>这些页面里还有指向它的链接，请先把链接改掉或删掉：</p><ul>' + hits.map(function (h) { return "<li>" + esc(h) + "</li>"; }).join("") + "</ul>");
      return;
    }
    confirmBox("删除页面", "<p>确定删除「" + esc(pageLabel(pages.get(path))) + "」吗？导航里的入口会一起去掉。发布后生效，之后也可以在历史版本里找回。</p>", "删除", true).then(function (ok) {
      if (!ok) return;
      var p = pages.get(path);
      if (p.isNew) pages.delete(path); else p.deleted = true;
      var items = readNav().filter(function (it) { return pathOf(it.href) !== path; });
      writeNav(items);
      saveDraft(p);
      openPage("index.html");
      toast("页面已删除，发布后生效");
    });
  }

  // ───────────────────────── 导航 ─────────────────────────
  function readNav() {
    var src = (pages.get("index.html") || pages.get(current)).html;
    var nav = src.match(/<nav class="desktop-nav"[^>]*>([\s\S]*?)<\/nav>/);
    if (!nav) return [];
    var items = [];
    var re = /<a href="([^"]*)"[^>]*>[\s\S]*?<span>([^<]*)<\/span><small[^>]*>([^<]*)<\/small>[\s\S]*?<\/a>/g;
    var m;
    while ((m = re.exec(nav[1]))) items.push({ href: m[1], zh: unescapeAttr(m[2]), en: unescapeAttr(m[3]) });
    return items;
  }
  function writeNav(items) {
    serializeCurrent();
    var desk = items.map(function (it) {
      return '<a href="' + esc(it.href) + '"><span class="bilingual-label"><span>' + esc(it.zh) + '</span><small lang="en">' + esc(it.en) + "</small></span></a>";
    }).join("");
    var foot = items.map(function (it) { return '<a href="' + esc(it.href) + '">' + esc(it.zh) + " <small>" + esc(it.en) + "</small></a>"; }).join("");
    livePages().forEach(function (pg) {
      var h = pg.html;
      h = h.replace(/(<nav class="desktop-nav"[^>]*>)[\s\S]*?(<\/nav>)/, function (_, a, b) { return a + desk + b; });
      h = h.replace(/(<nav aria-label="移动端主导航">)[\s\S]*?(<\/nav>)/, function (_, a, b) { return a + desk + b; });
      h = h.replace(/(<div class="footer-links">)[\s\S]*?(<\/div>)/, function (_, a, b) { return a + foot + b; });
      if (h !== pg.html) { pg.html = h; saveDraft(pg); }
    });
  }
  $("#nav-btn").addEventListener("click", openNavEditor);
  function openNavEditor() {
    serializeCurrent();
    var items = readNav();
    var pageOpts = livePages().filter(function (p) { return p.path !== "404.html"; });
    function rows() {
      return items.map(function (it, i) {
        var opts = pageOpts.map(function (p) {
          var r = routeOf(p.path);
          return '<option value="' + esc(r) + '"' + (r === it.href ? " selected" : "") + ">" + esc(pageLabel(p)) + "</option>";
        }).join("");
        return '<div class="nav-row" data-i="' + i + '">' +
          '<input data-k="zh" value="' + esc(it.zh) + '" aria-label="中文名">' +
          '<input data-k="en" value="' + esc(it.en) + '" aria-label="英文名">' +
          '<select data-k="href" aria-label="链接到">' + opts + "</select>" +
          '<span class="ops"><button class="btn ghost small" data-mv="-1" aria-label="上移">上</button><button class="btn ghost small" data-mv="1" aria-label="下移">下</button>' +
          '<button class="btn danger small" data-rm aria-label="删除">删</button></span></div>';
      }).join("");
    }
    function draw() {
      openModal("编辑导航",
        '<p class="insp-hint">这里的顺序和名字会同时用于电脑版导航、手机版目录和页脚。每行依次是：中文名、英文名、链接到的页面。</p>' +
        '<div class="nav-rows" id="nav-rows">' + rows() + "</div>" +
        '<div class="modal-actions"><button class="btn ghost" id="nav-add" style="margin-right:auto">加一个栏目</button><button class="btn primary" id="nav-save">保存导航</button></div>');
      var box = $("#nav-rows");
      box.querySelectorAll("input, select").forEach(function (inp) {
        inp.oninput = inp.onchange = function () { items[Number(inp.closest(".nav-row").dataset.i)][inp.dataset.k] = inp.value; };
      });
      box.querySelectorAll("[data-mv]").forEach(function (b) {
        b.onclick = function () {
          var i = Number(b.closest(".nav-row").dataset.i), j = i + Number(b.dataset.mv);
          if (j < 0 || j >= items.length) return;
          var t = items[i]; items[i] = items[j]; items[j] = t; draw();
        };
      });
      box.querySelectorAll("[data-rm]").forEach(function (b) {
        b.onclick = function () { items.splice(Number(b.closest(".nav-row").dataset.i), 1); draw(); };
      });
      $("#nav-add").onclick = function () { items.push({ zh: "新栏目", en: "NEW", href: routeOf(pageOpts[0].path) }); draw(); };
      $("#nav-save").onclick = function () {
        if (items.some(function (it) { return !it.zh.trim(); })) return toast("每个栏目都需要中文名", true);
        writeNav(items);
        closeModal(true);
        rerender();
        renderPageList();
        toast("导航已更新到全部页面，发布后生效");
      };
    }
    draw();
  }

  // ───────────────────────── 新建页面 ─────────────────────────
  $("#newpage-btn").addEventListener("click", openNewPage);
  $("#newpage-btn-2").addEventListener("click", openNewPage);
  function openNewPage() {
    serializeCurrent();
    var opts = livePages().filter(function (p) { return p.path !== "404.html"; }).map(function (p) {
      return '<option value="' + esc(p.path) + '"' + (p.path === "about/index.html" ? " selected" : "") + ">" + esc(pageLabel(p)) + "</option>";
    }).join("");
    openModal("新建页面",
      '<label class="field"><span>页面名称（中文）</span><input id="np-zh" placeholder="例如：松茸季"></label>' +
      '<label class="field"><span>英文名（可选）</span><input id="np-en" placeholder="例如：Matsutake Season"></label>' +
      '<label class="field"><span>网址路径（小写英文、数字和短横线）</span><input id="np-slug" placeholder="例如：matsutake"></label>' +
      '<label class="field"><span>版式参照</span><select id="np-base">' + opts + "</select></label>" +
      '<label class="field"><span>从参照页带过来</span><select id="np-scope"><option value="hero">只带第一屏板块，其余自己加</option><option value="all">全部板块，再逐个修改</option></select></label>' +
      '<label class="check"><input type="checkbox" id="np-nav"> 加入导航</label>' +
      '<div class="modal-actions"><button class="btn primary" id="np-create">创建页面</button></div>');
    $("#np-zh").focus();
    $("#np-create").onclick = function () {
      var zh = $("#np-zh").value.trim(), en = $("#np-en").value.trim();
      var slug = $("#np-slug").value.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
      if (!zh) return toast("请填写页面名称", true);
      if (!/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/.test(slug)) return toast("网址路径只能用小写英文、数字和短横线", true);
      if (/^(admin|media|assets|scripts)(\/|$)/.test(slug)) return toast("这个路径是网站保留的，请换一个", true);
      var path = slug + "/index.html";
      if (pages.has(path) && !pages.get(path).deleted) return toast("这个网址已经有页面了", true);
      var base = pages.get($("#np-base").value);
      var html = makePage(base.html, path, zh, en, $("#np-scope").value === "hero");
      pages.set(path, { path: path, sha: null, html: html, orig: "", isNew: true, deleted: false, globalEdit: false });
      if ($("#np-nav").checked) {
        var items = readNav();
        items.push({ zh: zh, en: (en || slug).toUpperCase(), href: routeOf(path) });
        writeNav(items);
      }
      saveDraft(pages.get(path));
      closeModal(true);
      openPage(path);
      toast("页面已创建。点页面上的文字直接改，改完记得发布");
    };
  }
  function makePage(baseHtml, path, zh, en, heroOnly) {
    var route = routeOf(path);
    var title = zh + (en ? " · " + en : "") + "｜麦尼海塘";
    var h = baseHtml.replace(/<script type="application\/ld\+json"[\s\S]*?<\/script>/g, "");
    h = h.replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, function () { return '<link rel="canonical" href="' + ORIGIN + route + '"/>'; });
    var tmp = { html: h };
    applySettings(tmp, title, zh + "。麦尼海塘，在远方。", "");
    h = setHeadMeta(tmp.html, "property", "og:url", ORIGIN + route);
    var bodyMatch = h.match(/<body[\s\S]*<\/body>/);
    var doc = new DOMParser().parseFromString("<!DOCTYPE html><html><head></head>" + bodyMatch[0] + "</html>", "text/html");
    var root = blockRoot(doc);
    if (heroOnly) Array.prototype.slice.call(root.children).slice(1).forEach(function (n) { n.remove(); });
    doc.body.querySelectorAll("[data-sss]").forEach(function (n) { n.removeAttribute("data-sss"); });
    var h1 = root.querySelector("h1");
    if (h1) {
      var zhSpan = h1.querySelector(".title-zh");
      var enSpan = h1.querySelector(".title-en");
      if (zhSpan) zhSpan.textContent = zh; else h1.textContent = zh;
      if (enSpan) { if (en) enSpan.textContent = en.toUpperCase(); else enSpan.remove(); }
    }
    return h.replace(/<body[\s\S]*<\/body>/, function () { return doc.body.outerHTML; });
  }

  // ───────────────────────── 发布 ─────────────────────────
  $("#publish-btn").addEventListener("click", openPublish);
  function syncGlobalAreas() {
    // 页眉页脚：把被编辑页面的版本同步到所有页面
    var src = null;
    pages.forEach(function (p) { if (p.globalEdit && !p.deleted) src = p; });
    if (!src) return;
    var header = (src.html.match(/<header class="site-header">[\s\S]*?<\/header>/) || [])[0];
    var footer = (src.html.match(/<footer class="site-footer">[\s\S]*?<\/footer>/) || [])[0];
    livePages().forEach(function (pg) {
      var h = pg.html;
      if (header) h = h.replace(/<header class="site-header">[\s\S]*?<\/header>/, function () { return header; });
      if (footer) h = h.replace(/<footer class="site-footer">[\s\S]*?<\/footer>/, function () { return footer; });
      if (h !== pg.html) { pg.html = h; saveDraft(pg); }
    });
    pages.forEach(function (p) { p.globalEdit = false; });
  }
  function changeList() {
    var list = [];
    pages.forEach(function (p) {
      if (p.deleted && !p.isNew) list.push({ kind: "删除页面", label: pageLabel(p), path: p.path });
      else if (p.isNew && !p.deleted) list.push({ kind: "新建页面", label: pageLabel(p), path: p.path });
      else if (!p.deleted && p.html !== p.orig) list.push({ kind: "修改", label: pageLabel(p), path: p.path });
    });
    uploads.forEach(function (u, path) { if (!u.committed) list.push({ kind: "上传", label: path.split("/").pop() + "（" + Math.round(u.blob.size / 1024) + " KB）", path: path }); });
    return list;
  }
  function openPublish() {
    serializeCurrent();
    syncGlobalAreas();
    renderPageList();
    var list = changeList();
    if (!list.length) return toast("还没有修改，不需要发布");
    openModal("发布到网站",
      '<ul class="changes">' + list.map(function (c) { return "<li>" + esc(c.kind) + "：" + esc(c.label) + "</li>"; }).join("") + "</ul>" +
      '<label class="field"><span>这次改了什么（可选，会记在历史版本里）</span><input id="pub-note" placeholder="例如：更新松茸季图片"></label>' +
      '<div class="modal-actions"><button class="btn ghost" id="pub-discard" style="margin-right:auto">放弃全部修改</button><button class="btn primary" id="pub-go">发布到网站</button></div>');
    $("#pub-go").onclick = function () { publish($("#pub-note").value.trim(), false); };
    $("#pub-discard").onclick = function () {
      confirmBox("放弃修改", "<p>未发布的修改会全部丢掉，网站保持现在的样子。确定吗？</p>", "放弃修改", true).then(function (ok) {
        if (!ok) return;
        clearDrafts();
        uploads.forEach(function (u, k) { if (!u.committed) uploads.delete(k); });
        undoStacks.clear();
        start();
      });
    };
  }

  function publish(note, force) {
    var btn = $("#pub-go");
    if (btn) { btn.disabled = true; btn.textContent = "正在发布…"; }
    var list = changeList();
    var latest;
    return loadHead().then(function (h) {
      latest = h;
      if (h.commit === headSha || force) return [];
      // 网站在你编辑期间被更新过：检查是否碰到了同一个文件
      return loadTree(h.tree).then(function (tree) {
        var map = {};
        tree.forEach(function (e) { map[e.path] = e.sha; });
        return list.filter(function (c) {
          var p = pages.get(c.path);
          return p && !p.isNew && map[c.path] && map[c.path] !== p.sha;
        });
      });
    }).then(function (conflicts) {
      if (conflicts.length) {
        closeModal(true);
        return confirmBox("网站刚被更新过",
          "<p>你编辑期间，这些页面在别处被更新了（可能是自动整理）：</p><ul>" + conflicts.map(function (c) { return "<li>" + esc(c.label) + "</li>"; }).join("") +
          "</ul><p>继续发布会用你现在的版本覆盖它们。如果不确定，可以先取消，复制好你的改动后点“历史版本”旁的刷新重新载入。</p>", "仍然发布", true).then(function (ok) {
          if (ok) return publish(note, true);
          throw Object.assign(new Error("已取消发布"), { quiet: true });
        });
      }
      toast("正在上传…");
      var entries = [];
      var jobs = [];
      list.forEach(function (c) {
        if (c.kind === "删除页面") { entries.push({ path: c.path, mode: "100644", type: "blob", sha: null }); return; }
        if (c.kind === "上传") {
          var u = uploads.get(c.path);
          jobs.push(blobToB64(u.blob).then(function (b64) {
            return gh(repoPath + "/git/blobs", { method: "POST", body: { content: b64, encoding: "base64" } });
          }).then(function (r) { entries.push({ path: c.path, mode: "100644", type: "blob", sha: r.sha }); }));
          return;
        }
        var p = pages.get(c.path);
        jobs.push(gh(repoPath + "/git/blobs", { method: "POST", body: { content: p.html, encoding: "utf-8" } }).then(function (r) {
          p._newSha = r.sha;
          entries.push({ path: c.path, mode: "100644", type: "blob", sha: r.sha });
        }));
      });
      return Promise.all(jobs).then(function () {
        return gh(repoPath + "/git/trees", { method: "POST", body: { base_tree: latest.tree, tree: entries } });
      }).then(function (tree) {
        var names = list.filter(function (c) { return c.kind !== "上传"; }).map(function (c) { return c.label; });
        var msg = "后台发布：" + (note || (names.length ? names.slice(0, 4).join("、") + (names.length > 4 ? " 等" : "") : "上传媒体文件"));
        return gh(repoPath + "/git/commits", { method: "POST", body: { message: msg, tree: tree.sha, parents: [latest.commit] } });
      }).then(function (commit) {
        return gh(repoPath + "/git/refs/heads/" + BRANCH, { method: "PATCH", body: { sha: commit.sha, force: false } }).then(function () { return commit; });
      }).then(function (commit) {
        headSha = commit.sha;
        treeSha = commit.tree.sha;
        pages.forEach(function (p, path) {
          if (p.deleted) { pages.delete(path); return; }
          if (p._newSha) { p.sha = p._newSha; delete p._newSha; }
          p.orig = p.html;
          p.isNew = false;
        });
        uploads.forEach(function (u, path) {
          if (!u.committed) { u.committed = true; treeEntries.push({ path: path, type: "blob", sha: "" }); }
        });
        clearDrafts();
        closeModal(true);
        renderPageList();
        toast("已发布。网站通常 1–3 分钟后更新；视频封面和搜索地图会随后自动整理。");
      });
    }).catch(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = "发布到网站"; }
      if (!err.quiet) toast("发布没有成功：" + err.message, true);
    });
  }

  // ───────────────────────── 历史版本 ─────────────────────────
  $("#history-btn").addEventListener("click", function () {
    openModal("历史版本", '<p class="insp-hint">正在读取…</p>');
    Promise.all([
      gh(repoPath + "/commits?sha=" + BRANCH + "&per_page=30"),
      gh(repoPath + "/branches?per_page=100").catch(function () { return []; })
    ]).then(function (res) {
      var commits = res[0], branches = res[1].filter(function (b) { return /^backup\//.test(b.name); });
      var fmt = function (iso) { var d = new Date(iso); return d.toLocaleString("zh-CN", { hour12: false }); };
      var html = '<p class="insp-hint">恢复会新建一个版本，不会删除任何历史；恢复后仍然可以再回到现在。后台本身不受恢复影响。</p>' +
        '<div class="insp-row" style="margin-bottom:10px"><button class="btn ghost small" id="reload-btn">重新载入网站内容</button></div>';
      if (branches.length) {
        html += "<h3>备份</h3><ul class='hist'>" + branches.map(function (b) {
          return "<li><div>" + esc(b.name.replace(/^backup\//, "")) + '</div><button class="btn ghost small" data-restore="' + esc(b.commit.sha) + '" data-label="' + esc(b.name) + '">恢复到这个备份</button></li>';
        }).join("") + "</ul>";
      }
      html += "<h3>最近的发布</h3><ul class='hist'>" + commits.map(function (c, i) {
        var first = c.commit.message.split("\n")[0];
        return "<li><div><div>" + esc(first) + '</div><div class="meta">' + esc(fmt(c.commit.author.date)) + " · " + esc(c.sha.slice(0, 7)) + (i === 0 ? " · 当前版本" : "") + "</div></div>" +
          (i === 0 ? "" : '<button class="btn ghost small" data-restore="' + esc(c.sha) + '" data-label="' + esc(first) + '">恢复到这一版</button>') + "</li>";
      }).join("") + "</ul>";
      $("#modal-body").innerHTML = html;
      $("#reload-btn").onclick = function () {
        if (countChanges() && !window.confirm("未发布的修改会丢失，确定重新载入吗？")) return;
        clearDrafts(); closeModal(true); start();
      };
      $("#modal-body").querySelectorAll("[data-restore]").forEach(function (b) {
        b.onclick = function () { restoreTo(b.dataset.restore, b.dataset.label); };
      });
    }).catch(function (err) { $("#modal-body").innerHTML = '<p class="error">' + esc(err.message) + "</p>"; });
  });

  function restoreTo(sha, label) {
    confirmBox("恢复版本", "<p>把网站内容恢复到「" + esc(label) + "」时的样子？未发布的修改会丢失。</p>", "恢复", true).then(function (ok) {
      if (!ok) return;
      toast("正在恢复…");
      var latest;
      loadHead().then(function (h) {
        latest = h;
        return Promise.all([gh(repoPath + "/git/commits/" + sha), loadTree(h.tree)]);
      }).then(function (res) {
        return loadTree(res[0].tree.sha).then(function (oldTree) { return [oldTree, res[1]]; });
      }).then(function (trees) {
        var keep = function (path) { return KEEP_ON_RESTORE.some(function (k) { return path.indexOf(k) === 0; }); };
        var entries = trees[0].filter(function (e) { return e.type === "blob" && !keep(e.path); })
          .concat(trees[1].filter(function (e) { return e.type === "blob" && keep(e.path); }))
          .map(function (e) { return { path: e.path, mode: e.mode, type: "blob", sha: e.sha }; });
        return gh(repoPath + "/git/trees", { method: "POST", body: { tree: entries } });
      }).then(function (tree) {
        return gh(repoPath + "/git/commits", { method: "POST", body: { message: "后台恢复：回到「" + label + "」（" + sha.slice(0, 7) + "）", tree: tree.sha, parents: [latest.commit] } });
      }).then(function (commit) {
        return gh(repoPath + "/git/refs/heads/" + BRANCH, { method: "PATCH", body: { sha: commit.sha, force: false } });
      }).then(function () {
        clearDrafts();
        uploads.clear();
        undoStacks.clear();
        closeModal(true);
        toast("已恢复。网站通常 1–3 分钟后更新。");
        return start();
      }).catch(function (err) { toast("恢复没有成功：" + err.message, true); });
    });
  }

  // 离开前提醒
  window.addEventListener("beforeunload", function (e) {
    if (!$("#app").hidden) { serializeCurrent(); if (countChanges()) { e.preventDefault(); e.returnValue = ""; } }
  });

  // ───────────────────────── 启动 ─────────────────────────
  try { token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || ""; } catch (err) { token = ""; }
  if (token) start(); else showLogin();
})();
