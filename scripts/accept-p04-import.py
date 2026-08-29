# -*- coding: utf-8 -*-
"""P0-4 端到端验收：Excel 导入两套（users / external-orgs）"""
import json, urllib.request, urllib.error, urllib.parse, io, sys, uuid

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
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

def upload(path, filepath, token, dry_run=False):
    boundary = uuid.uuid4().hex
    fn = filepath.replace('\\', '/').split('/')[-1]
    with open(filepath, 'rb') as f:
        content = f.read()
    parts = []
    if dry_run:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="dryRun"\r\n\r\n1\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{fn}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'.encode())
    parts.append(content)
    parts.append(f'\r\n--{boundary}--\r\n'.encode())
    body = b''.join(parts)
    req = urllib.request.Request(BASE + path, method='POST', data=body)
    req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
    req.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

TOKEN = call('POST', '/auth/login', {'email': 'chenmuzhi@example.com', 'password': 'demo123456'})[1]['data']['token']
GEN = 'prisma/data/generated'

results = []
def check(name, cond, detail=''):
    results.append(('PASS' if cond else 'FAIL', name, detail))

# ── users.xlsx：真实 51 人 ──
s, r = upload('/users/import', f'{GEN}/users.xlsx', TOKEN, dry_run=True)
check('users dryRun 51 行全过', s == 200 and r['data']['validRows'] == 51 and len(r['data']['errors']) == 0,
      f"valid={r['data'].get('validRows')} create={r['data'].get('wouldCreate')} update={r['data'].get('wouldUpdate')}")

s, r = upload('/users/import', f'{GEN}/users.xlsx', TOKEN)
check('users 正式导入 51 updated 0 err', s == 200 and r['data']['updated'] == 51 and r['data']['created'] == 0 and len(r['data']['errors']) == 0,
      f"created={r['data'].get('created')} updated={r['data'].get('updated')}")

# 部门挂载正确性抽查：胡云帆 → 技术部/工艺组
s, r = call('GET', '/departments', token=TOKEN)
def find(items, name):
    for d in items:
        if d['name'] == name: return d
        hit = find(d.get('children', []), name)
        if hit: return hit
gy = find(r['data']['items'], '工艺组')
lxy = [m for m in gy['members'] if m['name'] == '胡云帆']
check('导入后胡云帆在 工艺组', len(lxy) == 1 and lxy[0]['jobTitle'] == '工艺工程师', lxy[0]['jobTitle'] if lxy else '缺失')

# ── users-bad.xlsx：错误行报告 ──
s, r = upload('/users/import', f'{GEN}/users-bad.xlsx', TOKEN)
errs = r['data']['errors']
check('bad users 2 行错误报告', s == 200 and len(errs) == 2 and all('row' in e and 'reason' in e for e in errs),
      ' | '.join(f"L{e['row']}:{e['reason'][:22]}" for e in errs))

# ── external-orgs.xlsx：虚构 5 家 + 多联系人行 ──
s, r = upload('/external-orgs/import', f'{GEN}/external-orgs.xlsx', TOKEN, dry_run=True)
check('orgs dryRun 5 家 6 联系人', s == 200 and r['data']['wouldUpdateOrgs'] == 5 and r['data']['wouldCreateOrgs'] == 0 and len(r['data']['errors']) == 0,
      f"update={r['data'].get('wouldUpdateOrgs')} contacts={r['data'].get('wouldAddContacts')}")

s, r = upload('/external-orgs/import', f'{GEN}/external-orgs.xlsx', TOKEN)
# 注：本轮为重复导入（前轮已验证追加），断言幂等：updated=5、无错误；首次追加由下方联系人断言覆盖
check('orgs 正式导入幂等 5 updated', s == 200 and r['data']['updatedOrgs'] == 5 and r['data']['createdOrgs'] == 0 and len(r['data']['errors']) == 0,
      f"updated={r['data'].get('updatedOrgs')} +contacts={r['data'].get('addedContacts')}")

# 多联系人追加验证：东岳电气元件应有 赵主管+钱会计
s, r = call('GET', '/external-orgs?q=' + urllib.parse.quote('东岳'), token=TOKEN)
dy = r['data']['items'][0]
names = [c['name'] for c in dy['contacts']]
check('东岳电气元件 2 联系人（赵主管+钱会计）', '赵主管' in names and '钱会计' in names, str(names))

# 重复导入不重复加联系人
s, r = upload('/external-orgs/import', f'{GEN}/external-orgs.xlsx', TOKEN)
s, r = call('GET', '/external-orgs?q=' + urllib.parse.quote('东岳'), token=TOKEN)
dy = r['data']['items'][0]
check('重复导入联系人不重复', len(dy['contacts']) == 2, f"{len(dy['contacts'])} 名")

# ── MEMBER 导入 403 ──
mt = call('POST', '/auth/login', {'email': 'zhanghengyu@example.com', 'password': 'demo123456'})[1]['data']['token']
s, r = upload('/users/import', f'{GEN}/users.xlsx', mt)
check('MEMBER 导入 403', s == 403)

# ── 非 Excel 文件 400 ──
s, r = upload('/users/import', 'package.json', TOKEN)
check('非 Excel 400', s == 400, r.get('message', '')[:40])

fails = 0
for st_, name, detail in results:
    print(f'[{st_}] {name}' + (f'  → {detail}' if detail else ''))
    if st_ == 'FAIL': fails += 1
print(f'\n== {len(results)-fails}/{len(results)} PASS ==')
