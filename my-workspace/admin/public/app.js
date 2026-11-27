// Pi Admin — 前端交互
let unlocked = true; // 编辑锁已禁用：默认可直接修改
let currentResourceFilter = "all";
let resourcesCache = [];
let builtinProviders = [];
let orgData = null;
let employeesCache = [];
let currentEmployeeFilter = "all";
let editingEmployeeId = "";
let editingDepartmentId = "";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- 富文本渲染（纯前端 Markdown 子集，零 token）----------
// 先把原文整体转义，再在转义后的文本上做安全替换，杜绝 XSS。
function richInline(text) {
  let s = esc(text);
  // 行内代码 `code`
  s = s.replace(/`([^`\n]+)`/g, '<code class="rt-code">$1</code>');
  // @提及 @name（中文/字母数字/下划线/短横线），支持已有 employees 名字高亮
  s = s.replace(/@([\u4e00-\u9fa5A-Za-z0-9_-]{1,40})/g, '<span class="rt-mention">@$1</span>');
  // 粗体 **text**
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong class="rt-strong">$1</strong>');
  return s;
}
function richText(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return "";
  const lines = raw.split("\n");
  const out = [];
  let listBuf = [];
  let listType = "";
  const flushList = () => {
    if (!listBuf.length) return;
    const tag = listType === "ol" ? "ol" : "ul";
    out.push(`<${tag} class="rt-list">${listBuf.map((x) => `<li>${x}</li>`).join("")}</${tag}>`);
    listBuf = []; listType = "";
  };
  for (const line of lines) {
    const t = line.replace(/\s+$/, "");
    // 标题：# / ## / ###（结尾的 ## 也去掉）
    const h = t.match(/^(#{1,4})\s+(.+?)\s*#*$/);
    if (h) { flushList(); out.push(`<div class="rt-h rt-h${h[1].length}">${richInline(h[2])}</div>`); continue; }
    // 无序列表：- / * / • 开头
    const ul = t.match(/^\s*[-*•]\s+(.+)$/);
    if (ul) { if (listType && listType !== "ul") flushList(); listType = "ul"; listBuf.push(richInline(ul[1])); continue; }
    // 有序列表：1. / 1) 开头
    const ol = t.match(/^\s*\d+[.)、]\s+(.+)$/);
    if (ol) { if (listType && listType !== "ol") flushList(); listType = "ol"; listBuf.push(richInline(ol[1])); continue; }
    flushList();
    if (!t.trim()) { out.push('<div class="rt-gap"></div>'); continue; }
    // 结论/重点行：整行加粗或以"结论/总结/最终"开头 → 强调块
    const isKey = /^\s*(\*\*.{0,80}\*\*\s*$|(结论|总结|最终状态|关键|注意|重要)[:：])/.test(t);
    out.push(`<p class="rt-p${isKey ? " rt-key" : ""}">${richInline(t)}</p>`);
  }
  flushList();
  return out.join("");
}
/** 长回复折叠：字符数超过阈值时默认收起，点「展开全文」查看细节 */
function richMessage(text, opts = {}) {
  const raw = String(text ?? "");
  const html = richText(raw);
  if (!html) return "";
  const threshold = opts.threshold || 900;
  const id = `rm-${Math.random().toString(36).slice(2, 9)}`;
  if (raw.length <= threshold) return `<div class="rt-body">${html}</div>`;
  return `<div class="rt-collapsible" data-rm="${id}">
    <div class="rt-body rt-clamped">${html}</div>
    <button type="button" class="rt-expand" onclick="rtToggleExpand(this)">展开全文 ▾</button>
  </div>`;
}
function rtToggleExpand(btn) {
  const body = btn.previousElementSibling;
  const on = body.classList.toggle("rt-clamped");
  btn.textContent = on ? "展开全文 ▾" : "收起 ▴";
}
/** 精简总结：展开/收起被隐藏的原文。按钮在摘要卡片内，原文是卡片所在 body 下的 .chat-msg-text/.gc-msg-text */
function rtToggleOrig(btn) {
  const card = btn.closest(".rt-summary");
  const body = card?.parentElement;
  const orig = body?.querySelector(".chat-msg-text, .gc-msg-text");
  if (!orig) return;
  const hidden = orig.classList.toggle("rt-orig-hidden");
  btn.textContent = hidden ? "展开原文 ▾" : "收起原文 ▴";
  btn.classList.toggle("expanded", !hidden);
}

// 会话级「精简总结」开关：按会话文件持久化，默认关闭；额外调用模型，需用户主动开启
const SUMMARY_KEY = "pi-admin-chat-summary";
function summaryEnabled(file) {
  try { return !!(JSON.parse(localStorage.getItem(SUMMARY_KEY) || "{}")[file]); } catch { return false; }
}
function chatToggleSummary() {
  const on = $("#chatSummaryToggle")?.checked;
  if (!chatFile) { toast("请先打开一条会话", "err"); if ($("#chatSummaryToggle")) $("#chatSummaryToggle").checked = false; return; }
  try {
    const all = JSON.parse(localStorage.getItem(SUMMARY_KEY) || "{}");
    if (on) all[chatFile] = true; else delete all[chatFile];
    localStorage.setItem(SUMMARY_KEY, JSON.stringify(all));
  } catch {}
  toast(on ? "已开启精简总结：后续每条回复会额外调用模型生成结论（消耗 token）" : "已关闭精简总结", on ? "ok" : "info");
}
function syncSummaryToggle() {
  const el = $("#chatSummaryToggle");
  if (el && chatFile) el.checked = summaryEnabled(chatFile);
}

/** 在指定消息气泡前插入精简总结卡片，并把原文折叠 */
async function renderSummary(bubble, text) {
  if (!bubble) return;
  const card = document.createElement("div");
  card.className = "rt-summary";
  card.innerHTML = `<div class="rt-summary-head">${icon("sparkle")}<span>精简结论</span><span class="rt-summary-tag">生成中…</span></div><div class="rt-summary-body">正在生成精简结论…</div><button type="button" class="rt-orig-btn" onclick="rtToggleOrig(this)">展开原文 ▾</button>`;
  const body = bubble.querySelector(".chat-msg-body");
  if (!body) return;
  const orig = body.querySelector(".chat-msg-text");
  body.insertBefore(card, orig);
  // 原文默认隐藏，点「展开原文」才显示
  if (orig) orig.classList.add("rt-orig-hidden");
  try {
    const model = chatCurrentModel || {};
    const r = await api("/api/chat/summarize", {
      method: "POST",
      body: JSON.stringify({ text, provider: model.provider || "", modelId: model.modelId || "" }),
    });
    card.querySelector(".rt-summary-body").innerHTML = richText(r.summary || "（无结果）");
    const cost = r.cost?.cny ? ` · ${fmtCost(r.cost.cny)}` : "";
    card.querySelector(".rt-summary-tag").textContent = `AI 精简${cost}`;
  } catch (e) {
    card.querySelector(".rt-summary-body").textContent = `精简失败：${e.message}`;
    card.querySelector(".rt-summary-tag").textContent = "失败";
    // 总结失败时恢复原文、移除展开按钮，避免用户看不到内容
    if (orig) orig.classList.remove("rt-orig-hidden");
    card.querySelector(".rt-orig-btn")?.remove();
  }
}

// 群聊「精简总结」：按群持久化，默认关闭；不传模型时由服务端回退到默认模型
function gcSummaryEnabled(gid) {
  try { return !!(JSON.parse(localStorage.getItem(SUMMARY_KEY) || "{}")[`group:${gid}`]); } catch { return false; }
}
function gcToggleSummary() {
  const on = $("#gcSummaryToggle")?.checked;
  const gid = gcState.groupId;
  if (!gid) { toast("请先打开一个群聊", "err"); if ($("#gcSummaryToggle")) $("#gcSummaryToggle").checked = false; return; }
  try {
    const all = JSON.parse(localStorage.getItem(SUMMARY_KEY) || "{}");
    if (on) all[`group:${gid}`] = true; else delete all[`group:${gid}`];
    localStorage.setItem(SUMMARY_KEY, JSON.stringify(all));
  } catch {}
  toast(on ? "已开启精简总结：本群每条员工回应会额外调用模型生成结论（消耗 token）" : "已关闭本群精简总结", on ? "ok" : "info");
}
function syncGcSummaryToggle() {
  const el = $("#gcSummaryToggle");
  if (el && gcState.groupId) el.checked = gcSummaryEnabled(gcState.groupId);
}

/** 群聊回应摘要：在指定消息气泡的 body 顶部插入摘要卡片并折叠原文 */
async function gcRenderSummary(wrap, text) {
  if (!wrap) return;
  const body = wrap.querySelector(".gc-msg-body");
  if (!body) return;
  const card = document.createElement("div");
  card.className = "rt-summary gc-summary";
  card.innerHTML = `<div class="rt-summary-head">${icon("sparkle")}<span>精简结论</span><span class="rt-summary-tag">生成中…</span></div><div class="rt-summary-body">正在生成精简结论…</div><button type="button" class="rt-orig-btn" onclick="rtToggleOrig(this)">展开原文 ▾</button>`;
  const orig = body.querySelector(".gc-msg-text");
  body.insertBefore(card, orig);
  if (orig) orig.classList.add("rt-orig-hidden");
  try {
    const r = await api("/api/chat/summarize", { method: "POST", body: JSON.stringify({ text }) });
    card.querySelector(".rt-summary-body").innerHTML = richText(r.summary || "（无结果）");
    const cost = r.cost?.cny ? ` · ${fmtCost(r.cost.cny)}` : "";
    card.querySelector(".rt-summary-tag").textContent = `AI 精简${cost}`;
  } catch (e) {
    card.querySelector(".rt-summary-body").textContent = `精简失败：${e.message}`;
    card.querySelector(".rt-summary-tag").textContent = "失败";
    if (orig) orig.classList.remove("rt-orig-hidden");
    card.querySelector(".rt-orig-btn")?.remove();
  }
}

// ---------- 主题 ----------
const THEME_KEY = "pi-admin-theme";

// 统一图标助手
const icon = (name, cls = "") => `<svg class="icon ${cls}"><use href="#i-${name}"/></svg>`;

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const sel = $("#themeSelect");
  if (sel) sel.value = theme;
  $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b.dataset.themeValue === theme));
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
}

function initTheme() {
  let saved = "dark";
  try { saved = localStorage.getItem(THEME_KEY) || "dark"; } catch {}
  // URL ?theme=light 可临时覆盖（方便分享指定主题的链接）
  const fromUrl = new URLSearchParams(location.search).get("theme");
  if (["dark", "light", "auto"].includes(fromUrl)) saved = fromUrl;
  if (!["dark", "light", "auto"].includes(saved)) saved = "dark";
  applyTheme(saved);
  $$(".theme-seg button").forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.themeValue)));
  $("#themeSelect")?.addEventListener("change", (e) => applyTheme(e.target.value));
  // auto 模式下跟随系统变化
  window.matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => {
    if ($("#themeSelect")?.value === "auto") applyTheme("auto");
  });
}

// ---------- 通用 ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || `HTTP ${res.status}`;
    if (res.status === 404 && path.startsWith("/api/org/") && msg === "未知 API")
      throw new Error("管理服务还是旧版本，请重启：bash start.sh");
    throw new Error(msg);
  }
  return data;
}

function toast(msg, type = "") {
  const t = $("#toast");
  const iconName = type === "ok" ? "circle-check" : type === "err" ? "circle-alert" : "info";
  t.querySelector(".toast-icon").innerHTML = `<use href="#i-${iconName}"/>`;
  $("#toastText").textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = "toast"), 3200);
}

// ---------- @ 提及员工：会话输入框与管家输入框共用 ----------
const mentionState = {
  input: null,      // 当前正在输入的 textarea
  start: -1,        // @ 字符在 value 中的位置
  query: "",        // @ 之后已输入的筛选词
  matches: [],      // 匹配到的员工
  index: 0,         // 键盘选中项
};

/** 取所有可选员工（排除归档，避免派活给离职员工）；兼容各页面数据源 */
function mentionEmployees() {
  let list = Array.isArray(employeesCache) && employeesCache.length ? employeesCache : [];
  if (!list.length && Array.isArray(companyData?.employees)) list = companyData.employees;
  return list.filter((e) => e.status !== "archived");
}

/** 在 input 的 value 中，从光标往前找最近的 @ 查询片段 */
function mentionDetect(input) {
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos);
  // 匹配行内最后一个 @ 及其后不含空白的内容；@ 前必须是行首或空白，避免邮箱
  const m = /(?:^|[\s(（])@([^\s@]*)$/.exec(before);
  if (!m) { mentionHide(); return; }
  const query = m[1];
  const start = pos - query.length - 1; // @ 的索引
  const q = query.toLowerCase();
  const matches = mentionEmployees().filter((e) => {
    if (!q) return true;
    const hay = `${e.name || ""} ${e.id || ""} ${e.role || ""} ${e.department || ""}`.toLowerCase();
    return hay.includes(q);
  }).slice(0, 8);
  mentionState.input = input;
  mentionState.start = start;
  mentionState.query = query;
  mentionState.matches = matches;
  mentionState.index = 0;
  mentionRender();
}

function mentionRender() {
  const pop = $("#mentionPopup");
  if (!pop) return;
  const ms = mentionState.matches;
  if (!ms.length) {
    pop.innerHTML = `<div class="mention-empty">${mentionState.query ? `没有匹配「${esc(mentionState.query)}」的员工` : "暂无可选的在职员工"}</div>`;
  } else {
    pop.innerHTML = `<div class="mention-head"><b>提及员工</b><span>↑↓ 选择 · Enter 确认 · Esc 关闭</span></div>` +
      ms.map((e, i) => {
        const name = e.name || e.id;
        const sub = `${e.role || "员工"}${e.department ? " · " + e.department : ""}`;
        return `<div class="mention-item ${i === mentionState.index ? "active" : ""}" data-index="${i}" onmousedown="event.preventDefault();mentionPick(${i})" role="option">
          <span class="mention-avatar">${esc(String(name).slice(0, 1).toUpperCase())}</span>
          <span class="mention-meta"><b>${esc(name)}</b><small>${esc(sub)}</small></span>
          <span class="mention-status"></span>
        </div>`;
      }).join("");
  }
  pop.classList.remove("hidden");
  mentionReposition();
}

/** 把浮层定位到输入框上方（空间不足则下方），并限制在视口内 */
function mentionReposition() {
  const pop = $("#mentionPopup");
  const input = mentionState.input;
  if (!pop || !input || pop.classList.contains("hidden")) return;
  const r = input.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let top = r.top - ph - 8;
  if (top < 8) top = Math.min(r.bottom + 8, window.innerHeight - ph - 8);
  let left = r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(8, top)}px`;
}

function mentionHide() {
  const pop = $("#mentionPopup");
  if (pop) pop.classList.add("hidden");
  mentionState.input = null;
  mentionState.start = -1;
  mentionState.query = "";
  mentionState.matches = [];
  mentionState.index = 0;
}

/** 选中员工：把光标前的 @query 替换为 @姓名 + 空格 */
function mentionPick(i) {
  const e = mentionState.matches[i];
  const input = mentionState.input;
  const start = mentionState.start;
  if (!e || !input || start < 0) return;
  const pos = input.selectionStart;
  const name = e.name || e.id;
  const insert = `@${name} `;
  input.value = input.value.slice(0, start) + insert + input.value.slice(pos);
  const caret = start + insert.length;
  mentionHide();
  input.focus();
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function mentionOnInput(e) { mentionDetect(e.target); }

/** 失焦时延迟关闭，给鼠标点击浮层留时间（浮层用 onmousedown 已 preventDefault） */
function mentionOnBlur() { setTimeout(() => mentionHide(), 120); }

/** 在 keydown 里优先处理提及导航，返回 true 表示已消费该按键 */
function mentionKeydown(e) {
  const pop = $("#mentionPopup");
  if (!pop || pop.classList.contains("hidden") || !mentionState.input) return false;
  const ms = mentionState.matches;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (ms.length) mentionState.index = (mentionState.index + 1) % ms.length;
    mentionRender();
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (ms.length) mentionState.index = (mentionState.index - 1 + ms.length) % ms.length;
    mentionRender();
    return true;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    if (ms.length) { e.preventDefault(); mentionPick(mentionState.index); return true; }
  }
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); mentionHide(); return true; }
  return false;
}

// ---------- 通用确认弹框：替代浏览器原生 confirm ----------
// 用法：if (!(await appConfirm({ title, message, detail, tone, okText, icon }))) return;
let confirmResolver = null;
function appConfirm(opts = {}) {
  const o = typeof opts === "string" ? { message: opts } : opts;
  const modal = $("#confirmModal");
  if (!modal) return Promise.resolve(false);
  const tone = o.tone || "danger"; // danger | warn | info
  modal.className = `modal ${tone}`;
  const iconName = o.icon || (tone === "danger" ? "trash" : tone === "warn" ? "alert" : "info");
  $("#confirmIcon").innerHTML = `<svg class="icon"><use href="#i-${iconName}"/></svg>`;
  $("#confirmTitle").textContent = o.title || "确认操作";
  $("#confirmSubtitle").textContent = o.subtitle || "请确认后继续";
  $("#confirmMessage").textContent = o.message || "";
  $("#confirmDetail").textContent = o.detail || "";
  $("#confirmSafeText").textContent = o.safe || "原文件会先自动备份";
  $("#confirmSafe").style.visibility = o.safe === false ? "hidden" : "visible";
  $("#confirmOkText").textContent = o.okText || (tone === "danger" ? "确认删除" : "确认");
  modal.classList.remove("hidden");
  const okBtn = $("#confirmOkBtn");
  setTimeout(() => okBtn.focus(), 0);
  return new Promise((resolve) => { confirmResolver = resolve; });
}
function resolveConfirm(ok) {
  const modal = $("#confirmModal");
  if (!modal || modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  const r = confirmResolver;
  confirmResolver = null;
  if (r) r(!!ok);
}

// 空状态组件
function emptyState(iconName, title, desc, actionHtml = "") {
  return `<tr><td colspan="99"><div class="empty-state">
    <div class="empty-illustration">${icon(iconName)}</div>
    <h3>${title}</h3><p>${desc}</p>${actionHtml}
  </div></td></tr>`;
}

function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function fmtTime(ts) {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return String(ts); }
}
// 费用统一按人民币展示。Pi 内部的 usage.cost 是 USD，服务端会带上实时汇率。
let adminFx = { usdCny: 7, date: "", source: "fallback" };
function fmtTokensFull(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v).toLocaleString("zh-CN") : "0";
}
function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  const units = [[1e8, "亿"], [1e6, "百万"], [1e4, "万"], [1e3, "千"]];
  for (const [step, unit] of units) {
    if (v < step * 0.995) continue;
    const x = v / step;
    const digits = x < 10 ? 2 : x < 100 ? 1 : 0;
    const compact = x.toFixed(digits).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
    return `${compact}${unit}`;
  }
  return String(Math.round(v));
}
function fmtCost(cny) {
  const n = Number(cny);
  if (!Number.isFinite(n) || n <= 0) return "¥0";
  if (n < 0.01) return `¥${n.toFixed(4)}`;
  if (n < 1) return `¥${n.toFixed(3)}`;
  if (n < 100) return `¥${n.toFixed(2)}`;
  return `¥${n.toFixed(1)}`;
}

function activeFx(fx) {
  const r = fx || adminFx || {};
  return {
    usdCny: Number.isFinite(Number(r.usdCny)) && Number(r.usdCny) > 0 ? Number(r.usdCny) : 7,
    date: r.date || "",
    source: r.source || "fallback",
  };
}

function normUsage(u) {
  if (!u || typeof u !== "object") return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const c = u.cost && typeof u.cost === "object" ? u.cost : {};
  return {
    input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite),
    reasoning: num(u.reasoning), totalTokens: num(u.totalTokens),
    cost: {
      input: num(c.input), output: num(c.output), cacheRead: num(c.cacheRead), cacheWrite: num(c.cacheWrite),
      total: num(c.total), totalFromProvider: c.totalFromProvider === true,
    },
  };
}

function mergeUsages(a, b) {
  const x = normUsage(a), y = normUsage(b);
  if (!x) return y;
  if (!y) return x;
  const sum = (k) => x[k] + y[k];
  return {
    input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"),
    reasoning: sum("reasoning"), totalTokens: sum("totalTokens"),
    cost: {
      input: x.cost.input + y.cost.input, output: x.cost.output + y.cost.output,
      cacheRead: x.cost.cacheRead + y.cost.cacheRead, cacheWrite: x.cost.cacheWrite + y.cost.cacheWrite,
      total: x.cost.total + y.cost.total,
      totalFromProvider: x.cost.totalFromProvider === true && y.cost.totalFromProvider === true,
    },
  };
}

/** 用量摘要：token 是模型真实返回；金额优先服务端按原生人民币/峰谷价算出的 costCny */
function usageInfo(u, fx, cnyOverride, labelOverride) {
  const n = normUsage(u);
  if (!n || (!n.totalTokens && !n.cost.total && !(Number(cnyOverride) > 0))) return null;
  const f = activeFx(fx);
  const hasOverride = cnyOverride !== undefined && cnyOverride !== null && Number.isFinite(Number(cnyOverride));
  const cny = hasOverride ? Number(cnyOverride) : n.cost.total * f.usdCny;
  const source = labelOverride || (n.cost.totalFromProvider ? "服务商账单" : "按真实 token 与模型单价计算");
  return {
    tokens: n.totalTokens,
    costCny: cny,
    source,
    short: `${fmtTokens(n.totalTokens)} tok · ${fmtCost(cny)}`,
    long: `真实用量 ${fmtTokensFull(n.totalTokens)} tokens · ${fmtCost(cny)}（${source}）`,
  };
}

// 自动生成的会话名会带一个创建时间后缀，和卡片里的「最后活动」时间并列时容易误读。
// 只清理 Pi Admin 自己生成的三类名字，用户改过的名字保持原样。
function sessionDisplayLabel(name) {
  const s = String(name || "").trim();
  const m = s.match(/^(与.+对话|新会话|任务)\s*·\s*\d{1,2}:\d{2}$/);
  return m ? m[1] : (s || "未命名会话");
}
function fmtSessionTime(ts) {
  if (!ts) return "时间未知";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const hhmm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay(d, now)) return `今天 ${hhmm}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return `昨天 ${hhmm}`;
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ---------- 导航 ----------
const TAB_TITLES = { overview: "概览", resources: "资源管理", skilllib: "技能库", soptpl: "SOP 模板", org: "组织概览", employees: "员工管理", groups: "团队 Group", tasks: "任务看板", collab: "协作中心", autonomous: "自主工作", knowledge: "知识库", settings: "设置编辑", sessions: "会话中心", models: "模型与认证" };
$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    $$(".nav-item[data-tab]").forEach((b) => b.classList.toggle("active", b === btn));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${tab}`));
    $("#pageTitle").textContent = TAB_TITLES[tab];
    if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
    if (tab === "resources") loadResources();
    if (tab === "skilllib") loadSkillLib();
    if (tab === "soptpl") loadSopTemplates();
    if (tab === "org") loadOrgOverview();
    if (tab === "employees") loadEmployees();
    if (tab === "groups") loadGroups();
    if (tab === "tasks") loadTasks();
    if (tab === "collab") loadCollab();
    if (tab === "autonomous") loadTriggers();
    if (tab === "knowledge") loadKnowledge();
    if (tab === "sessions") loadSessions();
    if (tab === "models") loadModels();
    if (tab === "settings") {
      if (!$("#settingsEditor").value) loadSettings();
      loadRetention();
    }
  });
});

// ---------- 编辑锁已禁用 ----------
// 保留 syncUnlockUI 兼容旧调用：所有写操作始终可用，解锁入口已在界面移除。
function syncUnlockUI() {
  unlocked = true;
  const b = $("#unlockBtn");
  if (b) b.style.display = "none";
  const title = $("#modeTitle");
  if (title) title.textContent = "编辑已开启";
  const sub = $("#modeSub");
  if (sub) sub.textContent = "无需解锁，直接修改";
  $$(".switch").forEach((s) => (s.disabled = false));
  [$("#saveSettingsBtn"), $("#saveRetentionBtn"), $("#runRetentionBtn")].forEach((el) => {
    if (el) el.disabled = false;
  });
}

// ---------- 概览 ----------
let overviewData = null;
const USAGE_COLORS = ["#38bdf8", "#f59e0b", "#a78bfa", "#34d399", "#f472b6", "#60a5fa", "#fb7185", "#2dd4bf", "#facc15", "#818cf8"];
const USAGE_TOTAL_KEY = "__total__";
const USAGE_KINDS = ["tokens", "cost"]; // 同一张图同时显示，实线 Token / 虚线 费用
let usageHidden = new Set();
try { usageHidden = new Set(JSON.parse(localStorage.getItem("pi-admin-usage-hidden") || "[]")); } catch {}

function persistUsageHidden() {
  try { localStorage.setItem("pi-admin-usage-hidden", JSON.stringify([...usageHidden])); } catch {}
}
function usageSeries() {
  const models = Array.isArray(overviewData?.usageByModel) ? overviewData.usageByModel : [];
  const out = [{ key: USAGE_TOTAL_KEY, label: "合计", color: "var(--text-2)", total: true }];
  models.forEach((m, i) => {
    const key = `${m.provider}|${m.model}`;
    out.push({ key, label: m.label || `${m.provider}/${m.model}`, color: USAGE_COLORS[i % USAGE_COLORS.length], model: m });
  });
  return out;
}
function usageSeriesColor(key) {
  return usageSeries().find((s) => s.key === key)?.color || "var(--text-2)";
}
function usageSeriesValue(r, key, kind) {
  if (key === USAGE_TOTAL_KEY) return kind === "cost" ? Number(r?.totalCostCny) || 0 : Number(r?.totalTokens) || 0;
  const b = r?.models?.[key];
  return kind === "cost" ? Number(b?.totalCostCny) || 0 : Number(b?.totalTokens) || 0;
}
function usagePointKey(key, kind) { return `${key}|${kind}`; }
function usageValueLabel(v, kind) { return kind === "cost" ? fmtCost(v) : fmtTokens(v); }
function toggleUsageSeries(key) {
  key = String(key);
  if (usageHidden.has(key)) usageHidden.delete(key); else usageHidden.add(key);
  persistUsageHidden();
  renderUsageChart();
}

function usageDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function usageRangeRows() {
  const raw = Array.isArray(overviewData?.usageTimeline) ? overviewData.usageTimeline : [];
  const sel = $("#usageDays")?.value || "14";
  if (sel === "all") return raw;
  const n = Number(sel) || 14;
  const map = new Map(raw.map((r) => [r.date, r]));
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - n + 1);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = usageDateKey(d);
    rows.push(map.get(key) || { date: key, totalTokens: 0, totalCostCny: 0, messages: 0, models: {} });
  }
  return rows;
}
function usageNiceMax(v) {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const f = v / base;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * base;
}
function bindUsageChartHover(box, points, W, H, visible) {
  const svg = box?.querySelector("svg");
  const guide = box?.querySelector("#usageGuide");
  const tip = box?.querySelector(".usage-tooltip");
  if (!svg || !guide || !tip) return;
  const dots = [...box.querySelectorAll(".usage-hover-dot")];
  const hide = () => {
    guide.style.display = "none";
    dots.forEach((d) => { d.style.display = "none"; });
    tip.classList.add("hidden");
  };
  const show = (i) => {
    const p = points[i];
    if (!p) return;
    guide.setAttribute("x1", p.x);
    guide.setAttribute("x2", p.x);
    guide.style.display = "";
    dots.forEach((d) => {
      const y = p.ys[d.dataset.key];
      if (!Number.isFinite(y)) { d.style.display = "none"; return; }
      d.setAttribute("cx", p.x);
      d.setAttribute("cy", y);
      d.style.display = "";
    });
    let html = `<b>${esc(p.r.date)}</b>`;
    visible.forEach((s) => {
      const tok = usageSeriesValue(p.r, s.key, "tokens");
      const cost = usageSeriesValue(p.r, s.key, "cost");
      html += `<div class="usage-tip-row"><i style="background:${s.color}"></i><span title="${esc(s.label)}">${esc(s.label)}</span><b>${esc(fmtTokens(tok))} · ${esc(fmtCost(cost))}</b></div>`;
    });
    html += `<div class="usage-tip-foot">${Number(p.r.messages) || 0} 次模型回应 · 实线 Token / 虚线 费用</div>`;
    tip.innerHTML = html;
    tip.classList.remove("hidden");
    const ys = Object.values(p.ys).filter((y) => Number.isFinite(y));
    const yTop = ys.length ? Math.min(...ys) : T;
    const rect = svg.getBoundingClientRect();
    const left = p.x / W * rect.width;
    const top = yTop / H * rect.height;
    const tw = tip.offsetWidth || 190;
    const th = tip.offsetHeight || 80;
    tip.style.left = `${Math.max(tw / 2 + 4, Math.min(rect.width - tw / 2 - 4, left))}px`;
    tip.style.top = `${Math.max(th + 4, top - 12)}px`;
  };
  box.querySelectorAll(".usage-hit").forEach((hit) => {
    const i = Number(hit.dataset.i);
    hit.addEventListener("pointerenter", () => show(i));
    hit.addEventListener("pointermove", () => show(i));
    hit.addEventListener("pointerleave", hide);
  });
  svg.addEventListener("pointerleave", hide);
}

function renderUsageLegend(series) {
  const box = $("#usageLegend");
  if (!box) return;
  box.innerHTML = series.map((s) => `<button class="usage-legend-item ${usageHidden.has(s.key) ? "off" : ""}" data-key="${esc(s.key)}" title="${esc(s.label)}：点击显示/隐藏该模型的 Token 与费用曲线"><i style="background:${s.color}"></i><span>${esc(s.label)}</span></button>`).join("")
    + `<span class="usage-legend-hint">实线 Token · 虚线 费用 · 左轴 Token / 右轴 费用</span>`;
  box.querySelectorAll(".usage-legend-item").forEach((btn) => {
    btn.addEventListener("click", () => toggleUsageSeries(btn.dataset.key));
  });
}

function renderUsageChart() {
  const box = $("#usageChart");
  if (!box) return;
  const source = $("#usageSource");
  if (source) source.textContent = `${overviewData?.usageSource || "按消息时间归入自然日"} · 员工累计重置不影响 · 左轴 Token / 右轴 费用`;
  const rows = usageRangeRows();
  const allSeries = usageSeries();
  const visible = allSeries.filter((s) => !usageHidden.has(s.key));
  renderUsageLegend(allSeries);
  const hasData = rows.some((r) => visible.some((s) => USAGE_KINDS.some((k) => usageSeriesValue(r, s.key, k) > 0)));
  if (!rows.length || !visible.length || !hasData) {
    box.innerHTML = `<div class="usage-empty">${visible.length ? "所选时间范围内暂无用量记录" : "已隐藏全部曲线，点击上方图例显示"}</div>`;
    renderUsageModelTable();
    return;
  }
  const W = 920, H = 230, L = 58, R = 62, T = 18, B = 32;
  const maxTokens = usageNiceMax(Math.max(...rows.flatMap((r) => visible.map((s) => usageSeriesValue(r, s.key, "tokens")))));
  const maxCost = usageNiceMax(Math.max(...rows.flatMap((r) => visible.map((s) => usageSeriesValue(r, s.key, "cost")))));
  const px = (i) => L + (rows.length === 1 ? (W - L - R) / 2 : i * (W - L - R) / (rows.length - 1));
  const pyTokens = (v) => T + (1 - v / maxTokens) * (H - T - B);
  const pyCost = (v) => T + (1 - v / maxCost) * (H - T - B);
  const points = rows.map((r, i) => ({
    x: px(i), r,
    ys: Object.fromEntries(visible.flatMap((s) => USAGE_KINDS.map((k) => [
      usagePointKey(s.key, k), (k === "cost" ? pyCost : pyTokens)(usageSeriesValue(r, s.key, k)),
    ]))),
  }));
  const total = visible.find((s) => s.total);
  const gradColor = total ? "#94a3b8" : visible[0].color;
  const grids = [0, 1, 2, 3, 4].map((i) => {
    const y = T + (1 - i / 4) * (H - T - B);
    return `<line class="usage-grid-line" x1="${L}" y1="${y}" x2="${W - R}" y2="${y}"/>
      <text class="usage-axis-label" x="${L - 8}" y="${y + 3}" text-anchor="end">${esc(usageValueLabel(maxTokens * i / 4, "tokens"))}</text>
      <text class="usage-axis-label usage-axis-right" x="${W - R + 8}" y="${y + 3}" text-anchor="start">${esc(usageValueLabel(maxCost * i / 4, "cost"))}</text>`;
  }).join("");
  const labelEvery = Math.max(1, Math.ceil(rows.length / 7));
  const labels = rows.map((r, i) => {
    if (i % labelEvery !== 0 && i !== rows.length - 1) return "";
    return `<text class="usage-axis-label" x="${px(i).toFixed(1)}" y="${H - 10}" text-anchor="middle">${esc(r.date.slice(5))}</text>`;
  }).join("");
  const seriesPaths = visible.map((s) => USAGE_KINDS.map((kind) => {
    const pk = usagePointKey(s.key, kind);
    const d = points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.ys[pk].toFixed(1)}`).join(" ");
    const area = kind === "tokens" && s.total
      ? `<path d="${d} L${points[points.length - 1].x.toFixed(1)},${H - B} L${points[0].x.toFixed(1)},${H - B} Z" fill="url(#usageAreaGrad)"/>`
      : "";
    const dots = kind === "tokens" && rows.length <= 31 ? points.map((p) => `<circle class="usage-series-dot" cx="${p.x.toFixed(1)}" cy="${p.ys[pk].toFixed(1)}" r="2.2" style="stroke:${s.color}"><title>${esc(p.r.date)} · ${esc(s.label)} · ${esc(fmtTokens(usageSeriesValue(p.r, s.key, "tokens")))} · ${esc(fmtCost(usageSeriesValue(p.r, s.key, "cost")))}</title></circle>`).join("") : "";
    return `${area}<path class="usage-line ${kind === "cost" ? "usage-line-cost" : ""} ${s.total ? "usage-line-total" : ""}" style="stroke:${s.color}" d="${d}"/>${dots}`;
  }).join("")).join("");
  const hits = points.map((p, i) => {
    const left = i === 0 ? L : (points[i - 1].x + p.x) / 2;
    const right = i === points.length - 1 ? W - R : (p.x + points[i + 1].x) / 2;
    return `<rect class="usage-hit" x="${left.toFixed(1)}" y="${T}" width="${(right - left).toFixed(1)}" height="${H - T - B}" data-i="${i}"></rect>`;
  }).join("");
  const hoverDots = visible.flatMap((s) => USAGE_KINDS.map((kind) => `<circle class="usage-hover-dot" data-key="${esc(usagePointKey(s.key, kind))}" r="${s.total ? 4.5 : 3.8}" style="stroke:${s.color};display:none"/>`)).join("");
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每日 Token 与费用用量趋势（按模型分线，双轴）">
    <defs><linearGradient id="usageAreaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${gradColor}" stop-opacity=".22"/><stop offset="100%" stop-color="${gradColor}" stop-opacity="0"/></linearGradient></defs>
    ${grids}${seriesPaths}${labels}
    <line id="usageGuide" class="usage-guide" x1="0" y1="${T}" x2="0" y2="${H - B}" style="display:none"/>
    ${hoverDots}${hits}
  </svg><div class="usage-tooltip hidden"></div>`;
  bindUsageChartHover(box, points, W, H, visible);
  renderUsageModelTable();
}
function renderUsageModelTable() {
  const box = $("#usageModelTable");
  if (!box) return;
  const models = Array.isArray(overviewData?.usageByModel) ? overviewData.usageByModel : [];
  if (!models.length) { box.innerHTML = `<div class="usage-empty" style="min-height:90px">暂无模型用量记录</div>`; return; }
  const total = models.reduce((s, m) => s + (Number(m.totalTokens) || 0), 0);
  box.innerHTML = models.map((m) => {
    const tokens = Number(m.totalTokens) || 0;
    const pct = total ? (tokens / total * 100) : 0;
    const key = `${m.provider}|${m.model}`;
    return `<div class="usage-model-row">
      <div class="usage-model-name"><i class="usage-model-dot" style="background:${usageSeriesColor(key)}"></i><div class="usage-model-text"><b title="${esc(m.label || m.model)}">${esc(m.label || m.model)}</b><small title="${esc(`${m.provider}/${m.model}`)}">${esc(m.provider || "-")}/${esc(m.model || "-")}</small></div></div>
      <div class="mono" title="${Number(m.messages) || 0} 次模型回应">${fmtNum(m.messages || 0)} 次</div>
      <div class="mono" title="${esc(fmtTokensFull(tokens))} tokens">${fmtTokens(tokens)} tok</div>
      <div class="mono" title="${esc(fmtCost(m.totalCostCny || 0))}">${fmtCost(m.totalCostCny || 0)}</div>
      <div class="usage-share"><div class="usage-share-track"><div class="usage-share-fill" style="width:${pct.toFixed(1)}%"></div></div><span class="mono">${pct.toFixed(1)}%</span></div>
    </div>`;
  }).join("");
}

async function loadOverview() {
  const d = await api("/api/overview");
  overviewData = d;
  if (d.fx) adminFx = activeFx(d.fx);
  unlocked = true; // 忽略服务端的旧锁定状态
  syncUnlockUI();

  $("#brandVersion").textContent = `v${d.version}`;
  const fx = activeFx(d.fx);
  const hasOverseas = (d.stats.priceModes || []).some((m) => m === "provider" || m === "catalog");
  const fxSub = hasOverseas
    ? `海外账单汇率 1 USD = ${fx.usdCny} CNY${fx.date ? ` · ${fx.date}` : ""}`
    : "国内模型原生人民币 · DeepSeek 峰谷价";
  const stats = [
    { label: "资源总数", value: fmtNum(d.stats.resources), sub: `${d.stats.enabledResources} 个已启用`, icon: "plug", color: "var(--accent)", soft: "var(--accent-soft)" },
    { label: "历史会话", value: fmtNum(d.stats.sessions), sub: "个 JSONL 会话", icon: "clock", color: "var(--purple)", soft: "var(--purple-soft)" },
    { label: "累计 Token", value: fmtTokens(d.stats.totalTokens), title: `${fmtTokensFull(d.stats.totalTokens)} tokens`, sub: "跨所有会话 · 模型真实返回", icon: "activity", color: "var(--cyan)", soft: "var(--cyan-soft)" },
    { label: "今日实际费用", value: fmtCost(d.stats.todayCostCny), title: `${fmtTokensFull(d.stats.todayTokens)} tokens`, sub: `${fmtTokens(d.stats.todayTokens)} tokens · ${fxSub}`, icon: "zap", color: "var(--green)", soft: "var(--green-soft)" },
    { label: "累计费用", value: fmtCost(d.stats.totalCostCny), sub: "按真实用量折算人民币", icon: "coins", color: "var(--amber)", soft: "var(--amber-soft)" },
  ];
  $("#statGrid").innerHTML = stats.map((s) => `
    <div class="stat-card"${s.title ? ` title="${esc(s.title)}"` : ""}>
      <div class="stat-top"><span class="stat-label">${s.label}</span><span class="stat-icon" style="background:${s.soft};color:${s.color}">${icon(s.icon)}</span></div>
      <div class="stat-value">${s.value}</div>
      <div class="stat-sub">${icon("arrow-right")}${s.sub}</div>
    </div>`).join("");
  renderUsageChart();

  const kv = [
    ["Pi Admin 版本", `v${d.version}`],
    ["工作区", d.workspace],
    ["Agent 目录", d.agentDir],
    ["项目配置目录", d.projectPi],
    ["会话目录", d.sessionDir],
    ["项目已信任", d.trusted ? "是 ✓" : "否"],
    ["默认 Provider", d.defaults.provider],
    ["默认模型", d.defaults.model],
    ["主题", d.defaults.theme],
    ["数据时间", fmtTime(d.now)],
  ];
  $("#envInfo").innerHTML = kv.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("");
  window._envInfo = kv;
}

async function copyEnvInfo() {
  const txt = (window._envInfo || []).map(([k, v]) => `${k}: ${v}`).join("\n");
  try { await navigator.clipboard.writeText(txt); toast("环境信息已复制", "ok"); }
  catch { toast("复制失败，请手动选中", "err"); }
}

// ---------- 资源管理 ----------
async function loadResources() {
  const all = await api("/api/resources");
  resourcesCache = all;
  const types = ["all", "extensions", "skills", "prompts", "themes"];
  $("#resourceFilters").innerHTML = types.map((t) =>
    `<button class="filter-chip ${t === currentResourceFilter ? "active" : ""}" data-filter="${t}">${t === "all" ? "全部" : t}</button>`).join("");
  $$("#resourceFilters .filter-chip").forEach((c) => c.addEventListener("click", () => {
    currentResourceFilter = c.dataset.filter;
    $$("#resourceFilters .filter-chip").forEach((x) => x.classList.toggle("active", x === c));
    renderResources();
  }));
  $("#resourceSearch")?.addEventListener("input", renderResources);
  renderResources();
}

function renderResources() {
  const q = ($("#resourceSearch")?.value || "").toLowerCase().trim();
  const list = resourcesCache.filter((r) =>
    (currentResourceFilter === "all" || r.type === currentResourceFilter) &&
    (!q || `${r.name} ${r.pattern} ${r.type}`.toLowerCase().includes(q)));
  $("#resourceCount").textContent = `${list.length} 项`;
  const tbody = $("#resourceTable tbody");
  if (!list.length) {
    tbody.innerHTML = emptyState("inbox", "没有匹配的资源",
      q ? `没有找到与「${esc(q)}」匹配的资源，换个关键词试试。` : `该类型下暂无资源。在 <code>.pi/${currentResourceFilter}/</code> 或 <code>~/.pi/agent/${currentResourceFilter}/</code> 下放置文件后刷新。`);
    return;
  }
  tbody.innerHTML = list.map((r) => {
    const scopeTag = r.scope === "builtin" ? "builtin" : r.scope;
    const statusTag = r.scope === "builtin"
      ? `<span class="tag ${r.enabled ? "on" : "off"}">${r.enabled ? "默认启用" : "已禁用"}</span>`
      : `<span class="switch ${r.enabled ? "on" : ""}" data-id="${esc(r.id)}" title="${r.enabled ? "点击禁用" : "点击启用"}"></span>`;
    return `<tr>
      <td><span class="tag type">${esc(r.type)}</span></td>
      <td><b>${esc(r.name)}</b></td>
      <td><span class="tag scope-${scopeTag}">${esc(scopeTag)}</span></td>
      <td class="mono path-cell" title="${esc(r.pattern)}">${esc(r.pattern)}</td>
      <td>${statusTag}</td>
    </tr>`;
  }).join("");

  $$(".switch").forEach((sw) => {
    sw.disabled = !unlocked;
    sw.addEventListener("click", async () => {
      if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
      const r = resourcesCache.find((x) => x.id === sw.dataset.id);
      const newEnabled = !r.enabled;
      sw.classList.toggle("on", newEnabled);
      toast(`正在${newEnabled ? "启用" : "禁用"} ${r.name}...`);
      try {
        await api("/api/resources/toggle", {
          method: "POST",
          body: JSON.stringify({
            unlocked: true,
            resourceType: r.type,
            scope: r.scope,
            pattern: r.pattern,
            enabled: newEnabled,
            path: r.path,
          }),
        });
        r.enabled = newEnabled;
        toast(`已${newEnabled ? "启用" : "禁用"} ${r.name}，在 Pi 里 /reload 生效`, "ok");
      } catch (e) {
        sw.classList.toggle("on");
        toast(e.message, "err");
      }
    });
  });
}

// ---------- 技能库管理 ----------
let skillLibCache = [];
let skillScopeFilter = "all";
async function loadSkillLib() {
  try {
    skillLibCache = await api("/api/skills");
  } catch (e) { toast(e.message, "err"); skillLibCache = []; }
  const scopes = [["all", "全部"], ["user", "用户级"], ["project", "项目级"]];
  $("#skillScopeFilters").innerHTML = scopes.map(([k, v]) =>
    `<button class="filter-chip ${k === skillScopeFilter ? "active" : ""}" data-skill-scope="${k}">${v}</button>`).join("");
  $$("#skillScopeFilters .filter-chip").forEach((c) => c.addEventListener("click", () => {
    skillScopeFilter = c.dataset.skillScope;
    $$("#skillScopeFilters .filter-chip").forEach((x) => x.classList.toggle("active", x === c));
    renderSkillLib();
  }));
  $("#skillSearch")?.addEventListener("input", renderSkillLib);
  renderSkillLib();
}
function renderSkillLib() {
  const q = ($("#skillSearch")?.value || "").toLowerCase().trim();
  const list = skillLibCache.filter((s) =>
    (skillScopeFilter === "all" || s.scope === skillScopeFilter) &&
    (!q || `${s.name} ${s.description} ${s.slug}`.toLowerCase().includes(q)));
  $("#skillCount").textContent = `${list.length} 项`;
  const tbody = $("#skillTable tbody");
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6">${emptyState("wand", "还没有技能", "点右上角「新建技能」创建第一个 SKILL.md，或从 QoderWake 导入。")}</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((s) => `<tr>
    <td><b>${esc(s.name)}</b><div class="cell-sub mono">${esc(s.slug)}</div>${s.description ? `<div class="cell-sub">${esc(s.description.slice(0, 60))}</div>` : ""}</td>
    <td><span class="tag scope-${s.scope}">${s.scope === "user" ? "用户级" : "项目级"}</span></td>
    <td>${s.files?.length ? `<span class="badge">${s.files.length}</span>` : "—"}</td>
    <td class="mono">${(s.size / 1024).toFixed(1)} KB</td>
    <td><span class="switch ${s.enabled ? "on" : ""}" data-skill-id="${esc(s.id)}" title="${s.enabled ? "点击禁用" : "点击启用"}"></span></td>
    <td><div class="row-actions">
      <button class="icon-btn" title="编辑" onclick="openSkillEditor('${esc(s.scope)}','${esc(s.slug)}')"><svg class="icon"><use href="#i-edit"/></svg></button>
      <button class="icon-btn" title="删除" onclick="deleteSkill('${esc(s.scope)}','${esc(s.slug)}','${esc(s.name)}')"><svg class="icon"><use href="#i-trash"/></svg></button>
    </div></td>
  </tr>`).join("");
  $$(".switch[data-skill-id]").forEach((sw) => sw.addEventListener("click", async () => {
    const s = skillLibCache.find((x) => x.id === sw.dataset.skillId);
    if (!s) return;
    const newEnabled = !s.enabled;
    sw.classList.toggle("on", newEnabled);
    try {
      await api("/api/resources/toggle", { method: "POST", body: JSON.stringify({ unlocked: true, resourceType: "skills", scope: s.scope, pattern: `skills/${s.slug}/SKILL.md`, enabled: newEnabled, path: s.path }) });
      s.enabled = newEnabled;
      toast(`已${newEnabled ? "启用" : "禁用"}「${s.name}」，Pi 内 /reload 生效`, "ok");
    } catch (e) { sw.classList.toggle("on"); toast(e.message, "err"); }
  }));
}
async function openSkillEditor(scope = "", slug = "") {
  const editing = !!slug;
  $("#skEditorTitle").textContent = editing ? "编辑技能" : "新建技能";
  $("#skScope").value = scope || "user";
  $("#skSlug").value = slug;
  $("#skSlug").disabled = editing;
  $("#skContent").value = "";
  if (editing) {
    try {
      const d = await api(`/api/skills/content?scope=${encodeURIComponent(scope)}&slug=${encodeURIComponent(slug)}`);
      $("#skContent").value = d.content;
    } catch (e) { toast(e.message, "err"); return; }
  }
  $("#skillEditorModal").classList.remove("hidden");
}
function closeSkillEditor() { $("#skillEditorModal").classList.add("hidden"); }
function fillSkillTemplate() {
  const name = $("#skSlug").value.trim() || "我的技能";
  $("#skContent").value = `---\nname: ${name}\ndescription: 这个技能解决什么问题、何时使用\n---\n\n# ${name}\n\n## 使用场景\n描述何时应该加载这个技能。\n\n## 操作步骤\n1. 第一步\n2. 第二步\n\n## 注意事项\n- 约束与边界\n`;
}
async function submitSkillEditor() {
  const scope = $("#skScope").value, slug = $("#skSlug").value.trim(), content = $("#skContent").value;
  if (!slug) { toast("请填写技能标识", "err"); return; }
  if (!content.trim()) { toast("SKILL.md 内容不能为空", "err"); return; }
  try {
    await api("/api/skills/save", { method: "POST", body: JSON.stringify({ unlocked: true, scope, slug, content }) });
    closeSkillEditor(); toast("技能已保存，Pi 内 /reload 生效", "ok");
    inheritOptionsCache = null; // 技能列表变了，继承选择器需刷新
    loadSkillLib();
  } catch (e) { toast(e.message, "err"); }
}
async function deleteSkill(scope, slug, name) {
  if (!await appConfirm({ title: "删除技能", message: `确认删除技能「${name}」？会删除整个技能目录及其附加文件，删除前会备份到 admin/.backups/。`, okText: "确认删除", tone: "danger" })) return;
  try {
    await api("/api/skills/delete", { method: "POST", body: JSON.stringify({ unlocked: true, scope, slug }) });
    toast("技能已删除（已备份）", "ok");
    inheritOptionsCache = null;
    loadSkillLib();
  } catch (e) { toast(e.message, "err"); }
}

// ---------- SOP 模板管理 ----------
let sopTplCache = [];
let sopEditingId = null;
let sopDraftSteps = [];
const SOP_ROLES = [["product", "产品"], ["developer", "研发"], ["tester", "测试"], ["manager", "管理"], ["ops", "运营"]];
async function loadSopTemplates() {
  try { sopTplCache = await api("/api/org/sops"); }
  catch (e) { toast(e.message, "err"); sopTplCache = []; }
  $("#sopTplSearch")?.addEventListener("input", renderSopTplGrid);
  renderSopTplGrid();
}
function renderSopTplGrid() {
  const q = ($("#sopTplSearch")?.value || "").toLowerCase().trim();
  const list = sopTplCache.filter((s) => !q || `${s.name} ${s.description} ${s.id}`.toLowerCase().includes(q));
  const grid = $("#sopTplGrid");
  if (!list.length) {
    grid.innerHTML = emptyState("layers", "没有模板", q ? "换个关键词试试。" : "点右上角「新建模板」创建第一个 SOP 流程。");
    return;
  }
  grid.innerHTML = list.map((s) => {
    const roleSet = [...new Set((s.steps || []).map((st) => st.role).filter(Boolean))];
    const skillSet = [...new Set((s.steps || []).map((st) => st.skill).filter(Boolean))];
    return `<div class="sop-tpl-card">
      <div class="stc-head"><div><h3>${esc(s.name)}</h3><div class="stc-id mono">${esc(s.id)}</div></div>
        <div class="stc-actions">
          <button class="icon-btn" title="复制模板" onclick="copySopTemplate('${esc(s.id)}')"><svg class="icon"><use href="#i-copy"/></svg></button>
          <button class="icon-btn" title="编辑" onclick="openSopTemplateModal('${esc(s.id)}')"><svg class="icon"><use href="#i-edit"/></svg></button>
          <button class="icon-btn" title="删除" onclick="deleteSopTemplate('${esc(s.id)}','${esc(s.name)}')"><svg class="icon"><use href="#i-trash"/></svg></button>
        </div>
      </div>
      <p class="stc-desc">${esc(s.description || "（无描述）")}</p>
      <div class="stc-flow">${(s.steps || []).map((st, i) => `<span class="stc-step">${i + 1}.${esc(st.name)}</span>`).join(`<svg class="icon stc-arrow"><use href="#i-arrow-right"/></svg>`)}</div>
      <div class="stc-meta">
        <span><svg class="icon"><use href="#i-layers"/></svg>${(s.steps || []).length} 阶段</span>
        ${roleSet.length ? `<span><svg class="icon"><use href="#i-users"/></svg>${roleSet.map((r) => SOP_ROLES.find((x) => x[0] === r)?.[1] || r).join("/")}</span>` : ""}
        ${skillSet.length ? `<span title="${esc(skillSet.join(", "))}"><svg class="icon"><use href="#i-wand"/></svg>${skillSet.length} 技能</span>` : ""}
      </div>
    </div>`;
  }).join("");
}
function openSopTemplateModal(id = "") {
  const t = id ? sopTplCache.find((x) => x.id === id) : null;
  sopEditingId = t?.id || null;
  $("#sopTplTitle").textContent = t ? "编辑模板" : "新建模板";
  $("#stId").value = t?.id || "";
  $("#stId").disabled = !!t;
  $("#stName").value = t?.name || "";
  $("#stDesc").value = t?.description || "";
  $("#stSource").value = t?.source || "";
  sopDraftSteps = t ? structuredClone(t.steps || []) : [];
  renderSopDraftSteps();
  $("#sopTplModal").classList.remove("hidden");
}
function closeSopTemplateModal() { $("#sopTplModal").classList.add("hidden"); }
function renderSopDraftSteps() {
  const box = $("#stSteps");
  if (!sopDraftSteps.length) { box.innerHTML = `<div class="board-empty">还没有阶段，点「添加阶段」开始。</div>`; return; }
  box.innerHTML = sopDraftSteps.map((st, i) => `<div class="sop-step-item" data-i="${i}">
    <div class="ssi-head"><span class="ssi-num">${i + 1}</span>
      <input class="ssi-name" value="${esc(st.name || "")}" placeholder="阶段名称" oninput="sopStepField(${i},'name',this.value)">
      <div class="ssi-btns">
        <button class="icon-btn" title="上移" ${i === 0 ? "disabled" : ""} onclick="sopStepMove(${i},-1)"><svg class="icon"><use href="#i-chevron" style="transform:rotate(-90deg)"/></svg></button>
        <button class="icon-btn" title="下移" ${i === sopDraftSteps.length - 1 ? "disabled" : ""} onclick="sopStepMove(${i},1)"><svg class="icon"><use href="#i-chevron" style="transform:rotate(90deg)"/></svg></button>
        <button class="icon-btn" title="删除阶段" onclick="sopStepRemove(${i})"><svg class="icon"><use href="#i-trash"/></svg></button>
      </div>
    </div>
    <div class="ssi-grid">
      <div class="form-row"><label>角色</label><select onchange="sopStepField(${i},'role',this.value)">${SOP_ROLES.map(([v, l]) => `<option value="${v}" ${st.role === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="form-row"><label>技能<span>可选，skill 名</span></label><input value="${esc(st.skill || "")}" placeholder="例如 planning" oninput="sopStepField(${i},'skill',this.value)"></div>
    </div>
    <div class="form-row"><label>阶段指令<span>支持 {{goal}} 与 {{prev}} 占位符</span></label><textarea rows="3" placeholder="告诉员工这个阶段要做什么、产出什么" oninput="sopStepField(${i},'instruction',this.value)">${esc(st.instruction || "")}</textarea></div>
    <div class="form-row"><label>验收标准<span>可证伪的完成条件</span></label><textarea rows="2" placeholder="什么样的产出算通过" oninput="sopStepField(${i},'acceptance',this.value)">${esc(st.acceptance || "")}</textarea></div>
  </div>`).join("");
}
function sopStepField(i, key, val) { if (sopDraftSteps[i]) sopDraftSteps[i][key] = val; }
function sopStepAdd() {
  sopDraftSteps.push({ id: `s${Date.now().toString(36)}`, name: "新阶段", role: "developer", skill: "", instruction: "", acceptance: "" });
  renderSopDraftSteps();
}
function sopStepRemove(i) { sopDraftSteps.splice(i, 1); renderSopDraftSteps(); }
function sopStepMove(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= sopDraftSteps.length) return;
  [sopDraftSteps[i], sopDraftSteps[j]] = [sopDraftSteps[j], sopDraftSteps[i]];
  renderSopDraftSteps();
}
async function submitSopTemplate() {
  const id = $("#stId").value.trim(), name = $("#stName").value.trim();
  if (!id || !name) { toast("模板 ID 和名称必填", "err"); return; }
  if (!sopDraftSteps.length) { toast("至少添加一个阶段", "err"); return; }
  if (sopDraftSteps.some((s) => !s.name?.trim())) { toast("每个阶段都要有名称", "err"); return; }
  const tpl = {
    id, name,
    description: $("#stDesc").value.trim(),
    source: $("#stSource").value.trim(),
    steps: sopDraftSteps.map((s, i) => ({
      id: s.id || `s${i + 1}`, name: s.name.trim(), role: s.role || "developer",
      skill: (s.skill || "").trim(), instruction: s.instruction || "", acceptance: s.acceptance || "",
    })),
  };
  const next = [...sopTplCache.filter((x) => x.id !== id), tpl];
  // 保持原顺序：编辑时原位替换，新建时追加
  if (sopEditingId) {
    const idx = sopTplCache.findIndex((x) => x.id === sopEditingId);
    if (idx >= 0) { next.pop(); next.splice(idx, 0, tpl); }
  }
  try {
    await api("/api/org/sops", { method: "POST", body: JSON.stringify({ unlocked: true, sops: next }) });
    closeSopTemplateModal(); toast("模板已保存（已备份原模板库）", "ok");
    inheritOptionsCache = null; // 工作流选项需刷新
    loadSopTemplates();
  } catch (e) { toast(e.message, "err"); }
}
async function copySopTemplate(id) {
  const t = sopTplCache.find((x) => x.id === id);
  if (!t) return;
  const copy = structuredClone(t);
  copy.id = `${t.id}_copy_${Date.now().toString(36)}`;
  copy.name = `${t.name}（副本）`;
  copy.steps = (copy.steps || []).map((s, i) => ({ ...s, id: `s${i + 1}` }));
  try {
    await api("/api/org/sops", { method: "POST", body: JSON.stringify({ unlocked: true, sops: [...sopTplCache, copy] }) });
    toast("模板已复制", "ok"); inheritOptionsCache = null; loadSopTemplates();
  } catch (e) { toast(e.message, "err"); }
}
async function deleteSopTemplate(id, name) {
  if (!await appConfirm({ title: "删除模板", message: `确认删除 SOP 模板「${name}」？已启动的流程不受影响，删除前会备份整个模板库。`, okText: "确认删除", tone: "danger" })) return;
  try {
    await api("/api/org/sops", { method: "POST", body: JSON.stringify({ unlocked: true, sops: sopTplCache.filter((x) => x.id !== id) }) });
    toast("模板已删除", "ok"); inheritOptionsCache = null; loadSopTemplates();
  } catch (e) { toast(e.message, "err"); }
}
function exportSops() {
  const blob = new Blob([JSON.stringify(sopTplCache, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sops-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("模板已导出", "ok");
}

// ---------- 设置编辑 ----------
async function loadSettings() {
  const scope = $("#settingScope").value;
  const file = $("#settingFile").value;
  try {
    const d = await api(`/api/settings?scope=${scope}&file=${file}`);
    $("#settingsTitle").textContent = `${file}.json`;
    $("#settingsPath").textContent = d.exists ? d.path : `${d.path}（尚不存在）`;
    $("#settingsEditor").value = d.exists ? JSON.stringify(d.data, null, 2) : "";
    if (!d.exists) toast("文件尚不存在，可直接编辑并保存创建", "");
  } catch (e) { toast(e.message, "err"); }
}

async function saveSettings() {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  let data;
  try { data = JSON.parse($("#settingsEditor").value); }
  catch (e) { toast(`JSON 格式错误：${e.message}`, "err"); return; }
  const scope = $("#settingScope").value;
  const file = $("#settingFile").value;
  try {
    const r = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ unlocked: true, scope, file, data }),
    });
    toast(`已保存${r.backup ? "（原文件已备份）" : ""}，在 Pi 里 /reload 生效`, "ok");
    $("#settingsPath").textContent = r.path;
  } catch (e) { toast(e.message, "err"); }
}

async function copySettings() {
  const txt = $("#settingsEditor").value;
  try { await navigator.clipboard.writeText(txt); toast("已复制到剪贴板", "ok"); }
  catch { toast("复制失败，请手动选中", "err"); }
}

$("#settingScope").addEventListener("change", loadSettings);
$("#settingFile").addEventListener("change", loadSettings);

// ---------- 会话自动清理 ----------
let retentionData = null;
function retentionFmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

async function loadRetention() {
  try {
    retentionData = await api("/api/session/retention");
    const { cfg, candidates, expiredCount, expiredBytes, totalCount, totalBytes, recentRuns } = retentionData;
    $("#retentionEnabled").checked = cfg.enabled;
    $("#retentionDays").value = String(cfg.days);
    $("#retentionMinKeep").value = String(cfg.minKeep);
    $("#retentionSummary").textContent = cfg.enabled
      ? `${cfg.days} 天 · 保留 ${cfg.minKeep} 条 · ${expiredCount} 条待清理`
      : `未启用 · ${totalCount} 条 / ${retentionFmtBytes(totalBytes)}`;
    const expired = candidates.filter((c) => c.expired);
    $("#retentionCandidates").innerHTML = expired.length
      ? `<div class="retention-list-head">待清理 ${expired.length} 条 · 可释放 ${retentionFmtBytes(expiredBytes)}</div>`
        + expired.map((c) => `<div class="retention-row"><span class="retention-name" title="${esc(c.file)}">${esc(c.name)}</span><span class="retention-meta">闲置 ${c.idleDays} 天 · ${retentionFmtBytes(c.bytes)}</span></div>`).join("")
      : `<div class="retention-empty">${cfg.enabled ? "当前没有过期会话" : "自动清理未启用，暂无过期会话预览"}</div>`;
    const last = recentRuns[0];
    $("#retentionLastRun").innerHTML = last
      ? `上次清理：${esc(String(last.at || "").slice(0, 16).replace("T", " "))} · ${last.reason === "schedule" ? "自动" : "手动"} · 删除 ${last.deleted} 条 / 释放 ${retentionFmtBytes(last.freedBytes)}`
      : "尚未执行过清理";
  } catch (e) { toast(e.message, "err"); }
}

async function saveRetention() {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  try {
    await api("/api/session/retention", {
      method: "PUT",
      body: JSON.stringify({
        unlocked: true,
        enabled: $("#retentionEnabled").checked,
        days: Number($("#retentionDays").value),
        minKeep: Number($("#retentionMinKeep").value),
      }),
    });
    toast("清理策略已保存", "ok");
    await loadRetention();
  } catch (e) { toast(e.message, "err"); }
}

function openRetentionConfirm() {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  const d = retentionData;
  if (!d || !d.expiredCount) { toast("当前没有过期会话可清理", ""); return; }
  $("#retentionConfirmCount").textContent = `${d.expiredCount} 条`;
  $("#retentionConfirmBytes").textContent = retentionFmtBytes(d.expiredBytes);
  $("#retentionConfirmModal").classList.remove("hidden");
}
function closeRetentionConfirm() { $("#retentionConfirmModal").classList.add("hidden"); }

async function submitRetentionNow() {
  closeRetentionConfirm();
  try {
    const r = await api("/api/session/retention/run", { method: "POST", body: JSON.stringify({ unlocked: true }) });
    toast(r.skipped === "disabled" ? "自动清理未启用，未删除任何会话" : `已清理 ${r.deleted} 条，释放 ${retentionFmtBytes(r.freedBytes)}`, "ok");
    await loadRetention();
    if (chatFile) await loadSessions();
  } catch (e) { toast(e.message, "err"); }
}

// ---------- 会话中心：三栏联动（员工 / 群 / 会话 / 对话）----------
let sessionsCache = [];
let groupsCache = [];                 // 协作群（作为一类会话归属）
let groupPreviews = {};               // groupId -> { preview, lastTs, count, sopStatus }
let sessionSelectedEmp = "__all__";   // 左侧筛选：__all__ | __me__ | group:<id> | emp-xxx
let sessionActiveOwner = "";          // 当前打开会话的归属（与筛选独立）：__me__ | group:<id> | emp-xxx
// 群聊状态：host = modal（团队页弹层） | session（会话中心右栏）
const gcState = { groupId: "", sending: false, host: "modal", lastUserText: "" };
// 群 SOP：流程模板 + 当前运行实例
// runs：本群所有进行中的流程；activeRunId：面板当前查看的流程；run：由 runs 派生，兼容旧代码
const gcSopState = { runs: [], run: null, activeRunId: "", templates: [], collapsed: false, selectedTpl: "", selectedStep: null, busy: false };

/** 把群转换成会话卡片结构，和 Pi 会话混排展示 */
function groupSessions() {
  return groupsCache.map((g) => {
    const p = groupPreviews[g.id] || {};
    return {
      isGroup: true,
      groupId: g.id,
      id: g.id,
      file: `group:${g.id}`,
      name: g.name || g.id,
      preview: p.preview || g.description || "群聊 · 点击开始对话",
      lastTs: p.lastTs || g.updatedAt || g.createdAt,
      messages: p.count || 0,
      sopStatus: p.sopStatus || "",
      sopCount: p.sopCount || 0,
    };
  });
}

function sessSessionsForEmp(emp) {
  if (emp === "__all__") return [...sessionsCache, ...groupSessions()];
  if (emp === "__me__") return sessionsCache.filter((s) => !s.employeeId);
  if (emp.startsWith("group:")) return groupSessions().filter((s) => s.groupId === emp.slice(6));
  return sessionsCache.filter((s) => s.employeeId === emp);
}

/** 当前归属 + 搜索框过滤后的会话列表（列表渲染与自动选中共用） */
function filteredSessionsForEmp(emp) {
  const q = ($("#sessionSearch")?.value || "").toLowerCase().trim();
  const list = sessSessionsForEmp(emp);
  if (!q) return list;
  return list.filter((s) => `${s.name} ${s.cwd || ""} ${s.employeeId || ""} ${s.id}`.toLowerCase().includes(q));
}

/** 会话归属键：群会话 > 员工会话 > 我的会话 */
function sessionOwnerKey(s) {
  if (!s) return "";
  if (s.isGroup || s.groupId) return `group:${s.groupId}`;
  if (s.employeeId) return s.employeeId;
  return "__me__";
}

function renderSessionEmpList(revealOwner = false) {
  const emps = Array.isArray(employeesCache) ? employeesCache : [];
  const item = (id, name, sub, count, cls, ops = "") => {
    const isOwner = !!sessionActiveOwner && sessionActiveOwner === id;
    return `
    <div class="sess-emp-item ${cls || ""} ${count === 0 ? "zero" : ""} ${sessionSelectedEmp === id ? "active" : ""} ${isOwner ? "session-owner" : ""}" data-owner-key="${esc(id)}" role="button" tabindex="0"
      onclick='selectSessionEmp(${JSON.stringify(id)})'
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectSessionEmp(${JSON.stringify(id)})}">
      <span class="sess-emp-avatar">${esc(String(name || "?").slice(0, 1).toUpperCase())}</span>
      <span class="sess-emp-meta"><b>${esc(name || id)}</b><small>${esc(sub)}</small></span>
      ${ops}
      ${isOwner ? `<span class="sess-emp-owner-tag" title="当前打开的会话属于这里">当前会话</span>` : ""}
      <span class="sess-emp-count">${count}</span>
    </div>`;
  };
  let html = item("__all__", "全部会话", "所有员工与我的会话", sessionsCache.length, "");
  html += `<div class="sess-emp-divider"></div><div class="sess-emp-label">我</div>`;
  html += item("__me__", "我的会话", "普通 / 非员工会话", sessSessionsForEmp("__me__").length, "me");
  html += `<div class="sess-emp-divider"></div><div class="sess-emp-label">数字员工</div>`;
  if (!emps.length) html += `<div style="padding:8px 10px;font-size:11px;color:var(--text-3)">还没有员工，可在「员工管理」创建</div>`;
  for (const e of emps) {
    const status = e.status === "archived" ? "已归档" : (e.status === "active" ? "在职" : "空闲");
    const ops = `<span class="sess-emp-ops">
      <button class="icon-btn" title="编辑员工" onclick='event.stopPropagation();openEmployeeModal(${JSON.stringify(e.id)})'>${icon("edit")}</button>
      <button class="icon-btn" title="员工工作台（记忆/技能/权限/任务/对话）" onclick='event.stopPropagation();openEmpDetail(${JSON.stringify(e.id)})'>${icon("sparkle")}</button>
    </span>`;
    html += item(e.id, e.name || e.id, `${e.role || "员工"} · ${status}`, sessSessionsForEmp(e.id).length, "", ops);
  }
  html += `<div class="sess-emp-divider"></div><div class="sess-emp-label">协作群</div>`;
  if (!groupsCache.length) html += `<div style="padding:8px 10px;font-size:11px;color:var(--text-3)">还没有团队，可在「团队 Group」创建</div>`;
  for (const g of groupsCache) {
    const gid = `group:${g.id}`;
    const members = [...new Set([...(g.members || []), g.leader].filter(Boolean))];
    const ops = `<span class="sess-emp-ops">
      <button class="icon-btn" title="团队群聊（新窗口）" onclick='event.stopPropagation();openGroupChat(${JSON.stringify(g.id)})'>${icon("external")}</button>
    </span>`;
    html += item(gid, g.name || g.id, `${members.length} 名成员 · 群聊`, 1, "group", ops);
  }
  $("#sessionEmpList").innerHTML = html;
  if (revealOwner && sessionActiveOwner) {
    const ownerEl = $$("#sessionEmpList .sess-emp-item").find((el) => el.dataset.ownerKey === sessionActiveOwner);
    ownerEl?.scrollIntoView({ block: "nearest" });
  }
}

function renderSessions() {
  const q = ($("#sessionSearch")?.value || "").toLowerCase().trim();
  const list = filteredSessionsForEmp(sessionSelectedEmp);
  $("#sessionCount").textContent = `${list.length} 个`;
  $("#sessionConvTitle").textContent = sessionSelectedEmp === "__all__" ? "全部会话"
    : sessionSelectedEmp === "__me__" ? "我的会话"
    : sessionSelectedEmp.startsWith("group:") ? (groupsCache.find((g) => g.id === sessionSelectedEmp.slice(6))?.name || "群聊")
    : (employeesCache.find((e) => e.id === sessionSelectedEmp)?.name || "员工会话");
  const stats = overviewData?.stats || {};
  const fxNow = activeFx(overviewData?.fx);
  const hasOverseas = (stats.priceModes || []).some((m) => m === "provider" || m === "catalog");
  const usageBar = $("#sessionUsageBar");
  if (usageBar) {
    usageBar.innerHTML = stats.todayTokens
      ? `${icon("activity")}<span title="${fmtTokensFull(stats.todayTokens)} tokens">今日真实用量 ${fmtTokens(stats.todayTokens)} tok</span><b>${fmtCost(stats.todayCostCny)}</b><em>${hasOverseas ? `海外账单汇率 ${fxNow.usdCny}` : "国内模型原生人民币"}</em>`
      : "";
  }
  const box = $("#sessionConvList");
  const hasAny = sessionsCache.length + groupsCache.length;
  if (!list.length) {
    box.innerHTML = emptyState("clock", hasAny ? "没有匹配的会话" : "还没有会话记录",
      hasAny ? `没有找到与「${esc(q)}」匹配的会话。` : "还没有会话。点右上角「新开会话」创建一条，或在 Pi 里开始对话后会话会自动保存在 <code>~/.pi/agent/sessions/</code>。",
      hasAny ? "" : `<button class="btn primary" onclick="quickCreateSession()">${icon("plus")}新开会话</button>`);
    return;
  }
  box.innerHTML = list.map((s) => {
    if (s.isGroup) {
      const g = groupsCache.find((x) => x.id === s.groupId) || {};
      const members = [...new Set([...(g.members || []), g.leader].filter(Boolean))];
      const active = gcState.groupId === s.groupId && !$("#sessionGroupHost")?.classList.contains("hidden");
      const sopN = s.sopCount > 1 ? ` ×${s.sopCount}` : "";
      const sopTag = s.sopStatus === "running" ? `<span class="sess-grp-sop live">SOP 进行中${sopN}</span>`
        : s.sopStatus === "blocked" ? `<span class="sess-grp-sop warn">SOP 暂停${sopN}</span>` : "";
      const gp = groupPreviews[s.groupId] || {};
      const groupUsage = gp.usageTokens || gp.usageCny
        ? `<div class="sess-conv-usage">${icon("activity")}<span>${fmtTokens(gp.usageTokens || 0)} tok · ${fmtCost(gp.usageCny || 0)}</span><em>${esc(gp.usageLabel || "群内回应累计")}</em></div>` : "";
      return `<div class="sess-conv-item sess-group-item ${active ? "active" : ""}" data-file="${esc(s.file)}" title="${esc(g.description || "团队群聊")}" onclick='viewGroupSession(${JSON.stringify(s.groupId)})'>
        <div class="sess-conv-head">
          <b title="${esc(s.name)}">${icon("users")} ${esc(s.name.slice(0, 36))}${s.name.length > 36 ? "…" : ""}</b>
          ${sopTag}
        </div>
        <div class="sess-conv-meta">
          <span class="sess-conv-preview">${esc(s.preview)}</span>
          <span class="sess-conv-time">${members.length}人 · ${fmtSessionTime(s.lastTs)}</span>
        </div>
        ${groupUsage}
      </div>`;
    }
    const label = sessionDisplayLabel(s.name);
    const preview = String(s.preview || "").trim();
    const basisLabel = s.priceLabel || (s.costBasis === "provider" ? "服务商账单" : s.costBasis === "mixed" ? "混合计价" : s.costBasis === "computed" ? "真实 token 计费" : "模型单价");
    const usage = (s.totalTokens || s.totalCostCny) ? usageInfo(
      { totalTokens: s.totalTokens, cost: { total: s.totalCost, totalFromProvider: s.costBasis === "provider" } },
      undefined, s.totalCostCny, basisLabel,
    ) : null;
    const detail = [
      s.messages ? `${s.messages} 条消息` : "空会话",
      s.totalTokens ? `${fmtTokensFull(s.totalTokens)} tok` : null,
      usage ? `${fmtCost(usage.costCny)}（${usage.source}）` : null,
    ].filter(Boolean).join(" · ");
    const usageLine = usage ? `<div class="sess-conv-usage">${icon("activity")}<span>${esc(usage.short)}</span><em>${esc(usage.source)}</em></div>` : "";
    return `<div class="sess-conv-item ${chatFile === s.file ? "active" : ""}" data-file="${esc(s.file)}" title="${esc(detail)}" onclick='viewSession(${JSON.stringify(s.file)},${JSON.stringify(s.name)})'>
      <div class="sess-conv-head">
        <b title="${esc(s.name)}">${esc(label.slice(0, 40))}${label.length > 40 ? "…" : ""}</b>
        <button class="sess-conv-more" title="更多操作" aria-label="更多操作" onclick='event.stopPropagation();toggleSessionMenu(event,this,${JSON.stringify(s.file)},${JSON.stringify(s.id)},${JSON.stringify(s.name)})'>${icon("more")}</button>
      </div>
      <div class="sess-conv-meta">
        <span class="sess-conv-preview">${preview ? esc(preview) : (s.messages ? "无文本预览" : "还没有消息，点击开始对话")}</span>
        <span class="sess-conv-time">${fmtSessionTime(s.lastTs)}</span>
      </div>
      ${usageLine}
    </div>`;
  }).join("");
}

// 会话卡片「...」菜单：操作收进浮层，卡片更紧凑，也避免误点删除
function closeSessionMenu() {
  $("#sessActionMenu")?.remove();
}

function toggleSessionMenu(evt, btn, file, id, name) {
  evt.stopPropagation();
  const existing = $("#sessActionMenu");
  if (existing?.dataset.file === file) { closeSessionMenu(); return; }
  closeSessionMenu();
  const menu = document.createElement("div");
  menu.id = "sessActionMenu";
  menu.className = "sess-action-menu";
  menu.dataset.file = file;
  menu.dataset.id = id;
  menu.dataset.name = name;
  menu.innerHTML = `
    <button class="sess-menu-item" data-act="chat">${icon("zap")}对话</button>
    <button class="sess-menu-item" data-act="export">${icon("download")}导出会话</button>
    <div class="sess-menu-divider"></div>
    <button class="sess-menu-item danger" data-act="delete">${icon("trash")}删除会话</button>`;
  menu.addEventListener("click", (e) => {
    const item = e.target.closest(".sess-menu-item");
    if (!item) return;
    e.stopPropagation();
    closeSessionMenu();
    const act = item.dataset.act;
    if (act === "chat") viewSession(menu.dataset.file, menu.dataset.name);
    else if (act === "export") exportSession(menu.dataset.file);
    else if (act === "delete") deleteSession(menu.dataset.file, menu.dataset.id);
  });
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = r.top - h - 6;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function selectSessionEmp(id) {
  sessionSelectedEmp = id;
  sessionActiveOwner = ""; // 切换归属 Filters 时不再标记旧会话
  closeSessionMenu();
  // 切换归属时关闭当前对话与群聊，避免展示不属于该归属的内容
  if (chatES) { try { chatES.close(); } catch {} chatES = null; }
  chatFile = null;
  if (gcState.groupId && gcState.host === "session") closeGroupChat();
  $("#sessionDetailPanel").classList.add("hidden");
  $("#sessionChatEmpty").classList.remove("hidden");
  chatSetRunning(false);
  renderSessionEmpList();
  renderSessions();
  // 切换归属后默认打开第一条会话，省去再点一次中栏
  const first = filteredSessionsForEmp(id)[0];
  if (first?.isGroup) viewGroupSession(first.groupId);
  else if (first) viewSession(first.file, first.name);
}

async function loadSessions() {
  const [sessions, emps, groups, ov] = await Promise.all([
    api("/api/sessions"),
    api("/api/org/employees").catch(() => []),
    api("/api/org/groups").catch(() => []),
    api("/api/overview").catch(() => null),
  ]);
  sessionsCache = Array.isArray(sessions) ? sessions : (sessions.sessions || []);
  employeesCache = Array.isArray(emps) ? emps : (emps.employees || []);
  groupsCache = Array.isArray(groups) ? groups : (groups.groups || []);
  if (ov) {
    overviewData = ov;
    if (ov.fx) adminFx = activeFx(ov.fx);
  }
  await loadGroupPreviews();
  renderSessionEmpList();
  renderSessions();
}

/** 拉取群频道最近消息，生成会话列表用的预览与时间 */
async function loadGroupPreviews() {
  const next = {};
  try {
    const msgs = await api("/api/org/messages?limit=1000");
    const byGroup = {};
    for (const m of (Array.isArray(msgs) ? msgs : [])) {
      const mm = String(m.channel || "").match(/^group:(.+)$/);
      if (!mm) continue;
      (byGroup[mm[1]] ||= []).push(m);
    }
    for (const [gid, list] of Object.entries(byGroup)) {
      const last = list[list.length - 1];
      let preview = String(last.body || "").replace(/\s+/g, " ").slice(0, 80);
      if (last.type === "sop_event") preview = `[流程] ${preview}`;
      let usageTokens = 0, usageCny = 0;
      const labels = new Set();
      for (const m of list) {
        if (!m.usage) continue;
        usageTokens += Number(m.usage.totalTokens) || 0;
        usageCny += m.costCny !== undefined && m.costCny !== null
          ? Number(m.costCny)
          : (Number(m.usage.cost?.total) || 0) * activeFx(overviewData?.fx).usdCny;
        if (m.priceLabel) labels.add(m.priceLabel);
      }
      next[gid] = {
        preview, lastTs: last.createdAt, count: list.length,
        usageTokens, usageCny, usageLabel: labels.size === 1 ? [...labels][0] : (labels.size > 1 ? "混合计价" : ""),
      };
    }
  } catch {}
  // SOP 运行状态也标注到卡片上
  try {
    await Promise.all(groupsCache.map(async (g) => {
      const r = await api(`/api/org/groups/${encodeURIComponent(g.id)}/sop`).catch(() => null);
      const runs = r?.runs || [];
      (next[g.id] ||= {}).sopStatus = runs.some((x) => x.status === "running") ? "running"
        : runs.some((x) => x.status === "blocked") ? "blocked" : "";
      (next[g.id] ||= {}).sopCount = runs.length;
    }));
  } catch {}
  groupPreviews = next;
}

function switchTab(tab) {
  const btn = $(`.nav-item[data-tab="${tab}"]`);
  if (btn) btn.click();
}

// ---------- 专注模式：只显示会话中心，其余区域全部让出空间 ----------
function toggleFocusMode(force) {
  const on = typeof force === "boolean" ? force : !document.body.classList.contains("focus-mode");
  document.body.classList.toggle("focus-mode", on);
  try { localStorage.setItem("pi-admin-focus-mode", on ? "1" : "0"); } catch {}
  $$("[data-focus-toggle]").forEach((b) => {
    b.title = on ? "退出专注模式（Alt+F / Esc）" : "专注模式：只显示会话中心（Alt+F）";
    b.classList.toggle("active", on);
    const use = b.querySelector("use");
    if (use) use.setAttribute("href", on ? "#i-unfocus" : "#i-focus");
    const label = b.querySelector(".focus-label");
    if (label) label.textContent = on ? "退出专注" : "专注模式";
    if (b.hasAttribute("aria-label")) b.setAttribute("aria-label", on ? "退出专注模式" : "专注模式");
  });
  if (on && !$("#view-sessions").classList.contains("active")) switchTab("sessions");
  setTimeout(() => { try { chatScroll(); } catch {} }, 80);
}

// ===== 实时聊天（Pi RPC + SSE）=====
let chatES = null;            // 当前 EventSource
let chatFile = null;          // 当前会话文件
let chatStreaming = false;    // 模型是否正在回复
let chatStreamEl = null;      // 正在流式填充的 assistant 气泡
let chatStreamText = "";
let chatHistoryCount = 0;     // 已渲染的历史消息数（用于去重）
let chatCurrentModel = null;  // 当前会话使用的模型 {provider, modelId}
let chatAgentName = "Pi";     // 当前会话的助手显示名（员工会话显示员工名）
let chatRunTools = null;      // 本轮工具调用折叠条（聚合 start/end，避免逐条刷屏）
let chatToolRecords = [];     // 本轮工具记录 [{name, detail, phase, isError}]
let chatRunUsage = null;      // 本轮真实用量（多次工具调用会累加）
let chatRunCostCny = 0;       // 本轮人民币金额（服务端按原生计价/峰谷价算好）
let chatRunCostLabels = new Set();

function chatSetModelDisplay(model) {
  if (!model) return;
  const provider = model.provider || "";
  const modelId = model.id || model.name || "";
  if (!provider || !modelId) return;
  chatCurrentModel = { provider, modelId };
  const badge = $("#chatModelBadge");
  if (badge) badge.textContent = `${provider}/${modelId}`;
  const sel = $("#chatModelSelect");
  if (sel) {
    const val = `${provider}|${modelId}`;
    if ([...sel.options].some((o) => o.value === val)) sel.value = val;
  }
}

function chatScroll() {
  const box = $("#chatMessages");
  if (box) box.scrollTop = box.scrollHeight;
}

function chatBubble(role, text, meta = "", rich = false) {
  const wrap = document.createElement("div");
  wrap.className = `chat-msg ${role}`;
  const label = role === "user" ? "你" : (role === "tool" ? "工具" : chatAgentName);
  const avatar = role === "user" ? "我" : (role === "tool" ? "⚙" : (chatAgentName || "P").slice(0, 1).toUpperCase());
  wrap.innerHTML = `<div class="chat-avatar ${role}">${esc(avatar)}</div>
    <div class="chat-msg-body"><div class="chat-msg-head"><b>${esc(label)}</b>${meta ? `<span class="chat-msg-meta">${esc(meta)}</span>` : ""}</div>
    <div class="chat-msg-text"></div></div>`;
  const el = wrap.querySelector(".chat-msg-text");
  if (rich) el.innerHTML = richMessage(text); else el.textContent = text;
  $("#chatMessages").appendChild(wrap);
  chatScroll();
  return wrap;
}

/** 空会话引导：有内容可看、可点，不再是一片空白 */
function renderChatIntro() {
  const box = $("#chatMessages");
  if (!box) return;
  const who = chatAgentName || "Pi";
  const name = sessionDisplayLabel(chatSessionName);
  const model = chatCurrentModel ? `${chatCurrentModel.provider}/${chatCurrentModel.modelId}` : "默认模型";
  const suggestions = [
    "介绍一下你能做什么",
    "帮我梳理这个项目的当前状态",
    "给我三个下一步建议",
  ];
  box.innerHTML = `<div class="chat-intro">
    <div class="chat-intro-icon">${icon("sparkle")}</div>
    <h3>和 ${esc(who)} 开始对话</h3>
    <p>会话「${esc(name)}」还没有消息。发出第一条消息后，这个会话会自动保存完整上下文。</p>
    <div class="chat-intro-meta">${icon("zap")}<span class="chat-intro-model">${esc(model)}</span><span class="chat-intro-dot"></span><span>本地会话 · 自动保存</span></div>
    <div class="chat-suggestions">${suggestions.map((s) => `<button type="button" onclick="useChatSuggestion(this.dataset.text)" data-text="${esc(s)}">${esc(s)}</button>`).join("")}</div>
  </div>`;
}

function useChatSuggestion(text) {
  const input = $("#chatInput");
  if (!input) return;
  input.value = text;
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

/**
 * 过程块折叠：把 thinking / 工具调用汇总成一条默认收起的细节条，
 * 不再把 [thinking]/[toolCall] 当正文一条条输出。
 * anchor 传入时挂到该条 assistant 气泡下方，否则独立成行。
 */
function chatProcessFold(blocks, anchor = null) {
  if (!blocks?.length) return;
  const details = document.createElement("details");
  details.className = "chat-process";
  const tools = blocks.filter((b) => b.kind === "tool");
  const thinkings = blocks.filter((b) => b.kind === "thinking");
  const results = blocks.filter((b) => b.kind === "toolResult");
  const steps = tools.length || results.length;
  const hasThink = thinkings.length > 0;
  const single = steps === 1 ? (tools[0] || results[0]) : null;
  let summary = "过程细节";
  let summaryIcon = "chevron";
  if (steps > 1 || (steps > 0 && hasThink)) {
    // 多轮工具调用合并成一条，只记步骤数，不再一条条列「1 次工具调用」
    summary = `${hasThink ? "深度思考 · " : ""}查看 ${steps} 个步骤`;
    summaryIcon = "eye";
  } else if (single) {
    summary = `已完成 ${single.name || "工具"}`;
    summaryIcon = "circle-check";
  } else if (hasThink) {
    summary = "深度思考";
    summaryIcon = "sparkle";
  }

  let body = "";
  if (thinkings.length) {
    body += thinkings.map((b) => `<div class="cp-thinking">${esc(b.text || "")}</div>`).join("");
  }
  if (tools.length) {
    body += tools.map((b) => `<div class="cp-tool"><b>${esc(b.name || "工具")}</b>${b.detail ? ` <span>${esc(b.detail)}</span>` : ""}</div>`).join("");
  }
  if (results.length) {
    body += results.map((b) => `<div class="cp-result"><b>${esc(b.name || "工具")}</b><pre>${esc(b.text || "")}</pre></div>`).join("");
  }

  details.title = "展开查看思考过程与工具步骤";
  details.innerHTML = `<summary><svg class="icon ${summaryIcon === "chevron" ? "cp-chevron" : ""}" style="width:13px;height:13px"><use href="#i-${summaryIcon}"/></svg>${esc(summary)}</summary><div class="chat-process-body">${body}</div>`;
  if (anchor && anchor.parentElement) {
    anchor.insertAdjacentElement("afterend", details);
  } else {
    $("#chatMessages").appendChild(details);
  }
  chatScroll();
  return details;
}

/** 把本轮的工具调用聚合成一条默认收起的折叠条，就地更新而不是逐条刷屏 */
function chatRenderRunTools() {
  if (!chatToolRecords.length) return;
  const done = chatToolRecords.filter((r) => r.phase === "done").length;
  const running = chatToolRecords.length - done;
  const summary = running > 0
    ? `查看 ${chatToolRecords.length} 个步骤 · ${running} 进行中`
    : `查看 ${chatToolRecords.length} 个步骤`;
  let body = chatToolRecords.map((r) => {
    const mark = r.isError ? "✕" : (r.phase === "running" ? "…" : "✓");
    return `<div class="cp-tool ${r.isError ? "err" : ""}"><span class="cp-mark">${mark}</span><b>${esc(r.name)}</b>${r.detail ? ` <span>${esc(r.detail)}</span>` : ""}</div>`;
  }).join("");

  if (!chatRunTools || !chatRunTools.isConnected) {
    chatRunTools = document.createElement("details");
    chatRunTools.className = "chat-process live";
    chatRunTools.innerHTML = `<summary><svg class="icon" style="width:13px;height:13px"><use href="#i-eye"/></svg><span class="cp-summary"></span></summary><div class="chat-process-body"></div>`;
    $("#chatMessages").appendChild(chatRunTools);
  }
  chatRunTools.querySelector(".cp-summary").textContent = summary;
  chatRunTools.querySelector(".chat-process-body").innerHTML = body;
  chatScroll();
}

/** 工具参数摘要：让「调用 bash」显示具体命令，避免只剩一个空气泡 */
function chatToolDetail(args) {
  if (!args) return "";
  if (typeof args === "string") return args.replace(/\s+/g, " ").slice(0, 120);
  for (const k of ["command", "path", "pattern", "file", "url", "query"]) {
    if (args[k]) return String(args[k]).replace(/\s+/g, " ").slice(0, 120);
  }
  try { return JSON.stringify(args).replace(/\s+/g, " ").slice(0, 120); } catch { return ""; }
}

function chatSetStatus(kind, text) {
  const el = $("#chatStatus");
  el.className = `chat-status ${kind || ""}`;
  el.textContent = text || "";
}

function chatSetRunning(running) {
  chatStreaming = running;
  $("#chatSendBtn").style.display = running ? "none" : "";
  $("#chatStopBtn").style.display = running ? "" : "none";
  $("#chatInput").disabled = false; // 允许排队（steer），不锁输入
  chatSetStatus(running ? "busy" : "", running ? "生成中…" : "就绪");
}

/** Pi 的锁文件删除被运行环境拦截时的可操作提示（沙箱/安全软件场景） */
function chatShowLockError() {
  chatSetRunning(false);
  chatSetStatus("err", "环境拦截");
  const box = $("#chatMessages");
  if (box.querySelector(".chat-fatal")) return;
  box.innerHTML = `<div class="chat-fatal">
    <div class="chat-fatal-icon"><svg class="icon"><use href="#i-circle-alert"/></svg></div>
    <h3>Pi 无法启动：运行环境拦截了配置文件锁</h3>
    <p>管理端已默认让 Pi 使用隔离运行时目录，避免触碰 <code>~/.pi/agent/*.lock</code>；当前仍被拦截，说明该进程仍在受限环境里。请先重启管理端；若仍出现，再用普通终端启动。</p>
    <p class="chat-fatal-lead">普通终端启动命令：</p>
    <pre>cd /Users/lishuai/ai/pi/my-workspace/admin
node server.mjs --port 8787</pre>
    <p class="chat-fatal-note">普通终端没有该限制，启动后刷新本页即可正常对话。管理端界面本身的功能不受影响。</p>
  </div>`;
}

async function viewSession(file, name) {
  // 从群聊切回普通会话：先把群聊卡片归位到弹层槽
  if (gcState.host === "session") closeGroupChat();
  // 左侧标出这条会话的归属：群 > 员工 > 我的会话；不切换左侧筛选（仍保持“全部会话”）
  const ownerSession = sessionsCache.find((s) => s.file === file)
    || { employeeId: String(file).match(/org-workspaces-(emp-[a-z0-9]+)/)?.[1] || null };
  sessionActiveOwner = sessionOwnerKey(ownerSession);
  renderSessionEmpList(true);
  if (chatFile === file && chatES) {
    $("#sessionDetailPanel").classList.remove("hidden");
    $("#sessionChatEmpty").classList.add("hidden");
    chatScroll();
    return;
  }

  // 高亮选中的会话卡片；显示聊天栏、隐藏空状态
  $$(".sess-conv-item").forEach((el) => el.classList.toggle("active", el.dataset.file === file));
  $("#sessionDetailPanel").classList.remove("hidden");
  $("#sessionChatEmpty").classList.add("hidden");

  // 关闭上一条连接
  if (chatES) { try { chatES.close(); } catch {} chatES = null; }
  chatFile = file;
  syncSummaryToggle();
  chatCurrentModel = null;
  chatStreamEl = null;
  chatStreamText = "";
  chatHistoryCount = 0;
  // 员工会话显示员工名，普通会话显示 Pi
  chatAgentName = "Pi";
  const empMatch = file.match(/org-workspaces-(emp-[a-z0-9]+)/);
  if (empMatch) {
    try {
      const list = await api("/api/org/employees");
      const emp = (Array.isArray(list) ? list : list.employees || []).find((e) => e.id === empMatch[1]);
      if (emp) chatAgentName = emp.name || emp.id || "Pi";
    } catch {}
  } else {
    const labelMatch = name && String(name).match(/^与(.+)对话(?:\s*·.*)?$/);
    if (labelMatch) chatAgentName = labelMatch[1];
  }

  chatSessionName = name || "";
  $("#sessionDetailPanel").classList.remove("hidden");
  renderChatTitle();
  $("#chatMessages").innerHTML = `<div class="chat-welcome"><svg class="icon" style="width:30px;height:30px"><use href="#i-sparkle"/></svg><p>正在连接 Pi…</p></div>`;
  $("#chatModelBadge").textContent = "连接中…";
  $("#chatHint").textContent = "";
  chatRunUsage = null;
  chatRunCostCny = 0;
  chatRunCostLabels = new Set();
  chatSetStatus("", "连接中");

  try {
    // 1) 先加载历史消息（只读接口，不受解锁影响）
    const d = await api(`/api/session?file=${encodeURIComponent(file)}`);
    $("#chatMessages").innerHTML = "";
    // model_change / compaction 等系统事件也会出现在 entries 里，不能据此判断「有消息」。
    // 否则清空后一条都不渲染，聊天区就是一片空白。
    const visible = (d.entries || []).filter((e) =>
      ["user", "assistant"].includes(e.role) && (e.text || e.blocks?.length));
    if (visible.length) {
      // 一轮对话里可能有几十条「只有 thinking / toolCall」的 assistant 消息。
      // 先把过程块攒起来，遇到下一条正文（或用户消息）时合并成一条「查看 N 个步骤」。
      let pendingBlocks = [];
      const flushProcess = () => {
        if (!pendingBlocks.length) return;
        chatProcessFold(pendingBlocks);
        pendingBlocks = [];
      };
      for (const e of visible) {
        const info = usageInfo(e.usage, undefined, e.costCny, e.priceLabel);
        const meta = [
          e.model ? `${e.provider}/${e.model}` : "",
          info ? `${info.short}（${info.source}）` : "",
        ].filter(Boolean).join(" · ");
        chatHistoryCount++;
        if (e.role === "user") {
          flushProcess();
          chatBubble("user", e.text);
          continue;
        }
        if (e.blocks?.length) pendingBlocks.push(...e.blocks);
        if (e.text) {
          flushProcess();
          chatBubble("assistant", e.text, meta, true);
        }
      }
      flushProcess();
    } else {
      renderChatIntro();
    }
  } catch (e) {
    $("#chatMessages").innerHTML = `<div class="chat-welcome"><svg class="icon" style="width:30px;height:30px"><use href="#i-circle-alert"/></svg><p>${esc(e.message)}</p></div>`;
  }

  // 2) 建立 SSE 长连接
  try {
    chatES = new EventSource(`/api/chat/stream?file=${encodeURIComponent(file)}`);
    chatES.addEventListener("hello", (ev) => {
      const d = JSON.parse(ev.data);
      if (d.model) chatSetModelDisplay(d.model);
      else $("#chatModelBadge").textContent = "默认模型";
      const introModel = $("#chatMessages .chat-intro-model");
      if (introModel) introModel.textContent = $("#chatModelBadge").textContent;
      chatSetStatus("ok", "已连接");
    });
    chatES.addEventListener("state", (ev) => {
      const d = JSON.parse(ev.data);
      if (d.model) chatSetModelDisplay(d.model);
      if (typeof d.isStreaming === "boolean") chatSetRunning(d.isStreaming);
    });
    chatES.addEventListener("user_echo", (ev) => {
      const d = JSON.parse(ev.data);
      $$("#chatMessages .chat-welcome, #chatMessages .chat-intro").forEach((el) => el.remove());
      chatBubble("user", d.text);
    });
    chatES.addEventListener("run_start", () => {
      chatStreamText = "";
      chatStreamEl = null;
      chatRunTools = null;
      chatToolRecords = [];
      chatRunUsage = null;
      chatRunCostCny = 0;
      chatRunCostLabels = new Set();
      $("#chatHint").textContent = "";
      chatSetRunning(true);
    });
    chatES.addEventListener("delta", (ev) => {
      const d = JSON.parse(ev.data);
      if (!d.text) return;
      chatStreamText += d.text;
      if (!chatStreamEl) chatStreamEl = chatBubble("assistant", "");
      chatStreamEl.querySelector(".chat-msg-text").textContent = chatStreamText;
      chatScroll();
    });
    chatES.addEventListener("tool", (ev) => {
      const d = JSON.parse(ev.data);
      const name = d.name || "tool";
      const phase = d.phase || "start";
      if (phase === "start") {
        chatToolRecords.push({ name, detail: chatToolDetail(d.args), phase: "running", isError: false });
      } else {
        // end：更新最后一条同名工具为完成态
        for (let i = chatToolRecords.length - 1; i >= 0; i--) {
          if (chatToolRecords[i].name === name && chatToolRecords[i].phase === "running") {
            chatToolRecords[i].phase = "done";
            chatToolRecords[i].isError = !!d.isError;
            break;
          }
        }
      }
      chatRenderRunTools();
    });
    chatES.addEventListener("message_end", (ev) => {
      const d = JSON.parse(ev.data);
      if (d.text && chatStreamEl) {
        const textEl = chatStreamEl.querySelector(".chat-msg-text");
        textEl.innerHTML = richMessage(d.text);
        if (chatFile && summaryEnabled(chatFile)) {
          renderSummary(chatStreamEl, d.text);
        }
      } else if (!d.text && chatStreamEl) chatStreamEl.remove();
      if (d.usage) {
        chatRunUsage = mergeUsages(chatRunUsage, d.usage);
        chatRunCostCny += Number(d.cost?.cny) || 0;
        if (d.cost?.label) chatRunCostLabels.add(d.cost.label);
        const info = usageInfo(chatRunUsage, d.fx, chatRunCostCny, [...chatRunCostLabels].join("、"));
        if (info) $("#chatHint").textContent = `${info.long} · 本轮累计`;
      }
      chatStreamEl = null;
      chatStreamText = "";
    });
    chatES.addEventListener("run_end", (ev) => {
      const d = JSON.parse(ev.data);
      if (chatStreamEl && !chatStreamEl.querySelector(".chat-msg-text").textContent.trim()) chatStreamEl.remove();
      if (d.aborted && chatStreamEl) {
        chatStreamEl.querySelector(".chat-msg-text").textContent = (chatStreamText || "") + "  [已停止]";
      }
      chatStreamEl = null;
      chatStreamText = "";
      chatSetRunning(false);
      loadSessions(); // 刷新列表的 token/费用
    });
    chatES.addEventListener("stderr", (ev) => {
      const d = JSON.parse(ev.data);
      const text = String(d.text || "");
      // 锁文件删除被拦截：Pi 启动即崩溃。给出可操作的错误面板，而不是含糊的 toast。
      if (/EPERM|operation not permitted/i.test(text) && /\.lock|rmdir|unlink/i.test(text)) {
        chatShowLockError();
        return;
      }
      const lines = text.split("\n").filter((l) => /error|denied|failed|fatal|exception/i.test(l));
      if (lines.length) toast(`Pi：${lines[0].trim().slice(0, 180)}`, "err");
    });
    chatES.addEventListener("error", (ev) => {
      let msg = "出错了";
      try { msg = JSON.parse(ev.data).message || msg; } catch {}
      toast(msg, "err");
      chatSetRunning(false);
    });
    chatES.addEventListener("model_changed", (ev) => {
      const d = JSON.parse(ev.data);
      if (d.model) chatSetModelDisplay(d.model);
    });
    chatES.addEventListener("process_exit", (ev) => {
      const d = JSON.parse(ev.data);
      chatSetRunning(false);
      // 已显示锁错误面板时不再用 toast 覆盖
      if ($("#chatMessages .chat-fatal")) return;
      chatSetStatus("err", "进程已退出");
      toast(`Pi 进程已退出（code ${d.code}）`, "err");
    });
    chatES.onerror = () => {
      chatSetStatus("err", "连接断开");
    };
  } catch (e) {
    toast(`连接失败：${e.message}`, "err");
  }

  // 3) 加载模型下拉
  fillChatModels();
  setTimeout(() => $("#chatInput")?.focus(), 300);
}

async function fillChatModels() {
  const sel = $("#chatModelSelect");
  if (!sel) return;
  let data;
  try {
    data = await api("/api/models/configured");
  } catch (e) {
    sel.innerHTML = `<option value="">模型列表加载失败</option>`;
    return;
  }
  const opts = (data.providers || []).map((p) =>
    `<optgroup label="${esc(p.label)}">${(p.models || []).map((m) =>
      `<option value="${esc(p.id)}|${esc(m.id)}" title="${esc(m.id)}">${esc(m.name || m.id)}</option>`).join("")}</optgroup>`).join("");
  sel.innerHTML = `<option value="">${data.total ? "切换模型…" : "请先在「模型与认证」设置模型"}</option>${opts}`;
  if (chatCurrentModel) {
    const val = `${chatCurrentModel.provider}|${chatCurrentModel.modelId}`;
    if ([...sel.options].some((o) => o.value === val)) sel.value = val;
  }
}

async function chatChangeModel() {
  const sel = $("#chatModelSelect");
  const v = sel.value;
  if (!v || !chatFile) return;
  const [provider, modelId] = v.split("|");
  const restore = () => {
    sel.value = chatCurrentModel ? `${chatCurrentModel.provider}|${chatCurrentModel.modelId}` : "";
  };
  try {
    const r = await api("/api/chat/model", { method: "POST", body: JSON.stringify({ unlocked: true, file: chatFile, provider, modelId }) });
    chatSetModelDisplay(r.model || { provider, id: modelId });
    toast(`已切换到 ${provider}/${modelId}`, "ok");
  } catch (e) { toast(e.message, "err"); restore(); }
}

async function chatSend() {
  if (!chatFile) return;
  const input = $("#chatInput");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  $("#chatHint").textContent = "";
  try {
    await api("/api/chat/send", {
      method: "POST",
      body: JSON.stringify({ unlocked: true, file: chatFile, message, ...(chatStreaming ? { streamingBehavior: "steer" } : {}) }),
    });
    chatSetRunning(true);
  } catch (e) {
    toast(e.message, "err");
    input.value = message; // 恢复
  }
}

function chatInputKeydown(e) {
  if (mentionKeydown(e)) return;
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chatSend(); }
}

// ---------- 任务 → 会话：跳转到会话中心，或在弹窗里打开同一条实时会话 ----------
async function openTaskSession(file, fallbackName = "", mode = "jump") {
  if (!file) { toast("该任务还没有会话，先调用 Pi 执行", "err"); return; }
  closeTaskDetail();
  if (mode === "popup") { await openTaskSessionModal(file, fallbackName); return; }
  switchTab("sessions");
  await loadSessions();
  const s = sessionsCache.find((x) => x.file === file);
  if ($("#sessionSearch")) $("#sessionSearch").value = "";
  sessionSelectedEmp = "__all__";
  sessionActiveOwner = "";
  renderSessionEmpList();
  renderSessions();
  await viewSession(file, s?.name || fallbackName || "任务会话");
}

async function openTaskSessionModal(file, fallbackName = "") {
  const panel = $("#sessionDetailPanel");
  const body = $("#sessionViewModalBody");
  if (!panel || !body) return;
  // 把会话中心现成的聊天面板临时挂进弹窗，复用同一条 SSE 连接，不重复建连
  body.appendChild(panel);
  panel.classList.remove("hidden");
  $("#sessionChatEmpty")?.classList.remove("hidden");
  $("#sessionViewTitle").textContent = fallbackName || "任务会话";
  $("#sessionViewModal").classList.remove("hidden");
  const s = sessionsCache.find((x) => x.file === file);
  await viewSession(file, s?.name || fallbackName || "任务会话");
  $("#sessionViewTitle").textContent = chatSessionName || fallbackName || "任务会话";
}

function closeTaskSessionModal() {
  const modal = $("#sessionViewModal");
  if (!modal || modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  const panel = $("#sessionDetailPanel");
  const chatPane = $(".sess-chat");
  const groupHost = $("#sessionGroupHost");
  if (chatPane && groupHost) chatPane.insertBefore(panel, groupHost);
  else chatPane?.appendChild(panel);
  if (chatFile) {
    panel.classList.remove("hidden");
    $("#sessionChatEmpty")?.classList.add("hidden");
  } else {
    panel.classList.add("hidden");
    $("#sessionChatEmpty")?.classList.remove("hidden");
  }
  setTimeout(() => { try { chatScroll(); } catch {} }, 80);
}

async function chatStop() {
  if (!chatFile) return;
  try {
    await api("/api/chat/abort", { method: "POST", body: JSON.stringify({ file: chatFile }) });
    toast("已请求停止", "ok");
  } catch (e) { toast(e.message, "err"); }
}

function closeSessionDetail() {
  $("#sessionDetailPanel").classList.add("hidden");
  $("#sessionChatEmpty").classList.remove("hidden");
  $$(".sess-conv-item").forEach((el) => el.classList.remove("active"));
  if (chatES) { try { chatES.close(); } catch {} chatES = null; }
  chatFile = null;
  sessionActiveOwner = "";
  renderSessionEmpList();
  chatSetRunning(false);
}

// ---------- 新开会话：直接创建并在右侧开聊 ----------
async function quickCreateSession() {
  let cwd = overviewData?.workspace || "";
  const emp = employeesCache.find((e) => e.id === sessionSelectedEmp);
  const d = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const name = emp?.workspace
    ? `与${emp.name || emp.id}对话 · ${hhmm}`
    : `新会话 · ${hhmm}`;
  if (emp?.workspace) cwd = `${cwd.replace(/\/$/, "")}/${emp.workspace.replace(/^\//, "")}`;
  try {
    const r = await api("/api/session/quick-create", {
      method: "POST",
      body: JSON.stringify({ unlocked: true, cwd, name }),
    });
    await loadSessions();
    await viewSession(r.file, r.name);
    toast("已创建，可以直接开始聊天", "ok");
  } catch (e) { toast(e.message, "err"); }
}

// 会话名：右侧标题就地修改（回车保存，Esc 取消）
let chatSessionName = "";
function renderChatTitle() {
  const h = $("#sessionDetailTitle");
  if (!h) return;
  h.textContent = sessionDisplayLabel(chatSessionName || (chatFile ? chatFile.split("/").pop() : ""));
  $("#chatRenameBtn")?.classList.remove("hidden");
}
function startChatRename() {
  if (!chatFile) { toast("请先打开一条会话", "err"); return; }
  const h = $("#sessionDetailTitle");
  h.innerHTML = `<input id="chatRenameInput" class="chat-rename-input" value="${esc(chatSessionName)}" maxlength="80" placeholder="输入会话名称">`;
  $("#chatRenameBtn")?.classList.add("hidden");
  const input = $("#chatRenameInput");
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (!save) { renderChatTitle(); return; }
    const name = input.value.trim();
    if (!name) { toast("名称不能为空", "err"); renderChatTitle(); return; }
    try {
      await api("/api/session/rename", {
        method: "POST",
        body: JSON.stringify({ unlocked: true, file: chatFile, name }),
      });
      chatSessionName = name;
      await loadSessions();
      toast("已重命名", "ok");
    } catch (e) { toast(e.message, "err"); }
    renderChatTitle();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true), { once: true });
}

function exportSession(file) {
  window.location.href = `/api/session/export?file=${encodeURIComponent(file)}`;
  toast("已开始下载", "ok");
}

async function deleteSession(file, id) {
  if (!(await appConfirm({
    title: "删除会话", subtitle: "会话移除后可在备份中找回",
    message: `确定删除会话「${id.slice(0, 8)}…」吗？`,
    detail: "原文件会先备份到 admin/.backups/，删除后界面不再显示。",
    okText: "确认删除", icon: "trash",
  }))) return;
  try {
    await api("/api/session", { method: "DELETE", body: JSON.stringify({ file }) });
    toast("已删除（原文件已备份）", "ok");
    if (chatFile === file) closeSessionDetail();
    loadSessions();
  } catch (e) { toast(e.message, "err"); }
}

// ---------- 模型与认证 ----------
async function loadModels() {
  const d = await api("/api/models");
  const defs = [
    ["默认 Provider", d.defaultProvider],
    ["默认模型", d.defaultModel],
    ["默认思考级别", d.defaultThinkingLevel],
    ["启用的模型模式", d.enabledModels.length ? d.enabledModels.join(", ") : "(全部)"],
  ];
  $("#modelDefaults").innerHTML = defs.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${String(v) === "(自动)" ? esc(v) + ' <span class="tag type">跟随 Pi</span>' : esc(v)}</span></div>`).join("");

  const credBody = $("#credTable tbody");
  credBody.innerHTML = d.credentials.length ? d.credentials.map((c) => `<tr>
    <td><b>${esc(c.provider)}</b></td>
    <td><span class="tag type">${esc(c.type)}</span></td>
    <td class="mono">${esc(c.key || "—")}</td>
    <td class="mono">${c.oauth ? `access: ${esc(c.oauth.access)}<br>refresh: ${esc(c.oauth.refresh)}` : "—"}</td>
    <td>${c.hasEnv ? "有" : "—"}</td>
  </tr>`).join("") : emptyState("key", "还没有保存的凭证", "在 Pi 终端执行 <code>/login</code> 登录后，凭证会显示在这里。密钥始终脱敏显示。");

  const provBody = $("#providerTable tbody");
  provBody.innerHTML = d.configuredProviders.length ? d.configuredProviders.map((p) => {
    const modelCells = p.models.length
      ? p.models.map((m) => `<div style="display:flex;align-items:center;gap:6px;margin:2px 0">
          <span class="mono">${esc(m)}</span>
          <button class="icon-btn" style="width:22px;height:22px" title="删除该模型"
            onclick='removeModel(${JSON.stringify(p.id)},${JSON.stringify(m)})'>${icon("x", "icon-sm")}</button>
        </div>`).join("")
      : "—";
    return `<tr>
      <td><b>${esc(p.id)}</b></td>
      <td class="mono">${esc(p.baseUrl || "—")}</td>
      <td class="mono">${esc(p.api || "—")}</td>
      <td class="mono">${esc(p.apiKey || "—")}</td>
      <td>${modelCells}</td>
      <td><button class="btn btn-sm" onclick='addModelTo(${JSON.stringify(p.id)},${JSON.stringify(p.baseUrl)},${JSON.stringify(p.api)})'>${icon("plus", "icon-sm")}加模型</button></td>
    </tr>`;
  }).join("") : emptyState("server", "还没有自定义端点",
    "点右上角「新增模型」从内置目录挑选，或在 <code>models.json</code> 里手动配置。",
    `<button class="btn primary" onclick="openAddModel()">${icon("plus")}新增模型</button>`);

  loadModelTestList();
}

// ---------- 模型连通性校验 ----------
let modelTestTargets = [];
let modelDefaultsData = { provider: "", modelId: "" };
let setDefaultConfigured = [];

/** 直接把某个已配置模型设为默认（列表行内按钮） */
async function setDefaultModel(provider, modelId, name) {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  try {
    const r = await api("/api/models/set-default", {
      method: "POST",
      body: JSON.stringify({ unlocked: true, provider, modelId }),
    });
    toast(`已设为默认：${name || modelId}`, "ok");
    await loadModels();
  } catch (e) { toast(e.message, "err"); }
}

/** 打开「设置默认模型」弹窗：按 Provider 分组列出已配置模型 */
async function openSetDefault() {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  try {
    const data = await api("/api/models/configured");
    setDefaultConfigured = data.providers || [];
    modelDefaultsData = { provider: data.defaultProvider || "", modelId: data.defaultModel || "" };
  } catch (e) { toast(e.message, "err"); return; }
  const pSel = $("#sd-provider");
  pSel.innerHTML = '<option value="">— 请选择 Provider —</option>' +
    setDefaultConfigured.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}（${esc(p.id)}）</option>`).join("");
  $("#sd-model").innerHTML = '<option value="">— 先选 Provider —</option>';
  const notice = $("#sd-notice");
  notice.style.display = "none";
  // 预选当前默认
  if (modelDefaultsData.provider && setDefaultConfigured.some((p) => p.id === modelDefaultsData.provider)) {
    pSel.value = modelDefaultsData.provider;
    onSetDefaultProvider();
    const mSel = $("#sd-model");
    if (modelDefaultsData.modelId) mSel.value = modelDefaultsData.modelId;
  }
  $("#setDefaultModal").classList.remove("hidden");
}

function closeSetDefault() { $("#setDefaultModal").classList.add("hidden"); }

function onSetDefaultProvider() {
  const pid = $("#sd-provider").value;
  const mSel = $("#sd-model");
  const p = setDefaultConfigured.find((x) => x.id === pid);
  mSel.innerHTML = p
    ? p.models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} — ${esc(m.id)}</option>`).join("")
    : '<option value="">— 先选 Provider —</option>';
}

async function submitSetDefault() {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  const provider = $("#sd-provider").value;
  const modelId = $("#sd-model").value;
  if (!provider || !modelId) { toast("请选择 Provider 和模型", "err"); return; }
  try {
    await api("/api/models/set-default", {
      method: "POST",
      body: JSON.stringify({ unlocked: true, provider, modelId }),
    });
    closeSetDefault();
    toast("默认模型已设置", "ok");
    await loadModels();
  } catch (e) { toast(e.message, "err"); }
}

async function loadModelTestList() {
  const box = $("#modelTestList");
  if (!box) return;
  modelTestTargets = [];
  let data;
  try { data = await api("/api/models/configured"); }
  catch (e) { box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return; }
  modelDefaultsData = { provider: data.defaultProvider || "", modelId: data.defaultModel || "" };
  for (const p of data.providers || []) {
    for (const m of p.models || []) modelTestTargets.push({ provider: p.id, label: p.label, modelId: m.id, name: m.name });
  }
  box.innerHTML = modelTestTargets.length ? modelTestTargets.map((m, i) => {
    const isDefault = m.provider === modelDefaultsData.provider && m.modelId === modelDefaultsData.modelId;
    return `<div class="model-test-row ${isDefault ? "is-default" : ""}">
      <div class="model-test-info">
        <b>${esc(m.label)}${isDefault ? ' <span class="tag type">默认</span>' : ""}</b>
        <span class="mono">${esc(m.name)} — ${esc(m.modelId)}</span>
      </div>
      <span class="model-test-result" id="modelTestResult-${i}">未测试</span>
      <button class="btn btn-sm ${isDefault ? "" : "primary"}" onclick='setDefaultModel(${JSON.stringify(m.provider)},${JSON.stringify(m.modelId)},${JSON.stringify(m.name)})' ${isDefault ? "disabled" : ""}>${isDefault ? "当前默认" : "设为默认"}</button>
      <button class="btn btn-sm" onclick="testModel(${i})">测试</button>
    </div>`;
  }).join("")
    : `<div class="empty">还没有已设置的模型，请点右上角「新增模型」</div>`;
}

async function testModel(index) {
  const m = modelTestTargets[index];
  const el = $(`#modelTestResult-${index}`);
  if (!m || !el) return;
  el.className = "model-test-result testing";
  el.textContent = "测试中…";
  try {
    const r = await api("/api/models/test", {
      method: "POST",
      body: JSON.stringify({ provider: m.provider, modelId: m.modelId }),
    });
    el.textContent = r.ok ? `✓ 可用 · ${r.latencyMs} ms` : `✗ ${r.error || "校验失败"}`;
    el.className = `model-test-result ${r.ok ? "ok" : "err"}`;
    el.title = r.ok ? `HTTP ${r.status}` : (r.error || "");
  } catch (e) {
    el.textContent = `✗ ${e.message}`;
    el.className = "model-test-result err";
    el.title = e.message;
  }
}

async function testAllModels() {
  for (let i = 0; i < modelTestTargets.length; i++) await testModel(i);
}

// ---------- 新增模型弹窗 ----------
let providerCatalog = [];
let modelManualMode = false;

async function ensureBuiltinProviders() {
  if (!builtinProviders.length) {
    try { builtinProviders = await api("/api/models/builtin-providers"); } catch {}
  }
}

async function ensureProviderCatalog(force = false) {
  if (force || !providerCatalog.length) {
    try { providerCatalog = await api("/api/models/provider-catalog"); } catch {}
  }
}

function getProviderById(id) { return providerCatalog.find((p) => p.id === id); }

function populateProviderSelect() {
  const sel = $("#mf-providerSelect");
  if (!sel) return;
  const groups = { cn: [], global: [], custom: [] };
  for (const p of providerCatalog) groups[p.region === "cn" ? "cn" : p.region === "custom" ? "custom" : "global"].push(p);
  const opts = (list) => list.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}（${esc(p.id)}）</option>`).join("");
  sel.innerHTML =
    '<option value="">— 请选择 Provider —</option>' +
    `<optgroup label="国内 Provider">${opts(groups.cn)}</optgroup>` +
    `<optgroup label="国外 / 国际 Provider">${opts(groups.global)}</optgroup>` +
    (groups.custom.length ? `<optgroup label="自定义 Provider">${opts(groups.custom)}</optgroup>` : "") +
    '<option value="__custom__">自定义 Provider（手动输入 ID）</option>';
}

// 选 Provider → 自动填地址/API/名称，并把该 Provider 的模型 ID + 名称填进下拉
function onProviderSelect() {
  const id = $("#mf-providerSelect").value;
  const customInput = $("#mf-providerId");
  const modelSel = $("#mf-modelSelect");
  if (id === "__custom__") {
    customInput.classList.remove("hidden");
    customInput.value = "";
    modelSel.innerHTML = '<option value="">— 自定义：请手动输入模型 ID —</option>';
    $("#modelSelectHint").textContent = "自定义 Provider：点下方链接手动输入模型 ID";
    $("#mf-baseUrl").value = "";
    $("#mf-api").value = "openai-completions";
    $("#mf-name").value = "";
    setModelManual(true);
    checkBuiltinHint();
    return;
  }
  if (!id) {
    customInput.classList.add("hidden");
    customInput.value = "";
    modelSel.innerHTML = '<option value="">— 先选择 Provider —</option>';
    $("#modelSelectHint").textContent = "先选上面的 Provider，再从列表挑选";
    checkBuiltinHint();
    return;
  }
  const p = getProviderById(id);
  if (!p) return;
  customInput.classList.add("hidden");
  customInput.value = p.id; // 值载体：现有 submit 逻辑不用改
  $("#mf-baseUrl").value = p.baseUrl;
  if (p.apis.length) $("#mf-api").value = p.apis[0];
  if (!$("#mf-name").value.trim()) $("#mf-name").value = p.label;
  modelSel.innerHTML =
    `<option value="">— 从 ${esc(p.label)} 的 ${p.models.length} 个模型中选择 —</option>` +
    p.models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} — ${esc(m.id)}</option>`).join("");
  $("#modelSelectHint").textContent = `共 ${p.models.length} 个模型可选，选中后自动填入参数`;
  setModelManual(false);
  checkBuiltinHint();
}

// 选模型 → 自动填模型 ID/显示名/上下文/输出/输入类型/reasoning
function onModelSelect() {
  const id = $("#mf-modelSelect").value;
  if (!id) return;
  const p = getProviderById($("#mf-providerSelect").value);
  const m = p?.models.find((x) => x.id === id);
  if (!m) return;
  $("#mf-modelId").value = m.id; // 值载体
  $("#mf-modelName").value = m.name;
  if (m.contextWindow) $("#mf-contextWindow").value = m.contextWindow;
  if (m.maxTokens) $("#mf-maxTokens").value = m.maxTokens;
  if (m.api) $("#mf-api").value = m.api;
  $("#mf-input").value = String(m.input).includes("image") ? "text,image" : "text";
  $("#mf-reasoning").checked = !!m.reasoning;
}

function setModelManual(on) {
  modelManualMode = on;
  $("#mf-modelSelect").classList.toggle("hidden", on);
  $("#mf-modelId").classList.toggle("hidden", !on);
  const btn = $("#manualModelBtn");
  if (btn) btn.textContent = on ? "↩ 改回下拉选择" : "手动输入模型 ID";
  if (on) $("#mf-modelId").focus();
}

function toggleModelManual() { setModelManual(!modelManualMode); }

async function openAddModel(providerId = "", baseUrl = "", apiType = "") {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  await ensureBuiltinProviders();
  await ensureProviderCatalog();
  populateProviderSelect();
  $("#modelModal").classList.remove("hidden");
  // 重置表单，避免上次残留
  $("#mf-name").value = "";
  $("#mf-modelName").value = "";
  $("#mf-contextWindow").value = "";
  $("#mf-maxTokens").value = "";
  $("#mf-apiKey").value = "";
  $("#mf-modelId").value = "";
  $("#mf-reasoning").checked = false;
  $("#mf-authHeader").checked = false;
  $("#mf-baseUrl").value = baseUrl;
  if (providerId && getProviderById(providerId)) {
    $("#mf-providerSelect").value = providerId;
    onProviderSelect();
  } else if (providerId) {
    $("#mf-providerSelect").value = "__custom__";
    onProviderSelect();
    $("#mf-providerId").value = providerId;
  } else {
    $("#mf-providerSelect").value = "";
    onProviderSelect();
  }
  if (apiType) $("#mf-api").value = apiType;
}

function closeAddModel() { $("#modelModal").classList.add("hidden"); }

function addModelTo(providerId, baseUrl, apiType) { openAddModel(providerId, baseUrl, apiType); }

function checkBuiltinHint() {
  const id = $("#mf-providerId").value.trim();
  const hint = $("#builtinHint");
  if (builtinProviders.includes(id)) {
    const p = getProviderById(id);
    const label = p ? p.label : id;
    hint.textContent = `「${label}」是 Pi 内置 Provider——只会覆盖 Base URL / Key，新模型通过 modelOverrides 加入，不会替换内置模型列表。`;
    hint.classList.add("show");
  } else {
    hint.classList.remove("show");
  }
}

$("#mf-providerId")?.addEventListener("input", checkBuiltinHint);

async function submitAddModel() {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  const inputVal = $("#mf-input").value;
  const payload = {
    unlocked: true,
    providerId: $("#mf-providerId").value.trim(),
    name: $("#mf-name").value.trim(),
    baseUrl: $("#mf-baseUrl").value.trim(),
    api: $("#mf-api").value,
    apiKey: $("#mf-apiKey").value,
    modelId: $("#mf-modelId").value.trim(),
    modelName: $("#mf-modelName").value.trim(),
    contextWindow: $("#mf-contextWindow").value.trim(),
    maxTokens: $("#mf-maxTokens").value.trim(),
    reasoning: $("#mf-reasoning").checked,
    authHeader: $("#mf-authHeader").checked,
    input: inputVal ? inputVal.split(",").map((s) => s.trim()).filter(Boolean) : ["text"],
  };
  if (!payload.providerId || !payload.modelId || (!payload.baseUrl && !builtinProviders.includes(payload.providerId))) {
    toast("Provider ID、模型 ID 为必填；自定义 Provider 还需 Base URL", "err"); return;
  }
  try {
    const r = await api("/api/models/add", { method: "POST", body: JSON.stringify(payload) });
    closeAddModel();
    await ensureProviderCatalog(true); // 新增后立即刷新，新建员工时可立刻选到
    toast(r.isBuiltin ? "已保存（新建员工时可直接选择）" : "模型已保存，新建员工时可直接选择", "ok");
    loadModels();
  } catch (e) { toast(e.message, "err"); }
}

async function removeModel(providerId, modelId) {
  if (!(await appConfirm({
    title: "移除模型", subtitle: "仅从配置中移除，不影响服务",
    message: `从 ${providerId} 移除模型 ${modelId}？`,
    detail: "模型配置会先自动备份；已建立的会话不受影响。",
    okText: "确认移除", icon: "cpu",
  }))) return;
  try {
    await api("/api/models/remove", { method: "POST", body: JSON.stringify({ unlocked: true, providerId, modelId }) });
    await ensureProviderCatalog(true);
    toast("已删除模型（原文件已备份）", "ok");
    loadModels();
  } catch (e) { toast(e.message, "err"); }
}

// ---------- 数字员工：组织概览 ----------
const shortText = (s, n) => {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
};
const roleLabel = (id) => orgData?.roles?.find((r) => r.id === id)?.label || id || "自定义";
const deptLabel = (id) => orgData?.departments?.find((d) => d.id === id)?.name || (id ? id : "未分配");
const empLabel = (id) => {
  const e = orgData?.employees?.find((x) => x.id === id);
  return e ? e.name : (id || "—");
};
const statusLabel = (s) => ({ active: "在线", idle: "已停用", archived: "已归档" }[s] || s || "—");

async function loadOrgOverview() {
  try {
    orgData = await api("/api/org/overview");
    renderOrgStats(orgData.stats);
    renderOrgChart(orgData);
    renderMiniLists(orgData);
    fillOrgSelects(orgData);
  } catch (e) { toast(e.message, "err"); }
}

function renderOrgStats(stats) {
  const cards = [
    { label: "员工总数", value: stats.total, sub: `${stats.active} 人在线`, icon: "users", color: "var(--accent)", soft: "var(--accent-soft)" },
    { label: "在线员工", value: stats.active, sub: `${stats.idle} 人停用`, icon: "circle-check", color: "var(--green)", soft: "var(--green-soft)" },
    { label: "部门", value: stats.departments, sub: "组织架构分组", icon: "building", color: "var(--purple)", soft: "var(--purple-soft)" },
    { label: "岗位模板", value: stats.roles, sub: "含内置与自定义", icon: "briefcase", color: "var(--cyan)", soft: "var(--cyan-soft)" },
  ];
  $("#orgStatGrid").innerHTML = cards.map((s) => `
    <div class="stat-card">
      <div class="stat-top"><span class="stat-label">${s.label}</span><span class="stat-icon" style="background:${s.soft};color:${s.color}">${icon(s.icon)}</span></div>
      <div class="stat-value">${s.value}</div>
      <div class="stat-sub">${icon("arrow-right")}${s.sub}</div>
    </div>`).join("");
}

function renderOrgChart(data) {
  const active = data.employees.filter((e) => e.status !== "archived");
  const leads = active.filter((e) => e.role === "lead");
  const members = active.filter((e) => e.role !== "lead");
  const assigned = new Set(data.departments.map((d) => d.id));
  const groups = data.departments.map((d) => ({
    ...d,
    members: members.filter((m) => m.department === d.id),
  }));
  const unassigned = members.filter((m) => !m.department || !assigned.has(m.department));
  if (unassigned.length) groups.push({ id: "__unassigned", name: "未分配", description: "尚未指定部门", members: unassigned });

  $("#orgChartBadge").textContent = `${active.length} 人 · ${groups.length} 组`;

  const width = Math.max(900, groups.length * 220 + 120);
  const maxMembers = Math.max(1, ...groups.map((g) => g.members.length));
  const H = 190 + 62 + maxMembers * 30 + 24;
  const cx = width / 2;
  const bus1 = 86, bus2 = 160, leadY = 104, deptY = 190;
  const leadCenters = leads.length
    ? leads.map((_, i) => (leads.length === 1 ? cx : 110 + i * ((width - 220) / (leads.length - 1))))
    : [cx];
  const depCenters = groups.map((_, i) => (width / groups.length) * (i + 0.5));

  let svg = `<svg class="org-chart" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect class="org-root" x="${cx - 90}" y="20" width="180" height="48" rx="10"/>`;
  svg += `<text class="org-title" x="${cx}" y="44" text-anchor="middle" dominant-baseline="central">你 · 老板 / 管理员</text>`;
  svg += `<line class="org-link" x1="${cx}" y1="68" x2="${cx}" y2="${bus1}"/>`;
  svg += `<line class="org-link" x1="${leadCenters[0]}" y1="${bus1}" x2="${leadCenters[leadCenters.length - 1]}" y2="${bus1}"/>`;
  leadCenters.forEach((x) => { svg += `<line class="org-link" x1="${x}" y1="${bus1}" x2="${x}" y2="${leadY}"/>`; });

  if (leads.length) {
    leads.forEach((e, i) => {
      const x = leadCenters[i] - 75;
      svg += `<g class="org-node" data-emp="${esc(e.id)}">
        <rect class="org-box" x="${x}" y="${leadY}" width="150" height="52" rx="9"/>
        <circle class="org-status-${esc(e.status)}" cx="${x + 14}" cy="${leadY + 19}" r="4"/>
        <text class="org-title" x="${x + 25}" y="${leadY + 19}" dominant-baseline="central">${esc(shortText(e.name, 9))}</text>
        <text class="org-sub" x="${x + 14}" y="${leadY + 37}" dominant-baseline="central">主管 · ${esc(shortText(roleLabel(e.role), 10))}</text>
      </g>`;
    });
  } else {
    svg += `<rect class="org-box" x="${cx - 75}" y="${leadY}" width="150" height="52" rx="9"/>`;
    svg += `<text class="org-sub" x="${cx}" y="${leadY + 26}" text-anchor="middle" dominant-baseline="central">尚未任命主管</text>`;
  }

  svg += `<line class="org-link dash" x1="${cx}" y1="${bus1}" x2="${cx}" y2="${bus2}"/>`;
  svg += `<line class="org-link" x1="${depCenters[0]}" y1="${bus2}" x2="${depCenters[depCenters.length - 1]}" y2="${bus2}"/>`;

  groups.forEach((g, i) => {
    const center = depCenters[i];
    const gw = Math.max(176, width / groups.length - 24);
    const gx = center - gw / 2;
    const gh = 52 + g.members.length * 30 + 10;
    svg += `<line class="org-link" x1="${center}" y1="${bus2}" x2="${center}" y2="${deptY}"/>`;
    svg += `<rect class="org-dept-box" x="${gx}" y="${deptY}" width="${gw}" height="${gh}" rx="10"/>`;
    svg += `<text class="org-dept-title" x="${gx + 14}" y="${deptY + 20}" dominant-baseline="central">${esc(shortText(g.name, 12))}</text>`;
    svg += `<text class="org-count" x="${gx + gw - 14}" y="${deptY + 20}" text-anchor="end" dominant-baseline="central">${g.members.length} 人</text>`;
    if (!g.members.length) {
      svg += `<text class="org-sub" x="${gx + 14}" y="${deptY + 52}" dominant-baseline="central">暂无员工</text>`;
    } else {
      g.members.forEach((e, j) => {
        const mx = gx + 12, mw = gw - 24, my = deptY + 38 + j * 30;
        svg += `<g class="org-node" data-emp="${esc(e.id)}">
          <rect class="org-member-box" x="${mx}" y="${my}" width="${mw}" height="26" rx="6"/>
          <circle class="org-status-${esc(e.status)}" cx="${mx + 12}" cy="${my + 13}" r="4"/>
          <text class="org-sub" x="${mx + 22}" y="${my + 13}" dominant-baseline="central">${esc(shortText(e.name, 8))}</text>
          <text class="org-sub" x="${mx + mw - 10}" y="${my + 13}" text-anchor="end" dominant-baseline="central">${esc(shortText(roleLabel(e.role), 8))}</text>
        </g>`;
      });
    }
  });
  svg += `</svg>`;
  $("#orgChart").innerHTML = svg;
  $$("#orgChart [data-emp]").forEach((g) => g.addEventListener("click", () => openEmpDetail(g.dataset.emp)));
}

function renderMiniLists(data) {
  const deptCounts = new Map();
  data.employees.forEach((e) => {
    if (e.status === "archived") return;
    deptCounts.set(e.department || "", (deptCounts.get(e.department || "") || 0) + 1);
  });
  $("#departmentCount").textContent = `${data.departments.length} 个`;
  $("#departmentList").innerHTML = data.departments.length ? data.departments.map((d) => `
    <div class="mini-item">
      <div class="mini-main"><strong>${esc(d.name)}</strong><small>${esc(d.description || d.id)}</small></div>
      <span class="count">${deptCounts.get(d.id) || 0} 人</span>
      <div class="mini-actions">
        <button class="icon-btn" title="编辑部门" onclick='openDepartmentModal(${JSON.stringify(d.id)})'>${icon("eye")}</button>
        <button class="icon-btn danger" title="删除部门" onclick='deleteDepartment(${JSON.stringify(d.id)})'>${icon("trash")}</button>
      </div>
    </div>`).join("") : `<div class="empty-state" style="padding:28px"><h3>还没有部门</h3><p>点右上角「新增部门」创建第一个分组。</p></div>`;

  const roleCounts = new Map();
  data.employees.forEach((e) => {
    if (e.status === "archived") return;
    roleCounts.set(e.role || "custom", (roleCounts.get(e.role || "custom") || 0) + 1);
  });
  $("#roleCount").textContent = `${data.roles.length} 个`;
  $("#roleList").innerHTML = data.roles.map((r) => `
    <div class="mini-item">
      <div class="mini-main"><strong>${esc(r.label)}</strong><small>${esc(deptLabel(r.department))} · ${esc(r.id)}</small></div>
      <span class="count">${roleCounts.get(r.id) || 0} 人</span>
    </div>`).join("");
}

function fillOrgSelects(data) {
  const roleSel = $("#em-role");
  if (roleSel) {
    const cur = roleSel.value;
    roleSel.innerHTML = '<option value="custom">自定义岗位</option>' +
      data.roles.map((r) => `<option value="${esc(r.id)}">${esc(r.label)}（${esc(r.id)}）</option>`).join("");
    if (cur) roleSel.value = cur;
  }
  const depSel = $("#em-department");
  if (depSel) {
    const cur = depSel.value;
    depSel.innerHTML = '<option value="">未分配</option>' +
      data.departments.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join("");
    if (cur) depSel.value = cur;
  }
  const reportSel = $("#em-reportsTo");
  if (reportSel) {
    reportSel.innerHTML = '<option value="">无</option>' +
      data.employees.filter((e) => e.status !== "archived" && e.id !== editingEmployeeId)
        .map((e) => `<option value="${esc(e.id)}">${esc(e.name)}（${esc(e.id)}）</option>`).join("");
  }
  const provSel = $("#em-provider");
  if (provSel) {
    const cur = provSel.value;
    const groups = { cn: [], global: [], custom: [] };
    providerCatalog.forEach((p) => groups[p.region === "cn" ? "cn" : p.region === "custom" ? "custom" : "global"].push(p));
    const opts = (list) => list.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}（${esc(p.id)}）</option>`).join("");
    provSel.innerHTML = '<option value="">不指定（跟随 Pi 默认）</option>' +
      `<optgroup label="国内 Provider">${opts(groups.cn)}</optgroup>` +
      `<optgroup label="国外 / 国际 Provider">${opts(groups.global)}</optgroup>` +
      (groups.custom.length ? `<optgroup label="自定义 Provider">${opts(groups.custom)}</optgroup>` : "");
    if (cur) provSel.value = cur;
  }
}

// ---------- 数字员工：员工管理 ----------
async function loadEmployees() {
  try {
    orgData = await api("/api/org/overview");
    employeesCache = orgData.employees;
    renderEmployeeFilters();
    renderEmployees();
    fillOrgSelects(orgData);
  } catch (e) { toast(e.message, "err"); }
}

function renderEmployeeFilters() {
  const filters = [
    ["all", "全部"], ["active", "在线"], ["idle", "已停用"], ["archived", "已归档"],
    ...orgData.departments.map((d) => [`dept:${d.id}`, d.name]),
  ];
  $("#employeeFilters").innerHTML = filters.map(([v, label]) =>
    `<button class="filter-chip ${v === currentEmployeeFilter ? "active" : ""}" data-efilter="${esc(v)}">${esc(label)}</button>`).join("");
  $$("#employeeFilters .filter-chip").forEach((b) => b.addEventListener("click", () => {
    currentEmployeeFilter = b.dataset.efilter;
    $$("#employeeFilters .filter-chip").forEach((x) => x.classList.toggle("active", x === b));
    renderEmployees();
  }));
}

async function resetEmployeeUsage(employeeId) {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  const all = employeeId === "__all__";
  const emp = all ? null : (employeesCache.find((e) => e.id === employeeId) || empById(employeeId));
  const ok = await appConfirm({
    title: all ? "重置全部员工用量" : "重置员工累计用量",
    subtitle: "只清零统计，不删除原始数据",
    message: all ? "确定把所有员工的累计 Token 和金额清零吗？" : `确定把「${emp?.name || employeeId}」的累计 Token 和金额清零吗？`,
    detail: "只重置统计账本，不删除会话、群聊或任务记录；之后的消耗会继续累计。",
    tone: "warn", icon: "refresh", okText: "确认重置",
  });
  if (!ok) return;
  try {
    await api("/api/org/employee-usage/reset", {
      method: "POST", body: JSON.stringify({ unlocked: true, employeeId }),
    });
    toast(all ? "已重置全部员工用量" : "已重置该员工累计用量", "ok");
    await loadEmployees();
    if (currentEdEmployee && (all || currentEdEmployee.id === employeeId)) {
      await loadCompany();
      currentEdEmployee = empById(currentEdEmployee.id) || currentEdEmployee;
      renderEdOverview();
    }
  } catch (e) { toast(e.message, "err"); }
}

function renderEmployees() {
  const q = ($("#employeeSearch")?.value || "").toLowerCase().trim();
  const list = employeesCache.filter((e) => {
    const f = currentEmployeeFilter;
    const byFilter = f === "all" || e.status === f || (f.startsWith("dept:") && e.department === f.slice(5));
    const text = `${e.name} ${e.id} ${roleLabel(e.role)} ${deptLabel(e.department)} ${(e.skills || []).join(" ")}`.toLowerCase();
    return byFilter && (!q || text.includes(q));
  });
  $("#employeeCount").textContent = `${list.length} 人`;
  const tbody = $("#employeeTable tbody");
  if (!list.length) {
    tbody.innerHTML = emptyState("users", employeesCache.length ? "没有匹配的员工" : "还没有数字员工",
      employeesCache.length ? `没有找到与「${esc(q)}」匹配的员工，换个关键词或筛选条件试试。`
        : "点右上角「新增员工」，按岗位创建第一位数字员工。",
      employeesCache.length ? "" : `<button class="btn primary" onclick="openEmployeeModal()">${icon("plus")}新增员工</button>`);
    return;
  }
  tbody.innerHTML = list.map((e) => {
    const skills = (e.skills || []).length
      ? e.skills.map((s) => `<span class="tag type" style="margin:1px 3px 1px 0">${esc(s)}</span>`).join("")
      : "—";
    const model = e.model?.id
      ? `${esc(e.model.provider || "自定义")}/${esc(e.model.id)}`
      : "跟随默认";
    const usage = e.usage || {};
    const usageTokens = Number(usage.totalTokens) || 0;
    const usageCny = Number(usage.totalCostCny) || 0;
    const usageTip = `${fmtTokensFull(usageTokens)} tokens · ${usage.resetAt ? `上次重置 ${fmtSessionTime(usage.resetAt)}` : "含会话、群聊 @ 唤醒与群 SOP 任务消耗"}`;
    const actions = `
      <button class="btn btn-sm" title="员工工作台（记忆/技能/权限/任务/对话）" onclick='openEmpDetail(${JSON.stringify(e.id)})'>${icon("sparkle")}</button>
      ${e.status === "archived" ? "" : `<button class="btn btn-sm" title="对话" onclick='openEmployeeChat(${JSON.stringify(e.id)})'>${icon("terminal")}</button>`}
      <button class="btn btn-sm" title="编辑" onclick='openEmployeeModal(${JSON.stringify(e.id)})'>${icon("eye")}</button>
      <button class="btn btn-sm" title="克隆" onclick='cloneEmployee(${JSON.stringify(e.id)})'>${icon("copy")}</button>
      <button class="btn btn-sm" title="${e.status === "archived" ? "恢复" : "启停"}" onclick='toggleEmployee(${JSON.stringify(e.id)})'>${icon("power")}</button>
      <button class="btn btn-sm" title="重置该员工累计 token / 金额" onclick='resetEmployeeUsage(${JSON.stringify(e.id)})'>${icon("refresh")}</button>
      ${e.status === "archived" ? "" : `<button class="btn btn-sm danger" title="归档" onclick='archiveEmployee(${JSON.stringify(e.id)})'>${icon("trash")}</button>`}`;
    return `<tr>
      <td><b>${esc(e.name)}</b><br><span class="mono" style="font-size:10px;color:var(--text-3)">${esc(e.id)}</span></td>
      <td>${esc(roleLabel(e.role))}</td>
      <td>${esc(deptLabel(e.department))}</td>
      <td>${esc(empLabel(e.reportsTo))}</td>
      <td class="mono" style="font-size:11px">${model}</td>
      <td>${skills}</td>
      <td class="mono" style="font-size:11px" title="${esc(usageTip)}">${fmtTokens(usageTokens)}${usageTokens ? " tok" : ""}</td>
      <td class="mono" style="font-size:11px;color:var(--green)" title="${esc(usageTip)}">${fmtCost(usageCny)}</td>
      <td><span class="tag status-${esc(e.status)}"><span class="status-dot status-${esc(e.status)}"></span>${esc(statusLabel(e.status))}</span></td>
      <td><div class="row-actions">${actions}</div></td>
    </tr>`;
  }).join("");
}

// ---------- 员工对话 ----------
let chattingEmployee = null;
let lastEmployeeChat = null;

function openEmployeeChat(id) {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  const e = (orgData?.employees || employeesCache).find((x) => x.id === id);
  if (!e) { toast("员工不存在", "err"); return; }
  chattingEmployee = e;
  lastEmployeeChat = null;
  $("#ec-title").textContent = `与 ${e.name} 对话`;
  const model = e.model?.id ? `${e.model.provider || "自定义"}/${e.model.id}` : "Pi 默认模型";
  $("#ec-profile").innerHTML = `
    <div><b>${esc(e.name)}</b> · ${esc(roleLabel(e.role))} · ${esc(deptLabel(e.department))}</div>
    <div style="margin-top:4px;color:var(--text-3)">模型：${esc(model)}</div>
    <div style="margin-top:4px;color:var(--text-3)">工作区：${esc(e.workspace || `org/workspaces/${e.id}`)}</div>`;
  $("#ec-first").value = "";
  $("#ec-notice").style.display = "none";
  $("#ec-notice").innerHTML = "";
  $("#ec-submit").classList.remove("hidden");
  $("#employeeChatModal").classList.remove("hidden");
  $("#ec-first").focus();
}

function closeEmployeeChat() { $("#employeeChatModal").classList.add("hidden"); }

async function copyEmployeeChatCommand() {
  if (!lastEmployeeChat) return;
  try {
    await navigator.clipboard.writeText(lastEmployeeChat.command);
    toast("启动命令已复制", "ok");
  } catch (e) {
    toast("复制失败，请手动选中命令", "err");
  }
}

async function submitEmployeeChat() {
  if (!chattingEmployee) return;
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  try {
    const r = await api(`/api/org/employees/${encodeURIComponent(chattingEmployee.id)}/chat`, {
      method: "POST",
      body: JSON.stringify({ unlocked: true, firstMessage: $("#ec-first").value }),
    });
    lastEmployeeChat = r;
    $("#ec-submit").classList.add("hidden");
    const notice = $("#ec-notice");
    notice.style.display = "block";
    notice.innerHTML = `
      <div class="created-session">
        <div class="created-session-title"><svg class="icon"><use href="#i-terminal"/></svg> 对话已创建</div>
        <div class="created-session-cmd"><code>${esc(r.command)}</code><button class="btn btn-sm" onclick="copyEmployeeChatCommand()"><svg class="icon"><use href="#i-copy"/></svg>复制</button></div>
        <p class="created-session-hint">到终端粘贴执行即可与「${esc(chattingEmployee.name)}」对话。命令已带上该员工的系统提示词和模型；首次进入目录若提示信任项目，请选择信任。</p>
      </div>`;
    await loadSessions();
    toast("员工对话会话已创建", "ok");
  } catch (e) { toast(e.message, "err"); }
}

async function openEmployeeModal(id = "") {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  await ensureProviderCatalog();
  if (!orgData) orgData = await api("/api/org/overview");
  editingEmployeeId = id;
  fillOrgSelects(orgData);
  const e = id ? orgData.employees.find((x) => x.id === id) : null;
  if (id && !e) { toast("员工不存在", "err"); return; }
  $("#employeeModalTitle").textContent = e ? `编辑员工 · ${e.name}` : "新增员工";
  fillEmployeeForm(e || {
    id: `emp-${Date.now().toString(36)}`,
    name: "",
    role: "developer",
    department: "engineering",
    reportsTo: "",
    status: "idle",
    model: { provider: "", id: "" },
    skills: [],
    permissions: { filesystem: "read-only", commands: "deny", network: "deny", budget: {} },
    systemPrompt: "",
    note: "",
  });
  $("#employeeModal").classList.remove("hidden");
}

function fillEmployeeForm(e, isClone = false) {
  const role = orgData?.roles?.find((r) => r.id === e.role);
  $("#em-id").value = isClone ? `${e.id}-copy` : e.id;
  $("#em-id").disabled = !isClone && !!e.id;
  $("#em-name").value = isClone ? `${e.name} 副本` : (e.name || "");
  $("#em-role").value = e.role || "custom";
  $("#em-department").value = e.department || "";
  $("#em-reportsTo").value = isClone ? (e.reportsTo || "") : (e.reportsTo || "");
  const p = e.model?.provider || "";
  $("#em-provider").value = p;
  onOrgProviderChange();
  $("#em-modelId").value = e.model?.id || "";
  $("#em-modelSelect").value = e.model?.id || "";
  $("#em-skills").value = (e.skills || []).join(", ");
  $("#em-filesystem").value = e.permissions?.filesystem || role?.permissions?.filesystem || "read-only";
  $("#em-commands").value = e.permissions?.commands || role?.permissions?.commands || "deny";
  $("#em-network").value = e.permissions?.network || role?.permissions?.network || "deny";
  $("#em-maxTokens").value = e.permissions?.budget?.maxTokensPerTask || "";
  $("#em-maxCost").value = e.permissions?.budget?.maxCostPerDay || "";
  $("#em-prompt").value = e.systemPrompt || role?.systemPrompt || "";
  $("#em-note").value = e.note || "";
}

function closeEmployeeModal() { $("#employeeModal").classList.add("hidden"); }

function onOrgProviderChange() {
  const id = $("#em-provider").value;
  const sel = $("#em-modelSelect");
  if (!sel) return;
  if (!id) { sel.innerHTML = '<option value="">先选 Provider</option>'; return; }
  const p = getProviderById(id);
  if (!p) { sel.innerHTML = '<option value="">该 Provider 暂无可选模型，请手动填 ID</option>'; return; }
  const models = p.models || [];
  sel.innerHTML = '<option value="">— 不自动选择，手动填模型 ID —</option>' +
    models.map((m) => `<option value="${esc(m.id)}">${esc(m.name || m.id)} — ${esc(m.id)}</option>`).join("") +
    (models.length ? "" : '<option value="">该 Provider 暂无可选模型，请手动填 ID</option>');
}

function onOrgModelSelect() {
  const id = $("#em-modelSelect").value;
  if (id) $("#em-modelId").value = id;
}

async function cloneEmployee(id) {
  await openEmployeeModal();
  const e = orgData.employees.find((x) => x.id === id);
  if (e) fillEmployeeForm(e, true);
}

async function submitEmployee() {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  const payload = {
    id: $("#em-id").value.trim(),
    name: $("#em-name").value.trim(),
    role: $("#em-role").value,
    department: $("#em-department").value,
    reportsTo: $("#em-reportsTo").value,
    modelProvider: $("#em-provider").value,
    modelId: $("#em-modelId").value.trim(),
    skills: $("#em-skills").value.split(",").map((s) => s.trim()).filter(Boolean),
    permissions: {
      filesystem: $("#em-filesystem").value,
      commands: $("#em-commands").value,
      network: $("#em-network").value,
      budget: {
        maxTokensPerTask: $("#em-maxTokens").value,
        maxCostPerDay: $("#em-maxCost").value,
      },
    },
    systemPrompt: $("#em-prompt").value.trim(),
    note: $("#em-note").value.trim(),
  };
  if (!payload.id || !payload.name) { toast("姓名和员工 ID 为必填", "err"); return; }
  try {
    if (editingEmployeeId) {
      await api(`/api/org/employees/${encodeURIComponent(editingEmployeeId)}`, {
        method: "PUT", body: JSON.stringify({ unlocked: true, ...payload }),
      });
      toast("员工已更新（原文件已备份）", "ok");
    } else {
      await api("/api/org/employees", { method: "POST", body: JSON.stringify({ unlocked: true, ...payload }) });
      toast("员工已创建", "ok");
    }
    closeEmployeeModal();
    await Promise.all([loadOrgOverview(), loadEmployees()]);
  } catch (e) { toast(e.message, "err"); }
}

async function toggleEmployee(id) {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  try {
    const r = await api(`/api/org/employees/${encodeURIComponent(id)}/toggle`, {
      method: "POST", body: JSON.stringify({ unlocked: true }),
    });
    toast(r.note || "状态已更新", "ok");
    await Promise.all([loadOrgOverview(), loadEmployees()]);
  } catch (e) { toast(e.message, "err"); }
}

async function archiveEmployee(id) {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  const e = employeesCache.find((x) => x.id === id);
  if (!(await appConfirm({
    title: "归档员工", subtitle: "只改状态，不删除文件", tone: "warn", icon: "users",
    message: `归档员工「${e?.name || id}」？`,
    detail: "归档后不再参与派活；配置文件会保留并先备份，随时可恢复。",
    okText: "确认归档", safe: "配置文件保留，可随时恢复",
  }))) return;
  try {
    await api(`/api/org/employees/${encodeURIComponent(id)}/archive`, {
      method: "POST", body: JSON.stringify({ unlocked: true }),
    });
    toast("已归档（文件保留）", "ok");
    await Promise.all([loadOrgOverview(), loadEmployees()]);
  } catch (err) { toast(err.message, "err"); }
}

// ---------- 继承配置：技能/工作流 chip 选择器（部门与团队共用）----------
let inheritOptionsCache = null; // { skills: [...], workflows: [...] }
/** 加载可选技能与工作流名称（带缓存） */
async function loadInheritOptions() {
  if (inheritOptionsCache) return inheritOptionsCache;
  let skills = [];
  try {
    const resources = await api("/api/resources");
    skills = resources.filter((r) => r.type === "skill").map((r) => r.name || r.pattern || "").filter(Boolean);
  } catch {}
  let workflows = [];
  try {
    const sops = await api("/api/org/sops");
    workflows = (Array.isArray(sops) ? sops : []).map((s) => s.name || s.id).filter(Boolean);
  } catch {}
  inheritOptionsCache = { skills: [...new Set(skills)], workflows: [...new Set(workflows)] };
  return inheritOptionsCache;
}
/** 渲染一个 chip 选择器：点击切换选中，选中项写入 hidden 态（存到容器 dataset） */
async function renderChipPicker(containerSel, selected, kind) {
  const box = $(containerSel);
  if (!box) return;
  const opts = await loadInheritOptions();
  // 已配置但不在资源库里的值也要显示（如手填的技能名），否则无法查看/取消
  const chosen = new Set((selected || []).map(String));
  const list = [...new Set([...(opts[kind] || []), ...chosen])];
  const empty = !list.length
    ? `<span class="chip-picker-empty">暂无可选项（可先在 Pi 安装技能或创建 SOP 模板）</span>` : "";
  box.innerHTML = empty + list.map((name) =>
    `<button type="button" class="pick-chip ${chosen.has(name) ? "on" : ""}" data-name="${esc(name)}" onclick="togglePickChip(this)">${icon(chosen.has(name) ? "check" : "plus")}${esc(name)}</button>`
  ).join("");
  box.dataset.selected = JSON.stringify([...chosen]);
}
function togglePickChip(btn) {
  const box = btn.parentElement;
  const chosen = new Set(JSON.parse(box.dataset.selected || "[]"));
  const name = btn.dataset.name;
  if (chosen.has(name)) { chosen.delete(name); btn.classList.remove("on"); btn.querySelector("use")?.setAttribute("href", "#i-plus"); }
  else { chosen.add(name); btn.classList.add("on"); btn.querySelector("use")?.setAttribute("href", "#i-check"); }
  box.dataset.selected = JSON.stringify([...chosen]);
}
function pickedChips(containerSel) {
  const box = $(containerSel);
  if (!box) return [];
  try { return JSON.parse(box.dataset.selected || "[]"); } catch { return []; }
}

// ---------- 数字员工：部门 ----------
async function openDepartmentModal(id = "") {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  if (!orgData) orgData = await api("/api/org/overview");
  editingDepartmentId = id;
  const d = id ? orgData.departments.find((x) => x.id === id) : null;
  $("#departmentModalTitle").textContent = d ? `编辑部门 · ${d.name}` : "新增部门";
  $("#dm-id").value = d?.id || "";
  $("#dm-id").disabled = !!d;
  $("#dm-name").value = d?.name || "";
  $("#dm-desc").value = d?.description || "";
  $("#departmentModal").classList.remove("hidden");
  await Promise.all([
    renderChipPicker("#dm-skills", d?.skills || [], "skills"),
    renderChipPicker("#dm-workflows", d?.workflows || [], "workflows"),
  ]);
}

function closeDepartmentModal() { $("#departmentModal").classList.add("hidden"); }

async function submitDepartment() {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  const id = $("#dm-id").value.trim();
  const name = $("#dm-name").value.trim();
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(id) || !name) { toast("部门 ID 和名称都要填写，ID 只能用字母数字下划线短横线", "err"); return; }
  const departments = JSON.parse(JSON.stringify(orgData.departments));
  const idx = departments.findIndex((d) => d.id === id);
  const item = {
    id, name, description: $("#dm-desc").value.trim(),
    skills: pickedChips("#dm-skills"), workflows: pickedChips("#dm-workflows"),
  };
  if (editingDepartmentId) {
    if (idx < 0) { toast("部门不存在", "err"); return; }
    departments[idx] = item;
  } else {
    if (idx >= 0) { toast("部门 ID 已存在", "err"); return; }
    departments.push(item);
  }
  try {
    await api("/api/org/departments", { method: "POST", body: JSON.stringify({ unlocked: true, departments }) });
    closeDepartmentModal();
    toast("部门已保存（原文件已备份）", "ok");
    await Promise.all([loadOrgOverview(), loadEmployees()]);
  } catch (e) { toast(e.message, "err"); }
}

async function deleteDepartment(id) {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  if (!orgData) orgData = await api("/api/org/overview");
  const d = orgData.departments.find((x) => x.id === id);
  if (!d) { toast("部门不存在", "err"); return; }
  const members = (orgData.employees || []).filter((e) => e.department === id && e.status !== "archived");
  if (members.length) {
    toast(`「${d.name}」下还有 ${members.length} 名员工，请先把他们移到其他部门再删除`, "err");
    return;
  }
  if (!(await appConfirm({
    title: "删除部门", subtitle: "员工配置不受影响",
    message: `确定删除部门「${d.name}」吗？`,
    detail: "部门列表会先自动备份；该部门下的员工不会因此被删除。",
    okText: "确认删除", icon: "building",
  }))) return;
  const departments = orgData.departments.filter((x) => x.id !== id);
  try {
    await api("/api/org/departments", { method: "POST", body: JSON.stringify({ unlocked: true, departments }) });
    toast("部门已删除（列表已备份）", "ok");
    await Promise.all([loadOrgOverview(), loadEmployees()]);
  } catch (e) { toast(e.message, "err"); }
}

// ============================================================
// 虚拟公司：团队 / 任务看板 / 协作 / 自主工作 / 知识库 / 员工详情
// ============================================================
let companyData = null;       // /api/org/full 缓存
let taskBoards = [];          // 任务缓存
let orgES = null;             // 组织事件 SSE
let currentChannel = "general";
let currentEdEmployee = null; // 当前员工详情工作台的员工
let currentEdTab = "overview";

const empById = (id) => (companyData?.employees || employeesCache || []).find((e) => e.id === id);
const empName = (id) => empById(id)?.name || id || "未指派";
const taskStatusLabel = (s) => ({ todo: "待办", doing: "进行中", review: "待验收", done: "已完成", blocked: "受阻", cancelled: "已取消" }[s] || s);
const msgTypeLabel = (t) => ({ task_assign: "派活", status_report: "汇报", question: "提问", answer: "回答", handoff: "交接", review: "评审", escalation: "升级", broadcast: "广播", task_created: "建任务", task_status: "状态", task_done: "完成", task_failed: "失败", trigger_fired: "触发", approval: "审批" }[t] || t);

async function loadCompany() {
  companyData = await api("/api/org/full");
  return companyData;
}

// ---------- 组织事件流（实时） ----------
function connectOrgEvents() {
  if (orgES) return;
  try {
    orgES = new EventSource("/api/org/events");
    const relabel = (e) => {
      const d = JSON.parse(e.data || "{}");
      // 实时刷新当前视图
      const active = $(".view.active")?.id;
      if (active === "view-tasks") loadTasks();
      if (active === "view-collab") loadCollab();
      if (d.type === "task_done" || d.type === "task_failed") toast(d.note || "任务有更新", d.type === "task_done" ? "ok" : "err");
    };
    ["task_created","task_assigned","task_status","task_done","task_failed","handoff","trigger_fired","approval","message"].forEach((ev) => orgES.addEventListener(ev, relabel));
    // 群消息：实时追加到当前打开的群聊
    orgES.addEventListener("group_message", (e) => {
      try {
        const msg = JSON.parse(e.data || "{}");
        if (gcState.groupId && msg.channel === `group:${gcState.groupId}`) gcAppendMessage(msg, true, true);
        // 会话中心群卡片预览实时更新（当前打开的群无需重复刷新列表）
        const mm = String(msg.channel || "").match(/^group:(.+)$/);
        if (mm && !(gcState.groupId === mm[1] && !$("#sessionGroupHost")?.classList.contains("hidden"))) {
          const p = groupPreviews[mm[1]] ||= {};
          p.preview = (msg.type === "sop_event" ? "[流程] " : "") + String(msg.body || "").replace(/\s+/g, " ").slice(0, 80);
          p.lastTs = msg.createdAt || new Date().toISOString();
          p.count = (p.count || 0) + 1;
          if ($("#view-sessions").classList.contains("active")) renderSessions();
        }
      } catch {}
    });
    // 群 SOP 状态实时刷新：阶段开始/完成/终止都会推送
    orgES.addEventListener("sop_update", (e) => {
      try {
        const d = JSON.parse(e.data || "{}");
        if (gcState.groupId && d.groupId === gcState.groupId) {
          syncSopRuns(d.runs || (d.run ? [d.run] : []));
          gcSopRender();
        }
        if (d.groupId) {
          (groupPreviews[d.groupId] ||= {}).sopStatus = (d.runs || []).some((x) => x.status === "running") ? "running"
            : (d.runs || []).some((x) => x.status === "blocked") ? "blocked" : (d.run?.status || "");
          (groupPreviews[d.groupId] ||= {}).sopCount = (d.runs || []).length;
          if ($("#view-sessions").classList.contains("active")) renderSessions();
        }
      } catch {}
    });
  } catch {}
}

// ---------- 员工详情工作台 ----------
async function openEmpDetail(id) {
  await loadCompany();
  const emp = empById(id);
  if (!emp) { toast("员工不存在", "err"); return; }
  currentEdEmployee = emp;
  $("#edName").textContent = `${emp.name} · 员工工作台`;
  const role = (companyData.roles || []).find((r) => r.id === emp.role);
  const createdDays = emp.createdAt ? Math.max(1, Math.ceil((Date.now() - new Date(emp.createdAt).getTime()) / 86400000)) : 0;
  $("#edMeta").textContent = `${role?.label || emp.role || "自定义岗位"} · 入职 ${createdDays} 天 · ${emp.model?.provider || "默认"}/${emp.model?.id || "auto"}`;
  $("#empDetailModal").classList.remove("hidden");
  switchEdTab("overview");
}

function closeEmpDetail() {
  $("#empDetailModal").classList.add("hidden");
  stopEdChat();
  currentEdEmployee = null;
}

function switchEdTab(tab) {
  currentEdTab = tab;
  $$(".edt").forEach((b) => b.classList.toggle("active", b.dataset.edtab === tab));
  if (!currentEdEmployee) return;
  const body = $("#edBody");
  if (tab === "overview") renderEdOverview();
  else if (tab === "memory") renderEdMemory();
  else if (tab === "skills") renderEdSkills();
  else if (tab === "permissions") renderEdPermissions();
  else if (tab === "tasks") renderEdTasks();
  else if (tab === "chat") renderEdChat();
}

function renderEdOverview() {
  const emp = currentEdEmployee;
  const myTasks = (companyData?.tasks || []).filter((t) => t.assignee === emp.id);
  const usage = emp.usage || {};
  const usageTokens = Number(usage.totalTokens) || 0;
  const usageCny = Number(usage.totalCostCny) || 0;
  const stats = [
    ["状态", emp.status === "active" ? "在线" : emp.status === "idle" ? "停用" : "归档"],
    ["负责岗位", (companyData.roles || []).find((r) => r.id === emp.role)?.label || emp.role || "自定义"],
    ["任务总数", myTasks.length],
    ["进行中", myTasks.filter((t) => t.status === "doing").length],
    ["已完成", myTasks.filter((t) => t.status === "done").length],
    ["技能数", (emp.skills || []).length],
    ["累计 Token", `${fmtTokens(usageTokens)}${usageTokens ? " tok" : ""}`, `${fmtTokensFull(usageTokens)} tokens`],
    ["累计金额", fmtCost(usageCny)],
  ];
  let html = `<div class="overview-grid">${stats.map(([k, v, tip]) => `<div class="ov-stat"${tip ? ` title="${esc(tip)}"` : ""}><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>`;
  html += `<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <button class="btn btn-sm" onclick='resetEmployeeUsage(${JSON.stringify(emp.id)})'>${icon("refresh")}重置累计用量</button>
    <span style="font-size:11px;color:var(--text-3)">${usage.resetAt ? `上次重置 ${esc(fmtSessionTime(usage.resetAt))}` : "含会话、群聊 @ 唤醒与群 SOP 任务消耗"}</span>
  </div>`;
  html += `<div style="margin-top:20px"><h3 class="ed-section-title">身份与人格</h3><div class="td-desc">${esc(emp.systemPrompt || "（未设置岗位提示词）")}</div></div>`;
  html += `<div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">${icon("shield")}<span style="font-size:11.5px;color:var(--text-2)">文件系统 ${esc(emp.permissions?.filesystem || "-")} · 命令 ${esc(emp.permissions?.commands || "-")} · 网络 ${esc(emp.permissions?.network || "-")}</span></div>`;
  $("#edBody").innerHTML = html;
}

async function renderEdMemory() {
  const emp = currentEdEmployee;
  let items = [];
  try { items = await api(`/api/org/memory/${encodeURIComponent(emp.id)}`); } catch (e) { toast(e.message, "err"); }
  const typeLabel = { identity: "身份", preference: "偏好", project: "项目", rule: "规则", feedback: "反馈" };
  let html = `<h3 class="ed-section-title">长期记忆（${items.length} 条）· 执行任务时自动注入上下文</h3>`;
  html += items.map((m) => `<div class="mem-item"><span class="mem-type">${esc(typeLabel[m.type] || m.type)}</span><span class="mem-content">${esc(m.content)}</span><button class="icon-btn" onclick="deleteMemory('${esc(emp.id)}','${esc(m.id)}')" title="删除">${icon("trash")}</button></div>`).join("") || `<div class="board-empty">暂无记忆。添加一条让员工记住你或项目的长期信息。</div>`;
  html += `<div class="mem-add"><select id="newMemType"><option value="rule">规则</option><option value="identity">身份</option><option value="preference">偏好</option><option value="project">项目</option><option value="feedback">反馈</option></select><input id="newMemContent" placeholder="例如：这个项目的 API 都要带 JWT 校验"><button class="btn primary btn-sm" onclick="addMemory()">${icon("plus")}添加</button></div>`;
  $("#edBody").innerHTML = html;
}

async function addMemory() {
  const content = $("#newMemContent")?.value.trim();
  if (!content) { toast("请输入记忆内容", "err"); return; }
  try {
    await api(`/api/org/memory/${encodeURIComponent(currentEdEmployee.id)}`, { method: "POST", body: JSON.stringify({ unlocked: true, type: $("#newMemType").value, content }) });
    toast("记忆已添加", "ok"); renderEdMemory();
  } catch (e) { toast(e.message, "err"); }
}
async function deleteMemory(empId, memId) {
  try {
    await api(`/api/org/memory/${encodeURIComponent(empId)}`, { method: "DELETE", body: JSON.stringify({ unlocked: true, memId }) });
    toast("记忆已删除", "ok"); renderEdMemory();
  } catch (e) { toast(e.message, "err"); }
}

async function renderEdSkills() {
  const emp = currentEdEmployee;
  // 解析继承关系（部门 / 团队 / 个人）
  let resolved = null;
  try {
    const data = await api("/api/org/skills-resolve");
    resolved = (data.employees || []).find((x) => x.id === emp.id) || null;
  } catch {}
  const inherited = resolved?.inheritedSkills || [];
  const teamSkills = resolved?.teamSkills || [];
  const own = emp.skills || [];
  const allSkills = new Set([...inherited, ...teamSkills, ...own]);

  let html = `<div class="notice small"><span class="notice-icon">${icon("info")}</span><div><strong>技能继承</strong><p>员工自动继承所属部门的技能；在团队群聊/SOP 场景还会叠加团队专属技能。个人技能只需设置额外的部分，重复会自动去重。</p></div></div>`;

  // 继承层（只读）
  html += `<h3 class="ed-section-title" style="margin-top:18px">继承的技能（无需单独配置）</h3>`;
  const inheritedHtml = [
    ...inherited.map((s) => `<span class="skill-chip inherited" title="继承自部门：${esc(resolved?.departmentName || "")}">${icon("building")}${esc(s)}<small>部门</small></span>`),
    ...teamSkills.map((s) => `<span class="skill-chip inherited" title="继承自团队">${icon("users")}${esc(s)}<small>团队</small></span>`),
  ].join("");
  html += inheritedHtml || `<div class="board-empty">所属部门/团队暂无继承技能</div>`;

  // 个人专属层（可增删）
  html += `<h3 class="ed-section-title" style="margin-top:22px">个人专属技能（${own.length}）· 点击可卸载</h3>`;
  html += own.length ? own.map((s) => `<button class="skill-chip own" onclick="toggleSkill('${esc(s)}')" title="点击卸载个人技能">${icon("wand")}${esc(s)}${icon("x")}</button>`).join("")
    : `<div class="board-empty">无个人专属技能，点击下方技能库挂载</div>`;

  // 技能库（挂载个人技能）
  html += `<h3 class="ed-section-title" style="margin-top:24px">可用技能库 · 点击挂载为个人技能</h3>`;
  try {
    const resources = await api("/api/resources");
    const skills = resources.filter((r) => r.type === "skill");
    html += skills.length ? skills.map((s) => {
      const name = s.name || s.pattern || "";
      const on = own.includes(name);
      const fromInherit = allSkills.has(name) && !on;
      return `<button class="skill-chip" style="opacity:${on ? 1 : (fromInherit ? .7 : .55)};cursor:pointer" onclick="toggleSkill('${esc(name)}')" title="${fromInherit ? "已由部门/团队继承，无需重复挂载" : ""}">${icon(on ? "check" : "plus")}${esc(name)}${fromInherit ? `<small>已继承</small>` : ""}</button>`;
    }).join("") : `<div class="board-empty">项目与用户目录下暂无技能。可在 Pi 里安装后刷新。</div>`;
  } catch {}

  // 工作流（只读展示）
  const flows = resolved?.workflows || [];
  html += `<h3 class="ed-section-title" style="margin-top:24px">可用工作流（部门/团队继承）</h3>`;
  html += flows.length ? flows.map((f) => `<span class="skill-chip inherited" title="继承自部门/团队的工作流">${icon("layers")}${esc(f)}</span>`).join("")
    : `<div class="board-empty">部门/团队暂无工作流配置</div>`;

  $("#edBody").innerHTML = html;
}
async function toggleSkill(name) {
  const emp = currentEdEmployee;
  const cur = [...(emp.skills || [])];
  const i = cur.indexOf(name);
  if (i >= 0) cur.splice(i, 1); else cur.push(name);
  try {
    const r = await api(`/api/org/employees/${encodeURIComponent(emp.id)}`, { method: "PUT", body: JSON.stringify({ unlocked: true, skills: cur }) });
    currentEdEmployee = r.employee; empById(emp.id) && Object.assign(empById(emp.id), r.employee);
    toast(i >= 0 ? "技能已卸载" : "技能已挂载", "ok"); renderEdSkills();
  } catch (e) { toast(e.message, "err"); }
}

async function renderEdPermissions() {
  const emp = currentEdEmployee;
  const p = emp.permissions || {};
  const fsOpts = [["none", "无访问"], ["read-only", "只读"], ["workspace-write", "工作区可写"]];
  const cmdOpts = [["deny", "禁止"], ["allowlist", "白名单"], ["full", "完全允许"]];
  const netOpts = [["deny", "禁止"], ["review", "需审批"], ["allow", "允许"]];
  const sel = (id, label, opts, val) => `<div class="perm-row"><label>${label}</label><select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${val === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>`;
  let html = `<h3 class="ed-section-title">权限红线 · 决定员工能碰什么、哪些事必须请示</h3>`;
  html += `<div class="perm-grid">${sel("permFs", "文件系统", fsOpts, p.filesystem)}${sel("permCmd", "命令执行", cmdOpts, p.commands)}${sel("permNet", "网络访问", netOpts, p.network)}</div>`;
  html += `<div class="form-grid-2" style="margin-top:16px"><div class="form-row"><label>单任务 Token 上限（0=不限）</label><input id="permMaxTokens" type="number" min="0" value="${p.budget?.maxTokensPerTask || 0}"></div><div class="form-row"><label>单日费用上限 USD（0=不限）</label><input id="permMaxCost" type="number" min="0" step="0.01" value="${p.budget?.maxCostPerDay || 0}"></div></div>`;
  html += `<div style="margin-top:18px;display:flex;gap:8px"><button class="btn primary" onclick="savePermissions()">${icon("save")}保存权限</button></div>`;
  html += `<div class="notice small" style="margin-top:20px"><span class="notice-icon">${icon("info")}</span><div><strong>提示</strong><p>权限写入员工人格提示词，员工执行时会遵守。高风险操作（删除、外发、生产变更）建议在对话中保留人工确认。</p></div></div>`;
  $("#edBody").innerHTML = html;
}
async function savePermissions() {
  const permissions = {
    filesystem: $("#permFs").value, commands: $("#permCmd").value, network: $("#permNet").value,
    budget: { maxTokensPerTask: Number($("#permMaxTokens").value) || 0, maxCostPerDay: Number($("#permMaxCost").value) || 0 },
  };
  try {
    const r = await api(`/api/org/employees/${encodeURIComponent(currentEdEmployee.id)}`, { method: "PUT", body: JSON.stringify({ unlocked: true, permissions }) });
    currentEdEmployee = r.employee; toast("权限已保存并写入人格提示词", "ok");
  } catch (e) { toast(e.message, "err"); }
}

function renderEdTasks() {
  const emp = currentEdEmployee;
  const myTasks = (companyData?.tasks || []).filter((t) => t.assignee === emp.id);
  let html = `<h3 class="ed-section-title">${emp.name} 的任务（${myTasks.length}）</h3>`;
  html += myTasks.length ? myTasks.map((t) => `<div class="task-card" style="margin-bottom:8px" onclick="viewTask('${esc(t.id)}')"><div class="task-card-top"><span class="prio ${t.priority}">${esc(t.priority)}</span><span class="badge">${taskStatusLabel(t.status)}</span></div><h4>${esc(t.title)}</h4><div class="t-assignee">${icon("clock")}${esc((t.createdAt || "").slice(0, 10))}</div></div>`).join("") : `<div class="board-empty">还没有任务。去任务看板派活。</div>`;
  $("#edBody").innerHTML = html;
}

// 员工对话（复用 Pi RPC + SSE，与会话中心一致）
let edES = null, edStreaming = false, edStreamEl = null;
function stopEdChat() { if (edES) { edES.close(); edES = null; } }
async function renderEdChat() {
  const emp = currentEdEmployee;
  const ws = `org/workspaces/${emp.id}`;
  // 找到或建立该员工的对话会话
  let file = "";
  try {
    const sessions = await api("/api/sessions");
    const hit = (sessions.sessions || sessions || []).find((s) => (s.name || "").includes(`与${emp.name}对话`) || (s.cwd || "").includes(ws));
    file = hit?.file || "";
  } catch {}
  if (!file) {
    try {
      const r = await api(`/api/org/employees/${encodeURIComponent(emp.id)}/chat`, { method: "POST", body: JSON.stringify({ unlocked: true }) });
      file = r.file;
    } catch (e) { $("#edBody").innerHTML = `<div class="board-empty">无法创建对话：${esc(e.message)}</div>`; return; }
  }
  $("#edBody").innerHTML = `<div class="ed-chat"><div class="ed-chat-stream" id="edChatStream"><div class="chat-welcome">${icon("sparkle")}<p>与 ${esc(emp.name)} 对话</p></div></div><div class="ed-chat-input"><input id="edChatInput" placeholder="给 ${esc(emp.name)} 派活或提问…" onkeydown="if(event.key==='Enter')edSend()"><button class="btn primary" onclick="edSend()">${icon("zap")}发送</button></div></div>`;
  stopEdChat();
  edES = new EventSource(`/api/chat/stream?file=${encodeURIComponent(file)}`);
  edES.addEventListener("user_echo", (e) => { const d = JSON.parse(e.data); edAppend("user", d.text); });
  edES.addEventListener("delta", (e) => {
    const d = JSON.parse(e.data);
    if (!edStreamEl) { edStreamEl = edAppend("assistant", ""); }
    edStreamEl.textContent += d.text || "";
    const box = $("#edChatStream"); if (box) box.scrollTop = box.scrollHeight;
  });
  edES.addEventListener("message_end", () => { edStreamEl = null; });
  edES.addEventListener("run_end", () => { edStreamEl = null; });
}
function edAppend(role, text) {
  const box = $("#edChatStream"); if (!box) return null;
  const welcome = box.querySelector(".chat-welcome"); if (welcome) welcome.remove();
  const el = document.createElement("div");
  el.className = `msg-card from-${role === "user" ? "human" : "agent"}`;
  el.innerHTML = `<div class="msg-head"><span>${role === "user" ? "你" : esc(currentEdEmployee?.name || "员工")}</span></div><div class="msg-body"></div>`;
  el.querySelector(".msg-body").textContent = text;
  box.appendChild(el); box.scrollTop = box.scrollHeight;
  return el.querySelector(".msg-body");
}
async function edSend() {
  const input = $("#edChatInput"); const text = input?.value.trim();
  if (!text) return;
  input.value = "";
  try {
    // 复用会话中心发送：需要会话文件路径，从当前 SSE 的 file 拿
    const file = edES?.url?.split("file=")[1];
    await api("/api/chat/send", { method: "POST", body: JSON.stringify({ unlocked: true, file: decodeURIComponent(file), message: text }) });
  } catch (e) { toast(e.message, "err"); }
}

// ---------- 团队 Group ----------
async function loadGroups() {
  await loadCompany();
  const groups = companyData.groups || [];
  const grid = $("#groupGrid");
  if (!groups.length) { grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-illustration">${icon("briefcase")}</div><h3>还没有团队</h3><p>把职责互补的员工组成团队，一起承接复杂任务</p><button class="btn primary" onclick="openGroupModal()">${icon("plus")}新建团队</button></div>`; return; }
  grid.innerHTML = groups.map((g) => {
    const members = (g.members || []).map((m) => `<span class="g-member ${m === g.leader ? "leader" : ""}">${icon(m === g.leader ? "sparkle" : "users")}${esc(empName(m))}${m === g.leader ? " · Leader" : ""}</span>`).join("");
    return `<div class="group-card"><div class="group-card-head"><div class="group-card-icon">${icon("briefcase")}</div><div><h3>${esc(g.name)}</h3><div class="g-desc">${esc(g.description || "暂无职责说明")}</div></div></div><div class="group-members">${members || `<span class="board-empty">暂无成员</span>`}</div><div class="group-card-foot"><button class="btn btn-sm primary" onclick="openGroupChat('${esc(g.id)}')">${icon("users")}进群聊</button><button class="btn btn-sm" onclick="openGroupModal('${esc(g.id)}')">${icon("sliders")}编辑</button><button class="btn btn-sm" onclick="openGroupTask('${esc(g.id)}')">${icon("list")}派活</button><button class="btn btn-sm danger" onclick="deleteGroup('${esc(g.id)}')">${icon("trash")}删除</button></div></div>`;
  }).join("");
}
async function openGroupModal(id = "") {
  const g = (companyData?.groups || []).find((x) => x.id === id);
  $("#groupId").value = g?.id || "";
  $("#groupModalTitle").textContent = g ? "编辑团队" : "新建团队";
  $("#groupName").value = g?.name || "";
  $("#groupDesc").value = g?.description || "";
  const emps = companyData?.employees || [];
  $("#groupLeader").innerHTML = `<option value="">不指定</option>` + emps.map((e) => `<option value="${esc(e.id)}" ${g?.leader === e.id ? "selected" : ""}>${esc(e.name)}</option>`).join("");
  const selectedMembers = new Set(g?.members || []);
  $("#groupMembers").innerHTML = emps.length ? emps.map((e) => {
    const checked = selectedMembers.has(e.id);
    return `<label class="member-check ${checked ? "checked" : ""}">
      <input type="checkbox" value="${esc(e.id)}" ${checked ? "checked" : ""} onchange="this.parentElement.classList.toggle('checked',this.checked)">
      <span class="mc-avatar">${esc(String(e.name || "?").slice(0, 1).toUpperCase())}</span>
      <span class="mc-meta"><b>${esc(e.name || e.id)}</b><small>${esc(roleLabel(e.role) || e.role || "员工")}</small></span>
      <svg class="icon mc-check"><use href="#i-check"/></svg>
    </label>`;
  }).join("") : `<div class="member-check-empty">还没有员工，可先在「员工管理」创建</div>`;
  $("#groupModal").classList.remove("hidden");
  await Promise.all([
    renderChipPicker("#gm-skills", g?.skills || [], "skills"),
    renderChipPicker("#gm-workflows", g?.workflows || [], "workflows"),
  ]);
}
function closeGroupModal() { $("#groupModal").classList.add("hidden"); }
function toggleAllGroupMembers(checked) {
  $$("#groupMembers input[type=checkbox]").forEach((el) => {
    el.checked = !!checked;
    el.parentElement?.classList.toggle("checked", !!checked);
  });
}
async function submitGroup() {
  const members = $$("#groupMembers input[type=checkbox]:checked").map((el) => el.value);
  const payload = {
    unlocked: true, id: $("#groupId").value || undefined,
    name: $("#groupName").value.trim(), description: $("#groupDesc").value,
    leader: $("#groupLeader").value, members,
    skills: pickedChips("#gm-skills"), workflows: pickedChips("#gm-workflows"),
  };
  if (!payload.name) { toast("请填写团队名称", "err"); return; }
  try { await api("/api/org/groups", { method: "POST", body: JSON.stringify(payload) }); toast("团队已保存", "ok"); closeGroupModal(); loadGroups(); }
  catch (e) { toast(e.message, "err"); }
}
async function deleteGroup(id) {
  if (!(await appConfirm({
    title: "删除团队", subtitle: "任务不受影响",
    message: "确定删除这个团队吗？",
    detail: "团队下的任务与员工会保留，仅移除团队分组。",
    okText: "确认删除", icon: "briefcase",
  }))) return;
  try { await api(`/api/org/groups/${encodeURIComponent(id)}/delete`, { method: "POST", body: JSON.stringify({ unlocked: true }) }); toast("团队已删除", "ok"); loadGroups(); }
  catch (e) { toast(e.message, "err"); }
}
function openGroupTask(groupId) { openTaskModal(); $("#taskGroup").value = groupId; }

// ---------- 团队群聊（群模式）----------
/** 把群聊卡片挂载到指定宿主；host = modal（弹层）| session（会话中心右栏） */
function mountGroupChat(host) {
  const card = $("#groupChatCard");
  if (!card) return;
  gcState.host = host;
  if (host === "session") {
    $("#sessionGroupHost")?.appendChild(card);
    $("#sessionGroupHost")?.classList.remove("hidden");
    $("#sessionChatEmpty")?.classList.add("hidden");
    $("#sessionDetailPanel")?.classList.add("hidden");
    card.classList.add("gc-session-mode");
  } else {
    $("#gcModalSlot")?.appendChild(card);
    $("#groupChatModal").classList.remove("hidden");
    card.classList.remove("gc-session-mode");
  }
}

/** 会话中心里点开某个群：关闭当前 Pi 会话连接，把群聊挂进右栏 */
async function viewGroupSession(groupId) {
  if (chatES) { try { chatES.close(); } catch {} chatES = null; }
  chatFile = null;
  chatSetRunning(false);
  closeSessionMenu();
  sessionActiveOwner = `group:${groupId}`;
  renderSessionEmpList(true);
  $$(".sess-conv-item").forEach((el) => el.classList.toggle("active", el.dataset.file === `group:${groupId}`));
  mountGroupChat("session");
  await openGroupChat(groupId, "session");
}

async function openGroupChat(groupId, host = "modal") {
  const g = (companyData?.groups || []).find((x) => x.id === groupId)
    || groupsCache.find((x) => x.id === groupId);
  if (!g) { toast("团队不存在", "err"); return; }
  gcState.groupId = groupId;
  gcSopState.activeRunId = ""; // 切换群时重置流程选中，gcSopLoad 会回退到该群第一条
  gcSopState.selectedStep = null;
  $("#gcTitle").textContent = `${g.name} · 群聊`;
  const memberIds = [...new Set([...(g.members || []), g.leader].filter(Boolean))];
  $("#gcMeta").textContent = `${memberIds.length} 名成员 · ${g.description || "团队群聊"}`;
  $("#gcMembers").innerHTML = memberIds.map((id) => {
    const emp = empById(id);
    return `<span class="gc-member ${id === g.leader ? "leader" : ""}" title="${esc(emp?.name || id)}">${esc(String(emp?.name || id).slice(0, 1).toUpperCase())}</span>`;
  }).join("");
  mountGroupChat(host);
  syncGcSummaryToggle();
  connectOrgEvents();
  await Promise.all([gcLoadMessages(), gcSopLoad()]);
  setTimeout(() => $("#gcInput")?.focus(), 120);
}

function closeGroupChat() {
  if (gcState.host === "session") {
    // 归位到弹层槽（弹层保持隐藏），恢复会话中心空状态
    $("#gcModalSlot")?.appendChild($("#groupChatCard"));
    $("#groupChatCard")?.classList.remove("gc-session-mode");
    $("#sessionGroupHost")?.classList.add("hidden");
    $("#sessionChatEmpty")?.classList.remove("hidden");
    $$(".sess-conv-item").forEach((el) => el.classList.remove("active"));
  } else {
    $("#groupChatModal").classList.add("hidden");
  }
  closeSopStart();
  mentionHide();
  const gid = gcState.groupId;
  const wasSession = gcState.host === "session";
  gcState.groupId = "";
  gcState.host = "modal";
  if (wasSession) {
    sessionActiveOwner = "";
    renderSessionEmpList();
  }
  if (gid) loadGroupPreviews().then(() => { if ($("#view-sessions").classList.contains("active")) renderSessions(); }).catch(() => {});
}

async function gcLoadMessages() {
  const box = $("#gcMessages");
  if (!box) return;
  try {
    const msgs = await api(`/api/org/groups/${encodeURIComponent(gcState.groupId)}/messages?limit=200`);
    if (!msgs.length) {
      box.innerHTML = `<div class="gc-welcome"><svg class="icon"><use href="#i-sparkle"/></svg><h3>群里还没有消息</h3><p>发一条消息开始群聊。@ 成员会唤醒他以本人身份回应；点上方「启动 SOP」可按阶段自动流转协作。</p></div>`;
      return;
    }
    box.innerHTML = "";
    msgs.forEach((m) => gcAppendMessage(m, false));
    // 记住最近一条真人发言，用于自动预填 SOP 目标
    const lastHuman = [...msgs].reverse().find((m) => m.from === "human" && !/^\/sop\b/i.test(String(m.body || "").trim()));
    gcState.lastUserText = lastHuman ? String(lastHuman.body || "").trim().replace(/\s+/g, " ").slice(0, 120) : "";
    gcScroll();
  } catch (e) {
    box.innerHTML = `<div class="gc-welcome"><svg class="icon"><use href="#i-circle-alert"/></svg><p>加载失败：${esc(e.message)}</p></div>`;
  }
}

/** 追加一条群消息到消息流；scroll=true 时自动滚到底 */
function gcAppendMessage(m, scroll = true, allowSummary = false) {
  const box = $("#gcMessages");
  if (!box) return;
  const welcome = box.querySelector(".gc-welcome");
  if (welcome) welcome.remove();
  if (m.type === "sop_event") { gcAppendSopEvent(m, scroll); return; }
  const mine = m.from === "human";
  const emp = mine ? null : empById(m.from);
  const name = mine ? "我" : (emp?.name || m.from);
  const isReply = m.type === "group_reply";
  const body = String(m.body || "");
  const info = isReply ? usageInfo(m.usage, m.fx, m.costCny, m.priceLabel) : null;
  const usageLine = info ? `<div class="gc-msg-usage">${icon("activity")}<span>${esc(info.short)}</span><em>${esc(info.source)}</em></div>` : "";
  const wrap = document.createElement("div");
  wrap.className = `gc-msg ${mine ? "mine" : "agent"} ${isReply ? "reply" : ""}`;
  wrap.innerHTML = `
    <div class="gc-avatar">${esc(String(name).slice(0, 1).toUpperCase())}</div>
    <div class="gc-msg-main">
      <div class="gc-msg-head"><b>${esc(name)}</b>${isReply ? `<span class="gc-reply-tag">${icon("sparkle")}回应</span>` : ""}<span class="gc-msg-time">${fmtTime(m.createdAt)}</span></div>
      <div class="gc-msg-body"><div class="gc-msg-text">${richMessage(body)}</div></div>
      ${usageLine}
    </div>`;
  box.appendChild(wrap);
  if (scroll) gcScroll();
  // 精简总结：仅对实时新到的员工回应生成，历史消息不总结（避免一次性大量 token）
  if (allowSummary && isReply && !mine && gcState.groupId && gcSummaryEnabled(gcState.groupId)) {
    gcRenderSummary(wrap, body);
  }
}
function gcScroll() { const box = $("#gcMessages"); if (box) box.scrollTop = box.scrollHeight; }

/** SOP 流程事件消息：居中卡片式展示，与普通发言区分 */
function gcAppendSopEvent(m, scroll = true) {
  const box = $("#gcMessages");
  if (!box) return;
  const labels = { start: "流程启动", step_start: "阶段开始", step_done: "阶段完成", retry: "重新执行", stop: "流程终止", done: "流程完成", blocked: "流程暂停", skip: "阶段跳过" };
  const kind = m.sopEvent || "";
  const wrap = document.createElement("div");
  wrap.className = `gc-sop-event ${kind}`;
  wrap.innerHTML = `
    <div class="gc-sop-event-head"><svg class="icon"><use href="#i-layers"/></svg><b>${esc(labels[kind] || "SOP 事件")}</b><span class="gc-msg-time">${fmtTime(m.createdAt)}</span></div>
    <div class="gc-sop-event-body">${esc(String(m.body || ""))}</div>`;
  box.appendChild(wrap);
  if (scroll) gcScroll();
}

async function gcSend() {
  if (!gcState.groupId) return;
  const input = $("#gcInput");
  const text = input.value.trim();
  if (!text) return;
  mentionHide();
  input.value = "";
  gcState.sending = true;
  try {
    const r = await api(`/api/org/groups/${encodeURIComponent(gcState.groupId)}/messages`, {
      method: "POST", body: JSON.stringify({ unlocked: true, body: text }),
    });
    // 用户消息由 SSE 广播追加；若 SSE 未连上则手动补一条
    if (!r.message) gcAppendMessage({ from: "human", body: text, createdAt: new Date().toISOString(), type: "group_chat" });
    if (r.awakened?.length) $("#gcHint").textContent = `已唤醒 ${r.awakened.map((id) => empById(id)?.name || id).join("、")}，完成后会回写群聊`;
    setTimeout(() => {
      const run = gcSopState.run;
      const n = gcSopState.runs.length;
      $("#gcHint").textContent = run?.status === "running"
        ? `${n > 1 ? `${n} 条 SOP 并行 · 当前 ` : ""}阶段 ${run.currentStep + 1}/${run.steps.length} · 输入 /sop next 推进`
        : "@ 成员唤醒执行 · 输入 /sop start 启动流程";
    }, 5000);
  } catch (e) {
    toast(e.message, "err");
    input.value = text;
  } finally {
    gcState.sending = false;
  }
}

function gcKeydown(e) {
  if (mentionKeydown(e)) return;
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); gcSend(); }
}

// ---------- 群 SOP：模板启动 / 阶段流转 / 实时状态 ----------
const SOP_STEP_LABELS = { pending: "待执行", doing: "执行中", done: "已完成", skipped: "已跳过", blocked: "已暂停" };

/** 同步服务端返回的多流程列表，保持当前选中项（失效则回退到第一条） */
function syncSopRuns(runs) {
  gcSopState.runs = Array.isArray(runs) ? runs : [];
  const found = gcSopState.runs.find((x) => x.id === gcSopState.activeRunId);
  gcSopState.activeRunId = found ? found.id : (gcSopState.runs[0]?.id || "");
  gcSopState.run = found || gcSopState.runs[0] || null;
  if (gcSopState.run && gcSopState.selectedStep >= gcSopState.run.steps.length) gcSopState.selectedStep = null;
}

async function gcSopLoad() {
  if (!gcState.groupId) return;
  try {
    const r = await api(`/api/org/groups/${encodeURIComponent(gcState.groupId)}/sop`);
    syncSopRuns(r.runs || (r.run ? [r.run] : []));
    gcSopState.templates = r.templates || [];
    gcSopRender();
  } catch (e) {
    const steps = $("#gcSopSteps");
    if (steps) steps.innerHTML = `<div class="gc-sop-empty">SOP 状态加载失败：${esc(e.message)}</div>`;
  }
}

/** 切换面板查看的流程 */
function gcSopSelect(runId) {
  gcSopState.activeRunId = runId;
  gcSopState.run = gcSopState.runs.find((x) => x.id === runId) || null;
  gcSopState.selectedStep = null;
  gcSopRender();
}

function gcSopToggle() {
  gcSopState.collapsed = !gcSopState.collapsed;
  gcSopRender();
}

function gcSopRender() {
  const panel = $("#gcSopPanel");
  if (!panel) return;
  panel.classList.toggle("collapsed", gcSopState.collapsed);
  const toggleBtn = $("#gcSopToggleBtn");
  if (toggleBtn) toggleBtn.querySelector("use")?.setAttribute("href", gcSopState.collapsed ? "#i-chevron" : "#i-chevron");
  if (toggleBtn) toggleBtn.style.transform = gcSopState.collapsed ? "rotate(-90deg)" : "rotate(90deg)";

  // 多流程切换条：仅在进行中流程 >= 1 时显示，当前选中的高亮
  const tabsEl = $("#gcSopTabs");
  if (tabsEl) {
    const runs = gcSopState.runs;
    tabsEl.innerHTML = runs.length
      ? `<span class="gc-sop-tabs-label">进行中 ${runs.length}</span>`
        + runs.map((x) => {
          const done = x.steps.filter((s) => s.status === "done").length;
          const st = x.status === "blocked" ? "paused" : x.status;
          return `<button type="button" class="gc-sop-tab ${st} ${x.id === gcSopState.activeRunId ? "active" : ""}" onclick="gcSopSelect('${esc(x.id)}')" title="${esc(x.goal || x.templateName)}">
            <span class="gc-sop-tab-name">${esc(x.templateName)}</span>
            <span class="gc-sop-tab-prog">${done}/${x.steps.length}</span>
          </button>`;
        }).join("")
        + `<button type="button" class="gc-sop-tab-add" onclick="openSopStart()" title="再启动一条流程">${icon("plus")}</button>`
      : "";
    tabsEl.classList.toggle("hidden", !runs.length);
  }

  const run = gcSopState.run;
  const nameEl = $("#gcSopName"), descEl = $("#gcSopDesc"), progEl = $("#gcSopProgress");
  const actionsEl = $("#gcSopActions"), stepsEl = $("#gcSopSteps"), detailEl = $("#gcSopDetail");
  if (!run) {
    nameEl.textContent = "未启用 SOP";
    descEl.textContent = "按标准流程推进群内协作";
    progEl.innerHTML = "";
    actionsEl.innerHTML = `<button class="btn ghost btn-sm" onclick="openSopStart()"><svg class="icon"><use href="#i-layers"/></svg>启动 SOP</button>`;
    stepsEl.innerHTML = `<div class="gc-sop-empty">选一个流程模板并填写目标，系统会自动按阶段派活、回写群聊并流转到下一步。</div>`;
    detailEl.innerHTML = "";
    return;
  }

  const doneCount = run.steps.filter((s) => s.status === "done").length;
  const pct = Math.round((doneCount / Math.max(1, run.steps.length)) * 100);
  const statusLabel = { done: " · 已完成", stopped: " · 已终止", blocked: " · 已暂停" }[run.status] || "";
  nameEl.textContent = `${run.templateName}${statusLabel}`;
  descEl.textContent = run.goal || "（未填写目标）";
  progEl.innerHTML = `<span>${doneCount}/${run.steps.length}</span><div class="gc-sop-bar-track"><i style="width:${pct}%"></i></div>`;
  const active = run.status === "running" || run.status === "blocked";
  actionsEl.innerHTML = active
    ? `<button class="btn ghost btn-sm" onclick="gcSopAction('next')" title="确认当前阶段完成，进入下一步">推进</button>
       <button class="btn ghost btn-sm" onclick="gcSopAction('retry')" title="重新派活当前阶段">重试</button>
       <button class="btn ghost btn-sm" onclick="gcSopAction('skip')" title="跳过当前阶段">跳过</button>
       <button class="btn ghost btn-sm danger" onclick="gcSopAction('stop')">终止</button>`
    : `<button class="btn ghost btn-sm" onclick="openSopStart()">重新发起</button>`;

  stepsEl.innerHTML = run.steps.map((s, i) => {
    const who = empById(s.assignee)?.name || s.assignee || "待分配";
    const cls = [s.status, i === run.currentStep && active ? "current" : ""].filter(Boolean).join(" ");
    const warn = s.assigneeMismatch ? `<span class="gc-sop-step-warn" title="${esc(s.assigneeReason || "岗位不匹配")}">!</span>` : "";
    return `<button type="button" class="gc-sop-step ${cls}" onclick="gcSopShowStep(${i})" title="${esc(s.name)}">
      <span class="gc-sop-step-no">${s.status === "done" ? "✓" : i + 1}</span>
      <span class="gc-sop-step-name">${esc(s.name)}${warn}</span>
      <span class="gc-sop-step-who">${esc(who)}</span>
      <span class="gc-sop-step-state">${SOP_STEP_LABELS[s.status] || s.status}</span>
    </button>`;
  }).join("");

  const idx = Number.isInteger(gcSopState.selectedStep) ? gcSopState.selectedStep : run.currentStep;
  const step = run.steps[idx];
  if (step) {
    detailEl.innerHTML = `
      <div class="gc-sop-detail-head"><b>阶段 ${idx + 1} · ${esc(step.name)}</b><span>${esc(empById(step.assignee)?.name || step.assignee || "待分配")}${step.role ? ` · ${esc(step.role)}` : ""}${step.skill ? ` · /${esc(step.skill)}` : ""}</span></div>
      ${step.assigneeMismatch ? `<p class="gc-sop-detail-warn"><svg class="icon"><use href="#i-alert"/></svg>${esc(step.assigneeReason || "岗位未匹配，由群 leader 代执行")}</p>` : ""}
      <p class="gc-sop-detail-instruction">${esc(gcSopInstruction(step, run.goal))}</p>
      ${step.acceptance ? `<p class="gc-sop-detail-accept"><b>验收：</b>${esc(step.acceptance)}</p>` : ""}
      ${step.status === "done" && step.result ? `<details class="gc-sop-result"><summary>查看阶段结论</summary><pre>${esc(String(step.result).slice(0, 4000))}</pre></details>` : ""}`;
  } else detailEl.innerHTML = "";
}

/** 展示用：把模板里的 {{goal}} 占位符替换成本次目标（前序结果不在 run 上逐字保存，保留占位说明） */
function gcSopInstruction(step, goal) {
  return String(step.instruction || "（无指令）")
    .replace(/\{\{goal\}\}/g, goal || "（未提供目标）")
    .replace(/\{\{prev\}\}/g, "（前序阶段结果）");
}

/** 点击步骤查看该阶段详情 */
function gcSopShowStep(index) {
  gcSopState.selectedStep = index;
  gcSopRender();
}

/** 手动推进 / 跳过 / 重试 / 终止 */
async function gcSopAction(action) {
  if (gcSopState.busy) return;
  const meta = {
    next: { title: "确认推进", message: "确认当前阶段已完成，进入下一阶段？", okText: "确认推进", tone: "info", icon: "arrow-right" },
    skip: { title: "跳过当前阶段", message: "当前阶段会被标记为「已跳过」，直接进入下一阶段。", okText: "确认跳过", tone: "warn", icon: "alert" },
    retry: { title: "重新执行当前阶段", message: "会重新派活当前阶段，原阶段结果将被覆盖。", okText: "重新执行", tone: "warn", icon: "refresh" },
    stop: { title: "终止 SOP 流程", message: "流程将停止，后续阶段不再自动执行。", okText: "确认终止", tone: "danger", icon: "x" },
  }[action];
  if (meta && !await appConfirm({ ...meta, subtitle: `群 SOP · ${gcSopState.run?.templateName || ""}`, safe: false })) return;
  gcSopState.busy = true;
  try {
    const r = await api(`/api/org/groups/${encodeURIComponent(gcState.groupId)}/sop`, {
      method: "POST", body: JSON.stringify({ unlocked: true, action, runId: gcSopState.activeRunId }),
    });
    syncSopRuns(r.runs || (r.run ? [r.run] : []));
    gcSopState.selectedStep = null;
    gcSopRender();
    toast(r.note || "SOP 已更新", "ok");
  } catch (e) { toast(e.message, "err"); }
  finally { gcSopState.busy = false; }
}

function openSopStart() {
  const modal = $("#sopStartModal");
  if (!modal) return;
  if (!gcSopState.templates.length) {
    toast("模板还在加载，请稍后再试", "err");
    gcSopLoad();
    return;
  }
  gcSopState.selectedTpl = gcSopState.selectedTpl || gcSopState.templates[0].id;
  renderSopTemplates();
  // 自动带入群里最近一条发言作为目标，用户可直接改或留空（服务端也会兜底）
  const goalInput = $("#sopGoalInput");
  if (goalInput) goalInput.value = gcState.lastUserText || "";
  modal.classList.remove("hidden");
  setTimeout(() => goalInput?.focus(), 80);
}
function closeSopStart() { $("#sopStartModal")?.classList.add("hidden"); }

function renderSopTemplates() {
  const list = $("#sopTemplateList");
  if (!list) return;
  list.innerHTML = gcSopState.templates.map((t) => `
    <button type="button" class="sop-tpl ${t.id === gcSopState.selectedTpl ? "active" : ""}" onclick="selectSopTemplate('${esc(t.id)}')">
      <b>${esc(t.name)}</b><span>${esc(t.description || "")}</span><em>${(t.steps || []).length} 阶段</em>
    </button>`).join("");
  const tpl = gcSopState.templates.find((t) => t.id === gcSopState.selectedTpl);
  const preview = $("#sopPreview");
  if (preview) {
    preview.innerHTML = tpl ? `<div class="sop-preview-label">阶段顺序</div><div class="sop-preview-steps">${(tpl.steps || []).map((s, i) => `<span><i>${i + 1}</i>${esc(s.name)}</span>`).join("")}</div>` : "";
  }
}
function selectSopTemplate(id) {
  gcSopState.selectedTpl = id;
  renderSopTemplates();
}

async function confirmSopStart() {
  if (gcSopState.busy) return;
  const goal = String($("#sopGoalInput")?.value || "").trim(); // 可留空，服务端自动取群最近发言
  if (!gcSopState.selectedTpl) { toast("请选择流程模板", "err"); return; }
  gcSopState.busy = true;
  try {
    const r = await api(`/api/org/groups/${encodeURIComponent(gcState.groupId)}/sop`, {
      method: "POST", body: JSON.stringify({ unlocked: true, action: "start", templateId: gcSopState.selectedTpl, goal }),
    });
    syncSopRuns(r.runs || (r.run ? [r.run] : []));
    gcSopState.activeRunId = r.run.id; // 切到刚启动的流程
    gcSopState.run = r.run;
    gcSopState.selectedStep = null;
    closeSopStart();
    $("#sopGoalInput").value = "";
    gcSopRender();
    toast(`已启动「${r.run.templateName}」，第一阶段已派活`, "ok");
  } catch (e) { toast(e.message, "err"); }
  finally { gcSopState.busy = false; }
}

// ---------- 任务看板 ----------
async function loadTasks() {
  await loadCompany();
  const tasks = companyData.tasks || [];
  taskBoards = tasks;
  // 填充筛选下拉
  const sel = $("#taskFilterAssignee");
  if (sel) sel.innerHTML = `<option value="">全部负责人</option>` + (companyData.employees || []).map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join("");
  renderBoard();
}
function taskFiltered() {
  const fa = $("#taskFilterAssignee")?.value || "";
  const fp = $("#taskFilterPriority")?.value || "";
  const fk = ($("#taskFilterKeyword")?.value || "").toLowerCase();
  const daysRaw = $("#taskRecentDays")?.value;
  const days = daysRaw === "" || daysRaw == null ? null : Math.max(1, Number(daysRaw) || 0);
  const cutoff = days ? Date.now() - days * 86400000 : null;
  const terminal = (s) => s === "done" || s === "blocked" || s === "cancelled";
  const anchorTime = (t) => {
    const ts = t.doneAt || t.updatedAt || t.createdAt;
    const n = ts ? new Date(ts).getTime() : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  return taskBoards.filter((t) => {
    if (fa && t.assignee !== fa) return false;
    if (fp && t.priority !== fp) return false;
    if (fk && !t.title.toLowerCase().includes(fk)) return false;
    // 终态任务按完成/更新时间限制天数；无时间或超过窗口则隐藏
    if (cutoff && terminal(t.status) && anchorTime(t) < cutoff) return false;
    return true;
  });
}
function clearRecentDays() { const el = $("#taskRecentDays"); if (el) { el.value = ""; renderBoard(); } }
function renderBoard() {
  const cols = [["todo","待办","grid"],["doing","进行中","activity"],["review","待验收","eye"],["done","已完成","circle-check"],["blocked","受阻/取消","circle-alert"]];
  const dotColor = { todo: "var(--text-3)", doing: "var(--cyan)", review: "var(--amber)", done: "var(--green)", blocked: "var(--red)" };
  const list = taskFiltered();
  const board = $("#taskBoard");
  board.innerHTML = cols.map(([key, label]) => {
    const group = list.filter((t) => key === "blocked" ? (t.status === "blocked" || t.status === "cancelled") : t.status === key);
    const cards = group.map((t) => {
      const running = key === "doing";
      const timeHint = [
        t.createdAt ? `创建 ${fmtTime(t.createdAt)}` : null,
        t.doneAt ? `完成 ${fmtTime(t.doneAt)}` : null,
      ].filter(Boolean).join(" · ");
      return `<div class="task-card ${running ? "running" : ""}" onclick="viewTask('${esc(t.id)}')"><div class="task-card-top"><span class="prio ${esc(t.priority)}">${esc(t.priority)}</span>${running ? `<span class="running-pulse"></span>` : ""}<span class="badge" style="margin-left:auto">${esc(t.source === "trigger" ? "自动" : t.source === "group" ? "团队" : "手动")}</span></div><h4>${esc(t.title)}</h4><div class="t-assignee">${icon("users")}${esc(t.assignee ? empName(t.assignee) : t.groupId ? "团队:" + (companyData.groups || []).find((g) => g.id === t.groupId)?.name || t.groupId : "未指派")}</div><div class="t-time" title="${esc(timeHint || "无时间记录")}">${icon("clock")}${fmtSessionTime(t.createdAt)}</div>${t.tags?.length ? `<div class="t-tags">${t.tags.slice(0,3).map((tag) => `<span class="t-tag">${esc(tag)}</span>`).join("")}</div>` : ""}${t.sessionFile ? `<div class="t-session-actions"><button class="t-session-btn" title="跳转到会话中心打开最新会话" onclick='event.stopPropagation();openTaskSession(${JSON.stringify(t.sessionFile)},${JSON.stringify("任务 · " + t.title)},"jump")'>${icon("external")}跳转会话</button><button class="t-session-btn" title="弹窗打开最新会话" onclick='event.stopPropagation();openTaskSession(${JSON.stringify(t.sessionFile)},${JSON.stringify("任务 · " + t.title)},"popup")'>${icon("terminal")}弹窗打开</button></div>` : ""}</div>`;
    }).join("") || `<div class="board-empty">暂无${label}任务</div>`;
    return `<div class="board-col"><div class="board-col-head"><span class="dot" style="background:${dotColor[key]}"></span>${label}<span class="badge">${group.length}</span></div><div class="board-col-body">${cards}</div></div>`;
  }).join("");
}
function toggleTaskFilters() { const bar = $("#taskFilterBar"); bar.style.display = bar.style.display === "none" ? "flex" : "none"; }
function resetTaskFilters() { $("#taskFilterAssignee").value = ""; $("#taskFilterPriority").value = ""; $("#taskFilterKeyword").value = ""; renderBoard(); }
["taskFilterAssignee","taskFilterPriority","taskFilterKeyword","taskRecentDays"].forEach((id) => document.addEventListener("input", (e) => { if (e.target.id === id) renderBoard(); }));

function openTaskModal(id = "") {
  loadCompany().then(() => {
    const t = taskBoards.find((x) => x.id === id);
    $("#taskId").value = t?.id || "";
    $("#taskModalTitle").textContent = t ? "编辑任务" : "新建任务";
    $("#taskTitle").value = t?.title || "";
    $("#taskDesc").value = t?.description || "";
    $("#taskAcceptance").value = t?.acceptance || "";
    $("#taskPriority").value = t?.priority || "medium";
    $("#taskTags").value = (t?.tags || []).join(", ");
    const emps = companyData.employees || [];
    $("#taskAssignee").innerHTML = `<option value="">暂不指派</option>` + emps.map((e) => `<option value="${esc(e.id)}" ${t?.assignee === e.id ? "selected" : ""}>${esc(e.name)} · ${esc(e.role || "")}</option>`).join("");
    $("#taskGroup").innerHTML = `<option value="">不指派团队</option>` + (companyData.groups || []).map((g) => `<option value="${esc(g.id)}" ${t?.groupId === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("");
    $("#taskExecute").checked = true; // 派活即执行：新建任务默认立即执行
    $("#taskModal").classList.remove("hidden");
  });
}
function closeTaskModal() { $("#taskModal").classList.add("hidden"); }
async function submitTask() {
  const payload = {
    unlocked: true, id: $("#taskId").value || undefined, title: $("#taskTitle").value.trim(),
    description: $("#taskDesc").value, acceptance: $("#taskAcceptance").value, priority: $("#taskPriority").value,
    tags: $("#taskTags").value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    assignee: $("#taskAssignee").value, groupId: $("#taskGroup").value,
  };
  if (!payload.title) { toast("请填写任务标题", "err"); return; }
  try {
    const r = await api("/api/org/tasks", { method: "POST", body: JSON.stringify(payload) });
    closeTaskModal(); toast("任务已创建", "ok");
    // 若指派了且需要立即执行
    if ($("#taskExecute").checked && (payload.assignee)) {
      try { await api(`/api/org/tasks/${encodeURIComponent(r.task.id)}/run`, { method: "POST", body: JSON.stringify({ unlocked: true }) }); toast("任务已开始执行", "ok"); connectOrgEvents(); }
      catch (e) { toast(`派活成功，执行失败：${e.message}`, "err"); }
    }
    loadTasks();
  } catch (e) { toast(e.message, "err"); }
}

async function viewTask(id) {
  try {
    const d = await api(`/api/org/tasks/${encodeURIComponent(id)}`);
    const t = d.task;
    const latestSession = (d.runs || []).find((r) => r.sessionFile)?.sessionFile || t.sessionFile || "";
    $("#tdTitle").textContent = t.title;
    const timeMeta = [
      t.createdAt ? `创建 ${fmtTime(t.createdAt)}` : "",
      t.doneAt ? `完成 ${fmtTime(t.doneAt)}` : "",
      !t.doneAt && t.updatedAt && t.createdAt && t.updatedAt !== t.createdAt ? `更新 ${fmtTime(t.updatedAt)}` : "",
    ].filter(Boolean).join(" · ");
    $("#tdMeta").textContent = `${taskStatusLabel(t.status)} · ${esc(t.priority)} · ${t.assignee ? "负责人 " + empName(t.assignee) : t.groupId ? "团队任务" : "未指派"}${timeMeta ? " · " + timeMeta : ""}`;
    let html = "";
    // 操作区
    html += `<div class="td-section"><h3>操作</h3><div class="td-actions">`;
    if (latestSession) html += `<button class="btn btn-sm" onclick='openTaskSession(${JSON.stringify(latestSession)},${JSON.stringify("任务 · " + t.title)},"jump")'>${icon("external")}跳转会话</button><button class="btn btn-sm" onclick='openTaskSession(${JSON.stringify(latestSession)},${JSON.stringify("任务 · " + t.title)},"popup")'>${icon("terminal")}弹窗打开会话</button>`;
    if (!t.assignee && !t.groupId) html += `<button class="btn btn-sm" onclick="openAssignModal('${esc(t.id)}')">${icon("users")}派活</button>`;
    if (t.assignee && ["todo","blocked","review"].includes(t.status)) html += `<button class="btn primary btn-sm" onclick="runTask('${esc(t.id)}')">${icon("zap")}调用 Pi 执行</button>`;
    if (t.status === "review") html += `<button class="btn btn-sm" style="color:var(--green)" onclick="transitionTask('${esc(t.id)}','done','验收通过')">${icon("check")}验收通过</button><button class="btn btn-sm" onclick="transitionTask('${esc(t.id)}','doing','验收不通过，返工')">${icon("refresh")}返工</button>`;
    // 终态不是死状态：受阻/取消/已完成都可重新打开回到待办
    if (["blocked","cancelled","done"].includes(t.status)) html += `<button class="btn btn-sm" onclick="transitionTask('${esc(t.id)}','todo','重新打开')">${icon("refresh")}重新打开</button>`;
    if (!["done","cancelled"].includes(t.status)) html += `<button class="btn btn-sm" onclick="transitionTask('${esc(t.id)}','cancelled','手动取消')">取消任务</button>`;
    html += `</div></div>`;
    html += `<div class="td-section"><h3>任务描述</h3><div class="td-desc">${esc(t.description || "（无描述）")}</div></div>`;
    if (t.acceptance) html += `<div class="td-section"><h3>验收标准</h3><div class="td-desc">${esc(t.acceptance)}</div></div>`;
    if (t.lastResult) html += `<div class="td-section"><h3>执行结果</h3><div class="td-result">${esc(t.lastResult)}</div></div>`;
    html += `<div class="td-section"><h3>流转记录</h3><div class="td-timeline">${(t.history || []).map((h) => `<div class="td-tl-item"><div class="td-tl-dot"></div><div><div class="td-tl-text"><b>${taskStatusLabel(h.from) || "创建"} → ${taskStatusLabel(h.to)}</b> · ${esc(h.note || "")}</div><div class="td-tl-time">${esc((h.at || "").slice(0, 19).replace("T", " "))}</div></div></div>`).join("") || `<div class="board-empty">无记录</div>`}</div></div>`;
    if (d.runs?.length) html += `<div class="td-section"><h3>执行记录</h3>${d.runs.map((r) => `<div class="mem-item"><span class="mem-type">${esc(r.status)}</span><span class="mem-content">${icon("clock")} ${esc((r.startedAt || "").slice(0, 19).replace("T", " "))} · 会话 ${esc((r.sessionFile || "").split("/").pop()?.slice(0, 16) || "")}</span></div>`).join("")}</div>`;
    $("#taskDetailBody").innerHTML = html;
    $("#tdHint").textContent = `任务 ID ${t.id} · 产物 ${(t.artifacts || []).length} 个 · 消息 ${d.messages?.length || 0} 条`;
    $("#taskDetailModal").classList.remove("hidden");
    window._currentTaskId = id;
  } catch (e) { toast(e.message, "err"); }
}
function closeTaskDetail() { $("#taskDetailModal").classList.add("hidden"); }
let assignTaskId = null;
function openAssignModal(id) {
  const t = taskBoards.find((x) => x.id === id);
  const emps = companyData?.employees || [];
  const groups = companyData?.groups || [];
  assignTaskId = id;
  $("#assignTaskName").textContent = t ? `为「${t.title}」选择负责人 · 确认后立即执行` : "选择员工或团队，确认后立即执行";
  // 用 optgroup 分组，员工/团队一眼可辨，避免手输 emp:xxx / grp:xxx
  let opts = `<option value="">-- 请选择员工或团队 --</option>`;
  if (emps.length) opts += `<optgroup label="员工（${emps.length}）">` + emps.map((e) => `<option value="emp:${esc(e.id)}">${esc(e.name)}${e.role ? " · " + esc(e.role) : ""}</option>`).join("") + `</optgroup>`;
  if (groups.length) opts += `<optgroup label="团队（${groups.length}）">` + groups.map((g) => `<option value="grp:${esc(g.id)}">${esc(g.name)}</option>`).join("") + `</optgroup>`;
  $("#assignTarget").innerHTML = opts;
  $("#assignTarget").value = "";
  $("#assignModal").classList.remove("hidden");
  $("#assignTarget").focus();
}
function closeAssignModal() { $("#assignModal").classList.add("hidden"); }
async function submitAssign() {
  if (!assignTaskId) return;
  const choice = $("#assignTarget").value;
  if (!choice) { toast("请先从列表中选择员工或团队", "err"); return; }
  const payload = choice.startsWith("emp:") ? { assignee: choice.slice(4) } : { groupId: choice.slice(4) };
  try {
    const r = await api(`/api/org/tasks/${encodeURIComponent(assignTaskId)}/assign`, { method: "POST", body: JSON.stringify({ unlocked: true, ...payload, execute: true }) });
    closeAssignModal();
    closeTaskDetail();
    loadTasks();
    connectOrgEvents();
    if (r.spawned?.length) toast(`已派活，${r.spawned.length} 个子任务开始执行`, "ok");
    else if (r.note?.includes("失败")) toast(r.note, "err");
    else toast("已派活并启动执行，可在协作中心看实时汇报", "ok");
  } catch (e) { toast(e.message, "err"); }
}
async function runTask(id) {
  try { await api(`/api/org/tasks/${encodeURIComponent(id)}/run`, { method: "POST", body: JSON.stringify({ unlocked: true }) }); toast("任务已开始执行，可在协作中心看实时汇报", "ok"); connectOrgEvents(); closeTaskDetail(); loadTasks(); }
  catch (e) { toast(e.message, "err"); }
}
async function transitionTask(id, status, note) {
  try { await api(`/api/org/tasks/${encodeURIComponent(id)}/transition`, { method: "POST", body: JSON.stringify({ unlocked: true, status, note }) }); toast(`状态已更新：${taskStatusLabel(status)}`, "ok"); closeTaskDetail(); loadTasks(); }
  catch (e) { toast(e.message, "err"); }
}

// ---------- 协作中心 ----------
// 频道名是给人看的：task:task_xxx 用任务标题代替内部 ID
function channelLabel(c, taskMap, grouped) {
  if (typeof c !== "string") return String(c ?? "");
  if (c.startsWith("task:")) {
    const id = c.slice(5);
    const t = taskMap?.get?.(id);
    if (t) return `任务 · ${t.title}`;
    // 任务已删除时，尽量从该频道的历史消息还原一个可读标题
    const list = grouped?.get(c) || [];
    const card = list.map((m) => m.body || "").find((b) => /任务卡[：:]/.test(b));
    const title = card?.match(/任务卡[：:]\s*([^\n]+)/)?.[1]?.trim();
    if (title) return `任务 · ${title}`;
    const first = list.find((m) => m.from === "human")?.body?.trim();
    if (first) return `任务 · ${first.slice(0, 18)}${first.length > 18 ? "…" : ""}（历史）`;
    return `任务 · ${id.slice(-6)}（历史）`;
  }
  if (c === "general") return "公共频道";
  if (c === "org-events") return "组织动态";
  return c;
}

async function loadCollab() {
  await loadCompany();
  let msgs = [];
  try { msgs = await api("/api/org/messages?limit=500"); } catch {}
  const taskMap = new Map((companyData?.tasks || []).map((t) => [t.id, t]));
  const grouped = new Map();
  msgs.forEach((m) => {
    if (!m.channel) return;
    if (!grouped.has(m.channel)) grouped.set(m.channel, []);
    grouped.get(m.channel).push(m);
  });
  // 按最后一条消息的时间倒序，最近有人说话的频道排在最前
  const lastTs = (arr) => arr.reduce((mx, m) => (m.createdAt || "") > mx ? m.createdAt : mx, "");
  const channels = [...grouped.keys()].sort((a, b) => lastTs(grouped.get(a)) < lastTs(grouped.get(b)) ? 1 : -1);
  if (!channels.includes(currentChannel)) channels.unshift(currentChannel);
  $("#channelList").innerHTML = channels.map((c) => {
    const label = channelLabel(c, taskMap, grouped);
    return `<div class="channel-item ${c === currentChannel ? "active" : ""}" onclick='switchChannel(${JSON.stringify(c)})' title="${esc(label)}">${icon("list")}<span>${esc(label)}</span><span class="badge">${grouped.get(c)?.length || 0}</span></div>`;
  }).join("");
  $("#channelTitle").textContent = `# ${channelLabel(currentChannel, taskMap, grouped)}`;
  const list = msgs.filter((m) => m.channel === currentChannel);
  $("#messageCount").textContent = `${list.length} 条`;
  $("#messageStream").innerHTML = list.length ? list.map((m) => `<div class="msg-card from-${m.from === "human" ? "human" : "agent"}"><div class="msg-head"><span>${esc(m.from === "human" ? "你" : empName(m.from))}</span><span class="msg-type">${esc(msgTypeLabel(m.type))}</span><span>${esc((m.createdAt || "").slice(5, 16).replace("T", " "))}</span></div><div class="msg-body">${esc(m.body)}</div>${m.ref ? `<div style="margin-top:7px;font-size:10.5px;opacity:.7">${esc(channelLabel(`task:${m.ref}`, taskMap))}</div>` : ""}</div>`).join("") : `<div class="msg-empty">${icon("activity")}<p>这个频道还没有消息</p><button class="btn primary btn-sm" onclick="openMessageModal()">发第一条消息</button></div>`;
  const box = $("#messageStream"); if (box) box.scrollTop = box.scrollHeight;
}
function switchChannel(c) { currentChannel = c; $("#msgChannel").value = c; loadCollab(); }
function openMessageModal() { $("#msgChannel").value = currentChannel; $("#messageModal").classList.remove("hidden"); }
function closeMessageModal() { $("#messageModal").classList.add("hidden"); }
async function submitMessage() {
  const payload = { unlocked: true, channel: $("#msgChannel").value.trim() || "general", from: $("#msgFrom").value.trim() || "human", to: $("#msgTo").value.trim(), type: $("#msgType").value, body: $("#msgBody").value };
  if (!payload.body.trim()) { toast("请输入消息内容", "err"); return; }
  try {
    const r = await api("/api/org/messages", { method: "POST", body: JSON.stringify(payload) });
    closeMessageModal(); toast(r.spawnedTask ? `消息已发送，已为 ${payload.to} 创建任务 ${r.spawnedTask}` : "消息已发送", "ok");
    currentChannel = payload.channel; loadCollab();
  } catch (e) { toast(e.message, "err"); }
}

// ---------- 自主工作 ----------
async function loadTriggers() {
  await loadCompany();
  const triggers = companyData.triggers || [];
  $("#triggerCount").textContent = `${triggers.filter((t) => t.enabled).length} 启用 / ${triggers.length}`;
  const emps = companyData.employees || [];
  $("#triggerList").innerHTML = triggers.length ? triggers.map((t) => `<div class="trigger-item"><div class="trigger-info"><h4>${icon("zap")} ${esc(t.name)}</h4><div class="t-meta">员工 ${esc(empName(t.employeeId))} · ${t.type === "interval" ? `每 ${t.intervalMin} 分钟` : t.type === "once" ? "一次性" : esc(t.cron)} · 已运行 ${t.runCount || 0}${t.maxRuns ? "/" + t.maxRuns : ""} 次 · 上次 ${t.lastRunAt ? esc(t.lastRunAt.slice(5, 16).replace("T", " ")) : "从未"}</div></div><label class="switch"><input type="checkbox" ${t.enabled ? "checked" : ""} onchange="toggleTrigger('${esc(t.id)}',this.checked)"><span class="slider"></span></label><div class="trigger-actions"><button class="btn btn-sm" onclick="fireTrigger('${esc(t.id)}')">${icon("zap")}立即运行</button><button class="btn btn-sm" onclick="openTriggerModal('${esc(t.id)}')">${icon("sliders")}编辑</button><button class="btn btn-sm danger" onclick="deleteTrigger('${esc(t.id)}')">${icon("trash")}</button></div></div>`).join("") : `<div class="empty-state"><div class="empty-illustration">${icon("zap")}</div><h3>还没有自主工作</h3><p>把验证过的稳定任务设为定时自动开工</p><button class="btn primary" onclick="openTriggerModal()">${icon("plus")}新建自主工作</button></div>`;
}
function openTriggerModal(id = "") {
  const t = (companyData?.triggers || []).find((x) => x.id === id);
  $("#triggerId").value = t?.id || "";
  $("#triggerModalTitle").textContent = t ? "编辑自主工作" : "新建自主工作";
  $("#triggerName").value = t?.name || "";
  $("#triggerEmployee").innerHTML = `<option value="">选择员工</option>` + (companyData?.employees || []).map((e) => `<option value="${esc(e.id)}" ${t?.employeeId === e.id ? "selected" : ""}>${esc(e.name)}</option>`).join("");
  $("#triggerType").value = t?.type || "interval";
  $("#triggerInterval").value = t?.intervalMin || 60;
  $("#triggerMaxRuns").value = t?.maxRuns || 0;
  $("#triggerTaskTitle").value = t?.taskTitle || "";
  $("#triggerPrompt").value = t?.prompt || "";
  $("#triggerEnabled").checked = t ? t.enabled : true;
  $("#triggerModal").classList.remove("hidden");
}
function closeTriggerModal() { $("#triggerModal").classList.add("hidden"); }
async function submitTrigger() {
  const payload = { unlocked: true, id: $("#triggerId").value || undefined, name: $("#triggerName").value.trim(), employeeId: $("#triggerEmployee").value, type: $("#triggerType").value, intervalMin: Number($("#triggerInterval").value), maxRuns: Number($("#triggerMaxRuns").value), taskTitle: $("#triggerTaskTitle").value.trim(), prompt: $("#triggerPrompt").value, enabled: $("#triggerEnabled").checked };
  if (!payload.name || !payload.taskTitle) { toast("请填写名称和任务标题", "err"); return; }
  try { await api("/api/org/triggers", { method: "POST", body: JSON.stringify(payload) }); toast("自主工作已保存", "ok"); closeTriggerModal(); loadTriggers(); }
  catch (e) { toast(e.message, "err"); }
}
async function toggleTrigger(id, enabled) {
  const t = (companyData?.triggers || []).find((x) => x.id === id); if (!t) return;
  try { await api("/api/org/triggers", { method: "POST", body: JSON.stringify({ unlocked: true, ...t, enabled }) }); toast(enabled ? "已启用" : "已停用", "ok"); loadTriggers(); }
  catch (e) { toast(e.message, "err"); loadTriggers(); }
}
async function fireTrigger(id) {
  try { const r = await api(`/api/org/triggers/${encodeURIComponent(id)}/fire`, { method: "POST", body: JSON.stringify({ unlocked: true }) }); toast(`已触发任务 ${r.taskId}`, "ok"); connectOrgEvents(); loadTriggers(); }
  catch (e) { toast(e.message, "err"); }
}
async function deleteTrigger(id) {
  if (!(await appConfirm({
    title: "删除自主工作", subtitle: "由触发器发起的自动任务",
    message: "确定删除这个自主工作吗？",
    detail: "删除后该触发规则不再执行，已产生的任务与会话保留。",
    okText: "确认删除", icon: "zap",
  }))) return;
  try { await api(`/api/org/triggers/${encodeURIComponent(id)}/delete`, { method: "POST", body: JSON.stringify({ unlocked: true }) }); toast("已删除", "ok"); loadTriggers(); }
  catch (e) { toast(e.message, "err"); }
}

// ---------- 知识库 ----------
async function loadKnowledge() {
  let items = [];
  try { items = await api("/api/org/knowledge"); } catch (e) { toast(e.message, "err"); }
  const grid = $("#knowledgeGrid");
  grid.innerHTML = items.length ? items.map((k) => `<div class="kb-card"><h4>${icon("file")}${esc(k.title)}</h4><div class="kb-content">${esc(k.content)}</div><div class="kb-card-foot">${(k.tags || []).map((t) => `<span class="t-tag">${esc(t)}</span>`).join("")}<div style="margin-left:auto;display:flex;gap:6px"><button class="btn btn-sm" onclick="openKnowledgeModal('${esc(k.id)}')">${icon("sliders")}编辑</button><button class="btn btn-sm danger" onclick="deleteKnowledge('${esc(k.id)}')">${icon("trash")}</button></div></div></div>`).join("") : `<div class="empty-state" style="grid-column:1/-1"><div class="empty-illustration">${icon("database")}</div><h3>知识库为空</h3><p>添加稳定的资料，员工执行任务时会自动引用</p><button class="btn primary" onclick="openKnowledgeModal()">${icon("plus")}新增知识</button></div>`;
}
function openKnowledgeModal(id = "") {
  // 知识条目需要缓存以回填
  api("/api/org/knowledge").then((items) => {
    const k = items.find((x) => x.id === id);
    $("#kbId").value = k?.id || "";
    $("#knowledgeModalTitle").textContent = k ? "编辑知识" : "新增知识";
    $("#kbTitle").value = k?.title || "";
    $("#kbContent").value = k?.content || "";
    $("#kbTags").value = (k?.tags || []).join(", ");
    $("#knowledgeModal").classList.remove("hidden");
  });
}
function closeKnowledgeModal() { $("#knowledgeModal").classList.add("hidden"); }
async function submitKnowledge() {
  const payload = { unlocked: true, id: $("#kbId").value || undefined, title: $("#kbTitle").value.trim(), content: $("#kbContent").value, tags: $("#kbTags").value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) };
  if (!payload.title) { toast("请填写标题", "err"); return; }
  try { await api("/api/org/knowledge", { method: "POST", body: JSON.stringify(payload) }); toast("知识已保存", "ok"); closeKnowledgeModal(); loadKnowledge(); }
  catch (e) { toast(e.message, "err"); }
}
async function deleteKnowledge(id) {
  if (!(await appConfirm({
    title: "删除知识", subtitle: "从知识库中移除",
    message: "确定删除这条知识吗？",
    detail: "删除后员工将无法再引用这条内容，操作前会先备份。",
    okText: "确认删除", icon: "file",
  }))) return;
  try { await api(`/api/org/knowledge/${encodeURIComponent(id)}/delete`, { method: "POST", body: JSON.stringify({ unlocked: true }) }); toast("已删除", "ok"); loadKnowledge(); }
  catch (e) { toast(e.message, "err"); }
}

// 让员工列表的操作列支持「工作台」入口（点击姓名打开详情）
document.addEventListener("click", (e) => {
  const el = e.target.closest?.("[data-emp-detail]");
  if (el) { e.preventDefault(); openEmpDetail(el.getAttribute("data-emp-detail")); }
});

// ---------- 命令面板 ----------
const COMMANDS = [
  { group: "导航", label: "概览", hint: "系统状态与环境", icon: "grid", run: () => switchTab("overview") },
  { group: "导航", label: "资源管理", hint: "启停扩展 / 技能", icon: "plug", run: () => switchTab("resources") },
  { group: "导航", label: "组织概览", hint: "查看组织架构图", icon: "network", run: () => switchTab("org") },
  { group: "导航", label: "员工管理", hint: "创建与管理数字员工", icon: "users", run: () => switchTab("employees") },
  { group: "导航", label: "团队 Group", hint: "组建协作团队", icon: "briefcase", run: () => switchTab("groups") },
  { group: "导航", label: "任务看板", hint: "派活与执行", icon: "list", run: () => switchTab("tasks") },
  { group: "导航", label: "协作中心", hint: "消息与交接", icon: "activity", run: () => switchTab("collab") },
  { group: "导航", label: "自主工作", hint: "定时自动开工", icon: "zap", run: () => switchTab("autonomous") },
  { group: "导航", label: "知识库", hint: "组织共享知识", icon: "database", run: () => switchTab("knowledge") },
  { group: "导航", label: "会话中心", hint: "浏览历史会话", icon: "clock", run: () => switchTab("sessions") },
  { group: "导航", label: "专注模式", hint: "只显示会话中心，最大化工作区（Alt+F / Esc 退出）", icon: "focus", run: () => toggleFocusMode() },
  { group: "导航", label: "管家", hint: "问系统配置、让它代劳", icon: "sparkle", run: () => openButler() },
  { group: "导航", label: "设置编辑", hint: "编辑配置 JSON", icon: "sliders", run: () => switchTab("settings") },
  { group: "导航", label: "模型与认证", hint: "管理模型端点", icon: "cpu", run: () => switchTab("models") },
  { group: "操作", label: "新增模型", hint: "配置一个新的模型端点", icon: "plus", run: () => { switchTab("models"); setTimeout(openAddModel, 120); } },
  { group: "操作", label: "新增员工", hint: "创建一个数字员工", icon: "plus", run: () => { switchTab("employees"); setTimeout(() => openEmployeeModal(), 120); } },
  { group: "操作", label: "新建任务", hint: "创建并派活", icon: "plus", run: () => { switchTab("tasks"); setTimeout(openTaskModal, 120); } },
  { group: "操作", label: "新建团队", hint: "组建协作团队", icon: "plus", run: () => { switchTab("groups"); setTimeout(openGroupModal, 120); } },
  { group: "操作", label: "新建自主工作", hint: "配置定时任务", icon: "plus", run: () => { switchTab("autonomous"); setTimeout(openTriggerModal, 120); } },
  { group: "操作", label: "刷新数据", hint: "重新加载概览", icon: "refresh", run: () => refreshAll() },
  { group: "操作", label: "重启服务", hint: "停止并重新拉起管理服务", icon: "restart", run: () => openRestartModal() },
  { group: "操作", label: "导入技能与工作流", hint: "从 QoderWake 导出目录批量导入", icon: "wand", run: () => openImportModal() },
  { group: "外观", label: "切换浅色主题", hint: "明亮界面", icon: "sun", run: () => applyTheme("light") },
  { group: "外观", label: "切换深色主题", hint: "护眼界面", icon: "moon", run: () => applyTheme("dark") },
];
let cmdIndex = 0;
let cmdMatches = [];

function renderCommands(q = "") {
  cmdMatches = COMMANDS.filter((c) => !q || `${c.label} ${c.hint} ${c.group}`.toLowerCase().includes(q.toLowerCase()));
  cmdIndex = 0;
  let html = "", lastGroup = "";
  cmdMatches.forEach((c, i) => {
    if (c.group !== lastGroup) { html += `<div class="command-group">${c.group}</div>`; lastGroup = c.group; }
    html += `<button class="command-item ${i === 0 ? "selected" : ""}" data-i="${i}">${icon(c.icon)}<span class="cmd-label">${esc(c.label)}</span><span class="cmd-hint">${esc(c.hint)}</span></button>`;
  });
  $("#commandList").innerHTML = html || `<div class="empty-state"><div class="empty-illustration">${icon("search")}</div><h3>没有匹配的命令</h3><p>换个关键词试试</p></div>`;
  $$(".command-item").forEach((el) => el.addEventListener("click", () => runCommand(Number(el.dataset.i))));
}

function openCommandPalette() {
  $("#commandModal").classList.remove("hidden");
  $("#commandInput").value = "";
  renderCommands();
  $("#commandInput").focus();
}
function closeCommandPalette() { $("#commandModal").classList.add("hidden"); }
function runCommand(i) {
  const cmd = cmdMatches[i];
  if (!cmd) return;
  closeCommandPalette();
  setTimeout(() => cmd.run(), 60);
}

$("#commandInput")?.addEventListener("input", (e) => renderCommands(e.target.value));
document.addEventListener("keydown", (e) => {
  // ⌘K / Ctrl+K 打开命令面板
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("#commandModal").classList.contains("hidden") ? openCommandPalette() : closeCommandPalette();
    return;
  }
  // Alt+F 切换专注模式
  if (e.altKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    toggleFocusMode();
    return;
  }
  // B 唤起/收起浮动管家（输入框内不触发）
  if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "b") {
    const t = e.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    if (!typing && $("#commandModal")?.classList.contains("hidden")) {
      e.preventDefault();
      toggleButlerFloat();
      return;
    }
  }
  if (e.key === "Escape") {
    if (!$("#confirmModal").classList.contains("hidden")) resolveConfirm(false);
    else if (!$("#sopStartModal").classList.contains("hidden")) closeSopStart();
    else if (gcState.host === "session" && !$("#sessionGroupHost")?.classList.contains("hidden")) closeGroupChat();
    else if (!$("#groupChatModal").classList.contains("hidden")) closeGroupChat();
    else if (!$("#commandModal").classList.contains("hidden")) closeCommandPalette();
    else if (!$("#assignModal").classList.contains("hidden")) closeAssignModal();
    else if (!$("#employeeModal").classList.contains("hidden")) closeEmployeeModal();
    else if (!$("#departmentModal").classList.contains("hidden")) closeDepartmentModal();
    else if (!$("#modelModal").classList.contains("hidden")) closeAddModel();
    else if (!$("#setDefaultModal").classList.contains("hidden")) closeSetDefault();
    else if (!$("#employeeChatModal").classList.contains("hidden")) closeEmployeeChat();
    else if (!$("#retentionConfirmModal").classList.contains("hidden")) closeRetentionConfirm();
    else if ($("#butlerFloat") && !$("#butlerFloat").classList.contains("hidden")) closeButlerFloat();
    else if (document.body.classList.contains("focus-mode")) toggleFocusMode(false);
    return;
  }
  if (!$("#commandModal").classList.contains("hidden") && cmdMatches.length) {
    if (e.key === "ArrowDown") { e.preventDefault(); cmdIndex = (cmdIndex + 1) % cmdMatches.length; highlightCmd(); }
    if (e.key === "ArrowUp") { e.preventDefault(); cmdIndex = (cmdIndex - 1 + cmdMatches.length) % cmdMatches.length; highlightCmd(); }
    if (e.key === "Enter") { e.preventDefault(); runCommand(cmdIndex); }
  }
});
function highlightCmd() {
  $$(".command-item").forEach((el, i) => el.classList.toggle("selected", i === cmdIndex));
  $$(".command-item")[cmdIndex]?.scrollIntoView({ block: "nearest" });
}

// ---------- 时钟 / 问候 ----------
function tickClock() {
  const now = new Date();
  $("#clock").textContent = now.toLocaleTimeString("zh-CN", { hour12: false });
  const h = now.getHours();
  const g = h < 6 ? "夜深了" : h < 11 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  const el = $("#greeting");
  if (el && !el.textContent.startsWith(g)) el.textContent = `${g}，一切都就绪`;
}
setInterval(tickClock, 1000);
tickClock();

async function refreshAll() {
  try {
    await loadOverview();
    if ($("#view-org").classList.contains("active")) await loadOrgOverview();
    if ($("#view-employees").classList.contains("active")) await loadEmployees();
    if ($("#view-groups").classList.contains("active")) await loadGroups();
    if ($("#view-tasks").classList.contains("active")) await loadTasks();
    if ($("#view-collab").classList.contains("active")) await loadCollab();
    if ($("#view-autonomous").classList.contains("active")) await loadTriggers();
    if ($("#view-knowledge").classList.contains("active")) await loadKnowledge();
    toast("数据已刷新", "ok");
  } catch (e) { toast(e.message, "err"); }
}

// ---------- 管家与导入 ----------
let importItems = [];

// ===== 浮动管家：独立 SSE 通道，不占用会话中心的 chatFile / chatES =====
// 会话中心保持原样，管家独自持有 fixed 会话与连接；打开/关闭互不影响。
const bfState = {
  file: null, es: null, streaming: false,
  streamEl: null, streamText: "", toolRecords: [], runTools: null,
  model: null, usage: null, costCny: 0, costLabels: new Set(),
};

function bfBox() { return $("#butlerFloat"); }
function bfMessages() { return $("#butlerMessages"); }
function bfSetStatus(kind, text) {
  const el = $("#butlerFloatStatus");
  if (!el) return;
  el.textContent = text || "";
  el.className = kind || "";
}
function bfScroll() {
  const box = bfMessages();
  if (box) box.scrollTop = box.scrollHeight;
}
function bfBubble(role, text, meta = "", rich = false) {
  const wrap = document.createElement("div");
  wrap.className = `chat-msg ${role}`;
  const label = role === "user" ? "你" : "管家";
  const avatar = role === "user" ? "我" : "Pi";
  wrap.innerHTML = `<div class="chat-avatar ${role}">${esc(avatar)}</div>
    <div class="chat-msg-body"><div class="chat-msg-head"><b>${esc(label)}</b>${meta ? `<span class="chat-msg-meta">${esc(meta)}</span>` : ""}</div>
    <div class="chat-msg-text"></div></div>`;
  const el = wrap.querySelector(".chat-msg-text");
  if (rich) el.innerHTML = richMessage(text); else el.textContent = text;
  bfMessages().appendChild(wrap);
  bfScroll();
  return wrap;
}

/** 历史过程块折叠：与会话中心一致的多步骤合并规则 */
function bfProcessFold(blocks) {
  if (!blocks?.length) return;
  const details = document.createElement("details");
  details.className = "chat-process";
  const tools = blocks.filter((b) => b.kind === "tool");
  const thinkings = blocks.filter((b) => b.kind === "thinking");
  const results = blocks.filter((b) => b.kind === "toolResult");
  const steps = tools.length || results.length;
  const hasThink = thinkings.length > 0;
  let summary = "过程细节", summaryIcon = "chevron";
  if (steps > 1 || (steps > 0 && hasThink)) {
    summary = `${hasThink ? "深度思考 · " : ""}查看 ${steps} 个步骤`;
    summaryIcon = "eye";
  } else if (steps === 1) {
    summary = `已完成 ${(tools[0] || results[0]).name || "工具"}`;
    summaryIcon = "circle-check";
  } else if (hasThink) {
    summary = "深度思考";
    summaryIcon = "sparkle";
  }
  let body = "";
  if (thinkings.length) body += thinkings.map((b) => `<div class="cp-thinking">${esc(b.text || "")}</div>`).join("");
  if (tools.length) body += tools.map((b) => `<div class="cp-tool"><b>${esc(b.name || "工具")}</b>${b.detail ? ` <span>${esc(b.detail)}</span>` : ""}</div>`).join("");
  if (results.length) body += results.map((b) => `<div class="cp-result"><b>${esc(b.name || "工具")}</b><pre>${esc(b.text || "")}</pre></div>`).join("");
  details.innerHTML = `<summary><svg class="icon" style="width:13px;height:13px"><use href="#i-${summaryIcon}"/></svg>${esc(summary)}</summary><div class="chat-process-body">${body}</div>`;
  bfMessages().appendChild(details);
  bfScroll();
}

/** 实时工具步骤：一条折叠条就地更新，不逐条刷屏 */
function bfRenderRunTools() {
  if (!bfState.toolRecords.length) return;
  const done = bfState.toolRecords.filter((r) => r.phase === "done").length;
  const running = bfState.toolRecords.length - done;
  const summary = running > 0
    ? `查看 ${bfState.toolRecords.length} 个步骤 · ${running} 进行中`
    : `查看 ${bfState.toolRecords.length} 个步骤`;
  const body = bfState.toolRecords.map((r) => {
    const mark = r.isError ? "✕" : (r.phase === "running" ? "…" : "✓");
    return `<div class="cp-tool ${r.isError ? "err" : ""}"><span class="cp-mark">${mark}</span><b>${esc(r.name)}</b>${r.detail ? ` <span>${esc(r.detail)}</span>` : ""}</div>`;
  }).join("");
  if (!bfState.runTools || !bfState.runTools.isConnected) {
    bfState.runTools = document.createElement("details");
    bfState.runTools.className = "chat-process live";
    bfState.runTools.innerHTML = `<summary><svg class="icon" style="width:13px;height:13px"><use href="#i-eye"/></svg><span class="cp-summary"></span></summary><div class="chat-process-body"></div>`;
    bfMessages().appendChild(bfState.runTools);
  }
  bfState.runTools.querySelector(".cp-summary").textContent = summary;
  bfState.runTools.querySelector(".chat-process-body").innerHTML = body;
  bfScroll();
}

function bfSetModelDisplay(model) {
  if (!model) return;
  const provider = model.provider || "";
  const modelId = model.id || model.name || "";
  if (!provider || !modelId) return;
  bfState.model = { provider, modelId };
  const sel = $("#butlerModelSelect");
  if (sel) {
    const val = `${provider}|${modelId}`;
    if ([...sel.options].some((o) => o.value === val)) sel.value = val;
    else sel.title = `${provider}/${modelId}`;
  }
}
function bfSetRunning(running) {
  bfState.streaming = running;
  const send = $("#butlerSendBtn"), stop = $("#butlerStopBtn");
  if (send) send.style.display = running ? "none" : "";
  if (stop) stop.style.display = running ? "" : "none";
  const input = $("#butlerInput");
  if (input) input.disabled = false; // 允许 steer 排队
  bfSetStatus(running ? "busy" : "", running ? "生成中…" : "就绪");
}
function bfDisconnect() {
  if (bfState.es) { try { bfState.es.close(); } catch {} bfState.es = null; }
  bfState.streamEl = null;
  bfState.streamText = "";
  bfState.toolRecords = [];
  bfState.runTools = null;
}
function bfWelcome(withSuggestions = false) {
  const box = bfMessages();
  if (!box) return;
  box.innerHTML = `<div class="bf-welcome"><svg class="icon"><use href="#i-sparkle"/></svg>
    <h3>有什么想做的？</h3>
    <p>管家了解 Pi Admin 的结构与当前状态，可以直接问配置、资源，或让它代劳导入。</p>
    ${withSuggestions ? `<div class="bf-suggestions">
      <button type="button" onclick="bfUseSuggestion(this.dataset.text)" data-text="介绍一下你能做什么">介绍一下你能做什么</button>
      <button type="button" onclick="bfUseSuggestion(this.dataset.text)" data-text="帮我梳理这个项目的当前状态">帮我梳理当前状态</button>
      <button type="button" onclick="bfUseSuggestion(this.dataset.text)" data-text="给我三个下一步建议">给我三个下一步建议</button>
    </div>` : ""}</div>`;
}
function bfUseSuggestion(text) {
  const input = $("#butlerInput");
  if (!input) return;
  input.value = text;
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

/** 加载管家会话历史 + 建立独立 SSE 连接 */
async function bfConnect(file) {
  bfDisconnect();
  bfState.file = file;
  bfState.model = null;
  const box = bfMessages();
  box.innerHTML = `<div class="bf-welcome"><svg class="icon"><use href="#i-sparkle"/></svg><p>正在读取对话记录…</p></div>`;
  bfSetStatus("busy", "连接中");
  try {
    const d = await api(`/api/session?file=${encodeURIComponent(file)}`);
    box.innerHTML = "";
    const visible = (d.entries || []).filter((e) =>
      ["user", "assistant"].includes(e.role) && (e.text || e.blocks?.length));
    if (visible.length) {
      let pending = [];
      const flush = () => { if (pending.length) { bfProcessFold(pending); pending = []; } };
      for (const e of visible) {
        const meta = e.model ? `${e.provider}/${e.model}` : "";
        if (e.role === "user") { flush(); bfBubble("user", e.text); continue; }
        if (e.blocks?.length) pending.push(...e.blocks);
        if (e.text) { flush(); bfBubble("assistant", e.text, meta, true); }
      }
      flush();
    } else {
      bfWelcome(true);
    }
  } catch (e) {
    box.innerHTML = `<div class="bf-welcome"><svg class="icon"><use href="#i-circle-alert"/></svg><p>${esc(e.message)}</p></div>`;
  }

  try {
    const es = new EventSource(`/api/chat/stream?file=${encodeURIComponent(file)}`);
    bfState.es = es;
    es.addEventListener("hello", (ev) => {
      const d = JSON.parse(ev.data);
      if (d.model) bfSetModelDisplay(d.model);
      bfSetStatus("ok", "在线");
    });
    es.addEventListener("state", (ev) => {
      const d = JSON.parse(ev.data);
      if (d.model) bfSetModelDisplay(d.model);
      if (typeof d.isStreaming === "boolean") bfSetRunning(d.isStreaming);
    });
    es.addEventListener("user_echo", (ev) => {
      const d = JSON.parse(ev.data);
      box.querySelectorAll(".bf-welcome").forEach((el) => el.remove());
      bfBubble("user", d.text);
    });
    es.addEventListener("run_start", () => {
      bfState.streamText = ""; bfState.streamEl = null;
      bfState.toolRecords = []; bfState.runTools = null;
      bfState.usage = null; bfState.costCny = 0; bfState.costLabels = new Set();
      $("#butlerHint").textContent = "";
      bfSetRunning(true);
    });
    es.addEventListener("delta", (ev) => {
      const d = JSON.parse(ev.data);
      if (!d.text) return;
      bfState.streamText += d.text;
      if (!bfState.streamEl) bfState.streamEl = bfBubble("assistant", "");
      bfState.streamEl.querySelector(".chat-msg-text").textContent = bfState.streamText;
      bfScroll();
    });
    es.addEventListener("tool", (ev) => {
      const d = JSON.parse(ev.data);
      const name = d.name || "tool", phase = d.phase || "start";
      if (phase === "start") {
        bfState.toolRecords.push({ name, detail: chatToolDetail(d.args), phase: "running", isError: false });
      } else {
        for (let i = bfState.toolRecords.length - 1; i >= 0; i--) {
          if (bfState.toolRecords[i].name === name && bfState.toolRecords[i].phase === "running") {
            bfState.toolRecords[i].phase = "done";
            bfState.toolRecords[i].isError = !!d.isError;
            break;
          }
        }
      }
      bfRenderRunTools();
    });
    es.addEventListener("message_end", (ev) => {
      const d = JSON.parse(ev.data);
      if (d.text && bfState.streamEl) bfState.streamEl.querySelector(".chat-msg-text").innerHTML = richMessage(d.text);
      else if (!d.text && bfState.streamEl) bfState.streamEl.remove();
      if (d.usage) {
        bfState.usage = mergeUsages(bfState.usage, d.usage);
        bfState.costCny += Number(d.cost?.cny) || 0;
        if (d.cost?.label) bfState.costLabels.add(d.cost.label);
        const info = usageInfo(bfState.usage, d.fx, bfState.costCny, [...bfState.costLabels].join("、"));
        if (info) $("#butlerHint").textContent = `${info.long} · 本轮累计`;
      }
      bfState.streamEl = null; bfState.streamText = "";
    });
    es.addEventListener("run_end", () => {
      if (bfState.streamEl && !bfState.streamEl.querySelector(".chat-msg-text").textContent.trim()) bfState.streamEl.remove();
      bfState.streamEl = null; bfState.streamText = "";
      bfSetRunning(false);
    });
    es.addEventListener("stderr", (ev) => {
      const d = JSON.parse(ev.data);
      const text = String(d.text || "");
      if (/EPERM|operation not permitted/i.test(text) && /\.lock|rmdir|unlink/i.test(text)) {
        box.innerHTML = `<div class="bf-welcome"><svg class="icon"><use href="#i-circle-alert"/></svg>
          <h3>无法启动 Pi</h3><p>运行环境拦截了锁文件删除。请先重启管理端；若仍出现，再用普通终端启动后刷新本页。</p></div>`;
        bfSetStatus("err", "环境拦截");
        bfSetRunning(false);
      }
    });
    es.addEventListener("error", (ev) => {
      let msg = "出错了";
      try { msg = JSON.parse(ev.data).message || msg; } catch {}
      toast(msg, "err");
      bfSetRunning(false);
    });
    es.onerror = () => bfSetStatus("err", "连接断开");
  } catch (e) {
    toast(`管家连接失败：${e.message}`, "err");
    bfSetStatus("err", "连接失败");
  }

  await bfFillModels();
}

async function bfFillModels() {
  const sel = $("#butlerModelSelect");
  if (!sel) return;
  try {
    const data = await api("/api/models/configured");
    sel.innerHTML = (data.providers || []).map((p) =>
      `<optgroup label="${esc(p.label)}">${(p.models || []).map((m) =>
        `<option value="${esc(p.id)}|${esc(m.id)}" title="${esc(m.id)}">${esc(m.name || m.id)}</option>`).join("")}</optgroup>`).join("");
    if (bfState.model) {
      const val = `${bfState.model.provider}|${bfState.model.modelId}`;
      if ([...sel.options].some((o) => o.value === val)) sel.value = val;
    }
  } catch (e) {
    sel.innerHTML = `<option value="">模型加载失败</option>`;
  }
}

async function openButlerFloat() {
  const box = bfBox();
  if (!box) return;
  // 首次打开时按保存的位置恢复（隐藏态测不到尺寸，只能在这里做）
  if (box.style.left === "" && bfLoadPos(BF_WIN_POS_KEY)) bfRestoreWinPos();
  box.classList.remove("hidden");
  const fab = $("#butlerFab");
  if (fab) { fab.classList.add("active"); fab.setAttribute("aria-expanded", "true"); }
  if (!bfState.file || !bfState.es) {
    try {
      const b = await api("/api/butler/session");
      await bfConnect(b.file);
    } catch (e) { toast(e.message, "err"); }
  }
  setTimeout(() => $("#butlerInput")?.focus(), 120);
}
function closeButlerFloat() {
  const box = bfBox();
  if (!box) return;
  box.classList.add("hidden");
  const fab = $("#butlerFab");
  if (fab) { fab.classList.remove("active"); fab.setAttribute("aria-expanded", "false"); }
  bfDisconnect();
}
function toggleButlerFloat() {
  if (!bfBox()) return;
  bfBox().classList.contains("hidden") ? openButlerFloat() : closeButlerFloat();
}
async function butlerFloatSend() {
  const input = $("#butlerInput");
  if (!bfState.file) { toast("管家尚未就绪", "err"); return; }
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  $("#butlerHint").textContent = "";
  try {
    await api("/api/chat/send", {
      method: "POST",
      body: JSON.stringify({ unlocked: true, file: bfState.file, message, ...(bfState.streaming ? { streamingBehavior: "steer" } : {}) }),
    });
    bfSetRunning(true);
  } catch (e) {
    toast(e.message, "err");
    input.value = message;
  }
}
function butlerFloatKeydown(e) {
  if (mentionKeydown(e)) return;
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); butlerFloatSend(); }
}
async function butlerFloatStop() {
  if (!bfState.file) return;
  try {
    await api("/api/chat/abort", { method: "POST", body: JSON.stringify({ file: bfState.file }) });
    toast("已请求停止", "ok");
  } catch (e) { toast(e.message, "err"); }
}
async function butlerFloatChangeModel() {
  const sel = $("#butlerModelSelect");
  const v = sel.value;
  if (!v || !bfState.file) return;
  const [provider, modelId] = v.split("|");
  try {
    const r = await api("/api/chat/model", {
      method: "POST",
      body: JSON.stringify({ unlocked: true, file: bfState.file, provider, modelId }),
    });
    bfSetModelDisplay(r.model || { provider, id: modelId });
    toast(`管家已切换到 ${provider}/${modelId}`, "ok");
  } catch (e) { toast(e.message, "err"); await bfFillModels(); }
}
async function butlerFloatNewChat() {
  if (!(await appConfirm({
    title: "开启管家新对话", subtitle: "清空当前记录，重新开始",
    message: "开启一个新对话吗？",
    detail: "当前聊天记录会先备份，再从空白会话开始。",
    tone: "info", icon: "refresh", okText: "开启新对话", safe: "旧记录会先备份",
  }))) return;
  try {
    await api("/api/butler/reset", { method: "POST", body: JSON.stringify({ unlocked: true }) });
    bfState.file = null;
    bfDisconnect();
    await openButlerFloat();
    toast("已开启新对话", "ok");
  } catch (e) { toast(e.message, "err"); }
}

// ===== 浮动管家拖拽：Pointer Events（鼠标+触屏），位置持久化 =====
const BF_WIN_POS_KEY = "pi-admin-butler-pos";
const BF_FAB_POS_KEY = "pi-admin-butler-fab-pos";

function bfLoadPos(key) {
  try {
    const p = JSON.parse(localStorage.getItem(key) || "null");
    return p && Number.isFinite(p.left) && Number.isFinite(p.top) ? p : null;
  } catch { return null; }
}
function bfSavePos(key, el) {
  try {
    const r = el.getBoundingClientRect();
    localStorage.setItem(key, JSON.stringify({ left: r.left, top: r.top }));
  } catch {}
}
function bfClampToViewport(el) {
  if (!el || el.style.left === "" || el.style.top === "") return;
  const r = el.getBoundingClientRect();
  const m = 8;
  el.style.left = `${Math.max(m, Math.min(window.innerWidth - r.width - m, r.left))}px`;
  el.style.top = `${Math.max(m, Math.min(window.innerHeight - r.height - m, r.top))}px`;
}
function bfRestoreWinPos() {
  const box = bfBox();
  if (!box) return;
  const p = bfLoadPos(BF_WIN_POS_KEY);
  if (!p) return;
  // 隐藏状态下 offsetWidth 为 0，先显示再按视口校正
  box.classList.remove("hidden");
  box.style.left = `${p.left}px`;
  box.style.top = `${p.top}px`;
  box.style.right = "auto";
  box.style.bottom = "auto";
  bfClampToViewport(box);
  box.classList.add("hidden");
}

/** 通用拖拽绑定：handle 是拖拽把手，target 是被移动元素 */
function bfAttachDrag(handle, target, key, opts = {}) {
  if (!handle || !target) return () => false;
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, moved = false;
  const threshold = 4;
  handle.addEventListener("pointerdown", (e) => {
    // 排除把手/目标内部的可交互子元素（如窗口标题栏里的按钮）；
    // 但把手自身就是 button（浮动按钮）时允许拖动。
    const interactive = e.target.closest("button, a, input, select, textarea");
    if (interactive && interactive !== handle && interactive !== target) return;
    if (e.button !== undefined && e.button !== 0) return;
    const rect = target.getBoundingClientRect();
    target.style.left = `${rect.left}px`;
    target.style.top = `${rect.top}px`;
    target.style.right = "auto";
    target.style.bottom = "auto";
    sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
    dragging = true; moved = false;
    try { handle.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.abs(dx) + Math.abs(dy) > threshold) moved = true;
    if (!moved) return;
    document.body.classList.add("bf-dragging");
    target.classList.add("bf-dragging-target");
    const r = target.getBoundingClientRect();
    const m = 8;
    target.style.left = `${Math.max(m, Math.min(window.innerWidth - r.width - m, ox + dx))}px`;
    target.style.top = `${Math.max(m, Math.min(window.innerHeight - r.height - m, oy + dy))}px`;
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch {}
    document.body.classList.remove("bf-dragging");
    target.classList.remove("bf-dragging-target");
    if (moved) {
      bfSavePos(key, target);
      opts.onDragEnd?.();
    }
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  return () => moved;
}

function bfInitDrag() {
  const box = bfBox(), fab = $("#butlerFab"), head = $("#butlerFloatHead");
  if (!box || !fab || !head) return;

  // 浮动窗：拖标题栏；双击标题栏复位到右下角
  bfAttachDrag(head, box, BF_WIN_POS_KEY);
  head.addEventListener("dblclick", (e) => {
    if (e.target.closest("button")) return;
    try { localStorage.removeItem(BF_WIN_POS_KEY); } catch {}
    box.style.left = ""; box.style.top = ""; box.style.right = ""; box.style.bottom = "";
    toast("管家窗口已复位到右下角", "ok");
  });

  // 浮动按钮：自身可拖，拖动后抑制 click（避免误开窗口）
  let fabDragged = false;
  bfAttachDrag(fab, fab, BF_FAB_POS_KEY, {
    onDragEnd: () => { fabDragged = true; setTimeout(() => { fabDragged = false; }, 80); },
  });
  fab.addEventListener("click", () => {
    if (fabDragged) return;
    toggleButlerFloat();
  });

  // 启动时恢复按钮位置；窗口在首次打开时恢复（隐藏态无法测量尺寸）
  const fabPos = bfLoadPos(BF_FAB_POS_KEY);
  if (fabPos) {
    fab.style.left = `${fabPos.left}px`;
    fab.style.top = `${fabPos.top}px`;
    fab.style.right = "auto";
    fab.style.bottom = "auto";
    bfClampToViewport(fab);
  }
  // 视口变化时把已固定的元素拉回可视区
  window.addEventListener("resize", () => { bfClampToViewport(box); bfClampToViewport(fab); });
}

/** 兼容旧入口：侧边栏导航与命令面板仍调用 openButler */
async function openButler() { return openButlerFloat(); }

bfInitDrag();

function openImportModal() {
  $("#importModal").classList.remove("hidden");
}
function closeImportModal() {
  $("#importModal").classList.add("hidden");
}

async function scanImport() {
  const dir = $("#importDir").value.trim();
  if (!dir) { toast("请输入导出目录的绝对路径", "err"); return; }
  try {
    importItems = await api(`/api/import/scan?dir=${encodeURIComponent(dir)}`);
    renderImportPreview();
    toast(`识别到 ${importItems.length} 项`, "ok");
  } catch (e) { toast(e.message, "err"); }
}

function renderImportPreview() {
  const box = $("#importPreview");
  if (!importItems.length) {
    box.innerHTML = `<div class="import-placeholder">没有识别到技能或工作流。可把导出目录里的具体格式发给管家看。</div>`;
    return;
  }
  const kindLabel = { skill: "技能", workflow: "工作流", prompt: "提示词" };
  box.innerHTML = importItems.map((it, i) => `
    <div class="import-item ${it.exists ? "conflict" : ""}">
      <div class="import-item-main">
        <label><input type="checkbox" class="import-check" data-i="${i}" ${it.exists ? "" : "checked"}>
        <span class="import-kind">${esc(kindLabel[it.kind] || it.kind)}</span>
        <b>${esc(it.title)}</b></label>
        ${it.exists ? `<span class="import-conflict">已存在</span>` : ""}
      </div>
      <div class="import-source">${esc(it.name)}</div>
      <div class="import-target">→ ${esc(it.target)}</div>
    </div>`).join("");
}

async function applyImportItems() {
  if (!unlocked) { toast("请先点左下角「解锁编辑」", "err"); return; }
  const picked = $$(".import-check:checked").map((el) => importItems[Number(el.dataset.i)]);
  if (!picked.length) { toast("请先勾选要导入的条目", "err"); return; }
  try {
    const r = await api("/api/import/apply", {
      method: "POST",
      body: JSON.stringify({ unlocked: true, items: picked, overwrite: $("#importOverwrite").checked }),
    });
    closeImportModal();
    toast(`已导入 ${r.imported} 项${r.skipped ? `，跳过 ${r.skipped} 项` : ""}`, "ok");
    refreshAll();
  } catch (e) { toast(e.message, "err"); }
}

// ---------- 一键重启 ----------
let restartPolling = null;

async function openRestartModal() {
  try {
    const h = await api("/api/health");
    $("#restartPid").textContent = `PID ${h.pid}`;
    $("#restartStarted").textContent = new Date(h.startedAt).toLocaleString("zh-CN", { hour12: false });
  } catch {
    $("#restartPid").textContent = "—";
    $("#restartStarted").textContent = "—";
  }
  $("#restartModal").classList.remove("hidden");
}

function closeRestartModal() {
  $("#restartModal").classList.add("hidden");
}

function showRestartFailure(msg) {
  $("#restartStage").textContent = msg;
  $("#restartAttempt").textContent = "需要人工处理";
  const bar = $("#restartBar");
  bar.style.width = "100%";
  bar.style.background = "var(--red)";
  $("#restartRetry").classList.remove("hidden");
}

async function submitRestart() {
  closeRestartModal();
  if (restartPolling) return;

  const overlay = $("#restartOverlay");
  const stage = $("#restartStage");
  const bar = $("#restartBar");
  $("#restartRetry").classList.add("hidden");
  bar.style.background = "";
  bar.style.width = "8%";
  overlay.classList.remove("hidden");

  // 记录当前进程身份：必须等到 startedAt 变化，才算真正的新进程接管
  let oldStartedAt = null;
  try { oldStartedAt = (await api("/api/health")).startedAt; } catch {}

  stage.textContent = "正在通知服务重启…";
  try {
    await api("/api/restart", { method: "POST", body: JSON.stringify({}) });
    stage.textContent = "旧进程正在退出…";
    bar.style.width = "22%";
  } catch (e) {
    // 极端情况下服务可能先退出；还有旧身份就继续轮询
    if (!oldStartedAt) return showRestartFailure(e.message);
  }

  const started = Date.now();
  let attempts = 0;
  const tick = async () => {
    attempts++;
    const sec = Math.floor((Date.now() - started) / 1000);
    $("#restartElapsed").textContent = `${sec}s`;
    $("#restartAttempt").textContent = `第 ${attempts} 次探测`;
    bar.style.width = `${Math.min(22 + attempts * 2.4, 92)}%`;
    try {
      const h = await api("/api/health");
      if (!oldStartedAt || h.startedAt !== oldStartedAt) {
        bar.style.width = "100%";
        stage.textContent = `新服务已就绪（PID ${h.pid}）`;
        clearInterval(restartPolling);
        restartPolling = null;
        setTimeout(async () => {
          overlay.classList.add("hidden");
          toast("管理服务已重启", "ok");
          try {
            await refreshAll();
            // 重启会杀掉旧 Pi 子进程并重建 chatSessions。若正开着某条会话，
            // 必须重连（否则停留在「连接断开」+ 旧的 shim 锁错误面板）。
            if (chatFile) {
              const file = chatFile, name = chatSessionName;
              chatFile = null; chatES = null; // 强制 viewSession 走完整重连，而不是复用旧连接
              await viewSession(file, name);
            }
          } catch {}
        }, 600);
        return;
      }
      stage.textContent = "等待新进程接管端口…";
    } catch {
      stage.textContent = "等待服务重新上线…";
    }
    if (sec > 60) {
      clearInterval(restartPolling);
      restartPolling = null;
      showRestartFailure("等待超时，服务可能未能自动拉起。请手动运行「启动管理端.command」。");
    }
  };
  restartPolling = setInterval(tick, 800);
  setTimeout(tick, 400);
}

// ---------- 启动 ----------
// 支持 URL hash 直接进入某个 tab，例如 /#resources，方便分享与截图
async function bootFromHash() {
  let hash = location.hash.replace(/^#/, "");
  if (hash === "command") { openCommandPalette(); return; }
  if (hash.startsWith("addemployee")) {
    switchTab("employees");
    setTimeout(() => openEmployeeModal(), 150);
    return;
  }
  if (hash.startsWith("addmodel")) {
    const btn = $(`.nav-item[data-tab="models"]`);
    if (btn) btn.click();
    // #addmodel:deepseek 可直接打开某 Provider 的配置弹窗
    const providerId = hash.includes(":") ? hash.slice(hash.indexOf(":") + 1) : "";
    await openAddModel(providerId);
    return;
  }
  if (hash && TAB_TITLES[hash]) {
    const btn = $(`.nav-item[data-tab="${hash}"]`);
    if (btn) btn.click();
  }
}
initTheme();
// 会话「...」菜单：点外部或按 Esc 关闭
document.addEventListener("click", (e) => {
  if ($("#sessActionMenu") && !e.target.closest("#sessActionMenu, .sess-conv-more")) closeSessionMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeSessionMenu();
  if ($("#restartModal") && !$("#restartModal").classList.contains("hidden")) closeRestartModal();
});
// 搜索框绑定
$("#sessionSearch")?.addEventListener("input", renderSessions);
$("#employeeSearch")?.addEventListener("input", renderEmployees);
// Provider → 模型联动（P1 漏绑，选了 Provider 后模型下拉不会更新）
$("#em-provider")?.addEventListener("change", onOrgProviderChange);
$("#em-modelSelect")?.addEventListener("change", onOrgModelSelect);
// 选岗位模板时带出默认权限与提示词（新建时生效）
$("#em-role")?.addEventListener("change", () => {
  if (editingEmployeeId) return;
  const role = orgData?.roles?.find((r) => r.id === $("#em-role").value);
  if (!role) return;
  $("#em-department").value = role.department || "";
  $("#em-filesystem").value = role.permissions?.filesystem || "read-only";
  $("#em-commands").value = role.permissions?.commands || "deny";
  $("#em-network").value = role.permissions?.network || "deny";
  if (!$("#em-prompt").value.trim() || $("#em-prompt").value.startsWith("你是")) {
    $("#em-prompt").value = role.systemPrompt || "";
  }
  if ((role.skills || []).length && !$("#em-skills").value.trim()) $("#em-skills").value = role.skills.join(", ");
});
// 点弹窗外部关闭（命令面板的背景已单独处理）
// 等概览加载完（同步 unlocked 状态）再处理 hash，避免弹窗被只读拦截
loadOverview()
  .then(() => {
    bootFromHash();
    let focusOn = false;
    try { focusOn = localStorage.getItem("pi-admin-focus-mode") === "1"; } catch {}
    if (focusOn) toggleFocusMode(true);
    renderCommands();
    connectOrgEvents();
  })
  .catch((e) => toast(`连接失败：${e.message}`, "err"));
