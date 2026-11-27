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
 * 用法：node server.mjs [--port 8787] [--workspace <path>] [--agent-dir <path>] [--runtime-agent-dir <path>]
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync, renameSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { join, resolve, relative, dirname, basename, extname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const BACKUP_ROOT = join(__dirname, ".backups");

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const out = { port: 8787, workspace: null, agentDir: null, runtimeAgentDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && argv[i + 1]) out.port = Number(argv[++i]);
    else if (a === "--workspace" && argv[i + 1]) out.workspace = resolve(argv[++i]);
    else if (a === "--agent-dir" && argv[i + 1]) out.agentDir = resolve(argv[++i]);
    else if (a === "--runtime-agent-dir" && argv[i + 1]) out.runtimeAgentDir = resolve(argv[++i]);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

// workspace 默认取 admin 的上两级（my-workspace），agentDir 默认 ~/.pi/agent
const WORKSPACE = args.workspace ?? resolve(__dirname, "..");
const AGENT_DIR = args.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
// Pi 子进程专用配置目录：与用户配置目录隔离，避开 WorkBuddy/安全软件对 ~/.pi/agent/*.lock 删除的拦截。
// 管理端读写仍在 AGENT_DIR；这里只放启动 Pi 所需的副本，sessions 软链回原目录。
const RUNTIME_AGENT_DIR = args.runtimeAgentDir ?? process.env.PI_ADMIN_RUNTIME_AGENT_DIR ?? join(__dirname, ".pi-agent-runtime");
const PROJECT_PI = join(WORKSPACE, ".pi");
const SESSION_DIR = join(AGENT_DIR, "sessions");
// 会话自动清理：配置与日志独立于 Pi 自己的 settings.json，避免污染上游配置
const SESSION_RETENTION_FILE = join(__dirname, ".session-retention.json");
const SESSION_RETENTION_LOG = join(__dirname, ".session-retention-log.json");
// Token 费用：Pi 的 usage.cost 固定为 USD，展示时统一折算人民币；汇率每日从公开接口拉取并本地缓存
const FX_RATE_FILE = join(__dirname, ".usd-cny-rate.json");
const FX_TTL_MS = 6 * 60 * 60 * 1000;
// DeepSeek 峰谷定价：中国法定节假日按空闲时段；日期表可手工更新
const CN_HOLIDAYS_FILE = join(__dirname, ".china-holidays.json");
const PORT = Number.isFinite(args.port) ? args.port : 8787;
// 进程身份：前端用 startedAt 判断「重启后的新进程」是否已经真正接管端口
const SERVER_STARTED_AT = Date.now();
const SERVER_ENTRY = join(__dirname, "server.mjs");
// 解锁状态跨重启持久化：重启前后端 unlocked 变量不变，服务端也不能丢，否则出现「前端已解锁、后端拒绝」的不一致
const UNLOCK_STATE_FILE = join(__dirname, ".unlock-state.json");
// 管家：专用工作区 + 固定会话，复用现有 Pi RPC 聊天通道
const BUTLER_DIR = join(WORKSPACE, "org", "workspaces", "butler");
const BUTLER_STATE_FILE = join(BUTLER_DIR, ".pi", "butler.json");
const BUTLER_SYSTEM_FILE = join(BUTLER_DIR, ".pi", "SYSTEM.md");
const BUTLER_NAME = "Pi Admin 管家";

// ---------- 数字员工：组织数据（P1） ----------
const ORG_DIR = join(WORKSPACE, "org");
const ORG_EMPLOYEES_DIR = join(ORG_DIR, "employees");
const ORG_DEPARTMENTS_FILE = join(ORG_DIR, "departments.json");
const ORG_ROLES_FILE = join(ORG_DIR, "roles.json");
// P2+ 协作闭环数据
const ORG_GROUPS_FILE = join(ORG_DIR, "groups.json");
const ORG_TASKS_FILE = join(ORG_DIR, "tasks.json");
const ORG_MEMORY_DIR = join(ORG_DIR, "memory");
const ORG_TRIGGERS_FILE = join(ORG_DIR, "triggers.json");
const ORG_MESSAGES_FILE = join(ORG_DIR, "messages.jsonl");
const ORG_RUNS_DIR = join(ORG_DIR, "runs");
const ORG_KNOWLEDGE_FILE = join(ORG_DIR, "knowledge.json");
const ORG_PROJECTS_FILE = join(ORG_DIR, "projects.json");
// 群 SOP：流程模板库 + 运行实例库
const ORG_SOPS_FILE = join(ORG_DIR, "sops.json");
const ORG_SOP_RUNS_FILE = join(ORG_DIR, "sop-runs.json");
// 员工累计用量账本：会话里的 usage 是唯一计数源（群聊/任务会话也写在这里），避免与群消息重复统计
const ORG_EMPLOYEE_USAGE_FILE = join(ORG_DIR, "employee-usage.json");

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

/**
 * 内置群 SOP 模板。首次启动时写入 org/sops.json，之后以文件为准（用户可在管理端修改）。
 * 每步：name（阶段名）、role（按岗位自动匹配群成员）、assignee（可覆盖为指定员工 ID）、
 * instruction（派给员工的任务指令模板）、acceptance（验收标准）。
 * 变量占位：{{goal}} 为本次流程目标，{{prev}} 为上一阶段结果摘要。
 */
const DEFAULT_SOPS = [
  {
    id: "sop_qw_engineering", name: "QoderWake 工程研发", description: "QoderWake 工程 skill 链：规划 → 架构决策 → 编码实现 → 测试策略 → 代码评审 → 变更验证 → 交付发布（含 handoff 五要素与 Given/When/Then 验收）",
    source: "QoderWake skills: planning / architecture / testing-strategy / code-review / change-validation-planner / git-worktree-branch",
    steps: [
      { id: "s1", name: "规划规格", role: "product", skill: "planning", instruction: "按 QoderWake /planning 规范，为目标「{{goal}}」输出精简规格（lean spec），不要直接问用户：\n1) 独立理解需求：复述背景与真实目标，标注假设与不确定点；\n2) Goal Statement：一句话可验证目标；\n3) Deliverables：列出具体产出物（文件/接口/组件/行为），每项可独立验收且可回溯到目标；\n4) Acceptance Criteria：3-6 条可证伪条件，格式为 AC-1 [Happy path] Given … When … Then … / AC-2 [Error path] … / AC-3 [Edge case] … / AC-4 [Non-functional] …；\n5) Implementation Path：可执行步骤，每步写清产出与它如何解除下一步阻塞；\n6) Open Questions：仅列真正阻塞的问题，其余用假设推进。", acceptance: "结构化规格：目标 + 交付物 + 3-6 条 Given/When/Then AC + 实施路径 + 开放问题；AC 将被下游测试直接当作必测用例。" },
      { id: "s2", name: "架构决策", role: "developer", skill: "architecture", instruction: "按 QoderWake /architecture 输出 ADR（架构决策记录），针对「{{goal}}」：\n- Context：约束与驱动因素（工期、规模、非功能要求）；\n- Decision：明确选择；\n- Options Considered：至少两个备选及其被否原因；\n- Trade-off Analysis：取舍与代价；\n- Consequences：正向/负向后果；\n- Action Items：可勾选的实现步骤清单。\n{{prev}}", acceptance: "ADR 六段齐全，含备选方案与否决理由；Action Items 可直接作为实现任务。" },
      { id: "s3", name: "编码实现", role: "developer", skill: "implementation", instruction: "按 ADR 的 Action Items 完成「{{goal}}」实现：\n- 只改自己工作区内的文件，给出变更路径清单；\n- 逐条对应 AC，说明每条如何被满足；\n- 运行最小必要检查（语法/单测/启动），记录真实命令与输出；\n- 遇到失败按 failure signature 归类，同一签名不得重复高成本重试两次以上。\n架构结论：\n{{prev}}", acceptance: "变更清单 + AC 逐条对照 + 真实命令与结果；不确定处标注「需人工确认」，不臆造通过。" },
      { id: "s4", name: "测试策略", role: "tester", skill: "testing-strategy", instruction: "按 QoderWake /testing-strategy 为「{{goal}}」设计并执行验证：\n1) 把规划阶段的每条 AC 当作必测用例；\n2) Prove-It：先加能暴露问题的复现测试（最好修复前失败），再展示同一测试现在通过；无法确定性复现时明确说明并给等价基线证据；\n3) 覆盖 happy / error / edge 三类，不得在未给显式证据时宣称覆盖充分；\n4) 现有断言视为行为契约，不得为适配新代码而弱化；\n5) 交付门禁证据：baseline → regression matrix → 剩余风险。\n规格与实现结论：\n{{prev}}", acceptance: "测试用例 + 真实执行结果 + happy/error/edge 证据 + 剩余风险；给出明确通过/不通过结论。" },
      { id: "s5", name: "代码评审", role: "developer", skill: "code-review", instruction: "按 QoderWake /code-review 评审「{{goal}}」的变更，逐维度检查：\n- Security：注入/XSS/CSRF/鉴权/密钥硬编码/路径穿越/SSRF；\n- Performance：N+1、热路径复杂度、无界查询、资源泄漏；\n- Correctness：边界/空值、并发、错误处理、off-by-one；\n- Contract Compatibility：向后兼容、默认值语义、输出格式稳定、交付物路径/命名/入口；\n- Maintainability：命名、单一职责、重复、测试覆盖；\n- Existing-Test Integrity：检查现有测试是否被弱化/删除以适配新行为。\n交付门禁：验证交付物路径/入口与声明一致，证据中至少有一个目标验收命令/结果；修复必须给 before signature -> command -> after result 闭环证据。最终给 Verdict: Approve / Request Changes / Needs Discussion。\n测试结论：\n{{prev}}", acceptance: "Code Review Report：六维度结论 + 交付门禁检查 + before→command→after 闭环证据 + 明确 Verdict。" },
      { id: "s6", name: "变更验证规划", role: "tester", skill: "change-validation-planner", instruction: "按 QoderWake /change-validation-planner 为「{{goal}}」规划最窄可信验证路径：\n1) Identify Change Surface：明确改动面；\n2) Detect Existing Validation Paths：复用已有检查，不重复造轮子；\n3) Order Commands From Narrow To Broad：最窄定向测试 → 静态检查(lint/typecheck) → 跨边界时构建 → 必要时才跑集成/全量；\n4) Stop At The First Useful Confidence Boundary：达到第一个可信置信边界即停；\n5) Track What Remains Unverified：明确列出未验证项；\n6) Prefer Incremental Plans；\n7) 不与诊断/写测试职责交叉。\n评审结论：\n{{prev}}", acceptance: "Validation ladder（从窄到宽的命令顺序）+ 每步证明什么 + 未验证项 + 推荐停止点。" },
      { id: "s7", name: "交付发布", role: "developer", skill: "git-worktree-branch", instruction: "按 QoderWake /git-worktree-branch 完成「{{goal}}」交付：\n1) 仓库发现：git rev-parse --show-toplevel 定位仓库根；\n2) 确定主干与基线 ref；\n3) 从基线创建带时间戳的分支与 worktree，解析并给出绝对路径；\n4) 所有改动/测试/产物移入该 worktree；\n5) 在任务分支提交已验证 diff；\n6) 仅在凭据/远端/用户授权允许时发布 PR，未拿到 PR URL 不得宣称已发布；失败时给完整命令、错误、当前分支与提交。\n验证结论：\n{{prev}}", acceptance: "Git Worktree Status：worktree 绝对路径 + 分支 + 提交；发布成功需 PR URL，失败需完整失败信息。" }
    ],
  },
  {
    id: "sop_qw_bugfix", name: "QoderWake 缺陷修复", description: "QoderWake sde-debug 链：环境检测 → 复现 → 隔离 → 诊断 → 修复 → 强制交接测试 → 回归验证",
    source: "QoderWake skills: sde-debug / testing-strategy / code-review",
    steps: [
      { id: "s1", name: "环境检测与复现", role: "tester", skill: "sde-debug", instruction: "按 QoderWake /sde-debug 处理「{{goal}}」：\nStep 0 环境检测：探测可用 git/gh 工具，判断代码库是否为 git 仓库；若是则先建分支再动代码；\nStep 1 复现：明确期望 vs 实际行为、精确复现步骤、影响范围（何时开始/谁受影响），捕获契约锚点（现有测试/API 预期）；\nStep 2 隔离：缩小到具体组件/服务/代码路径，检查近期变更（部署/配置/依赖），审查日志与错误信息。", acceptance: "复现签名（错误类型+关键信息+命令上下文）、完整复现步骤、契约锚点、隔离出的可疑范围。" },
      { id: "s2", name: "诊断与根因", role: "developer", skill: "sde-debug", instruction: "按 QoderWake /sde-debug 诊断「{{goal}}」：\nStep 3 诊断：提出假设并验证、追踪代码路径、定位根因（非表象）、确定最小回归测试范围；\nFailure Loop Guard：跟踪失败签名，同一环境/依赖/构建签名出现两次即停止重复高成本命令，改用至少两种不同策略；仍无新证据才进入 environment-blocked 分支并写明原因；每次高成本重跑前必须给出新证据或新假设。\n复现结论：\n{{prev}}", acceptance: "根因陈述（非表象）+ 契约锚点 + 最小测试范围；若环境受阻，给出完整失败签名与已尝试的两种替代策略。" },
      { id: "s3", name: "修复实现", role: "developer", skill: "sde-debug", instruction: "按 QoderWake /sde-debug Step 4 修复「{{goal}}」：\n- 提出修复并解释、评估副作用与边界；\n- 运行回归测试确认未破坏既有行为；\n- 确认 happy/error/edge 路径的 testing-strategy 证据；\n- 产出实现级修复计划与风险说明；\n- 强制交接：向 /testing-strategy 提供复现签名、根因陈述、契约锚点、最小测试范围。\n诊断结论：\n{{prev}}", acceptance: "改动清单 + before signature -> command -> after result 闭环证据 + 面向测试阶段的 handoff 四要素。" },
      { id: "s4", name: "回归验证", role: "tester", skill: "testing-strategy", instruction: "按 QoderWake /testing-strategy 回归「{{goal}}」：\n- 先运行相关现有目标测试并捕获 baseline；\n- Prove-It：同一复现测试修复前失败、修复后通过；\n- happy/error/edge 三类显式证据；\n- 交付门禁证据：baseline → regression matrix → 剩余风险；\n- 发现根因确认+行为回归、修复验证将启动、受影响路径无测试、环境受阻等触发条件时明确上报。\n修复结论：\n{{prev}}", acceptance: "baseline + 回归矩阵 + happy/error/edge 证据 + 明确通过/不通过结论；不得弱化现有断言。" },
      { id: "s5", name: "交付评审", role: "developer", skill: "code-review", instruction: "按 QoderWake /code-review 交付门禁评审「{{goal}}」：\n检查交付物路径/命名/入口与声明一致；证据中至少有一个目标验收命令/结果；修复必须有 before signature -> command -> after result 闭环证据；检查现有测试完整性；给出 Verdict: Approve / Request Changes / Needs Discussion。\n回归结论：\n{{prev}}", acceptance: "交付门禁检查结论 + 闭环证据核验 + 明确 Verdict；门禁不完整时阻断交付建议。" }
    ],
  },
  {
    id: "sop_qw_delivery", name: "QoderWake 交付前验证", description: "QoderWake change-validation-planner + code-review：变更验证阶梯 → 评审 → 交付门禁（适合小改动快速过闸）",
    source: "QoderWake skills: change-validation-planner / code-review",
    steps: [
      { id: "s1", name: "变更面识别", role: "developer", skill: "change-validation-planner", instruction: "按 QoderWake /change-validation-planner 为「{{goal}}」识别变更面：列出改动的文件、接口、行为与契约影响，标注哪些是高风险边界；复用已有验证路径，不重复造轮子。", acceptance: "Scope reviewed：变更文件/接口/行为清单 + 高风险边界 + 可复用的现有检查。" },
      { id: "s2", name: "验证阶梯", role: "tester", skill: "change-validation-planner", instruction: "按 QoderWake /change-validation-planner 为「{{goal}}」规划并执行最窄可信验证：\n最窄定向测试 → 静态检查(lint/typecheck) → 跨边界时构建 → 必要时集成/全量；\n达到第一个可信置信边界即停；\n每步记录真实命令与结果；明确列出未验证项与推荐停止点。\n变更面：\n{{prev}}", acceptance: "Validation ladder（命令顺序）+ 每步证明什么 + 未验证项 + 推荐停止点。" },
      { id: "s3", name: "交付门禁评审", role: "developer", skill: "code-review", instruction: "按 QoderWake /code-review 为「{{goal}}」做交付门禁：\n核对交付物路径/命名/入口；确认至少一个目标验收命令/结果；修复需 before signature -> command -> after result 闭环；检查现有测试完整性；给 Verdict: Approve / Request Changes / Needs Discussion。\n验证结论：\n{{prev}}", acceptance: "交付门禁结论 + Verdict + 未闭环项清单。" }
    ],
  },
  {
    id: "sop_product_dev", name: "产品研发", description: "从需求澄清到交付汇总的标准研发流程",
    steps: [
      { id: "s1", name: "需求澄清", role: "product", instruction: "基于目标「{{goal}}」梳理需求规格：背景、用户场景、功能清单、非功能要求与验收清单。信息不足时列出需人工确认的问题，不要臆造。", acceptance: "输出结构化需求规格与验收清单，关键不确定点单独列出。" },
      { id: "s2", name: "技术方案", role: "developer", instruction: "针对目标「{{goal}}」给出技术方案：模块划分、关键接口、数据流、风险与备选方案。\n上一阶段结论：\n{{prev}}", acceptance: "方案可落地，含接口边界、风险点与工时粗估。" },
      { id: "s3", name: "编码实现", role: "developer", instruction: "按目标「{{goal}}」完成实现，只改自己工作区内的文件，并给出变更清单与自测结果。\n上一阶段结论：\n{{prev}}", acceptance: "有可验证的产出物、变更路径与自测记录；不确定处标注需人工确认。" },
      { id: "s4", name: "测试验证", role: "tester", instruction: "针对目标「{{goal}}」设计并执行验证：正向、边界、异常场景，记录实际结果。\n上一阶段结论：\n{{prev}}", acceptance: "输出用例与结果、缺陷清单（含严重程度与复现步骤）、是否通过结论。" },
      { id: "s5", name: "交付汇总", role: "product", instruction: "汇总目标「{{goal}}」全流程产出，给出交付结论、遗留问题与后续建议。\n各阶段结论：\n{{prev}}", acceptance: "一页式汇总：结论、交付物、风险/遗留、下一步。" }
    ],
  },
  {
    id: "sop_bugfix", name: "缺陷修复", description: "问题定位 → 修复 → 回归 → 关闭",
    steps: [
      { id: "s1", name: "问题定位", role: "tester", instruction: "针对「{{goal}}」复现并定位问题：现象、复现步骤、影响范围、初步根因。", acceptance: "明确的复现路径与根因判断，无法复现时说明环境与条件。" },
      { id: "s2", name: "修复方案", role: "developer", instruction: "针对「{{goal}}」给出修复方案与回归范围。\n定位结论：\n{{prev}}", acceptance: "方案含改动点、副作用评估与回归清单。" },
      { id: "s3", name: "代码修复", role: "developer", instruction: "按方案修复「{{goal}}」，只改自己工作区内的文件。\n方案结论：\n{{prev}}", acceptance: "改动清单、修复说明、自测结果。" },
      { id: "s4", name: "回归验证", role: "tester", instruction: "对「{{goal}}」执行回归验证，确认原问题已修复且无新增缺陷。\n修复结论：\n{{prev}}", acceptance: "回归用例与结果、明确通过/不通过结论。" }
    ],
  },
  {
    id: "sop_content", name: "内容创作", description: "选题 → 资料 → 初稿 → 评审 → 定稿",
    steps: [
      { id: "s1", name: "选题立项", role: "product", instruction: "围绕「{{goal}}」明确受众、目标、核心观点与大纲。", acceptance: "大纲含核心观点、章节结构与交付形式。" },
      { id: "s2", name: "资料收集", role: "product", instruction: "为「{{goal}}」收集支撑资料与数据，标注来源与可信度。\n大纲：\n{{prev}}", acceptance: "资料清单含来源、关键结论与可用性判断。" },
      { id: "s3", name: "初稿撰写", role: "product", instruction: "按大纲完成「{{goal}}」初稿，结构化输出全文。\n资料结论：\n{{prev}}", acceptance: "完整初稿，含标题、正文与引用。" },
      { id: "s4", name: "评审修改", role: "tester", instruction: "评审「{{goal}}」初稿并给出具体修改意见。\n初稿：\n{{prev}}", acceptance: "逐条修改意见，标注必须修改项。" },
      { id: "s5", name: "定稿发布", role: "developer", instruction: "根据评审意见完成「{{goal}}」终稿。\n评审意见：\n{{prev}}", acceptance: "终稿全文 + 修改说明。" }
    ],
  }
];

// ---------- 工具函数 ----------
const now = () => new Date().toISOString();
// 编辑锁已按用户要求禁用：始终允许写操作，不再读取/依赖持久化锁定状态
let EDIT_UNLOCKED = true;

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

// ---------- 用量与费用口径 ----------
// Pi 的 usage.cost 是 USD；totalFromProvider=true 表示服务商直接返回了账单金额。
// 没有账单金额的服务商（DeepSeek 等）用模型返回的真实 token × 模型单价计算。
let fxState = { usdCny: 7, date: "", source: "fallback", fetchedAt: 0, checkedAt: "" };
try {
  const cached = readJsonSafe(FX_RATE_FILE, null);
  const rate = Number(cached?.usdCny);
  if (cached && Number.isFinite(rate) && rate > 0) {
    fxState = { ...fxState, ...cached, usdCny: rate };
  }
} catch {}

function fxPublic() {
  return { usdCny: fxState.usdCny, date: fxState.date || "", source: fxState.source || "fallback" };
}

function usdToCny(usd) {
  const n = Number(usd);
  return Number.isFinite(n) ? n * fxState.usdCny : 0;
}

async function refreshUsdCnyRate(force = false) {
  if (!force && fxState.fetchedAt && Date.now() - fxState.fetchedAt < FX_TTL_MS) return fxPublic();
  try {
    const resp = await fetch("https://api.frankfurter.app/latest?from=USD&to=CNY", {
      signal: AbortSignal.timeout(4000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const rate = Number(data?.rates?.CNY);
      if (Number.isFinite(rate) && rate > 0) {
        fxState = {
          usdCny: rate,
          date: String(data.date || ""),
          source: "frankfurter.app",
          fetchedAt: Date.now(),
          checkedAt: now(),
        };
        writeJson(FX_RATE_FILE, fxState);
      }
    }
  } catch {
    // 离线或接口不可用时沿用上一次缓存，不影响管理端其它功能
  }
  return fxPublic();
}

function localDateKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// DeepSeek 官方按北京时间和中国法定节假日实行峰谷价：空闲时段价格为高峰的一半。
let cnHolidays = new Set();
try {
  const days = readJsonSafe(CN_HOLIDAYS_FILE, []);
  if (Array.isArray(days)) cnHolidays = new Set(days.map((d) => String(d)));
} catch {}

function beijingDate(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 60 * 60 * 1000);
}

function beijingDateKey(ts) {
  const d = beijingDate(ts);
  if (!d) return "";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function isDeepSeekPeak(ts) {
  const d = beijingDate(ts);
  if (!d) return false;
  if (cnHolidays.has(beijingDateKey(ts))) return false;
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (mins >= 9 * 60 && mins < 12 * 60) || (mins >= 14 * 60 && mins < 18 * 60);
}

/** DeepSeek 官方人民币价：元 / 百万 tokens，[空闲, 高峰] */
function deepseekRates(model, provider) {
  const id = String(model || "").toLowerCase();
  const p = String(provider || "").toLowerCase();
  const isDeepSeek = p === "deepseek" || id.startsWith("deepseek") || id.includes("deepseek");
  if (!isDeepSeek) return null;
  if (id.includes("v4-pro") || id.includes("v4pro")) {
    return { hit: [0.15, 0.30], miss: [4.5, 9.0], output: [13.5, 27.0] };
  }
  return { hit: [0.02, 0.04], miss: [1, 2], output: [4, 8] };
}

function isDomesticProvider(provider) {
  const id = String(provider || "").toLowerCase();
  return PROVIDER_LABELS?.[id]?.region === "cn"
    || /^(deepseek|qwen|moonshot|kimi|minimax|zai|xiaomi|ant-ling)/.test(id);
}

/**
 * 计算人民币金额：
 * - DeepSeek：按官方人民币峰谷价 × 模型真实返回的 token 分类，直接算出人民币，不经过汇率；
 * - 其它国内模型：按国内模型单价口径展示；
 * - 海外服务商：账单金额（USD）按实时汇率折算人民币。
 */
function usageCostInfo(u, meta = {}) {
  const rates = deepseekRates(meta.model, meta.provider);
  if (rates) {
    const peak = isDeepSeekPeak(meta.ts || Date.now());
    const i = peak ? 1 : 0;
    const cny = (u.input / 1e6) * rates.miss[i] + (u.cacheRead / 1e6) * rates.hit[i] + (u.output / 1e6) * rates.output[i];
    return {
      cny,
      mode: peak ? "deepseek-peak" : "deepseek-offpeak",
      label: peak ? "DeepSeek 高峰价" : "DeepSeek 空闲价（5折）",
    };
  }
  const cny = usdToCny(u.cost.total);
  if (isDomesticProvider(meta.provider)) return { cny, mode: "domestic", label: "国内模型单价" };
  if (u.cost.totalFromProvider) return { cny, mode: "provider", label: "服务商账单" };
  return { cny, mode: "catalog", label: "模型单价" };
}

function priceModeLabel(mode) {
  return {
    "deepseek-peak": "DeepSeek 高峰价",
    "deepseek-offpeak": "DeepSeek 空闲价（5折）",
    domestic: "国内模型单价",
    provider: "服务商账单",
    catalog: "模型单价",
  }[mode] || "模型单价";
}

function normalizeUsage(u) {
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

/** 合并同一轮（可能多次工具调用）的 usage；只要有一条不是账单金额，就按计算金额处理 */
function mergeUsage(a, b) {
  const x = normalizeUsage(a), y = normalizeUsage(b);
  if (!x) return y;
  if (!y) return x;
  const sum = (k) => x[k] + y[k];
  return {
    input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"),
    reasoning: sum("reasoning"), totalTokens: sum("totalTokens"),
    cost: {
      input: x.cost.input + y.cost.input,
      output: x.cost.output + y.cost.output,
      cacheRead: x.cost.cacheRead + y.cost.cacheRead,
      cacheWrite: x.cost.cacheWrite + y.cost.cacheWrite,
      total: x.cost.total + y.cost.total,
      totalFromProvider: x.cost.totalFromProvider === true && y.cost.totalFromProvider === true,
    },
  };
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
  // 兼容旧调用：保留签名，但编辑锁已禁用，不再拦截任何写操作
  return;
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

/**
 * 会话名展示清洗：旧的任务会话把内部 task id 拼在名字里（如
 *「任务 task_mwxmv… · 测试合作」），是给机器看的；列表与聊天标题统一去掉 id。
 * 不改会话文件本身，只在读取时转换，老会话立即变可读。
 */
function friendlySessionName(name) {
  const s = String(name || "");
  return s
    .replace(/^任务\s+task_[a-z0-9_-]+\s*[·•:：-]\s*/i, "任务 · ")
    .replace(/^任务\s+task_[a-z0-9_-]+\s*$/i, "任务");
}

// ---------- 会话自动清理 ----------
// 默认关闭。开启后按「会话文件最后修改时间」清理 N 天未更新的会话，真正删除以释放空间。
// 三重保护：管家固定会话、当前正在 RPC 对话的会话、最近 minKeep 条（无论是否过期）。
const RETENTION_DEFAULTS = { enabled: false, days: 30, minKeep: 3 };

function readRetentionConfig() {
  const c = readJsonSafe(SESSION_RETENTION_FILE, {});
  const days = Number(c.days);
  const minKeep = Number(c.minKeep);
  return {
    enabled: c.enabled === true,
    days: Number.isFinite(days) && days > 0 ? days : RETENTION_DEFAULTS.days,
    minKeep: Number.isInteger(minKeep) && minKeep >= 0 ? minKeep : RETENTION_DEFAULTS.minKeep,
    lastRunAt: c.lastRunAt || null,
    lastDeleted: Number(c.lastDeleted) || 0,
    lastFreedBytes: Number(c.lastFreedBytes) || 0,
  };
}

function writeRetentionConfig(cfg) {
  writeJson(SESSION_RETENTION_FILE, cfg);
}

/** 受保护会话：管家固定会话 + 当前正在 RPC 对话的会话 */
function protectedSessionFiles() {
  const set = new Set();
  try {
    const b = readJsonSafe(BUTLER_STATE_FILE, {});
    if (b.sessionFile) set.add(resolve(b.sessionFile));
  } catch {}
  for (const f of chatSessions.keys()) set.add(resolve(f));
  return set;
}

/**
 * 扫描会话并标记过期状态。空闲时间以文件 mtime 为准——Pi 每次追加消息都会更新 mtime，
 * 比解析jsonl首行时间戳更可靠（时间戳可能因时钟偏差或手工编辑失真）。
 */
function scanRetentionCandidates(cfg = readRetentionConfig()) {
  const cutoff = Date.now() - cfg.days * 24 * 60 * 60 * 1000;
  const protectedSet = protectedSessionFiles();
  const all = [];
  if (existsSync(SESSION_DIR)) {
    try {
      for (const d of readdirSync(SESSION_DIR, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const dir = join(SESSION_DIR, d.name);
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".jsonl")) continue;
          const p = join(dir, f);
          try {
            const st = statSync(p);
            all.push({ file: p, mtimeMs: st.mtimeMs, bytes: st.size, protected: protectedSet.has(resolve(p)) });
          } catch {}
        }
      }
    } catch {}
  }
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // 最近 minKeep 条无论是否过期都保留，避免一次把会话清空
  const keep = new Set(all.slice(0, cfg.minKeep).map((x) => x.file));
  for (const x of all) {
    x.expired = !x.protected && !keep.has(x.file) && x.mtimeMs < cutoff;
    x.reason = x.protected ? "受保护" : keep.has(x.file) ? "最少保留" : x.expired ? "过期" : "保留中";
  }
  return all;
}

/** 执行清理：真正删除文件释放空间；结果记入轻量日志（不备份，否则无法释放空间） */
function runSessionRetention(reason = "manual") {
  const cfg = readRetentionConfig();
  if (!cfg.enabled) return { ok: true, skipped: "disabled", deleted: 0, freedBytes: 0, cfg };
  let butlerFile = "";
  try { butlerFile = readJsonSafe(BUTLER_STATE_FILE, {}).sessionFile || ""; } catch {}
  let deleted = 0, freedBytes = 0;
  const files = [];
  for (const x of scanRetentionCandidates(cfg).filter((c) => c.expired)) {
    try {
      // 二次确认：扫描到执行之间用户可能刚好打开了这条会话
      if (x.file === butlerFile || chatSessions.has(x.file)) continue;
      if (!safePath(x.file) || !existsSync(x.file)) continue;
      unlinkSync(x.file);
      deleted++; freedBytes += x.bytes;
      files.push({ file: x.file, bytes: x.bytes, idleDays: Math.round((Date.now() - x.mtimeMs) / 86400000) });
    } catch (e) {
      files.push({ file: x.file, error: e.message });
    }
  }
  const next = { ...cfg, lastRunAt: now(), lastDeleted: deleted, lastFreedBytes: freedBytes };
  writeRetentionConfig(next);
  let log = readJsonSafe(SESSION_RETENTION_LOG, []);
  if (!Array.isArray(log)) log = [];
  log.unshift({ at: next.lastRunAt, reason, deleted, freedBytes, files });
  writeJson(SESSION_RETENTION_LOG, log.slice(0, 20));
  return { ok: true, deleted, freedBytes, files, at: next.lastRunAt, cfg: next };
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
          let totalTokens = 0, totalCostUsd = 0, totalCostCny = 0, todayTokens = 0, todayCostUsd = 0, todayCostCny = 0;
          let billedUsd = 0, computedUsd = 0, billedCount = 0, computedCount = 0;
          const priceModes = new Set();
          const usageByDay = {};
          const usageByModel = {};
          const todayKey = localDateKey(Date.now());
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
                const u = normalizeUsage(e.message?.usage);
                if (u) {
                  const ts = e.timestamp || (e.message?.timestamp ? new Date(e.message.timestamp).toISOString() : "");
                  const inToday = !!ts && localDateKey(ts) === todayKey;
                  const costInfo = usageCostInfo(u, { provider: e.message?.provider, model: e.message?.model, ts });
                  totalTokens += u.totalTokens;
                  totalCostUsd += u.cost.total;
                  totalCostCny += costInfo.cny;
                  if (inToday) {
                    todayTokens += u.totalTokens;
                    todayCostUsd += u.cost.total;
                    todayCostCny += costInfo.cny;
                  }
                  priceModes.add(costInfo.mode);
                  // 日趋势 / 按模型统计：口径与会话累计一致，均来自原始 usage
                  const day = localDateKey(ts || header.timestamp || Date.now()) || "unknown";
                  const provider = String(e.message?.provider || "unknown");
                  const model = String(e.message?.model || "unknown");
                  const modelKey = `${provider}|${model}`;
                  if (!usageByDay[day]) usageByDay[day] = { totalTokens: 0, totalCostCny: 0, messages: 0, models: {} };
                  usageByDay[day].totalTokens += u.totalTokens;
                  usageByDay[day].totalCostCny += costInfo.cny;
                  usageByDay[day].messages++;
                  if (!usageByDay[day].models[modelKey]) usageByDay[day].models[modelKey] = { totalTokens: 0, totalCostCny: 0, messages: 0 };
                  const db = usageByDay[day].models[modelKey];
                  db.totalTokens += u.totalTokens;
                  db.totalCostCny += costInfo.cny;
                  db.messages++;
                  if (!usageByModel[modelKey]) usageByModel[modelKey] = {
                    provider, model, totalTokens: 0, totalCostCny: 0, messages: 0,
                    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
                  };
                  const mb = usageByModel[modelKey];
                  mb.totalTokens += u.totalTokens;
                  mb.totalCostCny += costInfo.cny;
                  mb.messages++;
                  mb.input += u.input; mb.output += u.output; mb.cacheRead += u.cacheRead;
                  mb.cacheWrite += u.cacheWrite; mb.reasoning += u.reasoning;
                  if (u.cost.total > 0) {
                    if (costInfo.mode === "provider" && u.cost.totalFromProvider) { billedUsd += u.cost.total; billedCount++; }
                    else { computedUsd += u.cost.total; computedCount++; }
                  }
                }
              }
              if (e.timestamp && e.timestamp > lastTs) lastTs = e.timestamp;
            } catch {}
          }
          // 归属员工：从 cwd（org/workspaces/emp-xxx）或会话目录名解析
          const empId = (header.cwd || "").match(/org[\\/]workspaces[\\/](emp-[a-z0-9]+)/)?.[1]
            || d.name.match(/org-workspaces-(emp-[a-z0-9]+)/)?.[1] || null;
          out.push({
            file: p,
            id: header.id || f.replace(/\.jsonl$/, ""),
            cwd: header.cwd || "",
            employeeId: empId,
            name: friendlySessionName(sessionName) || userText || f,
            preview: userText,
            version: header.version || 1,
            messages: msgCount,
            bytes: Buffer.byteLength(txt),
            lastTs,
            totalTokens,
            totalCost: totalCostUsd, // 兼容旧字段：USD
            totalCostCny,
            todayTokens,
            todayCostUsd,
            todayCostCny,
            costBasis: billedCount && computedCount ? "mixed" : billedCount ? "provider" : computedCount ? "computed" : "none",
            priceModes: [...priceModes],
            priceLabel: priceModes.size === 1 ? priceModeLabel([...priceModes][0]) : (priceModes.size > 1 ? "混合计价" : ""),
            providerCostUsd: billedUsd,
            computedCostUsd: computedUsd,
            usageByDay,
            usageByModel,
          });
        } catch {}
      }
    }
  } catch {}
  return out.sort((a, b) => (b.lastTs || "").localeCompare(a.lastTs || ""));
}

// ---------- 员工累计 token / 金额（可重置） ----------
// 计数源统一为 Pi 会话的 message_end：普通对话、群聊 @ 唤醒、群 SOP 任务都会落到员工工作区的会话文件，
// 群消息的 usage 是同一份数据的副本，不再重复累加。重置只清零账本，不删除原始会话/群消息。
function sessionEmployeeId(file) {
  const s = String(file || "");
  return s.match(/org[\\/]workspaces[\\/](emp-[a-z0-9]+)/)?.[1]
    || s.match(/org-workspaces-(emp-[a-z0-9]+)/)?.[1] || "";
}

function emptyEmployeeUsage() {
  return { totalTokens: 0, totalCostCny: 0, resetAt: "", updatedAt: "" };
}

function readEmployeeUsageData() {
  const d = readJsonSafe(ORG_EMPLOYEE_USAGE_FILE, null);
  if (!d || typeof d !== "object" || !d.employees || typeof d.employees !== "object") {
    return { version: 1, seededAt: "", employees: {} };
  }
  return { version: 1, seededAt: String(d.seededAt || ""), employees: d.employees };
}

/** 首次读取时从已有会话播种历史累计，之后只靠 message_end 增量，避免重复 */
function ensureEmployeeUsageSeeded() {
  const d = readEmployeeUsageData();
  if (d.seededAt) return d;
  for (const s of collectSessions()) {
    if (!s.employeeId) continue;
    const b = d.employees[s.employeeId] ||= emptyEmployeeUsage();
    b.totalTokens += Number(s.totalTokens) || 0;
    b.totalCostCny += Number(s.totalCostCny) || 0;
    b.updatedAt = now();
  }
  d.seededAt = now();
  writeOrgFile(ORG_EMPLOYEE_USAGE_FILE, d);
  return d;
}

function employeeUsageSummary() {
  const d = ensureEmployeeUsageSeeded();
  return { seededAt: d.seededAt, employees: d.employees };
}

function recordEmployeeUsage(employeeId, tokens, costCny) {
  if (!employeeId || !(Number(tokens) > 0 || Number(costCny) > 0)) return;
  const d = ensureEmployeeUsageSeeded();
  const b = d.employees[employeeId] ||= emptyEmployeeUsage();
  b.totalTokens += Number(tokens) || 0;
  b.totalCostCny += Number(costCny) || 0;
  b.updatedAt = now();
  writeOrgFile(ORG_EMPLOYEE_USAGE_FILE, d);
  try { orgEmit("employee_usage", { employeeId, ...b }); } catch {}
}

function resetEmployeeUsage(employeeId) {
  const d = ensureEmployeeUsageSeeded();
  const ids = employeeId === "__all__" ? listOrgEmployees().map((e) => e.id) : [employeeId];
  const out = {};
  for (const id of ids) {
    if (!id) continue;
    const b = d.employees[id] ||= emptyEmployeeUsage();
    b.totalTokens = 0;
    b.totalCostCny = 0;
    b.resetAt = now();
    b.updatedAt = b.resetAt;
    out[id] = { ...b };
  }
  writeOrgFile(ORG_EMPLOYEE_USAGE_FILE, d);
  try { orgEmit("employee_usage", { employeeId: employeeId || "__all__", reset: true, employees: out }); } catch {}
  return out;
}

/** 工具参数摘要：给折叠条显示一行简短说明 */
function toolArgSummary(args) {
  if (!args) return "";
  if (typeof args === "string") return args.replace(/\s+/g, " ").slice(0, 120);
  for (const k of ["command", "path", "pattern", "file", "url", "query"]) {
    if (args[k]) return String(args[k]).replace(/\s+/g, " ").slice(0, 120);
  }
  try { return JSON.stringify(args).replace(/\s+/g, " ").slice(0, 120); } catch { return ""; }
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
        // 把「正文」与「过程块（thinking / 工具调用）」分开：正文给人看，过程块交给前端折叠展示
        let text = "";
        const blocks = [];
        if (typeof c === "string") {
          text = c;
        } else if (Array.isArray(c)) {
          for (const b of c) {
            if (!b || typeof b !== "object") continue;
            if (b.type === "text") text += (b.text || "") + "\n";
            else if (b.type === "thinking") blocks.push({ kind: "thinking", text: String(b.thinking || "").slice(0, 4000) });
            else if (b.type === "toolCall" || b.type === "tool_call")
              blocks.push({ kind: "tool", name: String(b.name || b.toolName || "工具"), detail: toolArgSummary(b.arguments || b.args) });
            else if (b.type === "toolResult" || b.type === "tool_result")
              blocks.push({ kind: "toolResult", name: String(b.name || b.toolName || "工具"), text: String(typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "")).slice(0, 1000) });
          }
        } else {
          text = String(c ?? "");
        }
        const usage = normalizeUsage(e.message?.usage);
        const costInfo = usage ? usageCostInfo(usage, {
          provider: e.message.provider || "",
          model: e.message.model || "",
          ts: e.timestamp || (e.message.timestamp ? new Date(e.message.timestamp).toISOString() : Date.now()),
        }) : null;
        entries.push({
          id: e.id,
          parentId: e.parentId,
          role: e.message.role,
          model: e.message.model || "",
          provider: e.message.provider || "",
          text: String(text).trim().slice(0, 4000),
          blocks,
          ts: e.timestamp,
          isError: e.message.isError || false,
          usage,
          costCny: costInfo?.cny || 0,
          priceLabel: costInfo?.label || "",
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

/**
 * 会话右上角模型下拉的数据源：只列「已经设置」的模型。
 * 纳入范围：
 *  - models.json 里配了 baseUrl / apiKey / models 的 Provider（其内置模型均可用）
 *  - models.json 的 modelOverrides（新增或覆盖的模型）
 *  - 管理端「新增模型」写入 model-catalog.json 的索引
 *  - auth.json 里有凭证的 Provider
 *  - settings 里的 defaultProvider / defaultModel / enabledModels
 * 不列未配置的纯内置目录，避免下拉出现一堆点不动的选项。
 */
function collectConfiguredModels() {
  const userCfg = readJsonSafe(join(AGENT_DIR, "models.json"), {});
  const auth = readJsonSafe(join(AGENT_DIR, "auth.json"), {});
  const settings = getSettings("user").data || {};
  const index = readJsonSafe(USER_MODEL_INDEX_FILE, { version: 1, entries: [] });
  const catalog = loadProviderCatalog();

  const providerIds = new Set();
  for (const [id, p] of Object.entries(userCfg.providers ?? {})) {
    if (p && (p.apiKey || p.baseUrl || (Array.isArray(p.models) && p.models.length))) providerIds.add(id);
  }
  for (const [id, cred] of Object.entries(auth)) {
    if (cred && (cred.key || cred.access || cred.env || cred.type === "oauth")) providerIds.add(id);
  }
  for (const e of index.entries ?? []) if (e?.providerId) providerIds.add(e.providerId);
  if (settings.defaultProvider) providerIds.add(settings.defaultProvider);

  const modelIds = new Set();
  for (const id of Object.keys(userCfg.modelOverrides ?? {})) modelIds.add(id);
  for (const id of settings.enabledModels ?? []) if (id) modelIds.add(id);
  if (settings.defaultModel) modelIds.add(settings.defaultModel);
  for (const e of index.entries ?? []) if (e?.modelId) modelIds.add(e.modelId);
  for (const p of Object.values(userCfg.providers ?? {})) {
    for (const m of p?.models ?? []) {
      const id = typeof m === "string" ? m : m?.id;
      if (id) modelIds.add(id);
    }
  }

  // 显式模型 → 归属 provider 映射：避免同一模型 ID 被挂到所有 provider 名下
  // （例如 defaultModel=deepseek-v4-pro 不应出现在「通义千问」下）
  const modelProviderMap = new Map();
  const mapModel = (modelId, providerId) => {
    if (!modelId || !providerId) return;
    if (!modelProviderMap.has(modelId)) modelProviderMap.set(modelId, new Set());
    modelProviderMap.get(modelId).add(providerId);
  };
  if (settings.defaultModel) mapModel(settings.defaultModel, settings.defaultProvider);
  for (const e of index.entries ?? []) mapModel(e.modelId, e.providerId);
  // modelOverrides / enabledModels 没有 provider 归属，只保留给已配置的 provider

  const providers = [];
  for (const pc of catalog) {
    const configured = providerIds.has(pc.id);
    const models = (pc.models || []).filter((m) => configured || modelProviderMap.get(m.id)?.has(pc.id));
    if (!models.length) continue;
    providers.push({
      id: pc.id,
      label: pc.label,
      region: pc.region,
      models: models.map((m) => ({ id: m.id, name: m.name || m.id })),
    });
  }

  // 索引里出现但全量目录未收录的 Provider（极端情况）兜底列出
  for (const e of index.entries ?? []) {
    if (!e?.modelId || !e?.providerId || providerIds.has(e.providerId)) continue;
    if (providers.some((p) => p.id === e.providerId && p.models.some((m) => m.id === e.modelId))) continue;
    let target = providers.find((p) => p.id === e.providerId);
    if (!target) {
      target = { id: e.providerId, label: e.providerName || e.providerId, region: "custom", models: [] };
      providers.push(target);
    }
    target.models.push({ id: e.modelId, name: e.name || e.modelId });
  }

  return {
    providers,
    total: providers.reduce((n, p) => n + p.models.length, 0),
    defaultProvider: settings.defaultProvider || "",
    defaultModel: settings.defaultModel || "",
  };
}

/**
 * 模型连通性校验：直接向 Provider API 发一次最小请求，
 * 验证 Base URL / API Key / 模型 ID 是否真的可用。只回传脱敏结果。
 */
async function testModelConnection(provider, modelId) {
  const started = Date.now();
  const userCfg = readJsonSafe(join(AGENT_DIR, "models.json"), {});
  const auth = readJsonSafe(join(AGENT_DIR, "auth.json"), {});
  const pcfg = userCfg.providers?.[provider] || {};
  const catalog = loadProviderCatalog().find((p) => p.id === provider) || {};
  const baseUrl = String(pcfg.baseUrl || catalog.baseUrl || "").replace(/\/+$/, "");
  const secret = String(pcfg.apiKey || auth[provider]?.key || auth[provider]?.access || "");
  const api = String(pcfg.api || catalog.apis?.[0] || "openai-completions");

  if (!baseUrl) return { ok: false, error: "未配置 Base URL" };
  if (!secret) return { ok: false, error: "未配置 API Key" };

  const anthropic = api.toLowerCase().includes("anthropic");
  const url = anthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`;
  const headers = anthropic
    ? { "content-type": "application/json", "x-api-key": secret, "anthropic-version": "2023-06-01" }
    : { "content-type": "application/json", authorization: `Bearer ${secret}` };
  const payload = anthropic
    ? { model: modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }
    : { model: modelId, max_tokens: 1, stream: false, messages: [{ role: "user", content: "ping" }] };

  let resp, text;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: ctl.signal });
    clearTimeout(timer);
    text = await resp.text();
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: e.name === "AbortError" ? "请求超时（12 秒）" : `连接失败：${e.message}`,
    };
  }

  let detail = "";
  try {
    const j = JSON.parse(text);
    detail = j.error?.message || j.message || j.error || "";
  } catch { detail = text.slice(0, 160); }
  detail = String(detail || "");
  if (secret) detail = detail.split(secret).join("***");
  detail = detail.slice(0, 200);

  if (!resp.ok)
    return { ok: false, latencyMs: Date.now() - started, status: resp.status, error: `HTTP ${resp.status}${detail ? ` · ${detail}` : ""}` };
  return { ok: true, latencyMs: Date.now() - started, status: resp.status };
}

/**
 * 一次性 LLM 调用（供「会话精简总结」用）：复用用户已配置的 Provider 凭证，
 * 直接向 API 发单请求拿到文本与 usage。不写会话、不落盘，属于额外消耗，
 * 前端仅在会话级开关打开时才调用。
 */
async function callLlmOnce(provider, modelId, systemPrompt, userText, maxTokens = 800) {
  const userCfg = readJsonSafe(join(AGENT_DIR, "models.json"), {});
  const auth = readJsonSafe(join(AGENT_DIR, "auth.json"), {});
  const pcfg = userCfg.providers?.[provider] || {};
  const catalog = loadProviderCatalog().find((p) => p.id === provider) || {};
  const baseUrl = String(pcfg.baseUrl || catalog.baseUrl || "").replace(/\/+$/, "");
  const secret = String(pcfg.apiKey || auth[provider]?.key || auth[provider]?.access || "");
  const api = String(pcfg.api || catalog.apis?.[0] || "openai-completions");
  if (!baseUrl) throw Object.assign(new Error("未配置 Base URL"), { status: 400 });
  if (!secret) throw Object.assign(new Error("未配置 API Key"), { status: 400 });

  const anthropic = api.toLowerCase().includes("anthropic");
  const url = anthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`;
  const headers = anthropic
    ? { "content-type": "application/json", "x-api-key": secret, "anthropic-version": "2023-06-01" }
    : { "content-type": "application/json", authorization: `Bearer ${secret}` };
  const payload = anthropic
    ? { model: modelId, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: "user", content: userText }] }
    : { model: modelId, max_tokens: maxTokens, stream: false, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userText }] };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  let resp, j;
  try {
    resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: ctl.signal });
    const txt = await resp.text();
    try { j = JSON.parse(txt); } catch { throw Object.assign(new Error(`响应解析失败：${txt.slice(0, 120)}`), { status: 502 }); }
  } catch (e) {
    if (e.status) throw e;
    throw Object.assign(new Error(e.name === "AbortError" ? "总结请求超时（30 秒）" : `总结请求失败：${e.message}`), { status: 502 });
  } finally { clearTimeout(timer); }

  if (!resp.ok) {
    let detail = String(j?.error?.message || j?.message || j?.error || "").split(secret).join("***").slice(0, 200);
    throw Object.assign(new Error(`HTTP ${resp.status}${detail ? ` · ${detail}` : ""}`), { status: 502 });
  }
  let text = "";
  if (anthropic) {
    text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  } else {
    const ch = j.choices?.[0];
    text = typeof ch?.message?.content === "string" ? ch.message.content
      : (Array.isArray(ch?.message?.content) ? ch.message.content.map((b) => b.text || "").join("") : (ch?.text || ""));
  }
  const u = j.usage || {};
  const input = u.prompt_tokens || u.input_tokens || 0;
  const cacheRead = u.prompt_tokens_details?.cached_tokens || u.cache_read_input_tokens || 0;
  const output = u.completion_tokens || u.output_tokens || 0;
  const usage = normalizeUsage({ input, cacheRead, output, totalTokens: input + cacheRead + output });
  return { text: String(text || "").trim(), usage, provider, modelId };
}

const SUMMARY_SYSTEM = `你是信息管理助手。把用户给的「员工回复」压缩成极简要点，让人只看结论就能决策。
要求：
- 只输出两部分：【结论】和【原因/要点】，每部分最多 3 条，每条一句话。
- 用中文，去掉过程细节、命令、ID、路径、时间戳、寒暄。
- 保留真实结论（尤其"已完成/受阻/需决策"这类判断），不要臆造。
- 不要 Markdown 标题符号，不要代码块。格式示例：
结论
- xxx
- xxx
原因/要点
- xxx`;

/** 概览 */
function collectOverview() {
  const sessions = collectSessions();
  const resources = collectResources();
  const userSettings = getSettings("user").data;
  // 全局用量始终从原始会话日志重算，不读员工累计账本；员工重置账本不会影响这里。
  const dayMap = {};
  const modelMap = {};
  for (const s of sessions) {
    for (const [day, b] of Object.entries(s.usageByDay || {})) {
      if (!dayMap[day]) dayMap[day] = { date: day, totalTokens: 0, totalCostCny: 0, messages: 0, models: {} };
      dayMap[day].totalTokens += Number(b.totalTokens) || 0;
      dayMap[day].totalCostCny += Number(b.totalCostCny) || 0;
      dayMap[day].messages += Number(b.messages) || 0;
      for (const [key, mb] of Object.entries(b.models || {})) {
        if (!dayMap[day].models[key]) dayMap[day].models[key] = { totalTokens: 0, totalCostCny: 0, messages: 0 };
        const t = dayMap[day].models[key];
        t.totalTokens += Number(mb.totalTokens) || 0;
        t.totalCostCny += Number(mb.totalCostCny) || 0;
        t.messages += Number(mb.messages) || 0;
      }
    }
    for (const [key, b] of Object.entries(s.usageByModel || {})) {
      if (!modelMap[key]) modelMap[key] = { ...b, key, totalTokens: 0, totalCostCny: 0, messages: 0 };
      const m = modelMap[key];
      for (const k of ["totalTokens", "totalCostCny", "messages", "input", "output", "cacheRead", "cacheWrite", "reasoning"])
        m[k] = (Number(m[k]) || 0) + (Number(b[k]) || 0);
    }
  }
  const modelsCfg = readJsonSafe(join(AGENT_DIR, "models.json"), {});
  const overrides = modelsCfg.modelOverrides && typeof modelsCfg.modelOverrides === "object" ? modelsCfg.modelOverrides : {};
  const usageTimeline = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));
  const usageByModel = Object.values(modelMap)
    .map((m) => ({ ...m, label: overrides[m.model]?.name || `${m.provider}/${m.model}` }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    version: "1.0.0",
    now: now(),
    workspace: WORKSPACE,
    agentDir: AGENT_DIR,
    runtimeAgentDir: RUNTIME_AGENT_DIR,
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
      totalCostCny: sessions.reduce((s, x) => s + x.totalCostCny, 0),
      todayTokens: sessions.reduce((s, x) => s + x.todayTokens, 0),
      todayCostUsd: sessions.reduce((s, x) => s + x.todayCostUsd, 0),
      todayCostCny: sessions.reduce((s, x) => s + x.todayCostCny, 0),
      priceModes: [...new Set(sessions.flatMap((x) => x.priceModes || []))],
    },
    usageSource: "原始会话日志（员工累计账本重置不影响）",
    usageTimeline,
    usageByModel,
    fx: fxPublic(),
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

/** 安全查找员工显示名：查不到（如 system / 已删除员工）不抛异常，回退到原始 id */
function employeeNameSafe(id) {
  if (id === "human") return "我（用户）";
  if (id === "system") return "系统";
  try { return getOrgEmployee(String(id)).data?.name || String(id); } catch { return String(id); }
}

function listOrgDepartments() {
  const data = readOrgJson(ORG_DEPARTMENTS_FILE, DEFAULT_DEPARTMENTS);
  return Array.isArray(data) && data.length ? data : DEFAULT_DEPARTMENTS;
}
/** 员工所属部门（或 null） */
function getEmployeeDepartment(employee) {
  if (!employee?.department) return null;
  return listOrgDepartments().find((d) => d.id === employee.department) || null;
}
/**
 * 员工的有效技能（三层合并去重，顺序：部门 → 团队 → 个人）。
 * - 部门技能 department.skills：基础层，所有场景生效；
 * - 团队技能 group.skills：仅传入 group 时叠加（群聊/SOP 场景）；
 * - 员工个人 skills：专属层，始终生效。
 * 同名技能自动去重；个人层无法"删除"部门/团队技能（如需排除请调整上级配置）。
 */
function effectiveEmployeeSkills(employee, group = null) {
  const dept = getEmployeeDepartment(employee);
  const inherited = Array.isArray(dept?.skills) ? dept.skills.map((s) => String(s).trim()).filter(Boolean) : [];
  const team = group && Array.isArray(group.skills) ? group.skills.map((s) => String(s).trim()).filter(Boolean) : [];
  const own = Array.isArray(employee?.skills) ? employee.skills.map((s) => String(s).trim()).filter(Boolean) : [];
  return [...new Set([...inherited, ...team, ...own])];
}
/** 员工继承到的工作流（SOP 模板名/id 列表）：部门 + 团队（传入时） */
function effectiveEmployeeWorkflows(employee, group = null) {
  const dept = getEmployeeDepartment(employee);
  const deptFlows = Array.isArray(dept?.workflows) ? dept.workflows.map((s) => String(s).trim()).filter(Boolean) : [];
  const teamFlows = group && Array.isArray(group.workflows) ? group.workflows.map((s) => String(s).trim()).filter(Boolean) : [];
  return [...new Set([...deptFlows, ...teamFlows])];
}
/** 技能注入 prompt 时的说明块（含来源标注），供三处 prompt 复用 */
function skillsPromptBlock(employee, group = null) {
  const all = effectiveEmployeeSkills(employee, group);
  if (!all.length) return "- 无特别指定";
  const dept = getEmployeeDepartment(employee);
  const inherited = new Set(Array.isArray(dept?.skills) ? dept.skills.map(String) : []);
  const team = new Set(group && Array.isArray(group.skills) ? group.skills.map(String) : []);
  return all.map((s) => {
    const src = team.has(s) ? "团队" : inherited.has(s) ? "部门" : "个人";
    return `- ${s}（${src}继承）`;
  }).join("\n");
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

// ---------- P2+ 协作数据层 ----------
const genId = (prefix) => `${prefix}_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
const TASK_STATUSES = ["todo", "doing", "review", "done", "blocked", "cancelled"];
const MEM_TYPES = ["identity", "preference", "project", "rule", "feedback"];

function listOrgTasks() {
  const data = readOrgJson(ORG_TASKS_FILE, []);
  return Array.isArray(data) ? data : [];
}
function saveOrgTasks(tasks) { return writeOrgFile(ORG_TASKS_FILE, tasks); }

function listOrgGroups() {
  const data = readOrgJson(ORG_GROUPS_FILE, []);
  return Array.isArray(data) ? data : [];
}
function saveOrgGroups(groups) { return writeOrgFile(ORG_GROUPS_FILE, groups); }

function listOrgTriggers() {
  const data = readOrgJson(ORG_TRIGGERS_FILE, []);
  return Array.isArray(data) ? data : [];
}
function saveOrgTriggers(triggers) { return writeOrgFile(ORG_TRIGGERS_FILE, triggers); }

function listOrgKnowledge() {
  const data = readOrgJson(ORG_KNOWLEDGE_FILE, []);
  return Array.isArray(data) ? data : [];
}
function saveOrgKnowledge(items) { return writeOrgFile(ORG_KNOWLEDGE_FILE, items); }

function listOrgProjects() {
  const data = readOrgJson(ORG_PROJECTS_FILE, []);
  return Array.isArray(data) ? data : [];
}
function saveOrgProjects(items) { return writeOrgFile(ORG_PROJECTS_FILE, items); }

// ---------- 群 SOP 数据层 ----------
function listOrgSops() {
  if (!existsSync(ORG_SOPS_FILE)) {
    writeOrgFile(ORG_SOPS_FILE, DEFAULT_SOPS);
    return DEFAULT_SOPS.map((s) => structuredClone(s));
  }
  const data = readOrgJson(ORG_SOPS_FILE, []);
  return Array.isArray(data) ? data : [];
}
function saveOrgSops(sops) { return writeOrgFile(ORG_SOPS_FILE, sops); }

function listSopRuns() {
  const data = readOrgJson(ORG_SOP_RUNS_FILE, []);
  return Array.isArray(data) ? data : [];
}
function saveSopRuns(runs) { return writeOrgFile(ORG_SOP_RUNS_FILE, runs); }
/** 一个群最多同时跑几条 SOP（防止误操作无限堆积）；已结束的不占名额 */
const MAX_ACTIVE_SOP_RUNS = 5;
/** 群当前所有活跃流程（running / blocked），最新启动的排前面 */
function getActiveSopRuns(groupId) {
  return listSopRuns()
    .filter((r) => r.groupId === groupId && ["running", "blocked"].includes(r.status))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
/** 兼容旧调用：取最新一条活跃流程 */
function getActiveSopRun(groupId) {
  return getActiveSopRuns(groupId)[0] || null;
}
/**
 * 找步骤负责人：显式 assignee > role 精确匹配（群内优先，其次全组织） > 群 leader 兜底。
 * 返回 { id, requiredRole, mismatch, reason }；mismatch=true 表示岗位无人匹配、leader 代执行，须告警。
 * 不再静默回退：岗位不符会在群消息与前端面板显式标记。
 */
function pickSopAssignee(step, group, employees = listOrgEmployees()) {
  const active = employees.filter((e) => e.status !== "archived");
  const ids = [...new Set([...(group.members || []), group.leader].filter(Boolean))];
  const inGroup = ids.map((id) => active.find((e) => e.id === id)).filter(Boolean);
  const requiredRole = String(step.role || "");
  if (step.assignee) {
    const hit = active.find((e) => e.id === step.assignee);
    if (hit) return { id: hit.id, requiredRole, mismatch: !!requiredRole && hit.role !== requiredRole, reason: "" };
  }
  if (requiredRole) {
    const match = inGroup.find((e) => e.role === requiredRole) || active.find((e) => e.role === requiredRole);
    if (match) return { id: match.id, requiredRole, mismatch: false, reason: "" };
  }
  const leader = active.find((e) => e.id === group.leader) || inGroup[0] || active[0];
  return {
    id: leader?.id || "", requiredRole,
    mismatch: !!leader && !!requiredRole,
    reason: requiredRole ? `岗位「${requiredRole}」无匹配员工，由 ${leader?.name || "leader"} 代执行` : "",
  };
}

/** 渲染 SOP 指令模板：替换 {{goal}} / {{prev}} */
function renderSopInstruction(step, goal, prevText) {
  return String(step.instruction || "")
    .replace(/\{\{goal\}\}/g, goal || "（未提供目标）")
    .replace(/\{\{prev\}\}/g, prevText || "（无前序阶段）");
}

/** 员工记忆：org/memory/<id>.json；文件不存在返回空数组 */
function memoryPath(id) {
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(String(id || "")))
    throw Object.assign(new Error("员工 ID 不合法"), { status: 400 });
  const p = join(ORG_MEMORY_DIR, `${id}.json`);
  if (!safePath(p)) throw Object.assign(new Error("路径越界"), { status: 400 });
  return p;
}
function listEmployeeMemory(id) {
  const data = readOrgJson(memoryPath(id), []);
  return Array.isArray(data) ? data : [];
}
function saveEmployeeMemory(id, items) {
  return writeOrgFile(memoryPath(id), items);
}

/** 追加一条 JSONL 消息（组织消息总线） */
function appendOrgMessage(msg) {
  mkdirSync(dirname(ORG_MESSAGES_FILE), { recursive: true });
  appendFileSync(ORG_MESSAGES_FILE, JSON.stringify(msg) + "\n", "utf8");
}
function listOrgMessages(channel = "", limit = 300) {
  if (!existsSync(ORG_MESSAGES_FILE)) return [];
  const lines = readFileSync(ORG_MESSAGES_FILE, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const m = JSON.parse(line);
      if (!channel || m.channel === channel) out.push(m);
    } catch {}
  }
  return out.slice(-limit);
}

function normalizeTask(body, existing = {}) {
  const id = String(body.id || existing.id || genId("task")).trim();
  if (!/^[A-Za-z0-9_-]{4,60}$/.test(id))
    throw Object.assign(new Error("任务 ID 不合法"), { status: 400 });
  const title = String(body.title || existing.title || "").trim();
  if (!title) throw Object.assign(new Error("任务标题不能为空"), { status: 400 });
  const status = TASK_STATUSES.includes(body.status) ? body.status : existing.status || "todo";
  const nowTs = now();
  return {
    id,
    title,
    description: String(body.description ?? existing.description ?? "").trim(),
    acceptance: String(body.acceptance ?? existing.acceptance ?? "").trim(),
    assignee: String(body.assignee ?? existing.assignee ?? "").trim(),
    groupId: String(body.groupId ?? existing.groupId ?? "").trim(),
    priority: ["low", "medium", "high", "urgent"].includes(body.priority) ? body.priority : existing.priority || "medium",
    status,
    source: String(body.source ?? existing.source ?? "manual"),
    triggerId: String(body.triggerId ?? existing.triggerId ?? ""),
    sessionFile: String(body.sessionFile ?? existing.sessionFile ?? ""),
    artifacts: Array.isArray(body.artifacts) ? body.artifacts : existing.artifacts || [],
    tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean) : existing.tags || [],
    createdAt: existing.createdAt || nowTs,
    updatedAt: nowTs,
    startedAt: existing.startedAt || (status === "doing" ? nowTs : ""),
    doneAt: status === "done" ? (existing.doneAt || nowTs) : (existing.doneAt || ""),
    lastResult: String(body.lastResult ?? existing.lastResult ?? ""),
    history: Array.isArray(existing.history) ? existing.history : [],
  };
}

/** 任务状态流转：记录 history，非法跃迁抛错 */
function transitionTask(task, next, note = "", extra = {}) {
  if (!TASK_STATUSES.includes(next)) throw Object.assign(new Error("非法任务状态"), { status: 400 });
  const prev = task.status;
  if (prev === next) return task;
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.push({ from: prev, to: next, at: now(), note: String(note || "").slice(0, 500) });
  task.status = next;
  task.updatedAt = now();
  if (next === "doing" && !task.startedAt) task.startedAt = now();
  if (next === "done") task.doneAt = now();
  else task.doneAt = ""; // 从终态重新打开时清除完成时间，避免残留误导
  Object.assign(task, extra);
  return task;
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
  const usage = employeeUsageSummary().employees;
  const employees = listOrgEmployees().map((e) => ({ ...e, usage: usage[e.id] || emptyEmployeeUsage() }));
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
    `# 可用技能（含部门继承）`,
    skillsPromptBlock(employee),
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

// ---------- 实时聊天：Pi RPC 会话池 ----------
// 每个会话文件对应一个常驻 Pi RPC 子进程；浏览器通过 SSE 订阅事件流。
// 参考 packages/coding-agent/docs/rpc.md 与 json.md。
const PI_CLI = join(__dirname, "..", "..", "packages", "coding-agent", "dist", "cli.js");
const chatSessions = new Map(); // file -> { child, clients:Set, state, running, buffer, idleTimer, model, systemPrompt }

function cliPath() {
  if (existsSync(PI_CLI)) return PI_CLI;
  // 兼容全局 pi（PATH 查找交由调用方）
  return "pi";
}

/** 读取会话文件 header，拿到 cwd（RPC 子进程需在该目录运行以加载项目级配置） */
function sessionCwd(file) {
  try {
    const first = readFileSync(file, "utf8").split("\n").find(Boolean);
    const header = JSON.parse(first);
    if (header.cwd && isAbsolute(header.cwd) && existsSync(header.cwd)) return realpathSync(header.cwd);
  } catch {}
  return WORKSPACE;
}

/** 从会话文件推断该会话绑定的模型（取已有 assistant/user 消息里的 provider/model） */
function sessionModelHint(file) {
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const e = JSON.parse(lines[i]);
      if (e.type === "message" && e.message?.provider && e.message?.model)
        return { provider: e.message.provider, modelId: e.message.model };
      if (e.type === "model_change" && e.provider && e.modelId)
        return { provider: e.provider, modelId: e.modelId };
    }
  } catch {}
  return null;
}

function chatBroadcast(ctx, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of ctx.clients) {
    try { res.write(payload); } catch {}
  }
}

function touchIdle(ctx) {
  if (ctx.idleTimer) clearTimeout(ctx.idleTimer);
  // 10 分钟无客户端则回收子进程，避免泄漏
  ctx.idleTimer = setTimeout(() => closeChatSession(ctx.file, "idle"), 10 * 60 * 1000);
  ctx.idleTimer.unref?.();
}

/** 关闭一个 RPC 会话（不删除会话文件，只是停进程） */
function closeChatSession(file, reason = "manual") {
  const ctx = chatSessions.get(file);
  if (!ctx) return;
  chatSessions.delete(file);
  if (ctx.idleTimer) clearTimeout(ctx.idleTimer);
  chatBroadcast(ctx, "closed", { reason });
  for (const res of ctx.clients) { try { res.end(); } catch {} }
  ctx.clients.clear();
  try {
    ctx.child.stdin.end();
    // 给进程 2 秒优雅退出，之后强杀
    setTimeout(() => { try { ctx.child.kill("SIGTERM"); } catch {} }, 2000).unref?.();
  } catch {}
}

/** 刷新 Pi 子进程专用配置目录：只同步必要 JSON，不复制/触碰 *.lock */
const RUNTIME_CONFIG_FILES = ["auth.json", "models.json", "models-store.json", "settings.json", "trust.json"];
function refreshRuntimeAgentDir() {
  mkdirSync(RUNTIME_AGENT_DIR, { recursive: true });
  if (resolve(AGENT_DIR) !== resolve(RUNTIME_AGENT_DIR)) {
    for (const name of RUNTIME_CONFIG_FILES) {
      const src = join(AGENT_DIR, name);
      const dest = join(RUNTIME_AGENT_DIR, name);
      try { if (existsSync(src)) copyFileSync(src, dest); } catch {}
    }
  }
  const link = join(RUNTIME_AGENT_DIR, "sessions");
  const target = resolve(SESSION_DIR);
  if (resolve(link) !== target && !existsSync(link)) {
    try { symlinkSync(target, link, "dir"); } catch {}
  }
  return RUNTIME_AGENT_DIR;
}

/** 获取或创建某会话的 RPC 子进程 */
function getChatSession(file) {
  if (!safePath(file) || !file.endsWith(".jsonl") || !existsSync(file))
    throw Object.assign(new Error("会话文件不可访问"), { status: 400 });
  let ctx = chatSessions.get(file);
  if (ctx && ctx.child.exitCode === null && !ctx.child.killed) return ctx;

  const cwd = sessionCwd(file);
  const cli = cliPath();
  refreshRuntimeAgentDir();
  // Pi 子进程需要原生 fs 语义：清掉 WorkBuddy 注入的 node-language-shim，
      // 它会拦截 proper-lockfile 删除 trust.json.lock，导致 RPC 启动即崩溃。
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    // 彻底剔除所有 WorkBuddy 沙箱/注入变量，避免 shim 通过非 NODE_OPTIONS 途径生效。
    // 关键：NODE_OPTIONS 通过 --require 注入 node-language-shim，它会拦截 proper-lockfile
    // 删除 trust.json.lock，导致 Pi 启动即崩。BASH_ENV/TOYBOX/SANDBOX 等也要一起清掉。
    if (/^CODEBUDDY_|^BROKER|^WORKBUDDY_|^SANDBOX|^TOYBOX|SHIM|SAFE_DELETE|NODE_OPTIONS|BASH_ENV|ELECTRON_RUN_AS_NODE|DYLD_/i.test(k)) delete childEnv[k];
  }
  childEnv.PI_CODING_AGENT_DIR = RUNTIME_AGENT_DIR;
  console.error(`[chat] spawn Pi: NODE_OPTIONS=${JSON.stringify(childEnv.NODE_OPTIONS)} exec=${process.execPath}`);
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--session", file], {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  ctx = { file, child, clients: new Set(), state: null, running: false, buffer: "", model: null, pending: new Map(), reqId: 0 };
  chatSessions.set(file, ctx);

  const rpcSend = (obj) => {
    const id = obj.id || `req-${++ctx.reqId}`;
    child.stdin.write(JSON.stringify({ id, ...obj }) + "\n");
    return id;
  };
  ctx.rpcSend = rpcSend;

  // stderr 只做诊断，不解析为协议数据
  child.stderr.on("data", (d) => {
    const s = d.toString("utf8").trim();
    if (s) chatBroadcast(ctx, "stderr", { text: s.slice(0, 500) });
  });

  // 严格按 LF 切分（不用 readline，避免 U+2028/U+2029 被误当分隔符）
  child.stdout.on("data", (chunk) => {
    ctx.buffer += chunk.toString("utf8");
    let i;
    while ((i = ctx.buffer.indexOf("\n")) >= 0) {
      const line = ctx.buffer.slice(0, i).replace(/\r$/, "");
      ctx.buffer = ctx.buffer.slice(i + 1);
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type === "response") {
        const cb = ctx.pending.get(rec.id);
        if (cb) { ctx.pending.delete(rec.id); cb(rec); }
        if (rec.command === "get_state" && rec.success) {
          ctx.state = rec.data;
          chatBroadcast(ctx, "state", { model: rec.data.model, sessionId: rec.data.sessionId, isStreaming: rec.data.isStreaming });
        }
        if (rec.command === "prompt" && !rec.success)
          chatBroadcast(ctx, "error", { message: rec.error || "发送失败" });
      } else if (rec.type === "message_start" && rec.message?.role === "assistant") {
        ctx.running = true;
        chatBroadcast(ctx, "run_start", {});
      } else if (rec.type === "message_update" && rec.assistantMessageEvent?.type === "text_delta") {
        chatBroadcast(ctx, "delta", { text: rec.assistantMessageEvent.delta });
        try { ctx.taskSSE?.("delta", { text: rec.assistantMessageEvent.delta }); } catch {}
      } else if (rec.type === "tool_execution_start") {
        chatBroadcast(ctx, "tool", { phase: "start", name: rec.toolName, args: rec.args });
        try { ctx.taskSSE?.("tool", { phase: "start", name: rec.toolName, args: rec.args }); } catch {}
      } else if (rec.type === "tool_execution_end") {
        chatBroadcast(ctx, "tool", { phase: "end", name: rec.toolName, isError: rec.isError });
        try { ctx.taskSSE?.("tool", { phase: "end", name: rec.toolName, isError: rec.isError }); } catch {}
      } else if (rec.type === "approval_request" || rec.type === "confirmation_request") {
        // Pi 请求人工确认：进审批队列并广播
        const apId = genId("apr");
        const ap = { id: apId, taskId: [...runningTasks.values()].find((s) => s.ctx === ctx)?.taskId || "", title: rec.title || "工具执行需确认", detail: rec.message || rec.description || "", status: "pending", createdAt: now() };
        approvals.set(apId, ap);
        orgEmit("approval", { taskId: ap.taskId, approval: ap });
      } else if (rec.type === "message_end" && rec.message?.role === "assistant") {
        const c = rec.message.content;
        const text = Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("") : String(c ?? "");
        const usage = normalizeUsage(rec.message.usage);
        const meta = { provider: rec.message.provider || "", model: rec.message.model || "", ts: rec.message.timestamp || Date.now() };
        const info = usage ? usageCostInfo(usage, meta) : null;
        const payload = {
          text, usage, fx: fxPublic(), ...meta,
          cost: info ? { cny: info.cny, mode: info.mode, label: info.label } : null,
        };
        // 统一在这里累计员工用量：普通会话、群聊 @ 唤醒、群 SOP 任务都走这条路径；
        // 群消息里的 usage 是同一轮的副本，不再重复计入。
        try {
          const empId = sessionEmployeeId(ctx.file);
          if (empId && info) recordEmployeeUsage(empId, usage.totalTokens, info.cny);
        } catch (e) { console.error("[employee-usage] record failed:", e.message); }
        chatBroadcast(ctx, "message_end", payload);
        try { dispatchTaskEvent(ctx, "message_end", payload); } catch {}
      } else if (rec.type === "agent_settled") {
        ctx.running = false;
        chatBroadcast(ctx, "run_end", { aborted: !!rec.aborted });
        try { dispatchTaskEvent(ctx, "run_end", { aborted: !!rec.aborted }); } catch {}
      } else if (rec.type === "session_info_changed" && rec.name) {
        chatBroadcast(ctx, "renamed", { name: rec.name });
      }
    }
  });

  child.on("exit", (code) => {
    if (chatSessions.get(file) === ctx) {
      chatSessions.delete(file);
      chatBroadcast(ctx, "process_exit", { code });
      for (const res of ctx.clients) { try { res.end(); } catch {} }
      ctx.clients.clear();
    }
  });

  // 启动后拉一次状态，拿到当前模型
  setTimeout(() => { try { rpcSend({ type: "get_state" }); } catch {} }, 300);
  return ctx;
}

// ---------- 组织事件总线（SSE）+ 任务执行引擎 ----------
const orgClients = new Set(); // 组织级 SSE 订阅者
function orgBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of orgClients) { try { res.write(payload); } catch {} }
}
function orgEmit(type, data = {}) {
  const evt = { type, at: now(), ...data };
  // 关键业务事件写进消息总线，便于回放
  if (["task_created", "task_assigned", "task_status", "task_done", "task_failed", "handoff", "trigger_fired", "approval"].includes(type)) {
    try { appendOrgMessage({ id: genId("msg"), channel: data.channel || "org-events", from: data.from || "system", to: "", type, body: data.note || data.title || "", ref: data.taskId || "", createdAt: evt.at }); } catch {}
  }
  orgBroadcast(type, evt);
}

// 运行中的任务执行：taskId -> { ctx, pid, startedAt, buffers }
const runningTasks = new Map();
// 审批队列：审批 ID -> 请求
const approvals = new Map();

/** 构造任务派活的 prompt：身份 + 任务卡 + 验收标准 + 记忆摘要 + 协作上下文 */
function buildTaskPrompt(task, employee) {
  const parts = [
    `# 任务卡：${task.title}`,
    ``,
    task.description ? `## 任务描述\n${task.description}` : "",
    task.acceptance ? `## 验收标准\n${task.acceptance}` : "",
    task.tags?.length ? `## 标签\n${task.tags.join("、")}` : "",
    ``,
    `请以「${employee.name}」（${employee.role || "员工"}）的身份完成这个任务。`,
    `## 执行边界`,
    `- 你的工作目录是当前目录（员工专属工作区）。只在当前工作区内查找资料和写文件。`,
    `- 不要主动去读取工作区以外的用户目录、其他项目或系统敏感路径；确有必要先在结论里说明并标注「需人工确认」。`,
    `- 聚焦任务卡本身；若信息不足，直接给出基于已有信息的结论并注明不确定点，不要无限扩大搜索范围。`,
    `## 输出要求`,
    `- 先给结论，再给依据；把关键产物写成文本直接返回。`,
    `- 若需要写文件，说明写入路径与内容摘要。`,
    `- 若任务超出权限或需要人类决策，明确说明「需人工确认」并给出建议。`,
  ].filter((s) => s !== undefined);
  // 注入员工长期记忆（最多 20 条）
  const mem = listEmployeeMemory(employee.id).slice(0, 20);
  if (mem.length) {
    parts.push(``, `## 你的长期记忆`, ...mem.map((m) => `- [${m.type}] ${m.content}`));
  }
  // 注入组织知识库摘要（最多 15 条）
  const kb = listOrgKnowledge().slice(0, 15);
  if (kb.length) {
    parts.push(``, `## 组织知识库`, ...kb.map((k) => `- ${k.title}：${String(k.content).slice(0, 200)}`));
  }
  return parts.join("\n").trim() + "\n";
}

/** 真正执行一次任务：用员工工作区建立 RPC 会话并发送任务 prompt。异步，结果经 SSE 推送。 */
function executeTask(taskId) {
  const tasks = listOrgTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw Object.assign(new Error("任务不存在"), { status: 404 });
  if (runningTasks.has(taskId)) throw Object.assign(new Error("任务已在执行中"), { status: 409 });
  const emp = getOrgEmployee(task.assignee).data;
  if (emp.status === "archived") throw Object.assign(new Error("指派员工已归档，请先恢复"), { status: 400 });

  const ws = ensureEmployeeWorkspace(emp);
  // 每个任务独立会话文件，避免污染员工日常对话
  // 会话名是给人看的：直接用任务标题，不把内部 task id 拼进去
  const session = createSessionFile({ cwd: ws.dir, name: `任务 · ${task.title}` });
  const ctx = getChatSession(session.file);
  const run = {
    id: genId("run"), taskId, employeeId: emp.id, sessionFile: session.file,
    startedAt: now(), finishedAt: "", status: "running", result: "", usage: null, error: "",
  };
  mkdirSync(ORG_RUNS_DIR, { recursive: true });
  writeOrgFile(join(ORG_RUNS_DIR, `${run.id}.json`), run);

  const state = { ctx, runId: run.id, taskId, employeeId: emp.id, text: "", usage: null, costCny: 0, priceModes: new Set(), startedAt: Date.now() };
  runningTasks.set(taskId, state);
  // 执行超时保护：默认 8 分钟强制中止，防止任务无限运行
  const TASK_TIMEOUT_MS = 8 * 60 * 1000;
  state.timeoutTimer = setTimeout(() => {
    if (runningTasks.has(taskId) && !state.finalized) {
      try { ctx.rpcSend({ type: "abort" }); } catch {}
      state.text += "\n\n[系统提示：执行超时，已自动中止]";
      finalizeTaskRun(taskId, true);
      orgEmit("task_failed", { taskId, note: `任务「${task.title}」执行超时（超过 8 分钟），已自动中止` });
    }
  }, TASK_TIMEOUT_MS);
  state.timeoutTimer.unref?.();

  // 监听本次会话的结果（仅本 task 订阅，不干扰聊天 SSE）
  const onMessageEnd = (payload) => {
    state.text += (payload.text || "");
    if (payload.usage) state.usage = mergeUsage(state.usage, payload.usage);
    if (payload.cost) {
      state.costCny += payload.cost.cny || 0;
      if (payload.cost.mode) state.priceModes.add(payload.cost.mode);
    }
  };
  const onRunEnd = (payload) => {
    // 该会话可能有多轮，这里以最后一次 agent_settled 为准
    finalizeTaskRun(taskId, !!payload.aborted);
  };
  ctx.taskHooks ??= new Map();
  ctx.taskHooks.set(session.file, { onMessageEnd, onRunEnd });
  // 把执行进度实时广播到组织事件流
  ctx.taskSSE = (event, payload) => {
    if (event === "tool") orgEmit("task_tool", { taskId, ...payload });
    if (event === "delta") orgEmit("task_delta", { taskId, text: payload.text });
  };

  // 任务状态 -> doing，并广播
  const cur = listOrgTasks().find((t) => t.id === taskId);
  if (cur) {
    transitionTask(cur, "doing", "开始执行");
    cur.sessionFile = session.file;
    saveOrgTasks(listOrgTasks().map((t) => (t.id === cur.id ? cur : t)));
  }
  orgEmit("task_status", { taskId, status: "doing", note: `${emp.name} 开始执行「${task.title}」` });

  // 发送任务 prompt（如会话刚创建带 firstMessage 则不重复发）
  // 群聊唤醒走专属 prompt：注入群上下文摘要，只以本人身份回应
  const groupCtx = listOrgGroups().find((g) => g.id === task.groupId) || { name: "协作群", members: [] };
  const sopRun = task.source === "sop" && task.sopRunId
    ? listSopRuns().find((r) => r.id === task.sopRunId) : null;
  const sopStep = sopRun?.steps.find((s) => s.id === task.sopStepId);
  const prompt = sopRun && sopStep
    ? buildSopStepPrompt(groupCtx, emp, task, sopRun, sopStep, task.chatContext || [])
    : task.source === "group_chat"
      ? buildGroupChatPrompt(groupCtx, emp, task.description || "", task.chatContext || [])
      : buildTaskPrompt(task, emp);
  ctx.rpcSend({ type: "prompt", message: prompt });
  return { runId: run.id, sessionFile: session.file, taskId };
}

/** 任务执行收尾：把结果写回任务与 run，状态转 review/done，触发后续 handoff */
function finalizeTaskRun(taskId, aborted) {
  const state = runningTasks.get(taskId);
  if (!state) return;
  // 防止同一会话多次 agent_settled 重复收尾
  if (state.finalized) return;
  state.finalized = true;
  if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
  runningTasks.delete(taskId);
  const ctx = state.ctx;
  // 找到该 task 对应的 hook key（session.file）并清理
  if (ctx.taskHooks) {
    for (const [key, h] of [...ctx.taskHooks.entries()]) {
      if (h.onMessageEnd === undefined) continue;
      // 通过 taskId 无法直接反查，统一在匹配 run 的 sessionFile 时清理
      ctx.taskHooks.delete(key);
    }
  }
  ctx.taskSSE = null;

  const runPath = join(ORG_RUNS_DIR, `${state.runId}.json`);
  const run = readJsonSafe(runPath, null);
  if (run) {
    run.finishedAt = now();
    run.status = aborted ? "cancelled" : "done";
    run.result = state.text.slice(0, 20000);
    if (state.usage) run.usage = state.usage;
    if (state.costCny) {
      run.costCny = state.costCny;
      run.priceModes = [...state.priceModes];
      run.priceLabel = state.priceModes.size === 1 ? priceModeLabel([...state.priceModes][0]) : "混合计价";
    }
    if (!aborted) run.status = "done";
    writeOrgFile(runPath, run);
  }

  const tasks = listOrgTasks();
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return;
  const task = tasks[idx];
  if (aborted) {
    transitionTask(task, "blocked", "执行被中止");
    task.lastResult = state.text.slice(0, 20000);
    tasks[idx] = task;
    saveOrgTasks(tasks);
    orgEmit("task_failed", { taskId, note: `「${task.title}」执行被中止` });
    // SOP 中止也要流转：把阶段标记失败、流程转 blocked，避免群永久占用 409
    if (task.sopRunId) {
      try { onSopTaskFailed(task, "执行被中止/超时"); }
      catch (e) { orgEmit("task_failed", { taskId, note: `SOP 中止流转失败：${e.message}` }); }
    }
    return;
  }
  task.lastResult = state.text.slice(0, 20000);
  transitionTask(task, "review", "执行完成，等待验收");
  tasks[idx] = task;
  saveOrgTasks(tasks);
  orgEmit("task_done", { taskId, note: `${task.assignee} 完成「${task.title}」，待验收`, result: task.lastResult.slice(0, 500) });
  appendOrgMessage({ id: genId("msg"), channel: `task:${taskId}`, from: task.assignee, to: task.reporter || "human", type: "status_report", body: task.lastResult.slice(0, 4000), ref: taskId, createdAt: now() });
  // 群聊来源：把执行结果汇总成一条群消息回写，并实时广播到群频道
  if ((task.source === "group_chat" || task.source === "sop") && task.groupId) {
    const reply = {
      id: genId("msg"), channel: `group:${task.groupId}`, from: task.assignee,
      to: "human", type: "group_reply", body: task.lastResult.slice(0, 8000),
      ref: taskId, replyTo: task.chatSourceMsgId || "", createdAt: now(),
      usage: state.usage || null, fx: fxPublic(),
      costCny: state.costCny || 0,
      priceModes: [...state.priceModes],
      priceLabel: state.priceModes.size === 1 ? priceModeLabel([...state.priceModes][0]) : (state.priceModes.size > 1 ? "混合计价" : ""),
    };
    if (task.sopRunId) {
      reply.sopRunId = task.sopRunId;
      reply.sopStepId = task.sopStepId;
      reply.sopStage = task.sopStage || "";
    }
    appendOrgMessage(reply);
    orgBroadcast("group_message", reply);
  }
  // SOP 步骤完成：写入实例并自动流转到下一阶段
  if (task.sopRunId) {
    try { onSopTaskDone(task); }
    catch (e) { orgEmit("task_failed", { taskId, note: `SOP 流转失败：${e.message}` }); }
  }
}

/** 群聊 @ 唤醒：解析文本里的 @姓名，返回匹配的员工（仅限群成员） */
function resolveGroupMentions(text, group) {
  const members = new Set([...(group.members || []), group.leader].filter(Boolean));
  const all = listOrgEmployees().filter((e) => e.status !== "archived");
  // 群里 @ 任意在职成员都可唤醒（前端 @ 列表也是全组织）；群内成员排在前面。
  // 支持 @姓名、@姓名（全/半角标点或空白结尾），也兼容 @emp-xxx 这种 id 写法。
  const mentioned = all.filter((e) => {
    const hitByName = text.includes(`@${e.name}`);
    const hitById = text.includes(`@${e.id}`);
    return hitByName || hitById;
  });
  return mentioned.sort((a, b) => Number(members.has(b.id)) - Number(members.has(a.id)));
}

/** 群聊 prompt：群身份 + 近期群聊上下文摘要 + 本次 @ 消息 + 执行边界 */
function buildGroupChatPrompt(group, employee, message, recentMessages) {
  const parts = [
    `# 群聊发言：${group.name}`,
    ``,
    `你正在以「${employee.name}」（${employee.role || "员工"}）的身份，在一个多人协作群里回应。`,
    `群里还有这些成员：${(group.members || []).map((id) => employeeNameSafe(id)).join("、") || "（暂无其他成员）"}。`,
    group.description ? `群职责：${group.description}` : "",
    ``,
    `## 最近群聊上下文（摘要）`,
    ...(recentMessages.length
      ? recentMessages.map((m) => {
          const who = employeeNameSafe(m.from);
          return `- ${who}：${String(m.body).replace(/\s+/g, " ").slice(0, 300)}`;
        })
      : ["- （这是本群第一条消息）"]),
    ``,
    `## 本次需要你回应的消息`,
    String(message).slice(0, 4000),
    ``,
    `## 回应要求`,
    `- 只以「${employee.name}」的身份说话，不冒充其他成员，也不要替别人回答。`,
    `- 先给结论，再给依据；简明扼要，像在群里回话，不要长篇报告。`,
    `- 结合上面的群聊上下文理解来龙去脉；若信息不足，直接说明并标注不确定点。`,
    `- 需要写文件时只在你自己的工作区内操作，并说明路径与内容摘要。`,
    `- 若需要人类决策，明确说明「需人工确认」并给出建议。`,
  ].filter((s) => s !== undefined);
  // 注入继承技能（部门 + 团队 + 个人）
  parts.push(``, `## 可用技能（含部门/团队继承）`, skillsPromptBlock(employee, group));
  // 团队工作流提示
  const flows = effectiveEmployeeWorkflows(employee, group);
  if (flows.length) parts.push(``, `## 本团队可用工作流`, ...flows.map((f) => `- ${f}`));
  // 注入员工长期记忆摘要
  const mem = listEmployeeMemory(employee.id).slice(0, 10);
  if (mem.length) parts.push(``, `## 你的长期记忆`, ...mem.map((m) => `- [${m.type}] ${m.content}`));
  return parts.join("\n").trim() + "\n";
}

// ---------- 群 SOP 引擎 ----------
/** SOP 阶段任务 prompt：身份 + 流程目标 + 阶段指令 + 前序结果 + 群上下文 */
function buildSopStepPrompt(group, employee, task, run, step, recentMessages) {
  const prevText = run.steps.slice(0, run.currentStep)
    .filter((s) => s.status === "done")
    .map((s) => `### ${s.name}\n${String(s.result || "").slice(0, 1500)}`)
    .join("\n\n") || "（无前序阶段结果）";
  return [
    `# SOP 阶段任务：${step.name}`,
    ``,
    `你正在以「${employee.name}」（${employee.role || "员工"}）的身份，参与群「${group.name}」的 SOP 协作流程。`,
    `流程：${run.templateName}｜本次目标：${run.goal || "（未填写）"}`,
    `当前阶段：第 ${run.currentStep + 1} / ${run.steps.length} 步 · ${step.name}`,
    `完整阶段顺序：${run.steps.map((s, i) => `${i + 1}.${s.name}`).join(" → ")}`,
    group.description ? `群职责：${group.description}` : "",
    ``,
    `## 本阶段任务指令`,
    String(task.description || "").slice(0, 6000),
    ``,
    `## 验收标准`,
    String(step.acceptance || "按阶段指令交付，结论先行。").slice(0, 2000),
    step.skill ? `\n来源技能：QoderWake /${step.skill}` : "",
    ``,
    `## 协作协议（QoderWake 群协作规范，必须遵守）`,
    `- **交接五要素**：你的产出须包含 目标(objective)、必要上下文(context)、期望产出(expected output)、阶段/信息约束(stage constraints)、回交对象(return owner)。不要替其他成员写他们的发言或结论。`,
    `- **证据格式**：凡涉及修复/验证，必须给出 \`before signature -> command -> after result\` 闭环；不得用"已确认/应该没问题"代替真实命令与输出。`,
    `- **验收写法**：若本阶段产出验收条件，用 \`AC-n [Happy|Error|Edge|Non-functional] Given … When … Then …\`，3-6 条、每条可证伪。`,
    `- **阶段边界**：只负责本阶段「${step.name}」。完整阶段未完成前不要宣称整体完成；等待或交接不等于阶段完成。`,
    `- **阶段状态**：输出末尾附一段 \`### Stage State Update\`，写明 产出物路径、交接对象、当前阶段是否完成、未完成原因（若有）。`,
    ``,
    `## 前序阶段结果摘要`,
    prevText,
    ``,
    `## 最近群聊上下文（摘要）`,
    ...(recentMessages.length
      ? recentMessages.map((m) => {
          const who = employeeNameSafe(m.from);
          return `- ${who}：${String(m.body).replace(/\s+/g, " ").slice(0, 240)}`;
        })
      : ["- （暂无群聊上下文）"]),
    ``,
    `## 输出要求`,
    `- 只以「${employee.name}」的身份输出，不替其他阶段或其他成员下结论。`,
    `- 只负责本阶段「${step.name}」，完成后直接给出结论与依据，结果会自动回写群聊并流转到下一阶段。`,
    `- 结论先行，依据精简；需要写文件时只在你自己的工作区内操作并说明路径。`,
    `- 信息不足时不要臆造，明确标注「需人工确认」并给出建议。`,
    ``,
    `## 可用技能（含部门/团队继承）`,
    skillsPromptBlock(employee, group),
  ].filter((s) => s !== undefined).join("\n").trim() + "\n";
}

/** 往群频道写一条 SOP 系统事件消息，并实时广播 */
function sopSystemMessage(groupId, body, meta = {}) {
  const msg = {
    id: genId("msg"), channel: `group:${groupId}`, from: "system", to: "",
    type: "sop_event", body: String(body).slice(0, 6000), ref: meta.sopRunId || "",
    createdAt: now(), ...meta,
  };
  appendOrgMessage(msg);
  orgBroadcast("group_message", msg);
  return msg;
}
function sopBroadcast(run) {
  if (!run) return;
  // 推送全部活跃流程，前端可在多条并行时切换查看；run 为本次变更的那条
  orgBroadcast("sop_update", {
    groupId: run.groupId, run,
    runs: getActiveSopRuns(run.groupId),
  });
}
function persistSopRun(run) {
  const runs = listSopRuns();
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) runs[idx] = run; else runs.push(run);
  saveSopRuns(runs);
  return run;
}
/** 汇总全流程结论，供完成事件与历史回看 */
function buildSopSummary(run) {
  return run.steps.map((s, i) => {
    const result = String(s.result || (s.status === "skipped" ? "（已跳过）" : "（无结果）")).replace(/\s+/g, " ").slice(0, 320);
    return `${i + 1}. ${s.name}（${s.status}）：${result}`;
  }).join("\n");
}

/** 启动一条群 SOP：创建实例并把第一步派活给匹配成员 */
function startSopRun(group, templateId, goal, opts = {}) {
  const active = getActiveSopRuns(group.id);
  if (active.length >= MAX_ACTIVE_SOP_RUNS)
    throw Object.assign(new Error(`本群已有 ${active.length} 条进行中的 SOP（上限 ${MAX_ACTIVE_SOP_RUNS}），请先终止不再需要的流程`), { status: 409 });
  const template = listOrgSops().find((s) => s.id === templateId);
  if (!template) throw Object.assign(new Error("SOP 模板不存在"), { status: 404 });
  if (!Array.isArray(template.steps) || !template.steps.length) throw Object.assign(new Error("SOP 模板没有阶段定义"), { status: 400 });
  // 目标可留空：优先用传入值，其次自动取群里最近一条真人发言，最后用模板名兜底
  const latestHuman = listOrgMessages(`group:${group.id}`, 50)
    .filter((m) => m.from === "human" && !/^\/sop\b/i.test(String(m.body || "").trim()))
    .slice(-1)[0];
  const fallbackGoal = String(goal || "").trim()
    || (latestHuman ? String(latestHuman.body || "").trim().replace(/\s+/g, " ").slice(0, 120) : "")
    || `按「${template.name || templateId}」流程推进群内协作`;
  const mismatches = [];
  const run = {
    id: genId("soprun"), groupId: group.id, templateId: template.id,
    templateName: template.name || templateId, goal: fallbackGoal,
    goalAuto: !String(goal || "").trim(), // 标记目标是否自动推断（前端提示用）
    status: "running", currentStep: 0,
    // 保存模板快照：用户后续改模板不影响已启动的流程
    templateSteps: template.steps.map((s) => ({ ...s })),
    steps: template.steps.map((s, i) => {
      const picked = pickSopAssignee(s, group);
      if (picked.mismatch) mismatches.push(`「${s.name || `阶段 ${i + 1}`}」${picked.reason}`);
      return {
        id: s.id || `s${i + 1}`, name: String(s.name || `阶段 ${i + 1}`).slice(0, 80),
        role: String(s.role || ""), skill: String(s.skill || ""), assignee: picked.id,
        assigneeMismatch: picked.mismatch, assigneeReason: picked.reason,
        instruction: String(s.instruction || ""), acceptance: String(s.acceptance || ""),
        status: "pending", taskId: "", result: "", startedAt: "", finishedAt: "",
      };
    }),
    createdAt: now(), updatedAt: now(), finishedAt: "", summary: "",
  };
  persistSopRun(run);
  sopSystemMessage(group.id,
    `已启动 SOP「${run.templateName}」：${run.goal}${run.goalAuto ? "（目标自动取自群内最近发言，可忽略）" : ""}\n共 ${run.steps.length} 个阶段：${run.steps.map((s) => s.name).join(" → ")}。`,
    { sopEvent: "start", sopRunId: run.id });
  if (mismatches.length) {
    sopSystemMessage(group.id,
      `⚠ 岗位匹配提醒：${mismatches.join("；")}。\nSOP 仍能流转，但建议先在组织里配置对应岗位的员工，或指定群成员后重新发起。`,
      { sopEvent: "warn", sopRunId: run.id });
  }
  sopBroadcast(run);
  spawnSopStep(run, 0, opts);
  return run;
}

/** 派活某个 SOP 阶段（创建任务 + 真实执行） */
function spawnSopStep(run, index, opts = {}) {
  const step = run.steps[index];
  if (!step) return null;
  const group = listOrgGroups().find((g) => g.id === run.groupId);
  if (!group) return null;
  const emp = getOrgEmployee(step.assignee).data;
  if (!emp || emp.status === "archived") {
    step.status = "blocked";
    step.result = "（缺少可用负责人，流程已暂停）";
    step.finishedAt = now();
    run.status = "blocked";
    run.currentStep = index;
    run.updatedAt = now();
    persistSopRun(run);
    sopBroadcast(run);
    sopSystemMessage(group.id, `⚠ 阶段「${step.name}」缺少可用负责人，流程已暂停（不会卡死群）。请添加匹配岗位成员或调整负责人后重试。`, { sopEvent: "blocked", sopRunId: run.id, sopStepId: step.id });
    return null;
  }
  const prevText = run.steps.slice(0, index)
    .filter((s) => s.status === "done")
    .map((s) => `### ${s.name}\n${String(s.result || "").slice(0, 1200)}`)
    .join("\n\n") || "（无前序阶段结果）";
  const instruction = renderSopInstruction(step, run.goal, prevText);
  const tasks = listOrgTasks();
  const task = normalizeTask({
    id: genId("task"),
    title: `SOP · ${step.name} · ${(run.goal || run.templateName).slice(0, 36)}`,
    description: instruction,
    acceptance: step.acceptance || "",
    assignee: emp.id, groupId: group.id, source: "sop", priority: "medium",
    tags: [`sop:${run.id}`, `sopstep:${step.id}`],
  }, {});
  task.sopRunId = run.id;
  task.sopStepId = step.id;
  task.sopStage = step.name;
  task.chatSourceMsgId = opts.sourceMsgId || "";
  task.chatContext = listOrgMessages(`group:${group.id}`, 20).slice(-10).map((m) => ({ from: m.from, body: m.body }));
  tasks.push(task);
  saveOrgTasks(tasks);

  step.status = "doing";
  step.taskId = task.id;
  step.startedAt = now();
  step.finishedAt = "";
  step.result = "";
  run.currentStep = index;
  run.status = "running";
  run.updatedAt = now();
  persistSopRun(run);
  orgEmit("task_created", { taskId: task.id, note: `SOP「${run.templateName}」进入「${step.name}」，派给 ${emp.name}` });
  sopSystemMessage(group.id,
    `▶ 阶段 ${index + 1}/${run.steps.length}「${step.name}」开始，负责人：${emp.name}。\n指令：${instruction.slice(0, 900)}`,
    { sopEvent: "step_start", sopRunId: run.id, sopStepId: step.id });
  sopBroadcast(run);
  try { executeTask(task.id); }
  catch (e) {
    step.status = "blocked";
    persistSopRun(run); sopBroadcast(run);
    orgEmit("task_failed", { taskId: task.id, note: `SOP 阶段「${step.name}」唤醒失败：${e.message}` });
    sopSystemMessage(group.id, `⚠ 阶段「${step.name}」唤醒失败：${e.message}`, { sopEvent: "blocked", sopRunId: run.id, sopStepId: step.id });
  }
  return task;
}

/** 一个 SOP 阶段任务完成：写回结果并自动流转 */
function onSopTaskDone(task) {
  const run = listSopRuns().find((r) => r.id === task.sopRunId);
  if (!run || run.status !== "running") return;
  const step = run.steps.find((s) => s.id === task.sopStepId || s.taskId === task.id);
  if (!step || step.status === "done" || step.status === "skipped") return;
  const empName = getOrgEmployee(task.assignee).data?.name || task.assignee;
  step.status = "done";
  step.result = String(task.lastResult || "").slice(0, 8000);
  step.finishedAt = now();
  run.updatedAt = now();
  persistSopRun(run);
  sopSystemMessage(run.groupId, `✓ 阶段「${step.name}」完成（${empName}），正在流转到下一阶段。`, { sopEvent: "step_done", sopRunId: run.id, sopStepId: step.id });

  const next = run.steps.findIndex((s) => s.status === "pending");
  if (next >= 0) {
    run.currentStep = next;
    persistSopRun(run);
    sopBroadcast(run);
    spawnSopStep(run, next, { sourceMsgId: task.chatSourceMsgId });
  } else {
    const stuck = run.steps.find((s) => s.status === "blocked");
    if (stuck) {
      // 有阶段失败/缺人：流程暂停，等人工 retry 或 stop，不误报"全部完成"
      run.currentStep = run.steps.indexOf(stuck);
      run.status = "blocked";
      run.updatedAt = now();
      persistSopRun(run);
      sopSystemMessage(run.groupId, `⚠ SOP「${run.templateName}」已在「${stuck.name}」暂停：${stuck.result || "阶段未完成"}。可在流程面板点「重试」或「终止」。`, { sopEvent: "blocked", sopRunId: run.id, sopStepId: stuck.id });
    } else {
      run.status = "done";
      run.finishedAt = now();
      run.summary = buildSopSummary(run);
      run.updatedAt = now();
      persistSopRun(run);
      sopSystemMessage(run.groupId, `✅ SOP「${run.templateName}」已全部完成。\n\n${run.summary}`, { sopEvent: "done", sopRunId: run.id });
    }
    sopBroadcast(run);
  }
}

/** SOP 阶段执行失败/中止：阶段标记 blocked，流程暂停但保留重试能力 */
function onSopTaskFailed(task, reason = "执行失败") {
  const run = listSopRuns().find((r) => r.id === task.sopRunId);
  if (!run || run.status !== "running") return;
  const step = run.steps.find((s) => s.id === task.sopStepId || s.taskId === task.id);
  if (!step || step.status === "done" || step.status === "skipped") return;
  step.status = "blocked";
  step.result = `（${reason}）${String(task.lastResult || "").slice(0, 2000)}`;
  step.finishedAt = now();
  run.status = "blocked";
  run.currentStep = run.steps.indexOf(step);
  run.updatedAt = now();
  persistSopRun(run);
  sopSystemMessage(run.groupId, `⚠ 阶段「${step.name}」${reason}，流程已暂停（可重试，不会卡死群）。`, { sopEvent: "blocked", sopRunId: run.id, sopStepId: step.id });
  sopBroadcast(run);
}

/**
 * 启动对账：进程重启会丢失内存中的 runningTasks 与超时定时器。
 * 把孤儿 running 流程标为 blocked（可重试），避免永久占用群 SOP 名额。
 */
function reconcileSopRunsOnBoot() {
  const runs = listSopRuns();
  let changed = false;
  for (const run of runs) {
    if (run.status !== "running") continue;
    const step = run.steps?.[run.currentStep];
    // 阶段没有任何正在执行的任务痕迹 → 判定为重启遗留
    const hasLiveTask = step?.taskId && runningTasks.has(step.taskId);
    if (hasLiveTask) continue;
    run.status = "blocked";
    run.updatedAt = now();
    if (!run.summary) run.summary = buildSopSummary(run);
    if (step && step.status === "doing") {
      step.status = "blocked";
      step.result = step.result || "（进程重启，执行中断，可重试）";
      step.finishedAt = now();
    }
    changed = true;
    try {
      sopSystemMessage(run.groupId, `⚠ 服务重启后检测到 SOP「${run.templateName}」中断，已置为可重试状态，不会卡死群聊。`, { sopEvent: "blocked", sopRunId: run.id, sopStepId: step?.id || "" });
    } catch {}
  }
  if (changed) saveSopRuns(runs);
}

/** 手动控制 SOP：next / skip / retry / stop */
function controlSopRun(groupId, action, opts = {}) {
  const run = opts.runId
    ? listSopRuns().find((r) => r.id === opts.runId && r.groupId === groupId && ["running", "blocked"].includes(r.status))
    : getActiveSopRun(groupId);
  if (!run) throw Object.assign(new Error(opts.runId ? "指定的 SOP 流程不存在或已结束" : "本群没有进行中的 SOP"), { status: 404 });
  const step = run.steps[run.currentStep];
  if (action === "next" || action === "skip") {
    if (!step) throw Object.assign(new Error("没有可推进的阶段"), { status: 400 });
    step.status = action === "skip" ? "skipped" : "done";
    step.result = action === "skip" ? "人工跳过" : (step.result || "人工确认完成");
    step.finishedAt = now();
    const next = run.steps.findIndex((s) => s.status === "pending");
    if (next >= 0) {
      run.currentStep = next;
      run.status = "running";
      run.updatedAt = now();
      persistSopRun(run);
      sopSystemMessage(run.groupId, `${action === "skip" ? "⏭ 已跳过" : "✔ 已确认"}阶段「${step.name}」，流转到下一阶段。`, { sopEvent: "step_done", sopRunId: run.id, sopStepId: step.id });
      spawnSopStep(run, next);
    } else {
      run.status = "done";
      run.finishedAt = now();
      run.summary = buildSopSummary(run);
      run.updatedAt = now();
      persistSopRun(run);
      sopSystemMessage(run.groupId, `✅ SOP「${run.templateName}」已全部完成。\n\n${run.summary}`, { sopEvent: "done", sopRunId: run.id });
    }
  } else if (action === "retry") {
    if (!step) throw Object.assign(new Error("没有可重试的阶段"), { status: 400 });
    step.status = "pending"; step.result = ""; step.taskId = ""; step.finishedAt = "";
    run.status = "running";
    run.updatedAt = now();
    persistSopRun(run);
    sopSystemMessage(run.groupId, `↻ 阶段「${step.name}」重新执行。`, { sopEvent: "retry", sopRunId: run.id, sopStepId: step.id });
    spawnSopStep(run, run.currentStep);
  } else if (action === "stop") {
    run.status = "stopped";
    run.finishedAt = now();
    run.summary = buildSopSummary(run);
    run.updatedAt = now();
    persistSopRun(run);
    sopSystemMessage(run.groupId, `⏹ SOP「${run.templateName}」已人工终止。`, { sopEvent: "stop", sopRunId: run.id });
  } else {
    throw Object.assign(new Error("不支持的 SOP 操作"), { status: 400 });
  }
  sopBroadcast(run);
  return run;
}

/** 触发一个自主工作：按 prompt 建任务并派给绑定员工执行 */
function fireTrigger(triggerId, reason = "schedule") {
  const triggers = listOrgTriggers();
  const trg = triggers.find((t) => t.id === triggerId);
  if (!trg) throw Object.assign(new Error("自主工作不存在"), { status: 404 });
  if (!trg.enabled && reason !== "manual") throw Object.assign(new Error("自主工作已停用"), { status: 400 });
  if (trg.maxRuns > 0 && trg.runCount >= trg.maxRuns && reason !== "manual")
    throw Object.assign(new Error("已达最大运行次数"), { status: 400 });

  const tasks = listOrgTasks();
  const task = normalizeTask({
    id: genId("task"),
    title: trg.taskTitle,
    description: trg.prompt,
    assignee: trg.employeeId,
    source: "trigger",
    triggerId: trg.id,
    tags: ["autonomous", `trigger:${trg.id}`],
  }, {});
  task.history = [{ from: "", to: "todo", at: now(), note: `自主工作触发（${reason}）` }];
  tasks.push(task);
  saveOrgTasks(tasks);
  orgEmit("trigger_fired", { taskId: task.id, note: `自主工作「${trg.name}」触发了任务「${task.title}」` });

  trg.runCount = (trg.runCount || 0) + 1;
  trg.lastRunAt = now();
  if (trg.type === "once" && reason !== "manual") trg.enabled = false;
  const idx = triggers.findIndex((t) => t.id === triggerId);
  triggers[idx] = trg;
  saveOrgTriggers(triggers);

  let execution = null;
  try { execution = executeTask(task.id); } catch (e) { orgEmit("task_failed", { taskId: task.id, note: `自动执行失败：${e.message}` }); }
  return { taskId: task.id, execution };
}

/** 调度器：每 30 秒扫描一次 interval 触发器 */
function startTriggerScheduler() {
  const timer = setInterval(() => {
    const triggers = listOrgTriggers();
    const stamp = Date.now();
    for (const trg of triggers) {
      if (!trg.enabled || trg.type !== "interval" || trg.intervalMin < 1) continue;
      if (trg.maxRuns > 0 && (trg.runCount || 0) >= trg.maxRuns) continue;
      const last = trg.lastRunAt ? new Date(trg.lastRunAt).getTime() : 0;
      if (stamp - last < trg.intervalMin * 60 * 1000) continue;
      try { fireTrigger(trg.id, "schedule"); } catch {}
    }
  }, 30 * 1000);
  timer.unref?.();
  return timer;
}

/** 会话清理调度：启动 5 秒后跑一次，之后每 6 小时一次（自动执行不受编辑解锁影响） */
function startRetentionScheduler() {
  const run = () => {
    try {
      const r = runSessionRetention("schedule");
      if (r.deleted > 0)
        console.log(`[retention] 自动清理 ${r.deleted} 条会话，释放 ${(r.freedBytes / 1024).toFixed(1)} KB`);
    } catch (e) {
      console.error("[retention] 自动清理失败：", e.message);
    }
  };
  setTimeout(run, 5000).unref?.();
  const timer = setInterval(run, 6 * 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}

// 让聊天 RPC 的事件也分发给任务订阅者
// 在 getChatSession 的 stdout 解析里挂钩（通过包装 chatBroadcast 无法区分会话，改为在事件处显式分发）
function dispatchTaskEvent(ctx, event, payload) {
  if (!ctx.taskHooks || !ctx.taskHooks.size) return;
  for (const hooks of ctx.taskHooks.values()) {
    try {
      if (event === "message_end") hooks.onMessageEnd?.(payload);
      else if (event === "run_end") hooks.onRunEnd?.(payload);
    } catch {}
  }
}

// ---------- 管家 ----------
/** 管家的系统提示词：把 Pi Admin 的结构、现状和导入规则一次注入，写进工作区 .pi/SYSTEM.md */
function butlerSystemPrompt() {
  const safeCall = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const models = safeCall(collectModels, {});
  const resources = safeCall(collectResources, []);
  const employees = safeCall(listOrgEmployees, []);
  const tasks = safeCall(listOrgTasks, []);
  const sessions = safeCall(collectSessions, []);
  const byType = (t) => resources.filter((r) => r.type === t).length;
  return [
    `# 身份`,
    `你是「${BUTLER_NAME}」，Pi Admin 本地管理中心的管家。使用者不想逐个点配置项，希望你直接说清楚、能代劳的就代劳。`,
    ``,
    `# 你能回答什么`,
    `- 系统现状：模型、Provider、认证、默认模型、主题、扩展/技能/提示词、数字员工、任务、会话、知识库`,
    `- 操作指引：新增模型、设默认模型、派活、导入技能与工作流、重启服务、聊天报错排查`,
    `- 问题诊断：Pi 会话锁文件被沙箱拦截、模型连不通、任务没执行、按钮没反应`,
    ``,
    `# 当前系统快照（打开管家时生成）`,
    `- 工作区：${WORKSPACE}`,
    `- Pi 配置目录：${AGENT_DIR}`,
    `- 默认模型：${models.defaultProvider || "自动"} / ${models.defaultModel || "自动"}`,
    `- 已配置 Provider：${(models.configuredProviders || []).map((p) => p.id).join(", ") || "无"}`,
    `- 已配置凭证：${(models.credentials || []).map((c) => c.provider).join(", ") || "无"}（密钥已脱敏，永不输出明文）`,
    `- 资源：技能 ${byType("skills")}、提示词 ${byType("prompts")}、扩展 ${byType("extensions")}、主题 ${byType("themes")}`,
    `- 员工：${employees.length} 人；任务：${tasks.length} 个；会话：${sessions.length} 个`,
    ``,
    `# 关键路径`,
    `- 用户配置：~/.pi/agent/settings.json、models.json、auth.json、model-catalog.json`,
    `- 技能目录：~/.pi/agent/skills/（用户级）、<工作区>/.pi/skills/（项目级）`,
    `- 提示词目录：~/.pi/agent/prompts/、<工作区>/.pi/prompts/`,
    `- 组织数据：${join(WORKSPACE, "org")}（employees/、tasks.json、knowledge.json 等）`,
    ``,
    `# 导入 QoderWake 技能/工作流的规则`,
    `- 技能（SKILL.md 或 frontmatter 含 name/description）→ 写入 ~/.pi/agent/skills/<名称>/SKILL.md`,
    `- 工作流（文件名含 workflow 或内容含 steps）→ 转成提示词写入 ~/.pi/agent/prompts/<名称>.md`,
    `- 导入必须先预览、再执行；已有同名文件默认跳过，除非用户明确要覆盖；覆盖前由管理端自动备份`,
    `- 看不懂的格式如实说明，不要编造内容；不要输出任何密钥明文`,
    ``,
    `# 行为准则`,
    `- 结论先行，再给依据；能用列表就说清楚步骤`,
    `- 不确定就说不确定，并告诉用户去哪里核对`,
    `- 写文件、改配置、执行任务后，简要说明改了什么；密钥一律不回显`,
  ].join("\n") + "\n";
}

/** 取得（必要时创建）固定的管家会话；快照变化时更新 SYSTEM.md 并重启该会话 */
function ensureButlerSession() {
  mkdirSync(join(BUTLER_DIR, ".pi"), { recursive: true });
  const state = readJsonSafe(BUTLER_STATE_FILE, {});
  // 先确保会话文件存在，再生成快照：这样快照里的会话数已包含管家自己，
  // 下次打开不会因为数字变化而误判快照更新、白重启一次会话。
  let sessionFile = state.sessionFile;
  let created = false;
  if (!sessionFile || !existsSync(sessionFile)) {
    sessionFile = createSessionFile({ cwd: BUTLER_DIR, name: BUTLER_NAME }).file;
    created = true;
  }
  const content = butlerSystemPrompt();
  if (existsSync(BUTLER_SYSTEM_FILE)) {
    if (readFileSync(BUTLER_SYSTEM_FILE, "utf8") !== content) {
      backupFile(BUTLER_SYSTEM_FILE);
      writeFileSync(BUTLER_SYSTEM_FILE, content, "utf8");
      if (!created) closeChatSession(sessionFile, "system-prompt-updated");
    }
  } else {
    writeFileSync(BUTLER_SYSTEM_FILE, content, "utf8");
  }
  if (created) writeJson(BUTLER_STATE_FILE, { sessionFile, createdAt: now() });
  return { file: sessionFile, name: BUTLER_NAME };
}

// ---------- 导入：QoderWake 技能/工作流 → Pi 资源 ----------
function parseFrontmatter(text) {
  const out = {};
  const m = String(text).match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** 扫描导出目录，识别技能/工作流/提示词并给出目标路径（只读，不写盘） */
function scanImportDir(dir) {
  if (!dir || typeof dir !== "string" || !isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory())
    throw Object.assign(new Error("目录不存在或不是文件夹，请输入绝对路径"), { status: 400 });
  const files = listFiles(dir, [".md", ".markdown", ".yaml", ".yml", ".json"]).slice(0, 500);
  const items = [];
  for (const f of files) {
    try {
      const txt = readFileSync(f, "utf8");
      const name = basename(f);
      const fm = parseFrontmatter(txt);
      const head = txt.slice(0, 600);
      let kind = "";
      if (/^SKILL\.md$/i.test(name) || /skill/i.test(fm.name || "")) kind = "skill";
      else if (/workflow|wakerflow|flow/i.test(name) || /\bsteps\s*:|工作流/i.test(head)) kind = "workflow";
      else if (fm.name || fm.description || /^#\s+/.test(txt)) kind = "prompt";
      if (!kind) continue;
      const rawTitle = fm.name || fm.title || name.replace(/\.(md|markdown|ya?ml|json)$/i, "");
      const title = String(rawTitle).trim() || "untitled";
      const slug = title.replace(/[^\w\u4e00-\u9fa5-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";
      const targetType = kind === "skill" ? "skills" : "prompts";
      const target = join(AGENT_DIR, targetType, kind === "skill" ? `${slug}/SKILL.md` : `${slug}.md`);
      items.push({
        file: f, name, kind, title,
        description: String(fm.description || "").slice(0, 160),
        target, targetType,
        exists: existsSync(target),
        size: Buffer.byteLength(txt),
        preview: txt.slice(0, 240),
      });
    } catch {}
  }
  return items;
}

/** 执行导入：只写 Pi 的 skills/prompts 目录；同名默认跳过，覆盖前备份 */
function applyImport(items, overwrite) {
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error("没有要导入的条目"), { status: 400 });
  const allowed = [join(AGENT_DIR, "skills"), join(AGENT_DIR, "prompts")];
  let imported = 0, skipped = 0;
  const backups = [];
  for (const it of items) {
    let src = "", dest = "";
    try {
      src = resolve(String(it.file || ""));
      dest = resolve(String(it.target || ""));
    } catch { skipped++; continue; }
    if (!existsSync(src) || !statSync(src).isFile()) { skipped++; continue; }
    if (!allowed.some((base) => dest === base || dest.startsWith(base + "/"))) { skipped++; continue; }
    if (existsSync(dest) && !overwrite) { skipped++; continue; }
    if (existsSync(dest)) backups.push(backupFile(dest));
    mkdirSync(dirname(dest), { recursive: true });
    let txt = readFileSync(src, "utf8");
    if (it.kind === "workflow" && !/^\s*#/.test(txt)) txt = `# ${String(it.title || "工作流").trim()}\n\n${txt}`;
    writeFileSync(dest, txt, "utf8");
    imported++;
  }
  return { imported, skipped, backups: backups.filter(Boolean) };
}

// ---------- 技能库管理：读取 / 新建 / 编辑 / 删除 SKILL.md ----------
/** 技能目录白名单：只在 user/project 的 skills 下操作 */
function skillScopeBase(scope) {
  if (scope === "user") return join(AGENT_DIR, "skills");
  if (scope === "project") return join(PROJECT_PI, "skills");
  throw Object.assign(new Error("无效的技能 scope"), { status: 400 });
}
function skillSlugValid(slug) {
  return typeof slug === "string" && /^[A-Za-z0-9_\u4e00-\u9fa5-]{1,80}$/.test(slug);
}
/** 列出技能库：每个含 SKILL.md 的目录算一个技能，同时列出其附加 .md 文件 */
function listSkillLibrary() {
  const resources = collectResources();
  const enabledByPath = new Map(resources.filter((r) => r.type === "skills").map((r) => [r.path, r.enabled]));
  const out = [];
  for (const scope of ["user", "project"]) {
    const base = skillScopeBase(scope);
    if (!existsSync(base)) continue;
    let dirs = [];
    try { dirs = readdirSync(base, { withFileTypes: true }); } catch {}
    for (const ent of dirs) {
      if (!ent.isDirectory()) continue;
      const dir = join(base, ent.name);
      const skillMd = join(dir, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const txt = readFileSync(skillMd, "utf8");
      const fm = parseFrontmatter(txt);
      const refs = listFiles(dir, [".md", ".markdown"]).filter((f) => f !== skillMd);
      out.push({
        id: `${scope}:${ent.name}`, scope, slug: ent.name,
        name: String(fm.name || ent.name), description: String(fm.description || "").slice(0, 300),
        skill: ent.name, path: skillMd, size: Buffer.byteLength(txt),
        enabled: enabledByPath.get(skillMd) !== false,
        files: refs.map((f) => relative(base, f).replace(/\\/g, "/")),
        updatedAt: statSync(skillMd).mtimeMs || 0,
      });
    }
  }
  return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
}
function resolveSkillMd(scope, slug) {
  if (!skillSlugValid(slug)) throw Object.assign(new Error("技能标识不合法（仅字母数字、中文、下划线、短横线）"), { status: 400 });
  const base = skillScopeBase(scope);
  const dir = join(base, slug);
  const abs = resolve(dir);
  if (abs !== resolve(base) && !abs.startsWith(resolve(base) + "/"))
    throw Object.assign(new Error("技能路径越界"), { status: 400 });
  return { dir, file: join(dir, "SKILL.md") };
}

// ---------- 一键重启 ----------
// 用一个脱离父进程的 shell 等待端口释放后重新拉起 Node：
//  - 父进程 shutdown 后它仍存活，避免「自己杀自己」导致新进程起不来；
//  - 不依赖 Apple Events（open -a Terminal 在受限环境里可能静默失败）；
//  - Pi RPC 子进程在 spawn 时已逐个清理沙箱注入变量，因此这里无需额外处理。
function restartProcess() {
  const script = [
    `cd "${__dirname}"`,
    `for i in $(seq 1 40); do`,
    `  if ! lsof -tiTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then break; fi`,
    `  sleep 0.3`,
    `done`,
    `LEFT=$(lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null)`,
    `if [ -n "$LEFT" ]; then echo "$LEFT" | xargs kill -9 2>/dev/null; sleep 0.5; fi`,
    `unset NODE_OPTIONS`,
    `exec node "${SERVER_ENTRY}" --port ${PORT} --workspace "${WORKSPACE}" --agent-dir "${AGENT_DIR}"`,
  ].join("\n");
  try {
    const child = spawn("/bin/bash", ["-c", script], {
      cwd: __dirname,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    child.unref();
  } catch (e) {
    console.error("[restart] 启动新进程失败：", e.message);
  }
  // 让本进程优雅退出，同时关闭全部 RPC 子进程
  setTimeout(() => shutdown(), 250);
}

// ---------- 路由 ----------
async function handleApi(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  if (path === "/api/overview" && method === "GET") {
    await refreshUsdCnyRate();
    return send(res, 200, collectOverview());
  }
  if (path === "/api/fx" && method === "GET") return send(res, 200, fxPublic());

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

  // 技能库管理：列表 / 读取内容 / 新建编辑 / 删除
  if (path === "/api/skills" && method === "GET") return send(res, 200, listSkillLibrary());
  if (path === "/api/skills/content" && method === "GET") {
    const scope = url.searchParams.get("scope") || "";
    const slug = url.searchParams.get("slug") || "";
    const { file } = resolveSkillMd(scope, slug);
    if (!existsSync(file)) throw Object.assign(new Error("技能不存在"), { status: 404 });
    return send(res, 200, { scope, slug, content: readFileSync(file, "utf8") });
  }
  if (path === "/api/skills/save" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const scope = String(body.scope || "");
    const slug = String(body.slug || "");
    const content = String(body.content ?? "");
    const { dir, file } = resolveSkillMd(scope, slug);
    if (!content.trim()) throw Object.assign(new Error("SKILL.md 内容不能为空"), { status: 400 });
    const backup = backupFile(file);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content, "utf8");
    return send(res, 200, { ok: true, backup, id: `${scope}:${slug}`, note: "技能已保存，Pi 内执行 /reload 生效" });
  }
  if (path === "/api/skills/delete" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const scope = String(body.scope || "");
    const slug = String(body.slug || "");
    const { dir, file } = resolveSkillMd(scope, slug);
    if (!existsSync(file)) throw Object.assign(new Error("技能不存在"), { status: 404 });
    const backup = backupFile(file);
    const refs = listFiles(dir, [".md", ".markdown"]).filter((f) => f !== file);
    const refBackups = refs.map((f) => backupFile(f)).filter(Boolean);
    rmSync(dir, { recursive: true, force: true });
    return send(res, 200, { ok: true, backup, backups: refBackups, note: "技能已删除（含附加文件，均已备份）" });
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

  // ===== 实时聊天（Pi RPC + SSE） =====
  // SSE 事件流：浏览器用 EventSource 订阅，接收 delta / tool / run_end 等
  if (path === "/api/chat/stream" && method === "GET") {
    const file = url.searchParams.get("file") || "";
    const ctx = getChatSession(file);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ file, model: ctx.state?.model || null })}\n\n`);
    ctx.clients.add(res);
    touchIdle(ctx);
    const heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      ctx.clients.delete(res);
      if (ctx.clients.size === 0 && !ctx.running) {
        ctx.idleTimer = setTimeout(() => closeChatSession(file, "idle"), 60 * 1000);
        ctx.idleTimer.unref?.();
      }
    });
    return;
  }

  // 发送用户消息：对话是高频日常操作，不要求「解锁编辑」（解锁只保护配置写操作）
  if (path === "/api/chat/send" && method === "POST") {
    const body = await readBody(req);
    const { file, message, streamingBehavior } = body;
    if (typeof message !== "string" || !message.trim())
      throw Object.assign(new Error("消息不能为空"), { status: 400 });
    const ctx = getChatSession(file);
    if (ctx.running && !streamingBehavior)
      throw Object.assign(new Error("模型正在回复，请稍候或先停止"), { status: 409 });
    const cmd = { type: "prompt", message };
    if (streamingBehavior) cmd.streamingBehavior = streamingBehavior;
    // 先回显用户消息给前端（Pi 的 user message_start 事件在 RPC 下不一定推送）
    chatBroadcast(ctx, "user_echo", { text: message });
    const id = ctx.rpcSend(cmd);
    return send(res, 200, { ok: true, id, file });
  }

  // 中止当前回复
  if (path === "/api/chat/abort" && method === "POST") {
    const body = await readBody(req);
    const ctx = chatSessions.get(body.file);
    if (!ctx) return send(res, 200, { ok: true, note: "没有运行中的会话" });
    ctx.rpcSend({ type: "abort" });
    return send(res, 200, { ok: true });
  }

  // 关闭 RPC 子进程（不删会话文件）
  if (path === "/api/chat/close" && method === "POST") {
    const body = await readBody(req);
    closeChatSession(body.file, "manual");
    return send(res, 200, { ok: true });
  }

  // 查询运行中的聊天会话
  if (path === "/api/chat/status" && method === "GET") {
    return send(res, 200, [...chatSessions.entries()].map(([file, c]) => ({
      file, running: c.running, clients: c.clients.size,
      model: c.state?.model || null,
    })));
  }

  // 切换模型：属于对话交互，不要求解锁编辑
  if (path === "/api/chat/model" && method === "POST") {
    const body = await readBody(req);
    const ctx = getChatSession(body.file);
    if (!body.provider || !body.modelId)
      throw Object.assign(new Error("缺少 provider 或 modelId"), { status: 400 });
    return new Promise((resolve) => {
      const id = ctx.rpcSend({ type: "set_model", provider: body.provider, modelId: body.modelId });
      const timer = setTimeout(() => { ctx.pending.delete(id); resolve(send(res, 200, { ok: true, note: "已请求切换模型" })); }, 3000);
      ctx.pending.set(id, (rec) => {
        clearTimeout(timer);
        if (!rec.success) return resolve(send(res, 400, { error: rec.error || "切换模型失败" }));
        ctx.model = rec.data;
        chatBroadcast(ctx, "model_changed", { model: rec.data });
        resolve(send(res, 200, { ok: true, model: rec.data }));
      });
    });
  }

  if (path === "/api/sessions" && method === "GET") return send(res, 200, collectSessions());

  // 快速建会话：自动生成名称，创建后前端立刻在右侧开聊；员工工作目录缺失时自动补建。属于对话交互，不要求解锁
  if (path === "/api/session/quick-create" && method === "POST") {
    const body = await readBody(req);
    const cwd = body.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd))
      throw Object.assign(new Error("工作目录必须是绝对路径"), { status: 400 });
    const empRoot = join(WORKSPACE, "org", "workspaces");
    if (cwd.startsWith(empRoot + "/") && !existsSync(cwd)) mkdirSync(cwd, { recursive: true });
    const name = String(body.name || "").replace(/[\r\n]+/g, " ").trim()
      || `新会话 ${now().slice(5, 16).replace("T", " ")}`;
    const created = createSessionFile({ cwd, name });
    return send(res, 200, { ok: true, ...created, name });
  }

  // 重命名会话：更新 session_info.name（写前自动备份）
  // 会话改名：对话交互的一部分（自动命名/手动改名），不要求解锁编辑
  if (path === "/api/session/rename" && method === "POST") {
    const body = await readBody(req);
    const { file, name } = body;
    if (!safePath(file) || !file.endsWith(".jsonl") || !existsSync(file))
      throw Object.assign(new Error("会话文件不可访问"), { status: 400 });
    const clean = String(name || "").replace(/[\r\n]+/g, " ").trim();
    if (!clean) throw Object.assign(new Error("名称不能为空"), { status: 400 });
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.type === "session_info") { e.name = clean; lines[i] = JSON.stringify(e); found = true; }
      } catch {}
    }
    if (!found) {
      const id = randomUUID().replace(/-/g, "").slice(0, 8);
      lines.splice(1, 0, JSON.stringify({ type: "session_info", id, parentId: null, timestamp: now(), name: clean }));
      if (lines[2]) {
        try {
          const e2 = JSON.parse(lines[2]);
          if (e2.parentId == null) { e2.parentId = id; lines[2] = JSON.stringify(e2); }
        } catch {}
      }
    }
    const backup = backupFile(file);
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    return send(res, 200, { ok: true, name: clean, backup });
  }

  // 新开会话：生成 Pi v3 会话文件（header + 可选名称/首句），之后用 pi --session <id> 续聊
  if (path === "/api/session/create" && method === "POST") {
    const body = await readBody(req);
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
    // 和新建/重命名/聊天一致：会话级操作不需要解锁；前端有二次确认，删除前会自动备份
    const { file } = body;
    if (!safePath(file) || !file.endsWith(".jsonl") || !existsSync(file)) throw Object.assign(new Error("文件不可访问"), { status: 400 });
    const backup = backupFile(file);
    unlinkSync(file);
    return send(res, 200, { ok: true, backup });
  }

  // 会话自动清理：读取策略 + 预览将被清理的会话（只读，不修改文件）
  if (path === "/api/session/retention" && method === "GET") {
    const cfg = readRetentionConfig();
    const all = scanRetentionCandidates(cfg);
    let log = readJsonSafe(SESSION_RETENTION_LOG, []);
    if (!Array.isArray(log)) log = [];
    return send(res, 200, {
      cfg,
      candidates: all.map((x) => ({
        file: x.file,
        name: friendlySessionName(basename(x.file, ".jsonl")) || basename(x.file, ".jsonl"),
        bytes: x.bytes,
        idleDays: Math.round((Date.now() - x.mtimeMs) / 86400000),
        expired: x.expired,
        reason: x.reason,
      })),
      expiredCount: all.filter((x) => x.expired).length,
      expiredBytes: all.filter((x) => x.expired).reduce((s, x) => s + x.bytes, 0),
      totalCount: all.length,
      totalBytes: all.reduce((s, x) => s + x.bytes, 0),
      recentRuns: log.slice(0, 5),
    });
  }

  // 保存清理策略（配置写操作，需解锁）
  if (path === "/api/session/retention" && method === "PUT") {
    const body = await readBody(req);
    requireUnlock(body);
    const days = Number(body.days);
    const minKeep = Number(body.minKeep);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw Object.assign(new Error("保留天数需在 1-3650 之间"), { status: 400 });
    if (!Number.isInteger(minKeep) || minKeep < 0 || minKeep > 100) throw Object.assign(new Error("最少保留条数需在 0-100 之间"), { status: 400 });
    const next = { ...readRetentionConfig(), enabled: body.enabled === true, days, minKeep };
    writeRetentionConfig(next);
    return send(res, 200, { ok: true, cfg: next });
  }

  // 立即清理（真实删除文件，需解锁）
  if (path === "/api/session/retention/run" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    return send(res, 200, runSessionRetention("manual"));
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

  // 会话右上角模型下拉：仅返回用户已设置的模型
  if (path === "/api/models/configured" && method === "GET")
    return send(res, 200, collectConfiguredModels());

  // 模型连通性校验（只读探测，不写入配置）
  if (path === "/api/models/test" && method === "POST") {
    const body = await readBody(req);
    const provider = String(body.provider || "");
    const modelId = String(body.modelId || "");
    if (!provider || !modelId) throw Object.assign(new Error("缺少 provider 或 modelId"), { status: 400 });
    return send(res, 200, await testModelConnection(provider, modelId));
  }

  // 会话精简总结：额外 LLM 调用，仅前端会话级开关打开时才请求
  if (path === "/api/chat/summarize" && method === "POST") {
    const body = await readBody(req);
    const text = String(body.text || "");
    // 未指定模型时回退到系统默认模型（群聊回应不带模型信息）
    const def = getSettings("user").data;
    const provider = String(body.provider || def.defaultProvider || "");
    const modelId = String(body.modelId || def.defaultModel || "");
    if (!text.trim()) throw Object.assign(new Error("没有可总结的内容"), { status: 400 });
    if (!provider || !modelId) throw Object.assign(new Error("缺少模型信息，无法总结"), { status: 400 });
    const r = await callLlmOnce(provider, modelId, SUMMARY_SYSTEM, `员工回复：\n${text.slice(0, 12000)}`, 700);
    const info = r.usage ? usageCostInfo(r.usage, { provider, model: modelId, ts: now() }) : null;
    return send(res, 200, {
      ok: true, summary: r.text, usage: r.usage,
      cost: info ? { cny: info.cny, mode: info.mode, label: info.label } : null,
    });
  }

  // 设置默认模型：写用户 settings.json 的 defaultProvider / defaultModel
  // 与 Pi 源码 setDefaultModelAndProvider() 语义一致；写前备份、需解锁。
  if (path === "/api/models/set-default" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const provider = String(body.provider || "").trim();
    const modelId = String(body.modelId || "").trim();
    if (!provider || !modelId) throw Object.assign(new Error("缺少 provider 或 modelId"), { status: 400 });
    const { path: settingsPath, data: settings } = getSettings("user");
    const backup = backupFile(settingsPath);
    writeJson(settingsPath, { ...settings, defaultProvider: provider, defaultModel: modelId });
    return send(res, 200, {
      ok: true, provider, modelId, backup,
      note: "默认模型已保存；新会话立即生效，已打开的会话可点模型下拉切换。",
    });
  }

  // ---------- 数字员工：组织管理（P1） ----------
  if (path === "/api/org/overview" && method === "GET")
    return send(res, 200, collectOrgOverview());

  if (path === "/api/org/employees" && method === "GET") {
    const usage = employeeUsageSummary().employees;
    return send(res, 200, listOrgEmployees().map((e) => ({ ...e, usage: usage[e.id] || emptyEmployeeUsage() })));
  }

  // 员工累计 token / 金额（群聊与任务会话已计入）
  if (path === "/api/org/employee-usage" && method === "GET")
    return send(res, 200, employeeUsageSummary());

  if (path === "/api/org/employee-usage/reset" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const employeeId = String(body.employeeId || "").trim();
    if (!employeeId) throw Object.assign(new Error("缺少 employeeId"), { status: 400 });
    const employees = resetEmployeeUsage(employeeId);
    return send(res, 200, { ok: true, employees, note: employeeId === "__all__" ? "已重置全部员工用量" : "已重置该员工累计用量" });
  }

  // 技能/工作流继承解析：返回每个员工的 部门继承 / 个人 / 合并后 技能与工作流
  // 前端据此展示继承关系；不改变员工文件本身（个人 skills 仍是唯一可写源）
  if (path === "/api/org/skills-resolve" && method === "GET") {
    const employees = listOrgEmployees();
    const allGroups = listOrgGroups();
    const resolve = (e) => {
      const dept = getEmployeeDepartment(e);
      const inherited = Array.isArray(dept?.skills) ? dept.skills.map(String) : [];
      const own = Array.isArray(e.skills) ? e.skills.map(String) : [];
      // 员工所在的团队（成员或 leader）
      const myGroups = allGroups.filter((g) => (g.members || []).includes(e.id) || g.leader === e.id);
      const teamSkills = [...new Set(myGroups.flatMap((g) => Array.isArray(g.skills) ? g.skills.map(String) : []))];
      const teamFlows = [...new Set(myGroups.flatMap((g) => Array.isArray(g.workflows) ? g.workflows.map(String) : []))];
      const teamSkillsOnly = teamSkills.filter((s) => !inherited.includes(s) && !own.includes(s));
      return {
        id: e.id, department: e.department, departmentName: dept?.name || "",
        inheritedSkills: inherited, teamSkills: teamSkillsOnly,
        groupIds: myGroups.map((g) => g.id), groupNames: myGroups.map((g) => g.name),
        ownSkills: own, effectiveSkills: [...new Set([...inherited, ...teamSkills, ...own])],
        workflows: [...new Set([...effectiveEmployeeWorkflows(e), ...teamFlows])],
      };
    };
    return send(res, 200, {
      employees: employees.map(resolve),
      departments: listOrgDepartments().map((d) => ({
        id: d.id, name: d.name,
        skills: Array.isArray(d.skills) ? d.skills.map(String) : [],
        workflows: Array.isArray(d.workflows) ? d.workflows.map(String) : [],
      })),
      groups: listOrgGroups().map((g) => ({
        id: g.id, name: g.name,
        skills: Array.isArray(g.skills) ? g.skills.map(String) : [],
        workflows: Array.isArray(g.workflows) ? g.workflows.map(String) : [],
        memberIds: [...new Set([...(g.members || []), g.leader].filter(Boolean))],
      })),
    });
  }

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

  // ===== P2+ 协作闭环 =====
  // 组织事件流（SSE）：任务状态、执行结果、审批、handoff 实时推送
  if (path === "/api/org/events" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ at: now(), running: [...runningTasks.keys()] })}\n\n`);
    orgClients.add(res);
    const heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);
    req.on("close", () => { clearInterval(heartbeat); orgClients.delete(res); });
    return;
  }

  // 组织全景：员工/部门/岗位/任务/群组/触发器 + 统计
  if (path === "/api/org/full" && method === "GET") {
    const usage = employeeUsageSummary().employees;
    const employees = listOrgEmployees().map((e) => ({ ...e, usage: usage[e.id] || emptyEmployeeUsage() }));
    const tasks = listOrgTasks();
    const triggers = listOrgTriggers();
    return send(res, 200, {
      ...collectOrgOverview(),
      tasks,
      groups: listOrgGroups(),
      triggers,
      knowledge: listOrgKnowledge(),
      projects: listOrgProjects(),
      running: [...runningTasks.keys()],
      stats: {
        ...collectOrgOverview().stats,
        tasks: tasks.length,
        todo: tasks.filter((t) => t.status === "todo").length,
        doing: tasks.filter((t) => t.status === "doing").length,
        review: tasks.filter((t) => t.status === "review").length,
        done: tasks.filter((t) => t.status === "done").length,
        blocked: tasks.filter((t) => t.status === "blocked").length,
        groups: listOrgGroups().length,
        triggers: triggers.filter((t) => t.enabled).length,
      },
    });
  }

  // 任务列表 / 创建
  if (path === "/api/org/tasks" && method === "GET")
    return send(res, 200, listOrgTasks());

  if (path === "/api/org/tasks" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const tasks = listOrgTasks();
    let task = normalizeTask(body, {});
    if (tasks.some((t) => t.id === task.id)) throw Object.assign(new Error(`任务 ID ${task.id} 已存在`), { status: 409 });
    task.history = [{ from: "", to: task.status, at: now(), note: "任务创建" }];
    tasks.push(task);
    saveOrgTasks(tasks);
    orgEmit("task_created", { taskId: task.id, title: task.title, note: `新建任务「${task.title}」` });
    return send(res, 200, { ok: true, task, note: "任务已创建" });
  }

  // 单任务详情
  if (path.startsWith("/api/org/tasks/") && method === "GET" && !path.includes("/", "/api/org/tasks/".length + 1)) {
    const id = decodeURIComponent(path.slice("/api/org/tasks/".length));
    const task = listOrgTasks().find((t) => t.id === id);
    if (!task) throw Object.assign(new Error("任务不存在"), { status: 404 });
    const runFiles = existsSync(ORG_RUNS_DIR) ? listFiles(ORG_RUNS_DIR, [".json"]) : [];
    const runs = runFiles.map((p) => readJsonSafe(p, null)).filter((r) => r && r.taskId === id).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    const msgs = listOrgMessages(`task:${id}`, 200);
    return send(res, 200, { task, runs, messages: msgs });
  }

  // 更新任务
  if (path.startsWith("/api/org/tasks/") && method === "PUT" && !path.includes("/", "/api/org/tasks/".length + 1)) {
    const id = decodeURIComponent(path.slice("/api/org/tasks/".length));
    const body = await readBody(req);
    requireUnlock(body);
    const tasks = listOrgTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw Object.assign(new Error("任务不存在"), { status: 404 });
    const task = normalizeTask({ ...tasks[idx], ...body, id }, tasks[idx]);
    tasks[idx] = task;
    saveOrgTasks(tasks);
    orgEmit("task_status", { taskId: id, status: task.status, note: `任务「${task.title}」已更新` });
    return send(res, 200, { ok: true, task, note: "任务已更新" });
  }

  // 删除任务（不删会话/产物，仅移除任务卡；写前备份）
  if (path.startsWith("/api/org/tasks/") && method === "DELETE" && !path.includes("/", "/api/org/tasks/".length + 1)) {
    const id = decodeURIComponent(path.slice("/api/org/tasks/".length));
    const body = await readBody(req);
    requireUnlock(body);
    const tasks = listOrgTasks();
    const next = tasks.filter((t) => t.id !== id);
    if (next.length === tasks.length) throw Object.assign(new Error("任务不存在"), { status: 404 });
    const backup = saveOrgTasks(next);
    return send(res, 200, { ok: true, backup, note: "任务卡已移除（执行记录保留）" });
  }

  // 任务状态流转
  if (path.startsWith("/api/org/tasks/") && path.endsWith("/transition") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/tasks/".length, -"/transition".length));
    const body = await readBody(req);
    requireUnlock(body);
    const tasks = listOrgTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw Object.assign(new Error("任务不存在"), { status: 404 });
    transitionTask(tasks[idx], body.status, body.note || "手动流转");
    if (body.lastResult !== undefined) tasks[idx].lastResult = String(body.lastResult).slice(0, 20000);
    saveOrgTasks(tasks);
    orgEmit("task_status", { taskId: id, status: tasks[idx].status, note: body.note || `状态改为 ${tasks[idx].status}` });
    return send(res, 200, { ok: true, task: tasks[idx] });
  }

  // 派活 / 改派：指派员工或群组，可选立即执行
  if (path.startsWith("/api/org/tasks/") && path.endsWith("/assign") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/tasks/".length, -"/assign".length));
    const body = await readBody(req);
    requireUnlock(body);
    const tasks = listOrgTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw Object.assign(new Error("任务不存在"), { status: 404 });
    const assignee = String(body.assignee || "").trim();
    const groupId = String(body.groupId || "").trim();
    if (assignee) {
      if (!listOrgEmployees().some((e) => e.id === assignee)) throw Object.assign(new Error("指派的员工不存在"), { status: 400 });
      tasks[idx].assignee = assignee;
      tasks[idx].groupId = "";
      transitionTask(tasks[idx], "doing", `派活给 ${assignee}`);
    } else if (groupId) {
      if (!listOrgGroups().some((g) => g.id === groupId)) throw Object.assign(new Error("指派的群组不存在"), { status: 400 });
      tasks[idx].groupId = groupId;
      tasks[idx].assignee = "";
      transitionTask(tasks[idx], "doing", `派活给群组 ${groupId}`);
    } else {
      throw Object.assign(new Error("请选择员工或群组"), { status: 400 });
    }
    tasks[idx].updatedAt = now();
    saveOrgTasks(tasks);
    orgEmit("task_assigned", { taskId: id, assignee, groupId, note: `任务「${tasks[idx].title}」已派活` });
    appendOrgMessage({ id: genId("msg"), channel: `task:${id}`, from: "human", to: assignee || groupId, type: "task_assign", body: tasks[idx].description || tasks[idx].title, ref: id, createdAt: now() });

    // 群派活：拆成子任务给每个成员（保留父任务做汇总）
    let spawned = [];
    if (groupId) {
      const group = listOrgGroups().find((g) => g.id === groupId);
      const members = (group?.members || []).filter((m) => listOrgEmployees().some((e) => e.id === m && e.status !== "archived"));
      for (const m of members) {
        const sub = normalizeTask({
          id: genId("task"), title: `${tasks[idx].title} · ${listOrgEmployees().find((e) => e.id === m)?.name || m}`,
          description: `${tasks[idx].description || ""}\n\n（群组 ${group.name} 子任务，父任务 ${id}）`,
          acceptance: tasks[idx].acceptance, assignee: m, priority: tasks[idx].priority,
          source: "group", tags: [...(tasks[idx].tags || []), `parent:${id}`],
        }, {});
        sub.history = [{ from: "", to: "todo", at: now(), note: "群派活自动创建" }];
        tasks.push(sub);
        spawned.push(sub.id);
        orgEmit("task_created", { taskId: sub.id, title: sub.title, note: `群派活子任务：${sub.title}` });
      }
      tasks[idx].subtasks = spawned;
      saveOrgTasks(tasks);
      // 群派活：每个子任务也按"派活即执行"自动启动
      if (body.execute) {
        for (const sid of spawned) {
          try { executeTask(sid); }
          catch (e) { orgEmit("task_failed", { taskId: sid, note: `子任务自动执行失败：${e.message}` }); }
        }
      }
    }
    // 若要求立即执行且是单员工，直接启动
    if (body.execute && assignee) {
      try { const r = executeTask(id); return send(res, 200, { ok: true, task: tasks[idx], spawned, execution: r }); }
      catch (e) { return send(res, 200, { ok: true, task: tasks[idx], spawned, note: `派活成功，但自动执行失败：${e.message}` }); }
    }
    return send(res, 200, { ok: true, task: tasks[idx], spawned });
  }

  // 手动触发执行（真实接 Pi）
  if (path.startsWith("/api/org/tasks/") && path.endsWith("/run") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/tasks/".length, -"/run".length));
    const body = await readBody(req);
    requireUnlock(body);
    const r = executeTask(id);
    return send(res, 200, { ok: true, ...r, note: "任务已开始执行，订阅 /api/org/events 看进度" });
  }

  // 中止执行
  if (path.startsWith("/api/org/tasks/") && path.endsWith("/abort") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/tasks/".length, -"/abort".length));
    const body = await readBody(req);
    const state = runningTasks.get(id);
    if (!state) return send(res, 200, { ok: true, note: "任务未在执行" });
    state.ctx.rpcSend({ type: "abort" });
    finalizeTaskRun(id, true);
    return send(res, 200, { ok: true, note: "已请求中止" });
  }

  // 产物追加
  if (path.startsWith("/api/org/tasks/") && path.endsWith("/artifact") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/tasks/".length, -"/artifact".length));
    const body = await readBody(req);
    requireUnlock(body);
    const tasks = listOrgTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw Object.assign(new Error("任务不存在"), { status: 404 });
    const artifact = { path: String(body.path || "").trim(), note: String(body.note || "").trim(), at: now() };
    if (!artifact.path) throw Object.assign(new Error("缺少产物路径"), { status: 400 });
    tasks[idx].artifacts = Array.isArray(tasks[idx].artifacts) ? tasks[idx].artifacts : [];
    tasks[idx].artifacts.push(artifact);
    saveOrgTasks(tasks);
    return send(res, 200, { ok: true, artifact });
  }

  // 员工之间交接 / 汇报（结构化消息）
  if (path === "/api/org/messages" && method === "GET") {
    const channel = url.searchParams.get("channel") || "";
    const limit = Number(url.searchParams.get("limit") || 300);
    return send(res, 200, listOrgMessages(channel, limit));
  }
  if (path === "/api/org/messages" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const msg = {
      id: genId("msg"),
      channel: String(body.channel || "org"),
      from: String(body.from || "human"),
      to: String(body.to || ""),
      type: String(body.type || "status_report"),
      body: String(body.body || "").slice(0, 8000),
      ref: String(body.ref || ""),
      createdAt: now(),
    };
    appendOrgMessage(msg);
    orgBroadcast("message", msg);
    // handoff 自动为目标员工建任务
    if (msg.type === "handoff" && msg.to && listOrgEmployees().some((e) => e.id === msg.to)) {
      const tasks = listOrgTasks();
      const sub = normalizeTask({
        id: genId("task"), title: `交接：${String(body.title || msg.body).slice(0, 60)}`,
        description: msg.body, assignee: msg.to, source: "handoff",
        tags: [`handoff:${msg.ref || msg.from}`],
      }, {});
      sub.history = [{ from: "", to: "todo", at: now(), note: `来自 ${msg.from} 的交接` }];
      tasks.push(sub);
      saveOrgTasks(tasks);
      orgEmit("handoff", { taskId: sub.id, note: `${msg.from} 交接任务给 ${msg.to}` });
      return send(res, 200, { ok: true, message: msg, spawnedTask: sub.id });
    }
    return send(res, 200, { ok: true, message: msg });
  }

  // 执行记录
  if (path === "/api/org/runs" && method === "GET") {
    const taskId = url.searchParams.get("taskId") || "";
    const files = existsSync(ORG_RUNS_DIR) ? listFiles(ORG_RUNS_DIR, [".json"]) : [];
    let runs = files.map((p) => readJsonSafe(p, null)).filter((r) => r && (!taskId || r.taskId === taskId));
    runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return send(res, 200, runs.slice(0, 100));
  }

  // 审批队列
  if (path === "/api/org/approvals" && method === "GET")
    return send(res, 200, [...approvals.values()]);
  if (path === "/api/org/approvals" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const id = String(body.id || "");
    if (!approvals.has(id)) throw Object.assign(new Error("审批不存在或已处理"), { status: 404 });
    const ap = approvals.get(id);
    ap.decision = body.decision === "approve" ? "approve" : "reject";
    ap.decidedAt = now();
    ap.decidedBy = "human";
    approvals.delete(id);
    orgEmit("approval", { taskId: ap.taskId, note: `审批 ${ap.decision === "approve" ? "通过" : "拒绝"}：${ap.title}` });
    return send(res, 200, { ok: true, approval: ap });
  }

  // 群组 CRUD
  if (path === "/api/org/groups" && method === "GET")
    return send(res, 200, listOrgGroups());
  if (path === "/api/org/groups" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const groups = listOrgGroups();
    const exists = groups.findIndex((g) => g.id === String(body.id || ""));
    const group = {
      id: String(body.id || (exists >= 0 ? groups[exists].id : genId("grp"))),
      name: String(body.name || "").trim(),
      description: String(body.description || "").trim(),
      leader: String(body.leader || "").trim(),
      members: Array.isArray(body.members) ? body.members.map((m) => String(m).trim()).filter(Boolean) : [],
      // 团队专属技能与工作流：团队成员在群聊/SOP 场景下叠加继承
      skills: Array.isArray(body.skills) ? body.skills.map((s) => String(s).trim()).filter(Boolean) : [],
      workflows: Array.isArray(body.workflows) ? body.workflows.map((s) => String(s).trim()).filter(Boolean) : [],
      createdAt: exists >= 0 ? groups[exists].createdAt : now(),
      updatedAt: now(),
    };
    if (!group.name) throw Object.assign(new Error("群组名称不能为空"), { status: 400 });
    if (exists >= 0) groups[exists] = group; else groups.push(group);
    const backup = saveOrgGroups(groups);
    return send(res, 200, { ok: true, group, backup, note: exists >= 0 ? "群组已更新" : "群组已创建" });
  }
  if (path.startsWith("/api/org/groups/") && path.endsWith("/delete") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/groups/".length, -"/delete".length));
    const body = await readBody(req);
    requireUnlock(body);
    const groups = listOrgGroups();
    const next = groups.filter((g) => g.id !== id);
    if (next.length === groups.length) throw Object.assign(new Error("群组不存在"), { status: 404 });
    const backup = saveOrgGroups(next);
    return send(res, 200, { ok: true, backup, note: "群组已删除（任务不受影响）" });
  }

  // 群聊消息：读取群频道历史
  if (path.startsWith("/api/org/groups/") && path.endsWith("/messages") && method === "GET") {
    const id = decodeURIComponent(path.slice("/api/org/groups/".length, -"/messages".length));
    const group = listOrgGroups().find((g) => g.id === id);
    if (!group) throw Object.assign(new Error("群组不存在"), { status: 404 });
    const limit = Number(url.searchParams.get("limit") || 200);
    return send(res, 200, listOrgMessages(`group:${id}`, limit));
  }
  // 群聊消息：发送；@ 成员则唤醒执行，结果汇总回写群频道
  if (path.startsWith("/api/org/groups/") && path.endsWith("/messages") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/groups/".length, -"/messages".length));
    const body = await readBody(req);
    requireUnlock(body);
    const group = listOrgGroups().find((g) => g.id === id);
    if (!group) throw Object.assign(new Error("群组不存在"), { status: 404 });
    const text = String(body.body || "").trim();
    if (!text) throw Object.assign(new Error("消息不能为空"), { status: 400 });
    // SOP 命令（支持多流程并行）：
    //   /sop                       列出本群进行中的流程
    //   /sop start <模板名> <目标>  启动新流程（模板名可含空格）
    //   /sop next|skip|retry|stop [序号|runId]  操作指定流程，省略则操作最新一条
    const sopCmd = /^\/sop(?:\s+([\s\S]*))?$/i.exec(text);
    if (sopCmd) {
      const rest = String(sopCmd[1] || "").trim();
      const head = rest.split(/\s+/)[0].toLowerCase();
      const active = getActiveSopRuns(id);
      let sopRun = null, sub = head;
      // 先解析参数（失败时不写消息），解析通过后再记录命令消息
      let goalText = "", targetRunId = "";
      if (!rest || head === "list") {
        // 仅列出，不需额外参数
      } else if (head === "start") {
        goalText = rest.slice(4).trim();
        const matches = listOrgSops().filter((t) =>
          goalText === t.id || goalText.startsWith(`${t.id} `) ||
          goalText === t.name || goalText.startsWith(`${t.name} `));
        const tpl = matches.sort((a, b) => String(b.name).length - String(a.name).length)[0];
        if (!tpl) throw Object.assign(new Error("用法：/sop start <模板名> <目标>。可用模板：" + listOrgSops().map((t) => t.name).join("、")), { status: 400 });
        goalText = goalText.startsWith(tpl.name) ? goalText.slice(tpl.name.length).trim()
          : goalText.slice(tpl.id.length).trim();
        sopCmd._tplId = tpl.id;
      } else if (["next", "skip", "retry", "stop"].includes(head)) {
        const tail = rest.slice(head.length).trim();
        if (tail) {
          if (/^\d+$/.test(tail)) {
            const idx = Number(tail) - 1;
            if (!active[idx]) throw Object.assign(new Error(`没有第 ${tail} 条进行中的 SOP（当前 ${active.length} 条）`), { status: 400 });
            targetRunId = active[idx].id;
          } else if (tail.startsWith("soprun")) {
            targetRunId = tail;
          } else {
            throw Object.assign(new Error("用法：/sop <next|skip|retry|stop> [序号 或 soprun_xxx]"), { status: 400 });
          }
        }
      } else {
        throw Object.assign(new Error("用法：/sop｜/sop start <模板名> <目标>｜/sop next|skip|retry|stop [序号]"), { status: 400 });
      }
      const cmdMsg = {
        id: genId("msg"), channel: `group:${id}`, from: "human", to: "",
        type: "group_chat", body: text.slice(0, 8000), ref: "", createdAt: now(),
      };
      appendOrgMessage(cmdMsg);
      orgBroadcast("group_message", cmdMsg);
      if (!rest || head === "list") {
        if (!active.length) throw Object.assign(new Error("本群暂无进行中的 SOP。用法：/sop start <模板名> <目标>"), { status: 400 });
        sopSystemMessage(id, `本群 ${active.length} 条进行中的 SOP：\n` + active.map((r, i) =>
          `${i + 1}. ${r.templateName} · ${r.goal || "无目标"} · ${r.status} · ${r.steps.filter((s) => s.status === "done").length}/${r.steps.length}（id: ${r.id}）`).join("\n")
          + "\n操作：/sop <next|skip|retry|stop> <序号或 id>");
      } else if (head === "start") {
        sopRun = startSopRun(group, sopCmd._tplId, goalText, { sourceMsgId: cmdMsg.id });
      } else {
        sopRun = controlSopRun(id, sub, { runId: targetRunId });
      }
      return send(res, 200, { ok: true, message: cmdMsg, sopCommand: sub, sopRun });
    }
    // 写用户消息到群频道
    const msg = {
      id: genId("msg"), channel: `group:${id}`, from: "human", to: "",
      type: "group_chat", body: text.slice(0, 8000), ref: "", createdAt: now(),
    };
    appendOrgMessage(msg);
    orgBroadcast("group_message", msg);
    // 解析 @ 唤醒（未 @ 则默认 Leader）
    const targets = resolveGroupMentions(text, group);
    const spawned = [];
    if (targets.length) {
      const recent = listOrgMessages(`group:${id}`, 20);
      for (const emp of targets) {
        const task = normalizeTask({
          id: genId("task"),
          title: `群聊回应 · ${emp.name}`,
          description: text.slice(0, 4000),
          assignee: emp.id, groupId: id, source: "group_chat",
          tags: [`group:${id}`, `chat_msg:${msg.id}`],
        }, {});
        // 把群聊上下文与本次消息存进任务，供 buildGroupChatPrompt 使用
        task.chatSourceMsgId = msg.id;
        task.chatContext = recent.slice(-12).map((m) => ({ from: m.from, body: m.body }));
        const tasks = listOrgTasks();
        tasks.push(task);
        saveOrgTasks(tasks);
        orgEmit("task_created", { taskId: task.id, note: `${emp.name} 被 @ 唤醒回应群消息` });
        try { executeTask(task.id); spawned.push(task.id); }
        catch (e) { orgEmit("task_failed", { taskId: task.id, note: `唤醒 ${emp.name} 失败：${e.message}` }); }
      }
    }
    return send(res, 200, { ok: true, message: msg, awakened: targets.map((e) => e.id), spawnedTasks: spawned });
  }

  // 群 SOP：模板库（首次访问自动生成内置模板）
  if (path === "/api/org/sops" && method === "GET")
    return send(res, 200, listOrgSops());
  if (path === "/api/org/sops" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    if (!Array.isArray(body.sops)) throw Object.assign(new Error("sops 必须是数组"), { status: 400 });
    const backup = saveOrgSops(body.sops);
    return send(res, 200, { ok: true, sops: listOrgSops(), backup, note: "SOP 模板已保存" });
  }
  // 群 SOP：当前运行状态
  if (path.startsWith("/api/org/groups/") && path.endsWith("/sop") && method === "GET") {
    const groupId = decodeURIComponent(path.slice("/api/org/groups/".length, -"/sop".length));
    if (!listOrgGroups().some((g) => g.id === groupId)) throw Object.assign(new Error("群组不存在"), { status: 404 });
    const runs = getActiveSopRuns(groupId);
    return send(res, 200, { run: runs[0] || null, runs, templates: listOrgSops() });
  }
  // 群 SOP：启动 / 手动推进 / 跳过 / 重试 / 终止
  if (path.startsWith("/api/org/groups/") && path.endsWith("/sop") && method === "POST") {
    const groupId = decodeURIComponent(path.slice("/api/org/groups/".length, -"/sop".length));
    const body = await readBody(req);
    requireUnlock(body);
    const group = listOrgGroups().find((g) => g.id === groupId);
    if (!group) throw Object.assign(new Error("群组不存在"), { status: 404 });
    const action = String(body.action || "start").toLowerCase();
    let run;
    if (action === "start") {
      run = startSopRun(group, String(body.templateId || ""), String(body.goal || ""), { sourceMsgId: body.sourceMsgId || "" });
    } else {
      run = controlSopRun(groupId, action, { runId: String(body.runId || "") });
    }
    return send(res, 200, { ok: true, run, runs: getActiveSopRuns(groupId), note: `SOP ${action} 已执行` });
  }
  // 群 SOP：历史运行记录
  if (path.startsWith("/api/org/groups/") && path.endsWith("/sop/history") && method === "GET") {
    const groupId = decodeURIComponent(path.slice("/api/org/groups/".length, -"/sop/history".length));
    const runs = listSopRuns().filter((r) => r.groupId === groupId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return send(res, 200, runs.slice(0, 50));
  }

  // 员工记忆 CRUD
  if (path.startsWith("/api/org/memory/") && method === "GET") {
    const id = decodeURIComponent(path.slice("/api/org/memory/".length));
    return send(res, 200, listEmployeeMemory(id));
  }
  if (path.startsWith("/api/org/memory/") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/memory/".length));
    const body = await readBody(req);
    requireUnlock(body);
    if (!listOrgEmployees().some((e) => e.id === id)) throw Object.assign(new Error("员工不存在"), { status: 404 });
    const items = listEmployeeMemory(id);
    if (body.mode === "replace" && Array.isArray(body.items)) {
      const backup = saveEmployeeMemory(id, body.items);
      return send(res, 200, { ok: true, items: body.items, backup });
    }
    const item = {
      id: genId("mem"),
      type: MEM_TYPES.includes(body.type) ? body.type : "rule",
      content: String(body.content || "").slice(0, 4000),
      source: String(body.source || "manual"),
      createdAt: now(),
    };
    if (!item.content) throw Object.assign(new Error("记忆内容不能为空"), { status: 400 });
    items.push(item);
    const backup = saveEmployeeMemory(id, items);
    return send(res, 200, { ok: true, item, backup, note: "记忆已添加" });
  }
  if (path.startsWith("/api/org/memory/") && method === "DELETE") {
    const id = decodeURIComponent(path.slice("/api/org/memory/".length));
    const body = await readBody(req);
    requireUnlock(body);
    const items = listEmployeeMemory(id).filter((m) => m.id !== body.memId);
    const backup = saveEmployeeMemory(id, items);
    return send(res, 200, { ok: true, backup, note: "记忆已删除" });
  }

  // 触发器（自主工作）CRUD + 立即运行
  if (path === "/api/org/triggers" && method === "GET")
    return send(res, 200, listOrgTriggers());
  if (path === "/api/org/triggers" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const triggers = listOrgTriggers();
    const idx = triggers.findIndex((t) => t.id === String(body.id || ""));
    const intervalMin = Number(body.intervalMin);
    if (body.type === "interval" && (!Number.isFinite(intervalMin) || intervalMin < 1))
      throw Object.assign(new Error("间隔触发需填写 ≥1 的分钟数"), { status: 400 });
    const trigger = {
      id: idx >= 0 ? triggers[idx].id : genId("trg"),
      name: String(body.name || "").trim() || "未命名自主工作",
      employeeId: String(body.employeeId || "").trim(),
      taskTitle: String(body.taskTitle || "").trim() || "未命名自主任务",
      prompt: String(body.prompt || "").slice(0, 8000),
      type: ["interval", "cron", "once"].includes(body.type) ? body.type : "interval",
      intervalMin: Number.isFinite(intervalMin) && intervalMin >= 1 ? intervalMin : 60,
      cron: String(body.cron || "").trim(),
      maxRuns: Number(body.maxRuns) > 0 ? Number(body.maxRuns) : 0,
      runCount: idx >= 0 ? triggers[idx].runCount : 0,
      enabled: body.enabled !== false,
      lastRunAt: idx >= 0 ? triggers[idx].lastRunAt : "",
      createdAt: idx >= 0 ? triggers[idx].createdAt : now(),
      updatedAt: now(),
    };
    if (!trigger.employeeId || !listOrgEmployees().some((e) => e.id === trigger.employeeId))
      throw Object.assign(new Error("请选择有效的员工"), { status: 400 });
    if (idx >= 0) triggers[idx] = trigger; else triggers.push(trigger);
    const backup = saveOrgTriggers(triggers);
    return send(res, 200, { ok: true, trigger, backup });
  }
  if (path.startsWith("/api/org/triggers/") && path.endsWith("/delete") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/triggers/".length, -"/delete".length));
    const body = await readBody(req);
    requireUnlock(body);
    const next = listOrgTriggers().filter((t) => t.id !== id);
    const backup = saveOrgTriggers(next);
    return send(res, 200, { ok: true, backup, note: "自主工作已删除" });
  }
  if (path.startsWith("/api/org/triggers/") && path.endsWith("/fire") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/triggers/".length, -"/fire".length));
    const body = await readBody(req);
    requireUnlock(body);
    const r = fireTrigger(id, "manual");
    return send(res, 200, { ok: true, ...r, note: "自主工作已手动触发" });
  }

  // 知识库 CRUD
  if (path === "/api/org/knowledge" && method === "GET")
    return send(res, 200, listOrgKnowledge());
  if (path === "/api/org/knowledge" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const items = listOrgKnowledge();
    const idx = items.findIndex((k) => k.id === String(body.id || ""));
    const item = {
      id: idx >= 0 ? items[idx].id : genId("kb"),
      title: String(body.title || "").trim() || "未命名知识",
      content: String(body.content || "").slice(0, 20000),
      tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean) : [],
      createdAt: idx >= 0 ? items[idx].createdAt : now(),
      updatedAt: now(),
    };
    if (idx >= 0) items[idx] = item; else items.push(item);
    const backup = saveOrgKnowledge(items);
    return send(res, 200, { ok: true, item, backup });
  }
  if (path.startsWith("/api/org/knowledge/") && path.endsWith("/delete") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/knowledge/".length, -"/delete".length));
    const body = await readBody(req);
    requireUnlock(body);
    const backup = saveOrgKnowledge(listOrgKnowledge().filter((k) => k.id !== id));
    return send(res, 200, { ok: true, backup, note: "知识条目已删除" });
  }

  // 公开项目（多员工共享工作目录）
  if (path === "/api/org/projects" && method === "GET")
    return send(res, 200, listOrgProjects());
  if (path === "/api/org/projects" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    const items = listOrgProjects();
    const idx = items.findIndex((p) => p.id === String(body.id || ""));
    const dir = String(body.dir || "").trim();
    if (dir && !safePath(dir)) throw Object.assign(new Error("项目目录必须在工作区或 agent 目录内"), { status: 400 });
    const item = {
      id: idx >= 0 ? items[idx].id : genId("proj"),
      name: String(body.name || "").trim() || "未命名项目",
      dir,
      description: String(body.description || "").trim(),
      createdAt: idx >= 0 ? items[idx].createdAt : now(),
    };
    if (idx >= 0) items[idx] = item; else items.push(item);
    const backup = saveOrgProjects(items);
    return send(res, 200, { ok: true, item, backup });
  }
  if (path.startsWith("/api/org/projects/") && path.endsWith("/delete") && method === "POST") {
    const id = decodeURIComponent(path.slice("/api/org/projects/".length, -"/delete".length));
    const body = await readBody(req);
    requireUnlock(body);
    const backup = saveOrgProjects(listOrgProjects().filter((p) => p.id !== id));
    return send(res, 200, { ok: true, backup, note: "项目已移除（目录未删除）" });
  }

  if (path === "/api/unlock" && method === "POST") {
    // 兼容旧前端：任何调用都保持解锁状态
    EDIT_UNLOCKED = true;
    try { writeJson(UNLOCK_STATE_FILE, { unlocked: true }); } catch {}
    return send(res, 200, { unlocked: true });
  }

  // 管家：固定会话 + 系统快照
  if (path === "/api/butler/session" && method === "GET")
    return send(res, 200, ensureButlerSession());

  // 管家新对话：备份并移除旧固定会话，重新创建空白会话
  if (path === "/api/butler/reset" && method === "POST") {
    const state = readJsonSafe(BUTLER_STATE_FILE, {});
    const old = state.sessionFile;
    let backup = null;
    if (old && safePath(old) && old.endsWith(".jsonl") && existsSync(old)) {
      try { closeChatSession(old, "butler-reset"); } catch {}
      backup = backupFile(old);
      unlinkSync(old);
    }
    return send(res, 200, { ...ensureButlerSession(), backup });
  }

  if (path === "/api/butler/context" && method === "GET")
    return send(res, 200, {
      workspace: WORKSPACE,
      agentDir: AGENT_DIR,
      models: collectModels(),
      resources: collectResources().map((r) => ({ type: r.type, name: r.name, scope: r.scope, enabled: r.enabled })),
      employees: listOrgEmployees().map((e) => ({ id: e.id, name: e.name, role: e.role })),
      tasks: listOrgTasks().map((t) => ({ id: t.id, title: t.title, status: t.status })),
      sessionCount: collectSessions().length,
    });

  // 导入：扫描预览 / 执行写入
  if (path === "/api/import/scan" && method === "GET")
    return send(res, 200, scanImportDir(url.searchParams.get("dir") || ""));

  if (path === "/api/import/apply" && method === "POST") {
    const body = await readBody(req);
    requireUnlock(body);
    return send(res, 200, { ok: true, ...applyImport(body.items, body.overwrite === true) });
  }

  // 健康检查：startedAt 每次进程启动都会变，前端据此确认「真的是新进程」
  if (path === "/api/health" && method === "GET") {
    return send(res, 200, {
      ok: true,
      pid: process.pid,
      startedAt: SERVER_STARTED_AT,
      port: PORT,
      unlocked: EDIT_UNLOCKED,
    });
  }

  // 一键重启：运维动作，不改变任何配置，因此不受只读编辑锁限制
  if (path === "/api/restart" && method === "POST") {
    send(res, 200, { ok: true, note: "管理端正在重启，请稍候…" });
    setTimeout(() => restartProcess(), 150);
    return;
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
  console.log(`实时聊天：Pi RPC 子进程按会话懒启动，空闲 10 分钟自动回收。`);
  console.log(`数字员工：任务执行引擎 + 自主工作调度器已启动。`);
  const retention = readRetentionConfig();
  console.log(`会话自动清理：${retention.enabled ? `${retention.days} 天未更新且不在最近 ${retention.minKeep} 条内` : "未开启"}。`);
  refreshUsdCnyRate().catch(() => {});
  setInterval(() => { refreshUsdCnyRate().catch(() => {}); }, FX_TTL_MS).unref?.();
  startTriggerScheduler();
  startRetentionScheduler();
  reconcileSopRunsOnBoot();
});

// 服务退出时清理所有 RPC 子进程，避免孤儿进程
function shutdown() {
  for (const file of [...chatSessions.keys()]) closeChatSession(file, "shutdown");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
