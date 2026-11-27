#!/bin/bash
# Redmine 自动扫描调度（供 Pi Admin 触发器让 saul 定时执行）
# 认领标记 @piwake；派发走 Pi Admin 桥接脚本，派给 saul 处理。
cd /Users/lishuai/work/ai/redmine/check_redmine || exit 1

export REDMINE_CLAIM_KEYWORD='@piwake'
# 禁用 qoderwake 派发出口（置空 waker id），让脚本走 DISPATCH_CMD
export QODERWAKE_WAKER_ID=''
export DISPATCH_CMD='/usr/bin/python3 /Users/lishuai/ai/pi/my-workspace/admin/redmine-dispatch.py {kind} {issue_id}'

/usr/bin/python3 app.py 2>&1
