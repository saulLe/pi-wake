// Pi Admin — 前端交互
let unlocked = false;
let currentResourceFilter = "all";
let resourcesCache = [];
let builtinProviders = [];

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- 主题 ----------
const THEME_KEY = "pi-admin-theme";
const THEME_ICONS = { dark: "🌙", light: "☀️", auto: "◐" };

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const sel = $("#themeSelect");
  if (sel) sel.value = theme;
  const icon = $("#themeIcon");
  if (icon) icon.textContent = THEME_ICONS[theme] || "◐";
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
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, type = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = "toast"), 3000);
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
const TAB_TITLES = { overview: "概览", resources: "资源管理", settings: "设置编辑", sessions: "会话中心", models: "模型与认证" };
$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    $$(".nav-item").forEach((b) => b.classList.toggle("active", b === btn));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${tab}`));
    $("#pageTitle").textContent = TAB_TITLES[tab];
    if (tab === "resources") loadResources();
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
  b.textContent = unlocked ? "🔓 编辑已解锁" : "🔒 只读模式";
  b.classList.toggle("unlocked", unlocked);
  $$(".switch").forEach((s) => (s.disabled = !unlocked));
  $("#saveSettingsBtn").disabled = !unlocked;
}

// ---------- 概览 ----------
async function loadOverview() {
  const d = await api("/api/overview");
  unlocked = d.unlocked;
  syncUnlockUI();

  const stats = [
    { label: "资源总数", value: fmtNum(d.stats.resources), sub: `${d.stats.enabledResources} 个已启用`, icon: "▦", color: "var(--accent)" },
    { label: "历史会话", value: fmtNum(d.stats.sessions), sub: "个 JSONL 会话", icon: "☰", color: "var(--purple)" },
    { label: "累计 Token", value: fmtNum(d.stats.totalTokens), sub: "跨所有会话", icon: "◈", color: "var(--cyan)" },
    { label: "累计费用", value: fmtCost(d.stats.totalCost), sub: "估算成本", icon: "◇", color: "var(--amber)" },
  ];
  $("#statGrid").innerHTML = stats.map((s) => `
    <div class="stat-card">
      <div class="stat-label"><span class="stat-icon" style="background:${s.color}22;color:${s.color}">${s.icon}</span>${s.label}</div>
      <div class="stat-value">${s.value}</div>
      <div class="stat-sub">${s.sub}</div>
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
    renderResources();
  }));
  renderResources();
}

function renderResources() {
  const list = resourcesCache.filter((r) => currentResourceFilter === "all" || r.type === currentResourceFilter);
  $("#resourceCount").textContent = `${list.length} 项`;
  const tbody = $("#resourceTable tbody");
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">该类型下暂无资源<br>在 <code>.pi/${currentResourceFilter}/</code> 或 <code>~/.pi/agent/${currentResourceFilter}/</code> 下放置文件后刷新</td></tr>`;
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
async function loadSessions() {
  const list = await api("/api/sessions");
  $("#sessionCount").textContent = `${list.length} 个`;
  const tbody = $("#sessionTable tbody");
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">暂无会话。在 Pi 里对话后，会话会保存在 <code>~/.pi/agent/sessions/</code></td></tr>`;
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
      <button class="btn" onclick='viewSession(${JSON.stringify(s.file)})'>查看</button>
      <button class="btn" onclick='exportSession(${JSON.stringify(s.file)})'>导出</button>
      <button class="btn danger" onclick='deleteSession(${JSON.stringify(s.file)},${JSON.stringify(s.id)})'>删除</button>
    </div></td>
  </tr>`).join("");
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
  </tr>`).join("") : `<tr><td colspan="5" class="empty">暂无已保存凭证<br>在 Pi 里执行 <code>/login</code> 添加</td></tr>`;

  const provBody = $("#providerTable tbody");
  provBody.innerHTML = d.configuredProviders.length ? d.configuredProviders.map((p) => {
    const modelCells = p.models.length
      ? p.models.map((m) => `<div style="display:flex;align-items:center;gap:6px;margin:2px 0">
          <span class="mono">${esc(m)}</span>
          <button class="btn danger" style="padding:1px 7px;font-size:11px" title="删除该模型"
            onclick='removeModel(${JSON.stringify(p.id)},${JSON.stringify(m)})'>✕</button>
        </div>`).join("")
      : "—";
    return `<tr>
      <td><b>${esc(p.id)}</b></td>
      <td class="mono">${esc(p.baseUrl || "—")}</td>
      <td class="mono">${esc(p.api || "—")}</td>
      <td class="mono">${esc(p.apiKey || "—")}</td>
      <td>${modelCells}</td>
      <td><button class="btn" onclick='addModelTo(${JSON.stringify(p.id)},${JSON.stringify(p.baseUrl)},${JSON.stringify(p.api)})'>+ 加模型</button></td>
    </tr>`;
  }).join("") : `<tr><td colspan="6" class="empty">暂无自定义端点<br>点右上角「＋ 新增模型」添加，或在 <code>models.json</code> 里配置</td></tr>`;
}

// ---------- 新增模型弹窗 ----------
let providerCatalog = [];
let modelManualMode = false;

async function ensureBuiltinProviders() {
  if (!builtinProviders.length) {
    try { builtinProviders = await api("/api/models/builtin-providers"); } catch {}
  }
}

async function ensureProviderCatalog() {
  if (!providerCatalog.length) {
    try { providerCatalog = await api("/api/models/provider-catalog"); } catch {}
  }
}

function getProviderById(id) { return providerCatalog.find((p) => p.id === id); }

function populateProviderSelect() {
  const sel = $("#mf-providerSelect");
  if (!sel) return;
  const groups = { cn: [], global: [] };
  for (const p of providerCatalog) groups[p.region === "cn" ? "cn" : "global"].push(p);
  const opts = (list) => list.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}（${esc(p.id)}）</option>`).join("");
  sel.innerHTML =
    '<option value="">— 请选择 Provider —</option>' +
    `<optgroup label="🇨🇳 国内 Provider">${opts(groups.cn)}</optgroup>` +
    `<optgroup label="🌍 国外 / 国际 Provider">${opts(groups.global)}</optgroup>` +
    '<option value="__custom__">✏️ 自定义 Provider（手动输入 ID）</option>';
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
  const btn = $(".inline-link");
  if (btn) btn.textContent = on ? "↩️ 改回下拉选择" : "✏️ 手动输入模型 ID";
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
  if (!payload.providerId || !payload.modelId || !payload.baseUrl) {
    toast("Provider ID、模型 ID、Base URL 为必填", "err"); return;
  }
  try {
    const r = await api("/api/models/add", { method: "POST", body: JSON.stringify(payload) });
    closeAddModel();
    toast(r.isBuiltin ? "已保存（内置 Provider，走 modelOverrides）" : "模型已保存，Pi 里打开 /model 自动加载", "ok");
    loadModels();
  } catch (e) { toast(e.message, "err"); }
}

async function removeModel(providerId, modelId) {
  if (!unlocked) { toast("请先在左下角解锁编辑", "err"); return; }
  if (!confirm(`从 ${providerId} 删除模型 ${modelId}？\n原文件会先备份。`)) return;
  try {
    await api("/api/models/remove", { method: "POST", body: JSON.stringify({ unlocked: true, providerId, modelId }) });
    toast("已删除模型（原文件已备份）", "ok");
    loadModels();
  } catch (e) { toast(e.message, "err"); }
}

// ---------- 时钟 ----------
function tickClock() { $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false }); }
setInterval(tickClock, 1000);
tickClock();

async function refreshAll() {
  try { await loadOverview(); toast("数据已刷新", "ok"); }
  catch (e) { toast(e.message, "err"); }
}

// ---------- 启动 ----------
// 支持 URL hash 直接进入某个 tab，例如 /#resources，方便分享与截图
async function bootFromHash() {
  let hash = location.hash.replace(/^#/, "");
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
// 等概览加载完（同步 unlocked 状态）再处理 hash，避免弹窗被只读拦截
loadOverview()
  .then(bootFromHash)
  .catch((e) => toast(`连接失败：${e.message}`, "err"));
