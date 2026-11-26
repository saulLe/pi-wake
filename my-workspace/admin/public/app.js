// Pi Admin — 前端交互
let unlocked = false;
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
function fmtCost(c) { return c ? `$${c.toFixed(4)}` : "$0"; }

// ---------- 导航 ----------
const TAB_TITLES = { overview: "概览", resources: "资源管理", org: "组织概览", employees: "员工管理", settings: "设置编辑", sessions: "会话中心", models: "模型与认证" };
$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    $$(".nav-item[data-tab]").forEach((b) => b.classList.toggle("active", b === btn));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${tab}`));
    $("#pageTitle").textContent = TAB_TITLES[tab];
    if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
    if (tab === "resources") loadResources();
    if (tab === "org") loadOrgOverview();
    if (tab === "employees") loadEmployees();
    if (tab === "sessions") loadSessions();
    if (tab === "models") loadModels();
    if (tab === "settings" && !$("#settingsEditor").value) loadSettings();
  });
});

// ---------- 解锁 ----------
$("#unlockBtn").addEventListener("click", async () => {
  if (unlocked) {
    await api("/api/unlock", { method: "POST", body: JSON.stringify({ lock: true }) });
    unlocked = false;
    toast("已切回只读模式");
  } else {
    await api("/api/unlock", { method: "POST", body: JSON.stringify({ unlock: true }) });
    unlocked = true;
    toast("已解锁编辑，写操作将自动备份", "ok");
  }
  syncUnlockUI();
});
function syncUnlockUI() {
  const b = $("#unlockBtn");
  b.querySelector(".mode-icon").innerHTML = `<use href="#i-${unlocked ? "unlock" : "lock"}"/>`;
  $("#modeTitle").textContent = unlocked ? "编辑已解锁" : "只读模式";
  $("#modeSub").textContent = unlocked ? "写操作将备份" : "写操作已锁定";
  b.classList.toggle("unlocked", unlocked);
  $$(".switch").forEach((s) => (s.disabled = !unlocked));
  $("#saveSettingsBtn").disabled = !unlocked;
}

// ---------- 概览 ----------
let overviewData = null;
async function loadOverview() {
  const d = await api("/api/overview");
  overviewData = d;
  unlocked = d.unlocked;
  syncUnlockUI();

  $("#brandVersion").textContent = `v${d.version}`;
  const stats = [
    { label: "资源总数", value: fmtNum(d.stats.resources), sub: `${d.stats.enabledResources} 个已启用`, icon: "plug", color: "var(--accent)", soft: "var(--accent-soft)" },
    { label: "历史会话", value: fmtNum(d.stats.sessions), sub: "个 JSONL 会话", icon: "clock", color: "var(--purple)", soft: "var(--purple-soft)" },
    { label: "累计 Token", value: fmtNum(d.stats.totalTokens), sub: "跨所有会话", icon: "activity", color: "var(--cyan)", soft: "var(--cyan-soft)" },
    { label: "累计费用", value: fmtCost(d.stats.totalCost), sub: "估算成本", icon: "coins", color: "var(--amber)", soft: "var(--amber-soft)" },
  ];
  $("#statGrid").innerHTML = stats.map((s) => `
    <div class="stat-card">
      <div class="stat-top"><span class="stat-label">${s.label}</span><span class="stat-icon" style="background:${s.soft};color:${s.color}">${icon(s.icon)}</span></div>
      <div class="stat-value">${s.value}</div>
      <div class="stat-sub">${icon("arrow-right")}${s.sub}</div>
    </div>`).join("");

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
  $$(".filter-chip").forEach((c) => c.addEventListener("click", () => {
    currentResourceFilter = c.dataset.filter;
    $$(".filter-chip").forEach((x) => x.classList.toggle("active", x === c));
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

// ---------- 会话中心 ----------
let sessionsCache = [];
function renderSessions() {
  const q = ($("#sessionSearch")?.value || "").toLowerCase().trim();
  const list = sessionsCache.filter((s) => !q || `${s.name} ${s.cwd} ${s.id}`.toLowerCase().includes(q));
  $("#sessionCount").textContent = `${list.length} 个`;
  const tbody = $("#sessionTable tbody");
  if (!list.length) {
    tbody.innerHTML = emptyState("clock", sessionsCache.length ? "没有匹配的会话" : "还没有会话记录",
      sessionsCache.length ? `没有找到与「${esc(q)}」匹配的会话。` : "还没有会话。点右上角「新开会话」创建一条，或在 Pi 里开始对话后会话会自动保存在 <code>~/.pi/agent/sessions/</code>。",
      sessionsCache.length ? "" : `<button class="btn primary" onclick="openNewSession()">${icon("plus")}新开会话</button>`);
    return;
  }
  tbody.innerHTML = list.map((s) => `<tr>
    <td><b title="${esc(s.name)}">${esc(s.name.slice(0, 42))}${s.name.length > 42 ? "…" : ""}</b><br><span class="mono" style="font-size:10px;color:var(--text-3)">${esc(s.id.slice(0, 12))}</span></td>
    <td class="mono path-cell" title="${esc(s.cwd)}">${esc(s.cwd.split("/").slice(-2).join("/"))}</td>
    <td>${s.messages}</td>
    <td class="mono">${fmtNum(s.totalTokens)}</td>
    <td class="mono">${fmtCost(s.totalCost)}</td>
    <td class="mono" style="font-size:11px">${fmtTime(s.lastTs)}</td>
    <td><div class="row-actions">
      <button class="btn btn-sm" title="查看" onclick='viewSession(${JSON.stringify(s.file)})'>${icon("eye")}</button>
      <button class="btn btn-sm" title="导出" onclick='exportSession(${JSON.stringify(s.file)})'>${icon("download")}</button>
      <button class="btn btn-sm danger" title="删除" onclick='deleteSession(${JSON.stringify(s.file)},${JSON.stringify(s.id)})'>${icon("trash")}</button>
    </div></td>
  </tr>`).join("");
}

async function loadSessions() {
  sessionsCache = await api("/api/sessions");
  renderSessions();
}

function switchTab(tab) {
  const btn = $(`.nav-item[data-tab="${tab}"]`);
  if (btn) btn.click();
}

async function viewSession(file) {
  const d = await api(`/api/session?file=${encodeURIComponent(file)}`);
  $("#sessionDetailPanel").classList.remove("hidden");
  $("#sessionDetailTitle").textContent = `会话详情 — ${file.split("/").pop()}`;
  const tl = $("#sessionTimeline");
  if (!d.entries.length) { tl.innerHTML = `<div class="empty">该会话没有可显示的消息</div>`; return; }
  tl.innerHTML = d.entries.map((e) => {
    let body = e.text;
    if (e.role === "assistant" && !body) body = "(空回复)";
    const meta = e.model ? `${esc(e.provider)}/${esc(e.model)}` : "";
    return `<div class="tl-item ${esc(e.role)}">
      <div class="tl-head">
        <span class="tl-role ${esc(e.role)}">${esc(e.role)}</span>
        <span class="tl-meta">${meta} · ${fmtTime(e.ts)}</span>
      </div>
      <div class="tl-text">${esc(body)}</div>
    </div>`;
  }).join("");
  $("#sessionDetailPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeSessionDetail() { $("#sessionDetailPanel").classList.add("hidden"); }

// ---------- 新开会话 ----------
let lastCreatedSession = null;
function openNewSession() {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  $("#ns-cwd").value = overviewData?.workspace || "";
  $("#ns-name").value = "";
  $("#ns-first").value = "";
  $("#ns-notice").style.display = "none";
  $("#ns-notice").innerHTML = "";
  $("#ns-submit").classList.remove("hidden");
  lastCreatedSession = null;
  $("#sessionModal").classList.remove("hidden");
  $("#ns-name").focus();
}

function closeNewSession() { $("#sessionModal").classList.add("hidden"); }

async function copySessionCommand() {
  if (!lastCreatedSession) return;
  try {
    await navigator.clipboard.writeText(lastCreatedSession.command);
    toast("启动命令已复制", "ok");
  } catch (e) {
    toast("复制失败，请手动选中命令", "err");
  }
}

async function submitNewSession() {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  const cwd = $("#ns-cwd").value.trim();
  if (!cwd) { toast("请填写工作目录", "err"); return; }
  try {
    const r = await api("/api/session/create", {
      method: "POST",
      body: JSON.stringify({ unlocked: true, cwd, name: $("#ns-name").value, firstMessage: $("#ns-first").value }),
    });
    lastCreatedSession = r;
    $("#ns-submit").classList.add("hidden");
    const notice = $("#ns-notice");
    notice.style.display = "block";
    notice.innerHTML = `
      <div class="created-session">
        <div class="created-session-title"><svg class="icon"><use href="#i-terminal"/></svg> 会话已创建</div>
        <div class="created-session-cmd"><code>${esc(r.command)}</code><button class="btn btn-sm" onclick="copySessionCommand()"><svg class="icon"><use href="#i-copy"/></svg>复制</button></div>
        <p class="created-session-hint">在终端进入任意目录后粘贴执行，即可继续这条会话。会话已出现在下方列表。</p>
      </div>`;
    await loadSessions();
    toast("会话已创建", "ok");
  } catch (e) { toast(e.message, "err"); }
}

function exportSession(file) {
  window.location.href = `/api/session/export?file=${encodeURIComponent(file)}`;
  toast("已开始下载", "ok");
}

async function deleteSession(file, id) {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  if (!confirm(`确定删除会话 ${id.slice(0, 12)}... 吗？\n原文件会先备份到 .backups/。`)) return;
  try {
    await api("/api/session", { method: "DELETE", body: JSON.stringify({ unlocked: true, file }) });
    toast("已删除（原文件已备份）", "ok");
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
  $("#modelDefaults").innerHTML = defs.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("");

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
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  if (!confirm(`从 ${providerId} 删除模型 ${modelId}？\n原文件会先备份。`)) return;
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
  $$("#orgChart [data-emp]").forEach((g) => g.addEventListener("click", () => openEmployeeModal(g.dataset.emp)));
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
    const actions = `
      ${e.status === "archived" ? "" : `<button class="btn btn-sm" title="对话" onclick='openEmployeeChat(${JSON.stringify(e.id)})'>${icon("terminal")}</button>`}
      <button class="btn btn-sm" title="编辑" onclick='openEmployeeModal(${JSON.stringify(e.id)})'>${icon("eye")}</button>
      <button class="btn btn-sm" title="克隆" onclick='cloneEmployee(${JSON.stringify(e.id)})'>${icon("copy")}</button>
      <button class="btn btn-sm" title="${e.status === "archived" ? "恢复" : "启停"}" onclick='toggleEmployee(${JSON.stringify(e.id)})'>${icon("power")}</button>
      ${e.status === "archived" ? "" : `<button class="btn btn-sm danger" title="归档" onclick='archiveEmployee(${JSON.stringify(e.id)})'>${icon("trash")}</button>`}`;
    return `<tr>
      <td><b>${esc(e.name)}</b><br><span class="mono" style="font-size:10px;color:var(--text-3)">${esc(e.id)}</span></td>
      <td>${esc(roleLabel(e.role))}</td>
      <td>${esc(deptLabel(e.department))}</td>
      <td>${esc(empLabel(e.reportsTo))}</td>
      <td class="mono" style="font-size:11px">${model}</td>
      <td>${skills}</td>
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
  if (!confirm(`归档员工「${e?.name || id}」？\n只改状态，配置文件会保留并先备份，不会删除。`)) return;
  try {
    await api(`/api/org/employees/${encodeURIComponent(id)}/archive`, {
      method: "POST", body: JSON.stringify({ unlocked: true }),
    });
    toast("已归档（文件保留）", "ok");
    await Promise.all([loadOrgOverview(), loadEmployees()]);
  } catch (err) { toast(err.message, "err"); }
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
}

function closeDepartmentModal() { $("#departmentModal").classList.add("hidden"); }

async function submitDepartment() {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  const id = $("#dm-id").value.trim();
  const name = $("#dm-name").value.trim();
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(id) || !name) { toast("部门 ID 和名称都要填写，ID 只能用字母数字下划线短横线", "err"); return; }
  const departments = JSON.parse(JSON.stringify(orgData.departments));
  const idx = departments.findIndex((d) => d.id === id);
  const item = { id, name, description: $("#dm-desc").value.trim() };
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
  if (!confirm(`确定删除部门「${d.name}」吗？\n部门列表会先自动备份，员工配置不受影响。`)) return;
  const departments = orgData.departments.filter((x) => x.id !== id);
  try {
    await api("/api/org/departments", { method: "POST", body: JSON.stringify({ unlocked: true, departments }) });
    toast("部门已删除（列表已备份）", "ok");
    await Promise.all([loadOrgOverview(), loadEmployees()]);
  } catch (e) { toast(e.message, "err"); }
}

// ---------- 命令面板 ----------
const COMMANDS = [
  { group: "导航", label: "概览", hint: "系统状态与环境", icon: "grid", run: () => switchTab("overview") },
  { group: "导航", label: "资源管理", hint: "启停扩展 / 技能", icon: "plug", run: () => switchTab("resources") },
  { group: "导航", label: "组织概览", hint: "查看组织架构图", icon: "network", run: () => switchTab("org") },
  { group: "导航", label: "员工管理", hint: "创建与管理数字员工", icon: "users", run: () => switchTab("employees") },
  { group: "导航", label: "会话中心", hint: "浏览历史会话", icon: "clock", run: () => switchTab("sessions") },
  { group: "导航", label: "设置编辑", hint: "编辑配置 JSON", icon: "sliders", run: () => switchTab("settings") },
  { group: "导航", label: "模型与认证", hint: "管理模型端点", icon: "cpu", run: () => switchTab("models") },
  { group: "操作", label: "新增模型", hint: "配置一个新的模型端点", icon: "plus", run: () => { switchTab("models"); setTimeout(openAddModel, 120); } },
  { group: "操作", label: "新增员工", hint: "创建一个数字员工", icon: "plus", run: () => { switchTab("employees"); setTimeout(() => openEmployeeModal(), 120); } },
  { group: "操作", label: "刷新数据", hint: "重新加载概览", icon: "refresh", run: () => refreshAll() },
  { group: "操作", label: unlocked ? "切回只读模式" : "解锁编辑", hint: "切换写操作权限", icon: unlocked ? "lock" : "unlock", run: () => $("#unlockBtn").click() },
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
  if ($("#unlockBtn")) { /* COMMANDS 里的解锁文案可能需要刷新 */ }
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
  if (e.key === "Escape") {
    if (!$("#commandModal").classList.contains("hidden")) closeCommandPalette();
    else if (!$("#employeeModal").classList.contains("hidden")) closeEmployeeModal();
    else if (!$("#departmentModal").classList.contains("hidden")) closeDepartmentModal();
    else if (!$("#modelModal").classList.contains("hidden")) closeAddModel();
    else if (!$("#sessionModal").classList.contains("hidden")) closeNewSession();
    else if (!$("#employeeChatModal").classList.contains("hidden")) closeEmployeeChat();
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
    toast("数据已刷新", "ok");
  } catch (e) { toast(e.message, "err"); }
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
  .then(() => { bootFromHash(); renderCommands(); })
  .catch((e) => toast(`连接失败：${e.message}`, "err"));
