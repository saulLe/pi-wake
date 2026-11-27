#!/usr/bin/env python3
"""
Redmine 派发桥接：把 check_redmine/app.py 扫描到的工单，转成 Pi Admin 任务派给 saul 自动执行。

由 app.py 的 DISPATCH_CMD 调用，命令行参数形如：
    DISPATCH_CMD="/usr/bin/python3 .../redmine-dispatch.py {kind} {issue_id}"

- argv[1] = kind（review / feature / hotfix ...）
- argv[2] = issue_id（Redmine 工单号）
- stdin   = app.py 生成的完整工单处理 prompt

流程：
    1. 读 stdin prompt
    2. 查 Pi Admin 现有任务，按 tag `redmine:#<issue_id>` 去重（非终态则跳过）
    3. POST /api/org/tasks 建任务（assignee=saul, source=redmine）
    4. POST /api/org/tasks/<id>/assign 带 execute=true 立即执行
    5. 打印任务 id，供 app.py 记日志
"""
import sys
import os
import json
import urllib.request
import urllib.error

ADMIN_BASE = "http://127.0.0.1:8787"
SAUL_ID = "emp-mwx7w4eu"
TERMINAL = {"done", "cancelled"}
# 脚本位于 <workspace>/admin/，员工工作区在 <workspace>/org/workspaces/
WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def api(path, method="GET", body=None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(ADMIN_BASE + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    if len(sys.argv) < 3:
        print("用法: redmine-dispatch.py <kind> <issue_id>  (prompt 从 stdin 读入)", file=sys.stderr)
        sys.exit(2)
    kind = sys.argv[1].strip()
    issue_id = sys.argv[2].strip()
    prompt = sys.stdin.read().strip()
    if not prompt:
        print("stdin 为空，放弃派发", file=sys.stderr)
        sys.exit(2)

    dedup_tag = "redmine:#%s" % issue_id

    # 去重：同一工单若已有「会话仍在」的非终态任务，不再重复派发。
    # 用户删掉会话后再扫描，那次派发已经失效：把旧任务流转为 cancelled，放行重新派发，
    # 避免任务看板留下永远无法继续的 review 僵尸卡。
    try:
        tasks = api("/api/org/tasks")
        for t in tasks:
            if dedup_tag not in (t.get("tags") or []) or t.get("status") in TERMINAL:
                continue
            sf = t.get("sessionFile")
            if not sf or os.path.exists(sf):
                print("跳过：工单 #%s 已有任务 %s (status=%s)" % (issue_id, t["id"], t.get("status")))
                return
            try:
                api("/api/org/tasks/%s/transition" % t["id"], method="POST", body={
                    "status": "cancelled",
                    "note": "对应会话已被用户删除，旧派发失效；Redmine 重新扫描后允许再次派发",
                    "unlocked": True,
                })
                print("旧任务 %s 的会话已删除，已流转为 cancelled，允许重新派发" % t["id"])
            except Exception as e:
                print("旧任务 %s 流转 cancelled 失败（仍继续派发）: %s" % (t["id"], e), file=sys.stderr)
    except Exception as e:
        print("去重检查失败（继续派发）: %s" % e, file=sys.stderr)

    # 路径授权声明：app.py 生成的 prompt 涉及 sessions/workspace 等员工工作区外的路径，
    # Pi Admin 任务默认边界是「仅当前工作区」，这里显式声明本任务已获用户授权访问这些路径。
    auth_note = (
        "【路径授权】本任务由 Redmine 自动调度派发，用户已明确授权访问并改动以下路径，"
        "不受「仅当前工作区」限制：/Users/lishuai/sessions/（各工单 worktree）、"
        "/Users/lishuai/workspace/（主库基线）、/Users/lishuai/work/ai/redmine/check_redmine/（redmine 工具脚本）。\n\n"
    )
    # 完整工单规范落盘到 saul 工作区，让 saul 自己扫描 Redmine、读取详情后自主工作；
    # 会话第一条不再是「用户把整篇工单详情发过来」的消息，而是一条简短的自主工作指令。
    detail_dir = os.path.join(WORKSPACE, "org", "workspaces", SAUL_ID, ".autonomous", "redmine")
    os.makedirs(detail_dir, exist_ok=True)
    detail_path = os.path.join(detail_dir, "issue-%s.md" % issue_id)
    with open(detail_path, "w", encoding="utf-8") as f:
        f.write("# Redmine 工单 #%s · 扫描所得任务详情与执行规范\n\n" % issue_id)
        f.write(prompt.rstrip() + "\n")

    full_description = (
        "工单 #%s（%s）。\n\n"
        "请自主扫描 Redmine、读取该工单详情（含 @piwake 备注里的具体要求），"
        "然后按规范自主完成工作，把结论按流程写回工单备注。\n\n"
        "扫描得到的完整执行规范（开工门禁、分支与工作区约定、注意事项、收尾门禁）已保存为：\n"
        "  %s\n"
        "开工前先读取该文件并严格遵循；工单详情以 Redmine 上实时内容为准。\n\n"
        "%s"
    ) % (issue_id, kind, detail_path, auth_note)

    title = "[Redmine][%s] #%s" % (kind, issue_id)
    task_body = {
        "title": title,
        "description": full_description,
        "assignee": SAUL_ID,
        "source": "redmine",
        "priority": "high",
        "tags": ["redmine", dedup_tag, "auto-dispatch"],
        "unlocked": True,
    }
    # 从触发它的自主工作会话继承「派生会话模型」（由 Pi Admin 注入到 Pi 子进程环境）。
    # 这样工单会话用模型 B、扫描会话用模型 A，二者可以不同。
    dispatch_model = os.environ.get("PI_ADMIN_DISPATCH_MODEL", "").strip()
    if dispatch_model and "|" in dispatch_model:
        task_body["model"] = dispatch_model
    created = api("/api/org/tasks", method="POST", body=task_body)
    task_id = created["task"]["id"]

    # 派活并立即执行（REDMINE_DISPATCH_NOEXEC=1 时只派活不执行，供链路自测）
    noexec = os.environ.get("REDMINE_DISPATCH_NOEXEC") == "1"
    assigned = api("/api/org/tasks/%s/assign" % task_id, method="POST", body={
        "assignee": SAUL_ID,
        "execute": not noexec,
        "unlocked": True,
    })
    note = assigned.get("note") or ""
    print("已派发给 saul：任务 %s（工单 #%s）%s%s" % (
        task_id, issue_id, ("；" + note) if note else "", "（自测：未执行）" if noexec else ""))


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as e:
        print("Pi Admin API 错误 HTTP %s: %s" % (e.code, e.read().decode("utf-8", "replace")[:300]), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print("派发失败: %s" % e, file=sys.stderr)
        sys.exit(1)
