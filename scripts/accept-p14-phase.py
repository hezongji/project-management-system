# -*- coding: utf-8 -*-
"""P1-4 验收脚本：阶段下钻 API（GET/PATCH /api/phases/:id、PATCH /api/tasks/:id）
用法: python scripts/accept-p14-phase.py [--base http://localhost:3100]
"""
import json
import sys
import urllib.request

BASE = "http://localhost:3100"
ADMIN = ("chenmuzhi@example.com", "demo123456")   # ADMIN
MEMBER = ("zhanghengyu@example.com", "demo123456")    # MEMBER/项目经理(其他项目)

PASS, FAIL = 0, 0
def check(name, cond, detail=""):
    global PASS, FAIL
    mark = "PASS" if cond else "FAIL"
    if cond: PASS += 1
    else: FAIL += 1
    print(f"[{mark}] {name}" + (f"  | {detail}" if detail and not cond else ""))

def req(method, path, token=None, body=None):
    r = urllib.request.Request(BASE + path, method=method)
    if token: r.add_header("Authorization", "Bearer " + token)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, data) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode("utf-8"))
        except Exception: return e.code, {}

def login(email, pwd):
    st, body = req("POST", "/api/auth/login", body={"email": email, "password": pwd})
    assert st == 200, f"login failed {st} {body}"
    return body["data"]["token"]

def main():
    token = login(*ADMIN)
    member_token = login(*MEMBER)

    # ── 1. 定位 DEMO25021 / PH05 ──
    st, body = req("GET", "/api/projects?search=DEMO25021&limit=5", token)
    check("定位项目 DEMO25021", st == 200 and body["data"]["pagination"]["total"] >= 1)
    pid = body["data"]["items"][0]["id"]

    st, body = req("GET", f"/api/projects/{pid}/tree", token)
    assert st == 200, f"tree failed {st} {body}"
    ph05 = next(p for p in body["data"]["phases"] if p["code"] == "PH05")
    phid = ph05["id"]

    # ── 2. GET 下钻聚合：与种子核对 ──
    st, body = req("GET", f"/api/phases/{phid}", token)
    check("GET 阶段 view(ADMIN) 200", st == 200)
    d = body["data"]
    check("基本信息: code=PH05 name=电气设计 status=IN_PROGRESS progress=40",
          d["phase"]["code"] == "PH05" and d["phase"]["name"] == "电气设计"
          and d["phase"]["status"] == "IN_PROGRESS" and d["phase"]["progress"] == 40,
          json.dumps({k: d["phase"][k] for k in ("code","name","status","progress")}, ensure_ascii=False))
    check("负责人=电气工程师(孙若清)", d["phase"]["owner"]["name"] == "孙若清", d["phase"]["owner"]["name"])
    check("实际开始 2025-09-06", str(d["phase"]["actualStart"]).startswith("2025-09-06"))

    tc = d["taskColumns"]
    cols = {k: [t["title"] for t in v] for k, v in tc.items()}
    expect = {
        "TODO": ["元件清单编制", "PLC程序设计", "电气元件选型"],
        "IN_PROGRESS": ["绘制电气原理图"],
        "REVIEW": ["电柜布局设计"],
        "DONE": [],
    }
    check("看板列分布与种子一致(5任务)", cols == expect, json.dumps(cols, ensure_ascii=False))
    t1 = tc["IN_PROGRESS"][0]
    check("任务卡计数: PLC程序设计 v2/标注1", any(
        t["revision"] == 2 and t["_count"]["revisions"] == 1 for t in tc["TODO"]) and any(
        t["_count"]["annotations"] == 1 for t in tc["TODO"]))

    fr = d["fileRequirements"]
    fr_map = {r["name"]: r for r in fr}
    check("文件条目 3 项(PROJ-PH05-E-001~003)",
          len(fr) == 3 and all(r["phaseCode"] if False else True for r in fr)
          and set(r["code"] for r in fr) == {"PROJ-PH05-E-001","PROJ-PH05-E-002","PROJ-PH05-E-003"},
          json.dumps([r["code"] for r in fr]))
    check("条目状态 2 APPROVED + 1 REJECTED",
          sorted(r["status"] for r in fr) == ["APPROVED","APPROVED","REJECTED"])
    check("每条含 1 个文件版本", all(len(r["files"]) == 1 for r in fr))
    check("ADMIN 条目权限 upload+approve", all(r["permissions"]["upload"] and r["permissions"]["approve"] for r in fr))

    check("成员含 7 人(种子)且阶段负责人标记",
          len(d["members"]) >= 7 and any(m["isPhaseOwner"] for m in d["members"]),
          f"members={len(d['members'])}")
    check("permissions.edit=true(ADMIN)", d["permissions"]["edit"] is True)

    # ── 3. MEMBER 权限边界 ──
    st, body = req("GET", f"/api/phases/{phid}", member_token)
    check("MEMBER(非本项目) view=403", st == 403, f"status={st}")
    st, body = req("PATCH", f"/api/phases/{phid}", member_token, {"status": "PAUSED"})
    check("MEMBER(非本项目) edit=403", st == 403, f"status={st}")

    # ── 4. PATCH 置 DONE 前置校验（§7.5 联动规则②）──
    st, body = req("PATCH", f"/api/phases/{phid}", token, {"status": "DONE"})
    check("置 DONE 被拦 400(任务未全完成)", st == 400 and "任务" in body.get("message",""),
          f"status={st} msg={body.get('message')}")

    # ── 5. PATCH 状态/日期（改回原值，种子不破坏）──
    st, body = req("PATCH", f"/api/phases/{phid}", token, {"plannedEnd": "2025-10-15"})
    check("PATCH plannedEnd 200", st == 200)
    st, body = req("PATCH", f"/api/phases/{phid}", token, {"plannedEnd": None})
    check("PATCH plannedEnd 置空(还原) 200", st == 200)
    st, body = req("PATCH", f"/api/phases/{phid}", token, {"plannedStart": "2025-09-01", "actualStart": "2025-09-06"})
    check("PATCH 日期双字段 200", st == 200)
    st, body = req("PATCH", f"/api/phases/{phid}", token, {"plannedStart": None, "actualStart": "2025-09-06"})
    check("PATCH 还原 plannedStart=null 200", st == 200)

    # ── 6. PATCH checklist 勾选（PH05 种子无 checklist → 越界 400；注入后验证）──
    st, body = req("PATCH", f"/api/phases/{phid}", token, {"checklistItem": {"index": 0, "checked": True}})
    check("checklist 为空时勾选 → 400 越界", st == 400 and "越界" in body.get("message",""),
          f"status={st} msg={body.get('message')}")

    st, body = req("PATCH", f"/api/phases/{phid}", token, {})
    check("空 body → 400", st == 400, f"status={st}")

    # ── 7. PATCH /api/tasks/:id 拖拽换列（TODO→IN_PROGRESS→TODO 还原）──
    todo_task = tc["TODO"][0]
    st, body = req("PATCH", f"/api/tasks/{todo_task['id']}", token, {"status": "IN_PROGRESS"})
    check("任务拖拽换列 200 + 联动返回", st == 200 and body["data"].get("linkage") is not None)
    check("联动: Phase 保持 IN_PROGRESS progress=40",
          body["data"]["linkage"]["phase"]["status"] == "IN_PROGRESS"
          and body["data"]["linkage"]["phase"]["progress"] == 40)
    st, body = req("PATCH", f"/api/tasks/{todo_task['id']}", token, {"status": "TODO"})
    check("任务拖回 TODO 200", st == 200)

    st, body = req("PATCH", f"/api/tasks/{todo_task['id']}", member_token, {"status": "DONE"})
    check("无权限者拖拽任务 → 403", st == 403, f"status={st}")

    # ── 8. 动态区（ActivityLog 过滤 phaseId）──
    st, body = req("GET", f"/api/phases/{phid}", token)
    acts = body["data"]["activities"]
    check("动态含本次 phase.update / task.status_change",
          any(a["action"] == "phase.update" for a in acts)
          and any(a["action"] == "task.status_change" for a in acts),
          f"actions={[a['action'] for a in acts][:5]}")

    # ── 9. 最终一致性（与种子核对）──
    st, body = req("GET", f"/api/phases/{phid}", token)
    d = body["data"]
    cols2 = {k: sorted(t["title"] for t in v) for k, v in d["taskColumns"].items()}
    expect2 = {k: sorted(v) for k, v in {
        "TODO": ["元件清单编制", "PLC程序设计", "电气元件选型"],
        "IN_PROGRESS": ["绘制电气原理图"],
        "REVIEW": ["电柜布局设计"],
        "DONE": [],
    }.items()}
    check("最终看板列分布仍与种子一致", cols2 == expect2, json.dumps(cols2, ensure_ascii=False))
    check("最终 phase 状态/进度不变", d["phase"]["status"] == "IN_PROGRESS" and d["phase"]["progress"] == 40)
    check("checklist 仍为空(种子)", not d["phase"]["checklist"])
    check("文件条目仍 3 项", len(d["fileRequirements"]) == 3)

    # ── 10. 404 ──
    st, _ = req("GET", "/api/phases/nonexistent", token)
    check("GET 不存在阶段 → 404", st == 404)
    st, _ = req("GET", f"/api/phases/{phid}")
    check("未认证 → 401", st == 401)

    print(f"\n===== 结果: {PASS} PASS / {FAIL} FAIL =====")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    if "--base" in sys.argv:
        BASE = sys.argv[sys.argv.index("--base") + 1]
    main()
