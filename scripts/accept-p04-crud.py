# -*- coding: utf-8 -*-
"""P0-4 端到端验收：组织架构 API CRUD + 权限"""
import json, urllib.request, urllib.error, urllib.parse, io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# 登录拿 ADMIN token
BASE = 'http://localhost:3002/api'

def call(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method)
    if token: req.add_header('Authorization', 'Bearer ' + token)
    data = None
    if body is not None:
        req.add_header('Content-Type', 'application/json')
        data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(req, data) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

TOKEN = call('POST', '/auth/login', {'email': 'chenmuzhi@example.com', 'password': 'demo123456'})[1]['data']['token']

def auth_call(method, path, body=None):
    if any(ord(c) > 127 for c in path):
        path = urllib.parse.quote(path, safe="/?&=")
    return call(method, path, body, token=TOKEN)

results = []
def check(name, cond, detail=''):
    results.append(('PASS' if cond else 'FAIL', name, detail))

# ── 前置清理：历史遗留的验收测试数据（幂等）──
s, r = auth_call('GET', '/departments')
def walk_clean(items):
    for d in items:
        if d['name'].startswith('验收测试'):
            auth_call('DELETE', f"/departments/{d['id']}")
        walk_clean(d.get('children', []))
walk_clean(r['data']['items'])

# ── 部门 CRUD ──
s, r = auth_call('POST', '/departments', {'name': '验收测试部', 'sort': 99})
check('部门 POST 创建', s == 201 and r['success'], r.get('data', {}).get('name', ''))
dept_id = r['data']['id']

s, r = auth_call('POST', '/departments', {'name': '验收测试部'})
check('部门 POST 同级重名 409', s == 409, r.get('message', ''))

s, r = auth_call('PATCH', f'/departments/{dept_id}', {'name': '验收测试部X'})
check('部门 PATCH 改名', s == 200 and r['data']['name'] == '验收测试部X')

s, r = auth_call('DELETE', f'/departments/{dept_id}')
check('部门 DELETE 空部门', s == 200)

s, r = auth_call('GET', '/departments')
tech = [d for d in r['data']['items'] if d['name'] == '技术部'][0]
s, r = auth_call('DELETE', f"/departments/{tech['id']}")
check('部门 DELETE 非空 400（子部门）', s == 400 and '子部门' in r['message'], r['message'][:50])

s, r = auth_call('GET', '/departments')
gy = [c for d in r['data']['items'] if d['name'] == '技术部' for c in d['children'] if c['name'] == '工艺组'][0]
s, r = auth_call('PATCH', f"/departments/{tech['id']}", {'parentId': gy['id']})
check('部门 PATCH 循环引用 400', s == 400, r['message'][:40])

# ── 岗位字典 ──
s, r = auth_call('GET', '/job-titles')
check('岗位 GET 13 个含计数', len(r['data']['items']) == 13 and 'userCount' in r['data']['items'][0])
dq = [t for t in r['data']['items'] if t['name'] == '电气工程师'][0]
check('电气工程师 2人/5阶段', dq['userCount'] == 2 and dq['stageCount'] == 5, f"{dq['userCount']}人/{dq['stageCount']}阶段")

s, r = auth_call('POST', '/job-titles', {'name': '验收测试岗', 'deptHint': '技术部', 'sort': 99})
check('岗位 POST', s == 201)
jt_id = r['data']['id']
s, r = auth_call('POST', '/job-titles', {'name': '验收测试岗'})
check('岗位 POST 重名 409', s == 409)
s, r = auth_call('PATCH', f'/job-titles/{jt_id}', {'name': '验收测试岗X'})
check('岗位 PATCH', s == 200)
s, r = auth_call('DELETE', f'/job-titles/{jt_id}')
check('岗位 DELETE 无引用', s == 200)
s, r = auth_call('DELETE', f"/job-titles/{dq['id']}")
check('岗位 DELETE 被引用 400', s == 400 and '引用' in r['message'], r['message'][:60])

# 岗位改名联动：新建岗 → 挂到测试用户 → 改名 → 验证 User.jobTitle 同步 → 清理
s, r = auth_call('POST', '/job-titles', {'name': '联动测试岗', 'sort': 98})
lt_id = r['data']['id']
# 用一个不存在的部门的人不方便；直接用 PATCH /departments 之外的方式：临时改某用户不可行（无该接口）
# 用导入功能验证太重，此处以 TemplateStage 侧验证：跳过（导入验收里覆盖用户侧）
s, r = auth_call('DELETE', f'/job-titles/{lt_id}')
check('岗位 联动测试清理', s == 200)

# ── 外部主体 ──
s, r = auth_call('GET', '/external-orgs?type=CUSTOMER&page=1&limit=5')
check('主体 GET type 筛选分页', s == 200 and r['data']['pagination']['total'] == 33 and len(r['data']['items']) == 5, f"total={r['data']['pagination']['total']}")
s, r = auth_call('GET', '/external-orgs?type=FOO')
check('主体 GET 非法 type 400', s == 400)
s, r = auth_call('GET', '/external-orgs?q=华洋')
check('主体 GET 搜索 q', s == 200 and r['data']['pagination']['total'] == 1)

s, r = auth_call('POST', '/external-orgs', {'name': '验收测试供应商', 'type': 'SUPPLIER', 'remark': 'P0-4 验收'})
check('主体 POST', s == 201)
org_id = r['data']['id']
s, r = auth_call('PATCH', f'/external-orgs/{org_id}', {'phone': '021-12345678'})
check('主体 PATCH', s == 200 and r['data']['phone'] == '021-12345678')

s, r = auth_call('POST', f'/external-orgs/{org_id}/contacts', {'name': '张三', 'title': '经理', 'phone': '13900000000'})
check('联系人 POST', s == 201)
ct_id = r['data']['id']
s, r = auth_call('GET', f'/external-orgs/{org_id}/contacts')
check('联系人 GET', s == 200 and len(r['data']['items']) == 1)
s, r = auth_call('PATCH', f'/external-orgs/{org_id}/contacts/{ct_id}', {'title': '总经理'})
check('联系人 PATCH', s == 200 and r['data']['title'] == '总经理')
s, r = auth_call('POST', f'/external-orgs/{org_id}/contacts', {'name': 'X', 'email': 'bad-email'})
check('联系人 POST 坏邮箱 400', s == 400)

s, r = auth_call('GET', '/external-orgs?q=华洋')
hy = r['data']['items'][0]
s, r = auth_call('DELETE', f"/external-orgs/{hy['id']}")
check('主体 DELETE 被项目引用 400', s == 400 and '项目' in r['message'], r['message'][:60])
s, r = auth_call('DELETE', f'/external-orgs/{org_id}')
check('主体 DELETE 级联联系人', s == 200)

# ── org-chart ──
s, r = auth_call('GET', '/org-chart')
st = r['data']['stats']
check('org-chart 树+分组+统计', s == 200 and len(r['data']['departments']) == 9 and st['userTotal'] == 51 and 'CUSTOMER' in r['data']['externals'], f"stats={st}")

# ── 权限 ──
s, r = call('POST', '/auth/login', {'email': 'zhanghengyu@example.com', 'password': 'demo123456'})
mtoken = r['data']['token']
s, r = call('POST', '/departments', {'name': '越权部'}, token=mtoken)
check('MEMBER 建部门 403', s == 403)
s, r = call('GET', '/departments', token=mtoken)
check('MEMBER 读部门树 200', s == 200)
s, r = call('GET', '/departments', token=None)
check('未认证 401', s == 401)

fails = 0
for st_, name, detail in results:
    print(f'[{st_}] {name}' + (f'  → {detail}' if detail else ''))
    if st_ == 'FAIL': fails += 1
print(f'\n== {len(results)-fails}/{len(results)} PASS ==')
