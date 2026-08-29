/* P1-2 API 契约冒烟测试（真实 dev 服务器 :3000 + 真实账号） */
const BASE = 'http://localhost:3000/api'
const ADMIN = { email: 'chenmuzhi@example.com', password: 'demo123456' } // ADMIN
const PM = { email: 'zhoujincheng@example.com', password: 'demo123456' } // PROJECT_MANAGER

async function login(cred) {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cred),
  })
  const j = await r.json()
  if (!j.success) throw new Error('login fail: ' + j.message)
  return j.data.token
}

async function call(method, path, token, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await r.text()
    try {
      return { status: r.status, j: JSON.parse(text) }
    } catch {
      if (attempt === 2) {
        console.log(`  ⚠️ [${method} ${path}] HTTP ${r.status} 非JSON：${text.slice(0, 150)}`)
        return { status: r.status, j: {} }
      }
      await new Promise((res) => setTimeout(res, 1500)) // dev 冷编译重试
    }
  }
  throw new Error('unreachable')
}

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

const admin = await login(ADMIN)
const pm = await login(PM)
console.log('登录：ADMIN chenmuzhi / PROJECT_MANAGER zhoujincheng')

// ① GET 登录即可见，含 stages
{
  const { status, j } = await call('GET', '/process-templates', pm)
  check('GET 登录(非ADMIN) 200 含 stages', status === 200 && j.data.items.length >= 2 && j.data.items[0].stages.length === 20, JSON.stringify(j).slice(0, 200))
  const def = j.data.items.find(t => t.isDefault)
  check('默认模板在前且 20 阶段', def && def.stages.length === 20 && def.stages[0].name === '商务拜访')
  globalThis.tpl20 = def
  globalThis.tpl10 = j.data.items.find(t => !t.isDefault && t.stages.length === 10)
  check('精简10步模板存在', !!globalThis.tpl10)
}

// ② POST ADMIN 新建（非 ADMIN 403）
{
  const stages = globalThis.tpl10.stages.slice(0, 5).map((s, i) => ({
    name: s.name, order: i + 1, ownerJobTitle: s.ownerJobTitle,
    deliverables: s.deliverables, checklist: s.checklist,
  }))
  const no = await call('POST', '/process-templates', pm, { name: 'PM越权模板', stages })
  check('POST 非ADMIN → 403', no.status === 403, JSON.stringify(no.j))

  const bad = await call('POST', '/process-templates', admin, { name: '坏岗位', stages: [{ name: 'X', ownerJobTitle: '不存在的岗位' }] })
  check('POST 岗位不在字典 → 400', bad.status === 400, JSON.stringify(bad.j))

  const empty = await call('POST', '/process-templates', admin, { name: '空模板', stages: [] })
  check('POST 空阶段 → 400', empty.status === 400)

  const okr = await call('POST', '/process-templates', admin, { name: 'P12测试模板', stages })
  check('POST ADMIN 创建成功 201 + 重编order', okr.status === 201 && okr.j.data.stages.length === 5 && okr.j.data.stages.every((s, i) => s.order === i + 1), JSON.stringify(okr.j).slice(0, 300))
  globalThis.myTpl = okr.j.data
}

// ③ PATCH 默认模板：仅岗位
{
  const def = globalThis.tpl20
  const stage1 = def.stages[0]
  const r1 = await call('PATCH', `/process-templates/${def.id}`, admin, {
    stages: def.stages.map(s => ({ id: s.id, ownerJobTitle: s.id === stage1.id ? '技术负责人' : s.ownerJobTitle })),
  })
  check('PATCH 默认模板改岗位 → 200 且生效', r1.status === 200 && r1.j.data.stages[0].ownerJobTitle === '技术负责人', JSON.stringify(r1.j).slice(0, 300))
  // 还原
  await call('PATCH', `/process-templates/${def.id}`, admin, {
    stages: def.stages.map(s => ({ id: s.id, ownerJobTitle: s.ownerJobTitle })),
  })
  const r2 = await call('PATCH', `/process-templates/${def.id}`, admin, { name: '改名尝试' })
  check('PATCH 默认模板改名 → 400 只读保护', r2.status === 400, JSON.stringify(r2.j))
  const r3 = await call('PATCH', `/process-templates/${def.id}`, admin, {
    stages: def.stages.slice(0, 10).map(s => ({ id: s.id, ownerJobTitle: s.ownerJobTitle })),
  })
  check('PATCH 默认模板删阶段(数量不符) → 400', r3.status === 400)
}

// ④ PATCH 自定义模板全量编辑 + isDefault 切换规则
{
  const t = globalThis.myTpl
  const r1 = await call('PATCH', `/process-templates/${t.id}`, admin, {
    name: 'P12测试模板-改', stages: [
      { name: '商务拜访', ownerJobTitle: '商务经理' },
      { name: '方案设计', ownerJobTitle: '技术负责人' },
    ],
  })
  check('PATCH 自定义模板改名+整表替换 → 200', r1.status === 200 && r1.j.data.name === 'P12测试模板-改' && r1.j.data.stages.length === 2 && r1.j.data.stages[1].ownerJobTitle === '技术负责人', JSON.stringify(r1.j).slice(0, 300))
  const defId = globalThis.tpl20.id
  const r2 = await call('PATCH', `/process-templates/${defId}`, admin, { isDefault: false })
  check('PATCH 取消默认模板 → 400（恒有默认）', r2.status === 400)
  const r3 = await call('PATCH', `/process-templates/${t.id}`, admin, { isDefault: true })
  check('PATCH 设为默认 → 200 且旧默认取消', r3.status === 200 && r3.j.data.isDefault === true)
  const r4 = await call('GET', '/process-templates', admin)
  const defs = r4.j.data.items.filter(x => x.isDefault)
  check('系统仍只有一个默认模板', defs.length === 1 && defs[0].id === t.id)
  // 还原默认
  await call('PATCH', `/process-templates/${defId}`, admin, {
    stages: globalThis.tpl20.stages.map(s => ({ id: s.id, ownerJobTitle: s.ownerJobTitle })),
  })
  const r5 = await call('PATCH', `/process-templates/${defId}`, admin, { isDefault: true })
  check('默认还原为20步模板', r5.status === 200 && r5.j.data.isDefault === true)
}

// ⑤ DELETE 规则（注：不删种子模板，只用测试模板验证可删路径）
{
  const defId = globalThis.tpl20.id
  const r1 = await call('DELETE', `/process-templates/${defId}`, admin)
  check('DELETE 默认模板 → 400', r1.status === 400, JSON.stringify(r1.j))
  const r1b = await call('DELETE', `/process-templates/${defId}`, admin)
  check('DELETE 默认模板幂等拒绝', r1b.status === 400)
}

// ⑥ 被引用模板不可删（用已引用默认模板的 3 个项目验证另一种 400 分支：默认先抛，改用 tpl10? 不动种子，跳过破坏性验证）
{
  const r1 = await call('PATCH', `/process-templates/${globalThis.myTpl.id}`, pm, { name: 'x' })
  check('PATCH 非ADMIN → 403', r1.status === 403)
  const r2 = await call('DELETE', `/process-templates/${globalThis.myTpl.id}`, pm)
  check('DELETE 非ADMIN → 403', r2.status === 403)
}

// ⑦ 清理：删除测试模板
{
  const r = await call('DELETE', `/process-templates/${globalThis.myTpl.id}`, admin)
  check('DELETE 自定义模板(未被引用) → 200', r.status === 200, JSON.stringify(r.j))
  const g = await call('GET', '/process-templates', admin)
  check('清理后模板数回归 2', g.j.data.items.length === 2, `实际 ${g.j.data.items.length}`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
