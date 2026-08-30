// W5 · 网盘化改造全链验证（20260830-drive-war）
// 断言链（spec §7 W5 + intent §五成功判据）：
//   Phase A ADMIN 全链：建目录→嵌套→上传→同名版本→列表→重命名→移动(DB-only)→版本→软删→回收站→恢复→目录整树→批量下载→搜索→SYSTEM 保护
//   Phase B 权限矩阵：MEMBER 建目录/上传✓ SYSTEM 传自由文件✗ SYSTEM 改删✗ 删目录✗ 删自己文件✓ 非成员全 403
//   Phase C 回归：交付计划 catalogs/requirements 原样、catalogId 兼容上传/移动（IM App）
// 用法: node scripts/drive-war-verify.mjs            # BASE 默认 http://127.0.0.1:3101
import jwt from 'jsonwebtoken'
import fs from 'fs'

const BASE = (process.env.BASE || 'http://127.0.0.1:3101').replace(/\/+$/, '')
const env = fs.readFileSync('/opt/pm-app/.env', 'utf8')
const getEnv = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
const SECRET = getEnv('JWT_SECRET')

const PROJ = 'cmt7cdc9y0061v55oq7f3rgws' // 示例客户05增补（非归档）
const ADMIN = { userId: 'cmt7cdbzv001ov55otclrv94t', email: 'chenmuzhi@example.com', role: 'ADMIN' }
const MEMBER = { userId: 'cmt7cdc0c001vv55o1yisqwfn', email: 'sunruoqing@example.com', role: 'MEMBER' } // PROJ 成员(MEMBER)
const OUTSIDER = { userId: 'cmt7cdc00001qv55onm3ofacb', email: 'zhaowangshu@example.com', role: 'MEMBER' } // 非成员

const tk = (u) => jwt.sign(u, SECRET, { expiresIn: '2h' })
const H = (u) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${tk(u)}` })

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' · ' + detail : ''}`)
}
const json = async (u, path, opts = {}) => {
  const r = await fetch(BASE + path, { ...opts, headers: { ...H(u), ...(opts.headers || {}) } })
  let body = null
  try { body = await r.json() } catch { /* zip 等 */ }
  return { status: r.status, body, headers: r.headers }
}

async function upload(u, folderId, name, content, extra = {}) {
  const fd = new FormData()
  fd.append('file', new Blob([content], { type: 'text/plain' }), name)
  if (folderId) fd.append('folderId', folderId)
  for (const [k, v] of Object.entries(extra)) fd.append(k, v)
  const r = await fetch(`${BASE}/api/files/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tk(u)}` }, body: fd })
  let body = null
  try { body = await r.json() } catch {}
  return { status: r.status, body }
}

// ═══════════════ Phase A：ADMIN 全链 ═══════════════
console.log('── Phase A · ADMIN 全链 ──')

// A1 目录树回归：00-交付计划 收拢
const tree = await json(ADMIN, `/api/projects/${PROJ}/catalogs`)
const roots = tree.body?.data?.items ?? []
const sysGroup = roots.find((r) => r.name === '00-交付计划')
ok('A1 catalogs 200 且含 00-交付计划 组', tree.status === 200 && !!sysGroup, `根数=${roots.length}`)
ok('A1b 组为 SYSTEM 且含阶段目录', sysGroup?.kind === 'SYSTEM' && (sysGroup?.children?.length ?? 0) >= 18, `children=${sysGroup?.children?.length}`)

// A2 建目录（根级+嵌套）
const mk = await json(ADMIN, `/api/projects/${PROJ}/catalogs`, { method: 'POST', body: JSON.stringify({ name: `W5测试夹-${Date.now()}` }) })
const folder = mk.body?.data
ok('A2 根级建 USER 目录', mk.status === 201 && folder?.kind === 'USER' && folder?.path?.startsWith('/'), folder?.path)
const mk2 = await json(ADMIN, `/api/projects/${PROJ}/catalogs`, { method: 'POST', body: JSON.stringify({ name: '子夹', parentId: folder.id }) })
const sub = mk2.body?.data
ok('A2b 嵌套建目录 path 正确', mk2.status === 201 && sub?.path === `${folder.path}/${sub.id}`, sub?.path)
const dup = await json(ADMIN, `/api/projects/${PROJ}/catalogs`, { method: 'POST', body: JSON.stringify({ name: folder.name }) })
ok('A2c 同级重名被拒', dup.status === 400, `HTTP ${dup.status}`)

// A3 上传 + 同名版本合并（D4）
const fname = `W5验证文件-${Date.now()}.txt`
const up1 = await upload(ADMIN, sub.id, fname, 'version one content')
ok('A3 上传 v1', up1.status === 201 && up1.body?.data?.file?.version === 1, `HTTP ${up1.status} ${JSON.stringify(up1.body)?.slice(0, 160)}`)
const up2 = await upload(ADMIN, sub.id, fname, 'version two content')
ok('A3b 同名→v2（D4）', up2.status === 201 && up2.body?.data?.file?.version === 2, `v=${up2.body?.data?.file?.version}`)
const up3 = await upload(ADMIN, sub.id, fname, 'version three content')
ok('A3c 再传→v3', up3.body?.data?.file?.version === 3)

// A4 列表：合并展示（最新版本行）
const lst = await json(ADMIN, `/api/drive/list?projectId=${PROJ}&folderId=${sub.id}`)
const fileRows = (lst.body?.data?.items ?? []).filter((i) => i.type === 'file')
ok('A4 drive/list 200 单行最新版', lst.status === 200 && fileRows.length === 1 && fileRows[0].version === 3, JSON.stringify(fileRows.map((f) => `${f.name}v${f.version}`)))
ok('A4b 权限摘要返回', typeof lst.body?.data?.perms?.canUpload === 'boolean')

// A5 重命名
const ren = await json(ADMIN, `/api/files/${fileRows[0].id}`, { method: 'PATCH', body: JSON.stringify({ name: `改名-${fname}` }) })
ok('A5 重命名 200', ren.status === 200)

// A6 移动 DB-only（storagePath 不变）
const mv = await json(ADMIN, `/api/files/${fileRows[0].id}/move`, { method: 'PATCH', body: JSON.stringify({ folderId: folder.id }) })
const movedFile = mv.body?.data?.file
ok('A6 移动 200 folderId 变更', mv.status === 200 && movedFile?.folderId === folder.id)
ok('A6b storagePath 不变（物理解耦证明）', movedFile?.storagePath?.split('/')[1] === sub.id, movedFile?.storagePath)

// A7 版本列表
const vers = await json(ADMIN, `/api/files/${fileRows[0].id}/versions`)
ok('A7 版本列表 3 行', vers.status === 200 && vers.body?.data?.items?.length === 3, `n=${vers.body?.data?.items?.length}`)

// A8 软删→回收站→恢复
const del1 = await json(ADMIN, `/api/files/batch`, { method: 'POST', body: JSON.stringify({ fileIds: [fileRows[0].id], action: 'delete' }) })
ok('A8 软删文件', del1.status === 200 && del1.body?.data?.deleted >= 1)
const rc1 = await json(ADMIN, `/api/drive/list?projectId=${PROJ}&view=recycle`)
ok('A8b 回收站可见', (rc1.body?.data?.files ?? []).some((f) => f.id === fileRows[0].id))
const rst1 = await json(ADMIN, `/api/files/batch`, { method: 'POST', body: JSON.stringify({ fileIds: [fileRows[0].id], action: 'restore' }) })
ok('A8c 恢复', rst1.status === 200 && rst1.body?.data?.restored >= 1)

// A9 目录整树软删→回收站→恢复（删父目录：含子夹+文件家族）
const delF = await json(ADMIN, `/api/files/batch`, { method: 'POST', body: JSON.stringify({ folderIds: [folder.id], action: 'delete' }) })
ok('A9 目录软删（整树）', delF.status === 200 && delF.body?.data?.deleted >= 3, `deleted=${delF.body?.data?.deleted}（2目录+3版本）`)
const tree2 = await json(ADMIN, `/api/projects/${PROJ}/catalogs`)
const flatTree2 = JSON.stringify(tree2.body?.data?.items ?? [])
ok('A9b 软删后目录树不含父子夹', !flatTree2.includes(`"${sub.id}"`) && !flatTree2.includes(`"${folder.id}"`))
const rcF = await json(ADMIN, `/api/drive/list?projectId=${PROJ}&view=recycle`)
ok('A9c 回收站含目录', (rcF.body?.data?.folders ?? []).some((f) => f.id === folder.id))
const rstF = await json(ADMIN, `/api/files/batch`, { method: 'POST', body: JSON.stringify({ folderIds: [folder.id], action: 'restore' }) })
ok('A9d 目录恢复（整树）', rstF.status === 200 && rstF.body?.data?.restored >= 3, `restored=${rstF.body?.data?.restored}`)

// A10 批量下载 zip
const dl = await fetch(`${BASE}/api/files/batch-download?ids=${fileRows[0].id}`, { headers: H(ADMIN) })
const buf = Buffer.from(await dl.arrayBuffer())
ok('A10 批量下载 zip', dl.status === 200 && (dl.headers.get('content-type') || '').includes('zip') && buf.length > 100 && buf.subarray(0, 2).toString() === 'PK', `${buf.length}B`)

// A11 全局搜索
const sr = await json(ADMIN, `/api/files/search?q=${encodeURIComponent('改名-W5验证文件')}`)
ok('A11 搜索命中', sr.status === 200 && (sr.body?.data?.items ?? []).some((i) => i.id === fileRows[0].id), `n=${sr.body?.data?.total}`)

// A12 SYSTEM 保护（ADMIN 也不可破坏结构）
const sysDel = await json(ADMIN, `/api/projects/${PROJ}/catalogs?catalogId=${sysGroup.id}`, { method: 'DELETE' })
ok('A12 SYSTEM 目录删除被拒', sysDel.status === 403, `HTTP ${sysDel.status}`)
const sysRen = await json(ADMIN, `/api/projects/${PROJ}/catalogs`, { method: 'PATCH', body: JSON.stringify({ id: sysGroup.id, name: 'hack' }) })
ok('A12b SYSTEM 改名被拒', sysRen.status === 403, `HTTP ${sysRen.status}`)
// ADMIN 应急通道：SYSTEM 下建目录 + 传自由文件
const sysChild = await json(ADMIN, `/api/projects/${PROJ}/catalogs`, { method: 'POST', body: JSON.stringify({ name: `W5应急-${Date.now()}`, parentId: sysGroup.id }) })
ok('A12c MANAGER+ 在 SYSTEM 下建目录（应急）', sysChild.status === 201)
const sysUp = await upload(ADMIN, sysGroup.id, `sys-${Date.now()}.txt`, 'emergency')
ok('A12d MANAGER+ 在 SYSTEM 传自由文件（应急）', sysUp.status === 201)

// ═══════════════ Phase B：权限矩阵 ═══════════════
console.log('── Phase B · 权限矩阵（MEMBER/非成员）──')

// B1 MEMBER 建目录+上传（用户目录自由，intent C1）
const mF = await json(MEMBER, `/api/projects/${PROJ}/catalogs`, { method: 'POST', body: JSON.stringify({ name: `W5成员夹-${Date.now()}` }) })
const mFolder = mF.body?.data
ok('B1 MEMBER 建目录 ✓（文件夹基线）', mF.status === 201, `HTTP ${mF.status}`)
const mUp = await upload(MEMBER, mFolder.id, `member-${Date.now()}.txt`, 'member file')
ok('B1b MEMBER 上传自由文件 ✓', mUp.status === 201)

// B2 MEMBER 对 SYSTEM 的边界
const mSysUp = await upload(MEMBER, sysGroup.id, `deny-${Date.now()}.txt`, 'should fail')
ok('B2 MEMBER 在 SYSTEM 传自由文件 ✗', mSysUp.status === 403, `HTTP ${mSysUp.status}`)
const mSysMk = await json(MEMBER, `/api/projects/${PROJ}/catalogs`, { method: 'POST', body: JSON.stringify({ name: 'x', parentId: sysGroup.id }) })
ok('B2b MEMBER 在 SYSTEM 建目录 ✗', mSysMk.status === 403)
const mSysRen = await json(MEMBER, `/api/projects/${PROJ}/catalogs`, { method: 'PATCH', body: JSON.stringify({ id: sysGroup.children?.[0]?.id, name: 'hack' }) })
ok('B2c MEMBER 改 SYSTEM 目录名 ✗', mSysRen.status === 403)

// B3 MEMBER 目录删除边界（delete 留给 MANAGER+）
const mDel = await json(MEMBER, `/api/files/batch`, { method: 'POST', body: JSON.stringify({ folderIds: [mFolder.id], action: 'delete' }) })
const mDelFile = mDel.body?.data?.errors?.[0]
ok('B3 MEMBER 删目录 ✗（delete 级）', mDel.status !== 200 || (mDel.body?.data?.deleted ?? 0) === 0, `HTTP ${mDel.status}`)

// B4 MEMBER 删自己上传的文件（软删+恢复）
const mFileId = mUp.body?.data?.file?.id
const mDel2 = await json(MEMBER, `/api/files/batch`, { method: 'POST', body: JSON.stringify({ fileIds: [mFileId], action: 'delete' }) })
ok('B4 MEMBER 删自己文件 ✓（上传人）', mDel2.status === 200 && mDel2.body?.data?.deleted === 1)
const mRst = await json(MEMBER, `/api/files/batch`, { method: 'POST', body: JSON.stringify({ fileIds: [mFileId], action: 'restore' }) })
ok('B4b MEMBER 恢复自己文件 ✓', mRst.status === 200 && mRst.body?.data?.restored === 1)

// B5 MEMBER purge 被拒
const mPurge = await json(MEMBER, `/api/files/batch`, { method: 'POST', body: JSON.stringify({ fileIds: [mFileId], action: 'purge' }) })
ok('B5 MEMBER 彻底删除 ✗', mPurge.status === 200 ? (mPurge.body?.data?.purged ?? 0) === 0 : true, `HTTP ${mPurge.status}`)

// B6 非成员：整棵树不可见（owner 底线需求）
const oList = await json(OUTSIDER, `/api/drive/list?projectId=${PROJ}`)
ok('B6 非成员 drive/list ✗', oList.status === 403, `HTTP ${oList.status}`)
const oTree = await json(OUTSIDER, `/api/projects/${PROJ}/catalogs`)
ok('B6b 非成员 catalogs ✗', oTree.status === 403)
const oUp = await upload(OUTSIDER, mFolder.id, 'evil.txt', 'no way')
ok('B6c 非成员上传 ✗', oUp.status === 403 || oUp.status === 404, `HTTP ${oUp.status}`)

// ═══════════════ Phase C：回归（交付计划原样 + 兼容）═══════════════
console.log('── Phase C · 回归 ──')
const reqs = await json(ADMIN, `/api/file-requirements?projectId=${PROJ}&page=1&limit=20`)
ok('C1 交付计划条目 API 原样', reqs.status === 200 && Array.isArray(reqs.body?.data?.items))
const cat1 = sysGroup.children?.[0]
const oldUp = await upload(ADMIN, cat1.id, `兼容-${Date.now()}.txt`, 'catalogId compat', { catalogId: cat1.id })
ok('C2 旧 catalogId 入参上传兼容（IM/聊天链路）', oldUp.status === 201)
const oldMv = await json(ADMIN, `/api/files/${oldUp.body?.data?.file?.id}/move`, { method: 'PATCH', body: JSON.stringify({ catalogId: sysGroup.children?.[1]?.id }) })
ok('C3 旧 catalogId 移动兼容（IM App）', oldMv.status === 200, `HTTP ${oldMv.status}`)

// C4 需求列表在 drive/list 中混排
const lstSys = await json(ADMIN, `/api/drive/list?projectId=${PROJ}&folderId=${sysGroup.children?.[0]?.id}`)
ok('C4 SYSTEM 目录列表含条目行', (lstSys.body?.data?.items ?? []).some((i) => i.type === 'requirement'))
ok('C4b SYSTEM 标记 isSystemFolder', lstSys.body?.data?.isSystemFolder === true)

// ── 清理测试数据（purge）──
console.log('── 清理 ──')
await json(ADMIN, `/api/files/batch`, { method: 'POST', body: JSON.stringify({ folderIds: [folder.id, mFolder.id, sysChild.body?.data?.id].filter(Boolean), action: 'delete' }) })
const cl = await json(ADMIN, `/api/files/batch`, { method: 'POST', body: JSON.stringify({ folderIds: [folder.id, mFolder.id, sysChild.body?.data?.id].filter(Boolean), fileIds: [oldUp.body?.data?.file?.id, sysUp.body?.data?.file?.id].filter(Boolean), action: 'purge' }) })
ok('清理测试数据', cl.status === 200, `purged=${cl.body?.data?.purged}`)

console.log(`\n═══ 结果: ${pass} ✅ / ${fail} ❌ ═══`)
process.exit(fail > 0 ? 1 : 0)
