# Pi 二次开发工作台

这是基于 Pi 的定制工作区。所有二开配置都在这里，不修改 Pi 源码（`../`）。

## 目录结构

```
my-workspace/
├── AGENTS.md                          # 项目级代码规范（启动时自动加载）
├── admin/                             # 本地 Web 管理界面（零依赖）
│   ├── server.mjs                     # Node 原生 http 后端
│   ├── start.sh                       # 启动脚本：bash start.sh
│   ├── README.md                      # 使用说明（含界面预览）
│   └── public/                        # 前端 HTML/CSS/JS
├── docs/                              # Pi 项目全部调研资料
│   ├── README.md                      # 资料索引
│   ├── 01-项目概览.md
│   ├── 02-二次开发可行性分析.md
│   ├── 03-环境准备清单.md
│   ├── 04-数字员工功能规划.md
│   ├── 架构图-分层.svg
│   └── 架构图-二开路径.svg
└── .pi/
    ├── skills/velocity-sql/           # Velocity/SQL 优化 skill
    │   ├── SKILL.md
    │   └── references/code-conventions.md
    └── extensions/sql-review.ts       # 示例扩展：/sqlreview 命令
```

## 怎么用

在这个目录下启动 Pi，配置会被自动发现：

```bash
cd /Users/lishuai/ai/pi/my-workspace
pi
```

进入后：

- `/skills` 查看可用 skill，`/skill:velocity-sql` 强制加载某 skill。
- `/sqlreview` 运行示例扩展，打印 SQL 检查规则。
- 修改 skill 或 extension 后，输入 `/reload` 热重载（无需重启）。

## 已内置的规范

从你反复强调的偏好沉淀而来：

1. Velocity 模板不用 `#set`，改内联条件表达式。
2. `dim_tracking_employee` 与 `dim_member_counselor` 用 LEFT JOIN / UNION，语义要讲清。
3. 简化优先、清理死代码、渐进式迭代。

## 怎么继续开发

- **改规范**：直接编辑 `AGENTS.md` 或 skill 的 `SKILL.md`。
- **加命令/工具**：参考 `../packages/coding-agent/examples/extensions/`，复制一个示例到 `.pi/extensions/` 改。
- **让 Pi 自己写扩展**：在会话里描述需求，让 Pi 生成到 `.pi/extensions/`，`/reload` 生效。
- **打包分享**：把 extensions + skills + prompts 用 `pi install` 打成 Pi package，见 `../packages/coding-agent/docs/packages.md`。

## 本地 Web 管理界面

`admin/` 下有一个纯本地的管理界面，可管理资源启停、编辑配置、浏览会话、查看模型与认证（密钥脱敏）：

```bash
cd /Users/lishuai/ai/pi/my-workspace/admin
bash start.sh          # 浏览器打开 http://127.0.0.1:8787
```

默认只读，写操作需在界面左下角解锁，改文件前自动备份到 `admin/.backups/`。详见 `admin/README.md`。

## 版本

基于上游 commit `73315ff`（2026-11-26 导入）。上游有大更新时，重新导入并 merge 本目录。
