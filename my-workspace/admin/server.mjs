#!/usr/bin/env node
/**
 * Pi Admin — 本地 Web 管理界面后端
 *
 * 纯 Node 原生 http，零新增依赖，只绑定 127.0.0.1。
 * 四个模块：资源管理 / 设置编辑 / 会话中心 / 模型与认证。
 *
 * 安全约定：
 *  - 默认只读；所有写操作需界面上点「解锁编辑」(会话内存态) 才会放行。
 *  - 所有路径经白名单校验，禁止目录穿越。
 *  - auth.json 永不明文返回，密钥一律脱敏。
 *  - 每次写文件前自动备份到 admin/.backups/<时间戳>/。
 *
 * 用法：node server.mjs [--port 8787] [--workspace <path>] [--agent-dir <path>]
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync, renameSync, rmSync, realpathSync } from "node:fs";
import { join, resolve, relative, dirname, basename, extname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const BACKUP_ROOT = join(__dirname, ".backups");

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const out = { port: 8787, workspace: null, agentDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && argv[i + 1]) out.port = Number(argv[++i]);
    else if (a === "--workspace" && argv[i + 1]) out.workspace = resolve(argv[++i]);
    else if (a === "--agent-dir" && argv[i + 1]) out.agentDir = resolve(argv[++i]);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

// workspace 默认取 admin 的上两级（my-workspace），agentDir 默认 ~/.pi/agent
const WORKSPACE = args.workspace ?? resolve(__dirname, "..");
const AGENT_DIR = args.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PROJECT_PI = join(WORKSPACE, ".pi");
const SESSION_DIR = join(AGENT_DIR, "sessions");
const PORT = Number.isFinite(args.port) ? args.port : 8787;

// ---------- 数字员工：组织数据（P1） ----------
const ORG_DIR = join(WORKSPACE, "org");
const ORG_EMPLOYEES_DIR = join(ORG_DIR, "employees");
const ORG_DEPARTMENTS_FILE = join(ORG_DIR, "departments.json");
const ORG_ROLES_FILE = join(ORG_DIR, "roles.json");

const DEFAULT_DEPARTMENTS = [
  { id: "leadership", name: "管理部", description: "目标拆解与汇总汇报" },
  { id: "product", name: "产品部", description: "需求澄清与规格定义" },
  { id: "engineering", name: "研发部", description: "方案设计与代码交付" },
  { id: "quality", name: "质量部", description: "测试验证与评审" },
];

const BUILTIN_ROLES = [
  { id: "lead", label: "主管", department: "leadership", skills: [], systemPrompt: "你是团队主管，负责拆解目标、分派任务、汇总汇报。", permissions: { filesystem: "read-only", commands: "deny", network: "deny" } },
  { id: "product", label: "产品经理", department: "product", skills: [], systemPrompt: "你是产品经理，负责澄清需求、编写规格与验收清单。", permissions: { filesystem: "read-only", commands: "deny", network: "deny" } },
  { id: "architect", label: "架构师", department: "engineering", skills: [], systemPrompt: "你是架构师，负责技术方案、接口边界与评审意见。", permissions: { filesystem: "read-only", commands: "deny", network: "deny" } },
  { id: "developer", label: "开发工程师", department: "engineering", skills: [], systemPrompt: "你是开发工程师，按任务卡交付代码，不确定就提问。", permissions: { filesystem: "workspace-write", commands: "allowlist", network: "deny" } },
  { id: "tester", label: "测试工程师", department: "quality", skills: [], systemPrompt: "你是测试工程师，负责用例设计、回归验证与缺陷报告。", permissions: { filesystem: "read-only", commands: "allowlist", network: "deny" } },
  { id: "ops", label: "运维工程师", department: "engineering", skills: [], systemPrompt: "你是运维工程师，负责环境、部署与巡检。", permissions: { filesystem: "workspace-write", commands: "allowlist", network: "review" } },
  { id: "analyst", label: "数据分析师", department: "product", skills: ["velocity-sql"], systemPrompt: "你是数据分析师，负责查数、指标分析与可视化结论。", permissions: { filesystem: "read-only", commands: "deny", network: "deny" } },
  { id: "coordinator", label: "协调员", department: "leadership", skills: [], systemPrompt: "你是协调员，负责会议纪要、进度追踪与待办提醒。", permissions: { filesystem: "none", commands: "deny", network: "deny" } },
];

// ---------- 工具函数 ----------
const now = () => new Date().toISOString();
let EDIT_UNLOCKED = false; // 会话内存态：界面点「解锁编辑」后置 true

function readJsonSafe(path, fallback) {
  try {
    const txt = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    return txt.trim() ? JSON.parse(txt) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** 写前备份，返回备份路径 */
function backupFile(path) {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(BACKUP_ROOT, stamp);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, basename(path));
  copyFileSync(path, dest);
  return dest;
}

/** 路径白名单校验：只允许 agentDir 与 workspace 内的路径 */
function safePath(p) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(WORKSPACE, p);
  const inAgent = abs === AGENT_DIR || abs.startsWith(AGENT_DIR + "/");
  const inWorkspace = abs === WORKSPACE || abs.startsWith(WORKSPACE + "/");
  return inAgent || inWorkspace;
}

/** 脱敏：保留首尾少量字符 */
function maskSecret(v) {
  if (v === undefined || v === null || v === "") return "";
  const s = String(v);
  if (s.length <= 8) return "*".repeat(s.length);
  return `${s.slice(0, 4)}${"*".repeat(Math.min(12, s.length - 8))}${s.slice(-4)}`;
}

/** 把任意文本安全包成 shell 单引号参数 */
function shellQuote(v) {
  return "'" + String(v ?? "").replace(/'/g, "'\\''") + "'";
}

/** 递归列文件 */
function listFiles(dir, exts, depth = 0) {
  const out = [];
  if (!existsSync(dir) || depth > 4) return out;
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) out.push(...listFiles(p, exts, depth + 1));
      else if (!exts.length || exts.includes(extname(p).toLowerCase())) out.push(p);
    }
  } catch {}
  return out;
}

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function requireUnlock(body) {
  if (!EDIT_UNLOCKED || !body?.unlocked) {
    throw Object.assign(new Error("写操作被锁定：请先在界面点击「解锁编辑」"), { status: 403 });
  }
}

// ---------- 数据聚合 ----------
// Pi 内置 provider ID（来自 packages/ai/src/providers/*.ts）
const BUILTIN_PROVIDERS = [
  "amazon-bedrock", "ant-ling", "anthropic", "azure", "baseten", "cerebras",
  "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks",
  "github-copilot", "google", "google-vertex", "groq", "huggingface",
  "kimi-coding", "meta", "minimax", "minimax-cn", "mistral", "moonshotai",
  "moonshotai-cn", "nvidia", "openai", "openai-codex", "opencode", "opencode-go",
  "openrouter", "qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual",
  "qwen-token-plan-individual-cn", "together", "vercel-ai-gateway", "xai", "xiaomi",
  "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp",
  "zai", "zai-coding-cn",
];
// 内置 Provider 的中文显示名与国别分组（用于新增模型弹窗的分类下拉）
const PROVIDER_LABELS = {
  "deepseek": { label: "DeepSeek（深度求索）", region: "cn" },
  "kimi-coding": { label: "Kimi 编程（月之暗面）", region: "cn" },
  "moonshotai": { label: "Moonshot AI / Kimi", region: "cn" },
  "moonshotai-cn": { label: "Moonshot AI 中国", region: "cn" },
  "qwen-token-plan": { label: "通义千问（团队版）", region: "cn" },
  "qwen-token-plan-cn": { label: "通义千问 中国（团队版）", region: "cn" },
  "qwen-token-plan-individual": { label: "通义千问（个人版）", region: "cn" },
  "qwen-token-plan-individual-cn": { label: "通义千问 中国（个人版）", region: "cn" },
  "minimax": { label: "MiniMax（稀宇科技）", region: "cn" },
  "minimax-cn": { label: "MiniMax 中国", region: "cn" },
  "zai": { label: "智谱 GLM / Z.AI", region: "cn" },
  "zai-coding-cn": { label: "智谱 GLM 编程（中国）", region: "cn" },
  "ant-ling": { label: "蚂蚁灵犀", region: "cn" },
  "xiaomi": { label: "小米 MiLM", region: "cn" },
  "xiaomi-token-plan-ams": { label: "小米 Token Plan（国际）", region: "cn" },
  "xiaomi-token-plan-cn": { label: "小米 Token Plan（中国）", region: "cn" },
  "xiaomi-token-plan-sgp": { label: "小米 Token Plan（新加坡）", region: "cn" },
  "openai": { label: "OpenAI", region: "global" },
  "anthropic": { label: "Anthropic（Claude）", region: "global" },
  "google": { label: "Google（Gemini）", region: "global" },
  "xai": { label: "xAI（Grok）", region: "global" },
  "openrouter": { label: "OpenRouter（模型聚合）", region: "global" },
  "groq": { label: "Groq", region: "global" },
  "mistral": { label: "Mistral AI", region: "global" },
  "amazon-bedrock": { label: "AWS Bedrock", region: "global" },
  "azure": { label: "Azure OpenAI", region: "global" },
  "google-vertex": { label: "Google Vertex AI", region: "global" },
  "github-copilot": { label: "GitHub Copilot", region: "global" },
};
const PROVIDER_DATA_DIR = resolve(__dirname, "../../packages/ai/src/providers/data");

// 从 Pi 内置目录 + 用户 models.json 生成 provider → 模型列表，供新增模型与新建员工弹窗联动
const USER_MODEL_INDEX_FILE = join(WORKSPACE, "model-catalog.json");

function normalizeUserModel(id, raw = {}) {
  if (typeof raw === "string") return { id, name: raw, userDefined: true };
  const m = raw && typeof raw === "object" ? raw : {};
  return {
    id,
    name: m.name || id,
    api: m.api || "",
    baseUrl: m.baseUrl || "",
    contextWindow: m.contextWindow || null,
    maxTokens: m.maxTokens || null,
    reasoning: !!m.reasoning,
    input: Array.isArray(m.input) ? m.input.join(",") : "text",
    userDefined: true,
  };
}

/** 按模型 ID 合并，用户定义覆盖内置定义 */
function mergeCatalogModels(target, models) {
  const map = new Map();
  for (const m of [...(target.models || []), ...models]) if (m?.id) map.set(m.id, m);
  target.models = [...map.values()];
}

function loadProviderCatalog() {
  const out = [];
  for (const id of BUILTIN_PROVIDERS) {
    const file = join(PROVIDER_DATA_DIR, `${id}.json`);
    if (!existsSync(file)) continue;
    const groups = readJsonSafe(file, {});
    const models = [];
    for (const [api, group] of Object.entries(groups)) {
      for (const [key, m] of Object.entries(group || {})) {
        if (!key.startsWith("chat:") || !m || !m.id) continue;
        models.push({
          id: m.id,
          name: m.name || m.id,
          api: m.api || api,
          baseUrl: m.baseUrl || "",
          contextWindow: m.contextWindow || null,
          maxTokens: m.maxTokens || null,
          reasoning: !!m.reasoning,
          input: Array.isArray(m.input) ? m.input.join(",") : "text",
        });
      }
    }
    if (!models.length) continue;
    const meta = PROVIDER_LABELS[id] || { label: id, region: "global" };
    out.push({
      id,
      label: meta.label,
      region: meta.region,
      baseUrl: models[0].baseUrl || "",
      apis: [...new Set(models.map((m) => m.api))],
      models,
    });
  }

  const userCfg = readJsonSafe(join(AGENT_DIR, "models.json"), {});
  const indexed = new Set();

  // 自定义 Provider 的模型直接作为独立 Provider 条目
  for (const [id, p] of Object.entries(userCfg.providers ?? {})) {
    if (!p || !Array.isArray(p.models) || !p.models.length) continue;
    const models = p.models
      .map((m) => normalizeUserModel(typeof m === "string" ? m : m?.id, m))
      .filter((m) => m.id);
    if (!models.length) continue;
    models.forEach((m) => indexed.add(m.id));
    if (BUILTIN_PROVIDERS.includes(id)) {
      const target = out.find((x) => x.id === id);
      if (target) mergeCatalogModels(target, models);
      else {
        const meta = PROVIDER_LABELS[id] || { label: id, region: "global" };
        out.push({ id, label: meta.label, region: meta.region, baseUrl: p.baseUrl || "", apis: p.api ? [p.api] : [], models });
      }
    } else {
      out.push({
        id,
        label: p.name || id,
        region: "custom",
        baseUrl: p.baseUrl || "",
        apis: p.api ? [p.api] : [],
        models,
      });
    }
  }

  // 管理端新增模型时写入的索引：精确记录所属 Provider
  const index = readJsonSafe(USER_MODEL_INDEX_FILE, { version: 1, entries: [] });
  for (const entry of index.entries ?? []) {
    if (!entry?.modelId) continue;
    indexed.add(entry.modelId);
    const meta = PROVIDER_LABELS[entry.providerId] || { label: entry.providerId, region: "custom" };
    const pc = userCfg.providers?.[entry.providerId] || {};
    let target = out.find((x) => x.id === entry.providerId);
    if (!target) {
      target = {
        id: entry.providerId,
        label: pc.name || meta.label,
        region: meta.region,
        baseUrl: pc.baseUrl || "",
        apis: pc.api ? [pc.api] : [],
        models: [],
      };
      out.push(target);
    }
    mergeCatalogModels(target, [normalizeUserModel(entry.modelId, entry)]);
  }

  // modelOverrides 兜底：按模型 ID / 名称推断归属，推断不出来归到「自定义模型」
  const pool = [];
  for (const [modelId, raw] of Object.entries(userCfg.modelOverrides ?? {})) {
    if (indexed.has(modelId)) continue;
    const model = normalizeUserModel(modelId, raw);
    const text = `${modelId} ${model.name}`.toLowerCase();
    const guess = BUILTIN_PROVIDERS.find((pid) => text.includes(pid.toLowerCase()))
      || BUILTIN_PROVIDERS.find((pid) => text.includes(pid.split("-")[0].toLowerCase()));
    const target = guess && out.find((x) => x.id === guess);
    if (target) mergeCatalogModels(target, [model]);
    else pool.push(model);
  }
  if (pool.length) out.push({ id: "user-models", label: "自定义模型", region: "custom", baseUrl: "", apis: [], models: pool });

  return out;
}

/** 维护管理端模型索引：新增/删除模型后同步，供员工模型下拉准确归类 */
function updateUserModelIndex(providerId, model) {
  const idx = readJsonSafe(USER_MODEL_INDEX_FILE, { version: 1, entries: [] });
  idx.entries ??= [];
  const entry = {
    providerId,
    modelId: model.id,
    name: model.name || model.id,
    baseUrl: model.baseUrl || "",
    api: model.api || "",
    reasoning: !!model.reasoning,
    input: Array.isArray(model.input) ? model.input : undefined,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    addedAt: now(),
  };
  const i = idx.entries.findIndex((e) => e.providerId === providerId && e.modelId === model.id);
  if (i >= 0) idx.entries[i] = { ...idx.entries[i], ...entry };
  else idx.entries.push(entry);
  const backup = backupFile(USER_MODEL_INDEX_FILE);
  writeJson(USER_MODEL_INDEX_FILE, idx);
  return backup;
}

function removeUserModelIndex(providerId, modelId) {
  const idx = readJsonSafe(USER_MODEL_INDEX_FILE, { version: 1, entries: [] });
  if (!Array.isArray(idx.entries)) return null;
  const before = idx.entries.length;
  idx.entries = idx.entries.filter((e) => !(e.providerId === providerId && e.modelId === modelId));
  if (idx.entries.length === before) return null;
  const backup = backupFile(USER_MODEL_INDEX_FILE);
  writeJson(USER_MODEL_INDEX_FILE, idx);
  return backup;
}

const BUILTIN_EXTENSIONS = ["mcp", "llama.cpp", "codemode", "tool-search"];
const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"];
const EXT_BY_TYPE = {
  extensions: [".ts", ".js", ".mjs", ".cjs"],
  skills: [".md"],
  prompts: [".md", ".ts", ".js"],
  themes: [".json", ".ts", ".js"],
};

function getSettings(scope) {
  const path = scope === "project" ? join(PROJECT_PI, "settings.json") : join(AGENT_DIR, "settings.json");
  return { path, data: readJsonSafe(path, {}) };
}

/** 汇总资源：内置 + 用户级 + 项目级，并标注启用状态 */
function collectResources() {
  const userSettings = getSettings("user").data;
  const projectSettings = getSettings("project").data;

  const isEnabled = (scope, type, pattern) => {
    const settings = scope === "project" ? projectSettings : userSettings;
    const arr = (settings[type] ?? []) || [];
    // 默认加载（无该类型配置或空数组外的项）；带 - 前缀为禁用
    const neg = arr.find((p) => typeof p === "string" && (p.startsWith("-") || p.startsWith("!")) && p.slice(1) === pattern);
    const pos = arr.find((p) => typeof p === "string" && p.startsWith("+") && p.slice(1) === pattern);
    if (neg) return false;
    if (pos) return true;
    // 若该类型被显式设置为「只加载列出的项」（纯 + 列表且非空），未列入的视为关闭
    const onlyPositive = arr.length > 0 && arr.every((p) => typeof p === "string" && p.startsWith("+"));
    return !onlyPositive;
  };

  const resources = [];

  // 内置扩展
  for (const name of BUILTIN_EXTENSIONS) {
    const pattern = `builtin:${name}`;
    resources.push({
      id: `builtin:${name}`,
      type: "extensions",
      name,
      scope: "builtin",
      source: "builtin",
      pattern,
      enabled: !((userSettings.extensions ?? []).includes(`-${pattern}`) || (projectSettings.extensions ?? []).includes(`-${pattern}`)),
      path: pattern,
    });
  }

  // 用户级 / 项目级资源文件
  const scopes = [
    { scope: "user", base: AGENT_DIR },
    { scope: "project", base: PROJECT_PI },
  ];
  for (const { scope, base } of scopes) {
    for (const type of RESOURCE_TYPES) {
      const dir = join(base, type);
      const files = listFiles(dir, EXT_BY_TYPE[type]);
      for (const f of files) {
        const pattern = relative(base, f).replace(/\\/g, "/");
        resources.push({
          id: `${scope}:${type}:${pattern}`,
          type,
          name: basename(f),
          scope,
          source: "file",
          pattern,
          enabled: isEnabled(scope, type, pattern),
          path: f,
        });
      }
    }
  }
  return resources;
}

/** 会话列表（读取每个 jsonl 首行 header + 统计） */
function collectSessions() {
  if (!existsSync(SESSION_DIR)) return [];
  const out = [];
  try {
    const dirs = readdirSync(SESSION_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of dirs) {
      const dir = join(SESSION_DIR, d.name);
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const p = join(dir, f);
        try {
          const txt = readFileSync(p, "utf8");
          const lines = txt.split("\n").filter(Boolean);
          let header = {};
          try { header = JSON.parse(lines[0]); } catch {}
          let msgCount = 0, userText = "", sessionName = "", lastTs = header.timestamp || "";
          let totalTokens = 0, totalCost = 0;
          for (const line of lines) {
            try {
              const e = JSON.parse(line);
              if (e.type === "session_info" && e.name) sessionName = e.name;
              if (e.type === "message") {
                msgCount++;
                if (e.message?.role === "user" && !userText) {
                  const c = e.message.content;
                  userText = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join(" ").slice(0, 80) : "");
                }
                if (e.message?.usage) {
                  totalTokens += e.message.usage.totalTokens || 0;
                  totalCost += e.message.usage.cost?.total || 0;
                }
              }
              if (e.timestamp && e.timestamp > lastTs) lastTs = e.timestamp;
            } catch {}
          }
          out.push({
            file: p,
            id: header.id || f.replace(/\.jsonl$/, ""),
            cwd: header.cwd || "",
            name: sessionName || userText || f,
            version: header.version || 1,
            messages: msgCount,
            bytes: Buffer.byteLength(txt),
            lastTs,
            totalTokens,
            totalCost,
          });
        } catch {}
      }
    }
  } catch {}
  return out.sort((a, b) => (b.lastTs || "").localeCompare(a.lastTs || ""));
}

/** 读取单个会话的消息（树结构展平 + 角色） */
function readSession(file) {
  if (!safePath(file) || !file.endsWith(".jsonl") || !existsSync(file)) throw Object.assign(new Error("会话文件不可访问"), { status: 400 });
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.type === "message" && e.message?.role !== "system") {
        const c = e.message.content;
        const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.type === "text" ? b.text : (b.type === "thinking" ? `[thinking] ${b.thinking?.slice?.(0, 100) || ""}` : `[${b.type}]`)).join("\n") : String(c ?? ""));
        entries.push({
          id: e.id,
          parentId: e.parentId,
          role: e.message.role,
          model: e.message.model || "",
          provider: e.message.provider || "",
          text: String(text).slice(0, 4000),
          ts: e.timestamp,
          isError: e.message.isError || false,
        });
      } else if (e.type === "model_change") {
        entries.push({ id: e.id, parentId: e.parentId, role: "model_change", text: `${e.provider}/${e.modelId}`, ts: e.timestamp });
      } else if (e.type === "compaction") {
        entries.push({ id: e.id, parentId: e.parentId, role: "compaction", text: String(e.summary || "").slice(0, 500), ts: e.timestamp });
      }
    } catch {}
  }
  return entries;
}

/** 把 cwd 编码为 Pi 的会话目录名，与 session-manager.ts 的 getDefaultSessionDirPath 一致 */
function encodeSessionDir(cwd) {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * 创建一个 Pi 可识别的 v3 会话文件。
 * 只写 header + 可选 session_info（名称）+ 可选首条 user 消息，之后交给 Pi 续聊。
 */
function createSessionFile({ cwd, name, firstMessage }) {
  if (typeof cwd !== "string" || !isAbsolute(cwd))
    throw Object.assign(new Error("工作目录必须是绝对路径"), { status: 400 });
  if (!existsSync(cwd) || !statSync(cwd).isDirectory())
    throw Object.assign(new Error("工作目录不存在或不是文件夹"), { status: 400 });
  // 与 Pi 的 canonicalizePath 一致，跟随符号链接，保证 --session 能命中同一目录
  let realCwd;
  try { realCwd = realpathSync(cwd); } catch { realCwd = resolve(cwd); }

  const id = randomUUID();
  const ts = now();
  const dir = join(SESSION_DIR, encodeSessionDir(realCwd));
  const file = join(dir, `${ts.replace(/[:.]/g, "-")}_${id}.jsonl`);
  if (existsSync(file)) throw Object.assign(new Error("会话文件已存在，请重试"), { status: 409 });

  const lines = [{ type: "session", version: 3, id, timestamp: ts, cwd: realCwd }];
  const nextId = () => randomUUID().replace(/-/g, "").slice(0, 8);
  let parentId = null;

  if (name && String(name).trim()) {
    const entry = { type: "session_info", id: nextId(), parentId, timestamp: ts, name: String(name).replace(/[\r\n]+/g, " ").trim() };
    lines.push(entry);
    parentId = entry.id;
  }
  if (firstMessage && String(firstMessage).trim()) {
    const entry = {
      type: "message", id: nextId(), parentId, timestamp: ts,
      message: { role: "user", content: String(firstMessage), timestamp: Date.now() },
    };
    lines.push(entry);
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return { file, id, cwd: realCwd, lines: lines.length };
}

/** 模型与认证（脱敏） */
function collectModels() {
  const settings = getSettings("user").data;
  const auth = readJsonSafe(join(AGENT_DIR, "auth.json"), {});
  const modelsCfg = readJsonSafe(join(AGENT_DIR, "models.json"), {});

  const credentials = Object.entries(auth).map(([provider, cred]) => ({
    provider,
    type: cred?.type || "unknown",
    key: cred?.key ? maskSecret(cred.key) : "",
    hasEnv: !!cred?.env && Object.keys(cred.env).length > 0,
    oauth: cred?.type === "oauth" ? { access: maskSecret(cred.access), refresh: maskSecret(cred.refresh), expires: cred.expires } : null,
  }));

  const configuredProviders = Object.entries(modelsCfg.providers ?? {}).map(([id, p]) => ({
    id,
    baseUrl: p?.baseUrl || "",
    api: p?.api || "",
    apiKey: p?.apiKey ? maskSecret(p.apiKey) : "",
    models: (p?.models ?? []).map((m) => (typeof m === "string" ? m : m?.id)),
  }));

  return {
    defaultProvider: settings.defaultProvider || "(自动)",
    defaultModel: settings.defaultModel || "(自动)",
    defaultThinkingLevel: settings.defaultThinkingLevel || "medium",
    enabledModels: settings.enabledModels ?? [],
    credentials,
    configuredProviders,
  };
}

/** 概览 */
function collectOverview() {
  const sessions = collectSessions();
  const resources = collectResources();
  const userSettings = getSettings("user").data;
  return {
    version: "1.0.0",
    now: now(),
    workspace: WORKSPACE,
    agentDir: AGENT_DIR,
    projectPi: PROJECT_PI,
    sessionDir: SESSION_DIR,
    trusted: !!readJsonSafe(join(AGENT_DIR, "trust.json"), {})[WORKSPACE],
    unlocked: EDIT_UNLOCKED,
    stats: {
      resources: resources.length,
      enabledResources: resources.filter((r) => r.enabled).length,
      sessions: sessions.length,
      totalTokens: sessions.reduce((s, x) => s + x.totalTokens, 0),
      totalCost: sessions.reduce((s, x) => s + x.totalCost, 0),
    },
    defaults: {
      provider: userSettings.defaultProvider || "(自动)",
      model: userSettings.defaultModel || "(自动)",
      theme: userSettings.theme || "system",
    },
  };
}

// ---------- 数字员工数据层 ----------
function readOrgJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return readJsonSafe(path, fallback);
}

function listOrgEmployees() {
  if (!existsSync(ORG_EMPLOYEES_DIR)) return [];
  return listFiles(ORG_EMPLOYEES_DIR, [".json"])
    .map((p) => readJsonSafe(p, null))
    .filter((e) => e && typeof e === "object" && e.id)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function getOrgEmployee(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{2,40}$/.test(id))
    throw Object.assign(new Error("员工 ID 只能是字母、数字、下划线或短横线（2-40 位）"), { status: 400 });
  const p = join(ORG_EMPLOYEES_DIR, `${id}.json`);
  if (!safePath(p)) throw Object.assign(new Error("路径越界"), { status: 400 });
  if (!existsSync(p)) throw Object.assign(new Error("员工不存在"), { status: 404 });
  return { path: p, data: readJsonSafe(p, {}) };
}

function listOrgDepartments() {
  const data = readOrgJson(ORG_DEPARTMENTS_FILE, DEFAULT_DEPARTMENTS);
  return Array.isArray(data) && data.length ? data : DEFAULT_DEPARTMENTS;
}

function listOrgRoles() {
  const custom = readOrgJson(ORG_ROLES_FILE, []);
  return [...BUILTIN_ROLES, ...(Array.isArray(custom) ? custom : [])];
}

function writeOrgFile(path, data) {
  if (!safePath(path)) throw Object.assign(new Error("路径越界"), { status: 400 });
  mkdirSync(dirname(path), { recursive: true });
  const backup = backupFile(path);
  writeJson(path, data);
  return backup;
}

function normalizeEmployee(body, existing = {}) {
  const id = String(body.id || existing.id || "").trim();
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(id))
    throw Object.assign(new Error("员工 ID 不合法（字母/数字/下划线/短横线，2-40 位）"), { status: 400 });
  const name = String(body.name || "").trim();
  if (!name) throw Object.assign(new Error("员工姓名不能为空"), { status: 400 });

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const status = ["active", "idle", "archived"].includes(body.status) ? body.status : "idle";
  const perm = body.permissions || existing.permissions || {};
  const oldModel = existing.model || {};
  const provider = body.modelProvider !== undefined ? body.modelProvider : oldModel.provider;
  const modelId = body.modelId !== undefined ? body.modelId : oldModel.id;

  return {
    id,
    name,
    role: String(body.role || "custom").trim(),
    department: String(body.department || "").trim(),
    reportsTo: String(body.reportsTo || "").trim(),
    status,
    model: {
      provider: String(provider || "").trim(),
      id: String(modelId || "").trim(),
    },
    skills: Array.isArray(body.skills) ? body.skills.map((s) => String(s).trim()).filter(Boolean) : [],
    permissions: {
      filesystem: ["none", "read-only", "workspace-write"].includes(perm.filesystem) ? perm.filesystem : "read-only",
      commands: ["deny", "allowlist", "full"].includes(perm.commands) ? perm.commands : "deny",
      network: ["deny", "review", "allow"].includes(perm.network) ? perm.network : "deny",
      budget: {
        maxTokensPerTask: num(perm.budget?.maxTokensPerTask),
        maxCostPerDay: num(perm.budget?.maxCostPerDay),
      },
    },
    workspace: `org/workspaces/${id}`,
    systemPrompt: String(body.systemPrompt || "").trim(),
    note: String(body.note || "").trim(),
    createdAt: existing.createdAt || now(),
    updatedAt: now(),
  };
}

function collectOrgOverview() {
  const employees = listOrgEmployees();
  const departments = listOrgDepartments();
  const roles = listOrgRoles();
  return {
    orgDir: ORG_DIR,
    employees,
    departments,
    roles,
    stats: {
      total: employees.filter((e) => e.status !== "archived").length,
      active: employees.filter((e) => e.status === "active").length,
      idle: employees.filter((e) => e.status === "idle").length,
      archived: employees.filter((e) => e.status === "archived").length,
      departments: departments.length,
      roles: roles.length,
    },
    now: now(),
  };
}

/** 员工人格提示词：把组织信息、岗位、权限和自定义提示词拼成一份系统提示 */
function buildEmployeeSystemPrompt(employee) {
  const role = listOrgRoles().find((r) => r.id === employee.role);
  const dept = listOrgDepartments().find((d) => d.id === employee.department);
  const perm = employee.permissions || {};
  const budget = perm.budget || {};
  const lines = [
    `# 身份`,
    `你是「${employee.name}」（员工 ID：${employee.id}）。`,
    ``,
    `# 岗位与归属`,
    `- 岗位：${role?.label || employee.role || "未指定"}`,
    `- 部门：${dept?.name || employee.department || "未指定"}`,
    employee.reportsTo ? `- 汇报对象：${employee.reportsTo}` : "- 汇报对象：无",
    ``,
    `# 工作模型`,
    employee.model?.id
      ? `- 优先使用模型：${employee.model.provider || "默认 Provider"} / ${employee.model.id}`
      : "- 模型：跟随 Pi 当前默认配置",
    ``,
    `# 可用技能`,
    (employee.skills || []).length ? employee.skills.map((s) => `- ${s}`).join("\n") : "- 无特别指定",
    ``,
    `# 权限边界（必须遵守）`,
    `- 文件系统：${perm.filesystem || "read-only"}`,
    `- 命令执行：${perm.commands || "deny"}`,
    `- 网络访问：${perm.network || "deny"}`,
    budget.maxTokensPerTask ? `- 单任务 token 上限：${budget.maxTokensPerTask}` : "",
    budget.maxCostPerDay ? `- 单日费用上限：${budget.maxCostPerDay}` : "",
    ``,
    `# 行为准则`,
    `- 始终以「${employee.name}」的身份回应，不冒充其他员工。`,
    `- 输出先给结论，再给依据；不确定时明确说不确定。`,
    `- 涉及写文件、执行命令或联网时，先说明计划，再等待人类确认。`,
    ``,
  ].filter((l) => l !== undefined);
  if (employee.systemPrompt) {
    lines.push(`# 岗位专属要求`, employee.systemPrompt, ``);
  }
  return lines.join("\n").trim() + "\n";
}

/** 为员工准备独立工作区，并写入 Pi 可加载的 SYSTEM.md（写前备份） */
function ensureEmployeeWorkspace(employee) {
  const rel = employee.workspace || `org/workspaces/${employee.id}`;
  const dir = safePath(rel) ? join(WORKSPACE, rel) : join(WORKSPACE, "org", "workspaces", employee.id);
  if (!safePath(dir)) throw Object.assign(new Error("员工工作区路径越界"), { status: 400 });
  mkdirSync(dir, { recursive: true });
  const piDir = join(dir, ".pi");
  mkdirSync(piDir, { recursive: true });
  const systemPath = join(piDir, "SYSTEM.md");
  const content = buildEmployeeSystemPrompt(employee);
  let backup = null;
  if (existsSync(systemPath) && readFileSync(systemPath, "utf8") !== content) backup = backupFile(systemPath);
  writeFileSync(systemPath, content, "utf8");
  return { dir, systemPath, backup };
}

// ---------- 路由 ----------
async function handleApi(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  if (path === "/api/overview" && method === "GET") return send(res, 200, collectOverview());

  if (path === "/api/resources" && method === "GET") return send(res, 200, collectResources());

  if (path === "/api/resources/toggle" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const { resourceType, scope, pattern, enabled } = body;
    if (!RESOURCE_TYPES.includes(resourceType)) throw Object.assign(new Error("无效资源类型"), { status: 400 });
    if (!["user", "project", "builtin"].includes(scope)) throw Object.assign(new Error("无效 scope"), { status: 400 });
    if (typeof pattern !== "string" || !pattern) throw Object.assign(new Error("缺少 pattern"), { status: 400 });

    const store = getSettings(scope === "project" ? "project" : "user");
    const data = store.data;
    const arr = (data[resourceType] ?? []) || [];
    const updated = arr.filter((p) => {
      const stripped = typeof p === "string" && (p.startsWith("!") || p.startsWith("+") || p.startsWith("-")) ? p.slice(1) : p;
      return stripped !== pattern;
    });
    updated.push(`${enabled ? "+" : "-"}${pattern}`);
    data[resourceType] = updated;
    const backup = backupFile(store.path);
    writeJson(store.path, data);
    return send(res, 200, { ok: true, backup, note: "已写入设置，Pi 内执行 /reload 生效" });
  }

  if (path === "/api/settings" && method === "GET") {
    const scope = url.searchParams.get("scope") || "user";
    const file = url.searchParams.get("file") || "settings";
    const allowed = ["settings", "mcp", "models", "keybindings"];
    if (!allowed.includes(file)) throw Object.assign(new Error("无效配置文件"), { status: 400 });
    const base = scope === "project" ? PROJECT_PI : AGENT_DIR;
    const p = join(base, `${file}.json`);
    return send(res, 200, { path: p, scope, file, exists: existsSync(p), data: readJsonSafe(p, {}) });
  }

  if (path === "/api/settings" && method === "PUT") {
    const body = await readBody(req);
    requireUnlock(body);
    const { scope, file, data } = body;
    const allowed = ["settings", "mcp", "models", "keybindings"];
    if (!allowed.includes(file)) throw Object.assign(new Error("无效配置文件"), { status: 400 });
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw Object.assign(new Error("data 必须是 JSON 对象"), { status: 400 });
    const base = scope === "project" ? PROJECT_PI : AGENT_DIR;
    const p = join(base, `${file}.json`);
    if (!safePath(p)) throw Object.assign(new Error("路径越界"), { status: 400 });
    const backup = backupFile(p);
    writeJson(p, data);
    return send(res, 200, { ok: true, path: p, backup, note: "已保存，Pi 内执行 /reload 生效" });
  }

  if (path === "/api/sessions" && method === "GET") return send(res, 200, collectSessions());

  // 新开会话：生成 Pi v3 会话文件（header + 可选名称/首句），之后用 pi --session <id> 续聊
  if (path === "/api/session/create" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const created = createSessionFile({ cwd: body.cwd, name: body.name, firstMessage: body.firstMessage });
    return send(res, 200, {
      ok: true,
      ...created,
      command: `pi --session ${created.id}`,
      note: "会话已创建，用返回的命令在终端续聊",
    });
  }

  if (path === "/api/session" && method === "GET") {
    const file = url.searchParams.get("file");
    if (!file) throw Object.assign(new Error("缺少 file"), { status: 400 });
    return send(res, 200, { file, entries: readSession(file) });
  }

  if (path === "/api/session/export" && method === "GET") {
    const file = url.searchParams.get("file");
    if (!safePath(file) || !existsSync(file)) throw Object.assign(new Error("文件不可访问"), { status: 400 });
    const txt = readFileSync(file, "utf8");
    return send(res, 200, txt, "application/jsonl; charset=utf-8");
  }

  if (path === "/api/session" && method === "DELETE") {
    const body = await readBody(req);
    requireUnlock(body);
    const { file } = body;
    if (!safePath(file) || !file.endsWith(".jsonl") || !existsSync(file)) throw Object.assign(new Error("文件不可访问"), { status: 400 });
    const backup = backupFile(file);
    unlinkSync(file);
    return send(res, 200, { ok: true, backup });
  }

  if (path === "/api/models" && method === "GET") return send(res, 200, collectModels());

  // 新增模型：写入 models.json 的 providers[providerId].models
  // 自定义 provider 需要 baseUrl + api；内置 provider 只覆盖 baseUrl/apiKey，模型走 modelOverrides
  if (path === "/api/models/add" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const {
      providerId, name, baseUrl, api, apiKey, authHeader,
      modelId, modelName, reasoning, contextWindow, maxTokens, input,
    } = body;

    if (typeof providerId !== "string" || !/^[A-Za-z0-9._-]+$/.test(providerId))
      throw Object.assign(new Error("Provider ID 只能是字母、数字、点、下划线、短横线"), { status: 400 });
    if (typeof modelId !== "string" || !modelId.trim())
      throw Object.assign(new Error("模型 ID 不能为空"), { status: 400 });
    if (!BUILTIN_PROVIDERS.includes(providerId) && !baseUrl)
      throw Object.assign(new Error("自定义 Provider 必须填写 Base URL"), { status: 400 });

    const modelsPath = join(AGENT_DIR, "models.json");
    const cfg = readJsonSafe(modelsPath, { $schema: "https://pi.dev/schemas/models.schema.json" });
    cfg.providers ??= {};

    // 组装模型条目（只写用户显式填的字段）
    const modelObj = { id: modelId.trim() };
    if (name) modelObj.name = name;
    if (modelName) modelObj.name = modelName;
    if (reasoning === true) modelObj.reasoning = true;
    if (input && Array.isArray(input) && input.length) modelObj.input = input;
    const cw = Number(contextWindow);
    if (Number.isFinite(cw) && cw > 0) modelObj.contextWindow = cw;
    const mt = Number(maxTokens);
    if (Number.isFinite(mt) && mt > 0) modelObj.maxTokens = mt;

    const isBuiltin = BUILTIN_PROVIDERS.includes(providerId);
    const provider = cfg.providers[providerId] ??= {};

    if (isBuiltin) {
      // 内置 provider：只覆盖连接相关字段，不动内置模型列表
      if (baseUrl) provider.baseUrl = baseUrl;
      if (apiKey) provider.apiKey = apiKey;
      if (authHeader === true) provider.authHeader = true;
      // 新模型用 modelOverrides 追加（不会替换 provider 的模型列表）
      cfg.modelOverrides ??= {};
      cfg.modelOverrides[modelObj.id] = { ...modelObj };
      delete cfg.modelOverrides[modelObj.id].id;
    } else {
      // 自定义 provider：设置连接字段 + 追加/替换模型
      if (name) provider.name = name;
      if (baseUrl) provider.baseUrl = baseUrl;
      if (api) provider.api = api;
      else if (!provider.api) provider.api = "openai-completions";
      if (apiKey) provider.apiKey = apiKey;
      if (authHeader === true) provider.authHeader = true;
      provider.models ??= [];
      const idx = provider.models.findIndex((m) => (typeof m === "string" ? m : m?.id) === modelObj.id);
      if (idx >= 0) provider.models[idx] = modelObj;
      else provider.models.push(modelObj);
    }

    const backup = backupFile(modelsPath);
    writeJson(modelsPath, cfg);
    const indexBackup = updateUserModelIndex(providerId, modelObj);
    return send(res, 200, {
      ok: true, backup, indexBackup, path: modelsPath, isBuiltin,
      note: "已写入 models.json。Pi 里打开 /model 会自动重新加载，或执行 /reload",
    });
  }

  // 删除模型：从 providers[id].models 移除指定 modelId
  if (path === "/api/models/remove" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const { providerId, modelId } = body;
    if (typeof providerId !== "string" || typeof modelId !== "string")
      throw Object.assign(new Error("缺少 providerId 或 modelId"), { status: 400 });

    const modelsPath = join(AGENT_DIR, "models.json");
    const cfg = readJsonSafe(modelsPath, {});
    const provider = cfg.providers?.[providerId];
    let removed = false;
    if (provider && Array.isArray(provider.models)) {
      const before = provider.models.length;
      provider.models = provider.models.filter((m) => (typeof m === "string" ? m : m?.id) !== modelId);
      removed = provider.models.length !== before;
    }
    if (!removed && cfg.modelOverrides?.[modelId]) {
      delete cfg.modelOverrides[modelId];
      removed = true;
    }
    if (!removed) throw Object.assign(new Error("未找到该模型"), { status: 400 });

    removeUserModelIndex(providerId, modelId);
    const backup = backupFile(modelsPath);
    writeJson(modelsPath, cfg);
    return send(res, 200, { ok: true, backup, note: "已删除模型，原文件已备份" });
  }

  // 内置 provider ID 列表（供前端判断是否需要填 baseUrl/api）
  if (path === "/api/models/builtin-providers" && method === "GET")
    return send(res, 200, BUILTIN_PROVIDERS);

  if (path === "/api/models/provider-catalog" && method === "GET")
    return send(res, 200, loadProviderCatalog());

  // ---------- 数字员工：组织管理（P1） ----------
  if (path === "/api/org/overview" && method === "GET")
    return send(res, 200, collectOrgOverview());

  if (path === "/api/org/employees" && method === "GET")
    return send(res, 200, listOrgEmployees());

  if (path === "/api/org/employees" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const employee = normalizeEmployee(body);
    const p = join(ORG_EMPLOYEES_DIR, `${employee.id}.json`);
    if (existsSync(p)) throw Object.assign(new Error(`员工 ID ${employee.id} 已存在`), { status: 409 });
    const backup = writeOrgFile(p, employee);
    return send(res, 200, { ok: true, employee, backup, note: "员工已创建" });
  }

  if (path.startsWith("/api/org/employees/") && method === "PUT") {
    const id = decodeURIComponent(path.slice("/api/org/employees/".length));
    const body = await readBody(req);
    requireUnlock(body);
    const cur = getOrgEmployee(id);
    const employee = normalizeEmployee({ ...cur.data, ...body, id }, cur.data);
    const backup = writeOrgFile(cur.path, employee);
    return send(res, 200, { ok: true, employee, backup, note: "员工已更新（原文件已备份）" });
  }

  if (path.startsWith("/api/org/employees/") && path.endsWith("/toggle") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/employees/".length, -"/toggle".length));
    const body = await readBody(req);
    requireUnlock(body);
    const cur = getOrgEmployee(id);
    const next = ["active", "idle", "archived"].includes(body.status)
      ? body.status
      : cur.data.status === "active" ? "idle" : "active";
    const employee = { ...cur.data, status: next, updatedAt: now() };
    const backup = writeOrgFile(cur.path, employee);
    return send(res, 200, { ok: true, employee, backup, note: `员工已${next === "active" ? "上线" : "停用"}` });
  }

  if (path.startsWith("/api/org/employees/") && path.endsWith("/archive") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/employees/".length, -"/archive".length));
    const body = await readBody(req);
    requireUnlock(body);
    const cur = getOrgEmployee(id);
    const employee = { ...cur.data, status: "archived", updatedAt: now() };
    const backup = writeOrgFile(cur.path, employee);
    return send(res, 200, { ok: true, employee, backup, note: "员工已归档（文件保留，未删除）" });
  }

  // 与员工对话：准备独立工作区 + 人格提示词，再生成一条 Pi 会话，返回可直接复制的启动命令
  if (path.startsWith("/api/org/employees/") && path.endsWith("/chat") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/employees/".length, -"/chat".length));
    const body = await readBody(req);
    requireUnlock(body);
    const cur = getOrgEmployee(id);
    if (cur.data.status === "archived")
      throw Object.assign(new Error("已归档员工不能对话，请先恢复"), { status: 400 });
    const ws = ensureEmployeeWorkspace(cur.data);
    const created = createSessionFile({
      cwd: ws.dir,
      name: `与${cur.data.name}对话`,
      firstMessage: body.firstMessage,
    });
    const model = cur.data.model;
    const modelSpec = model?.provider && model?.id ? `${model.provider}/${model.id}` : "";
    const args = [`--session ${created.id}`];
    if (modelSpec) args.push(`--model ${shellQuote(modelSpec)}`);
    args.push(`--system-prompt ${shellQuote(readFileSync(ws.systemPath, "utf8"))}`);
    const command = `pi ${args.join(" ")}`;
    return send(res, 200, {
      ok: true,
      employee: cur.data,
      workspace: ws.dir,
      systemPrompt: ws.systemPath,
      promptBackup: ws.backup,
      ...created,
      command,
      shortCommand: `pi --session ${created.id}`,
      note: "已创建员工对话会话，复制命令到终端即可开始对话",
    });
  }

  if (path === "/api/org/departments" && method === "GET")
    return send(res, 200, listOrgDepartments());

  if (path === "/api/org/departments" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    if (!Array.isArray(body.departments)) throw Object.assign(new Error("departments 必须是数组"), { status: 400 });
    for (const d of body.departments) {
      if (!d || !/^[A-Za-z0-9_-]{2,40}$/.test(String(d.id || "")) || !String(d.name || "").trim())
        throw Object.assign(new Error("部门 ID 或名称不合法"), { status: 400 });
    }
    // 禁止删除仍有在职员工的部门，避免出现「员工指向不存在的部门」
    const nextIds = new Set(body.departments.map((d) => String(d.id)));
    const employees = listOrgEmployees();
    const blocked = listOrgDepartments()
      .filter((d) => !nextIds.has(String(d.id)))
      .filter((d) => employees.some((e) => e.department === d.id && e.status !== "archived"));
    if (blocked.length)
      throw Object.assign(new Error(`部门「${blocked.map((d) => d.name).join("、")}」下仍有员工，请先迁移再删除`), { status: 400 });
    const backup = writeOrgFile(ORG_DEPARTMENTS_FILE, body.departments);
    return send(res, 200, { ok: true, departments: body.departments, backup, note: "部门已保存" });
  }

  if (path === "/api/org/roles" && method === "GET")
    return send(res, 200, listOrgRoles());

  if (path === "/api/org/roles" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    if (!Array.isArray(body.roles)) throw Object.assign(new Error("roles 必须是数组"), { status: 400 });
    const backup = writeOrgFile(ORG_ROLES_FILE, body.roles);
    return send(res, 200, { ok: true, roles: listOrgRoles(), backup, note: "自定义岗位已保存" });
  }

  if (path === "/api/unlock" && method === "POST") {
    const body = await readBody(req);
    if (body.unlock === true) EDIT_UNLOCKED = true;
    else if (body.lock === true) EDIT_UNLOCKED = false;
    return send(res, 200, { unlocked: EDIT_UNLOCKED });
  }

  throw Object.assign(new Error("未知 API"), { status: 404 });
}

// ---------- 静态资源 ----------
function serveStatic(req, res, url) {
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = join(PUBLIC_DIR, p.replace(/^\/+/, ""));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
  if (!existsSync(file)) return send(res, 404, "Not Found", "text/plain; charset=utf-8");
  const ext = extname(file);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  send(res, 200, readFileSync(file), types[ext] || "application/octet-stream");
}

// ---------- 启动 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    send(res, e.status || 500, { error: e.message || String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Pi Admin 已启动： http://127.0.0.1:${PORT}`);
  console.log(`工作区：${WORKSPACE}`);
  console.log(`Agent 目录：${AGENT_DIR}`);
  console.log(`默认只读；在界面点「解锁编辑」后允许写操作（写前自动备份到 .backups/）。`);
});
