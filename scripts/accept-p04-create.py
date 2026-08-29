# -*- coding: utf-8 -*-
"""P0-4 补充验收：导入 create 路径 + 页面路由 smoke test"""
import json, urllib.request, urllib.error, urllib.parse, io, sys, uuid

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
BASE = 'http://localhost:3002/api'

def call(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method)
    if token: req.add_header('Authorization', 'Bearer ' + token)
    data = json.dumps(body).encode() if body is not None else None
    if data: req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, data) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {}

def upload(path, filepath, token):
    b = uuid.uuid4().hex
    fn = filepath.replace(chr(92), '/').split('/')[-1]
    content = open(filepath, 'rb').read()
    body = b''.join([
        f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{fn}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode(),
        content,
        f'\r\n--{b}--\r\n'.encode(),
    ])
    req = urllib.request.Request(BASE + path, method='POST', data=body)
    req.add_header('Content-Type', f'multipart/form-data; boundary={b}')
    req.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

T = call('POST', '/auth/login', {'email': 'chenmuzhi@example.com', 'password': 'demo123456'})[1]['data']['token']
GEN = 'prisma/data/generated'

# create 路径
s, r = upload('/users/import', f'{GEN}/users-create.xlsx', T)
print('users create:', s, 'created=', r['data']['created'],
      'errors=', [(e['row'], e['reason'][:24]) for e in r['data']['errors']])
assert s == 200 and r['data']['created'] == 1 and len(r['data']['errors']) == 1, 'users create-path FAIL'

s, r = upload('/external-orgs/import', f'{GEN}/users-create.xlsx', T)
print('orgs create:', s, 'createdOrgs=', r['data']['createdOrgs'], 'addedContacts=', r['data']['addedContacts'])
assert s == 200 and r['data']['createdOrgs'] == 2 and r['data']['addedContacts'] == 1, 'orgs create-path FAIL'

# 页面路由 smoke test（重定向跟随）
def page(path, follow=True):
    opener = urllib.request.build_opener(urllib.request.HTTPRedirectHandler())
    req = urllib.request.Request('http://localhost:3002' + path)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k): return None
    try:
        with urllib.request.build_opener(NoRedirect()).open(req) as resp:
            return resp.status, resp.url
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 307, 308):
            return e.code, e.headers.get('Location', '')
        return e.code, ''

for p in ['/organization', '/organization/externals', '/organization/job-titles', '/org', '/teams']:
    st, loc = page(p)
    print(f'GET {p} → {st}' + (f' Location: {loc}' if loc else ''))
    assert st in (200, 307, 308), f'{p} FAIL {st}'

print('\n== create-path + routes PASS ==')
