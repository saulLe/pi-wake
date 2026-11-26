---
name: velocity-sql
description: Velocity 模板与 SQL 代码优化专用规范。当任务涉及 Velocity 模板（.vm）、#set 语句清理、SQL 查询改写、dim_tracking_employee / dim_member_counselor 表关联、LEFT JOIN / UNION 逻辑简化、删除死代码时使用。
---

# Velocity / SQL 代码优化

处理 `.vm` 模板或 SQL 文件时遵循以下规则。读取本目录下的 `references/code-conventions.md` 获取完整约定。

## 核心原则

1. **去掉 `#set`**：把变量赋值改成内联条件表达式。这是硬性要求，除非用户明确允许保留。
2. **简化结构**：能内联就不拆行；能一个查询解决就不拆多个；去掉无引用的字段、JOIN、子查询和恒真/恒假条件。
3. **保持语义**：LEFT JOIN 保持左表全量；UNION 的列顺序与别名对齐；改动后说明对结果集的影响。

## 工作流程

1. 先通读整个文件，标出所有 `#set`、冗余 JOIN、死代码。
2. 给出最小改动的优化版本，逐条说明改了什么。
3. 等用户反馈后再迭代，不要一次大改。
4. 涉及 `dim_tracking_employee` / `dim_member_counselor` 关联时，明确说明 JOIN / UNION 语义变化。

## 验证

- 改动后检查：模板里是否还有 `#set` 残留、是否有未定义变量直接输出（应改用 `$!{}`）。
- SQL 改动后检查：JOIN 类型是否正确、UNION 列数是否一致。
