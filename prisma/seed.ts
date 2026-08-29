import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient, ExternalOrgType } from '@prisma/client';
import bcrypt from 'bcrypt';
import { writeUploadFile } from '../src/lib/file-storage';

const prisma = new PrismaClient();
const DATA_DIR = join(process.cwd(), 'prisma', 'data');

const employees = JSON.parse(
  readFileSync(join(DATA_DIR, 'company-employees.json'), 'utf8'),
) as {
  departments: { name: string; manager: string | null; children?: { name: string; note?: string }[] }[];
  staff: {
    name: string;
    dept: string;
    jobTitle: string | null;
    globalRole: string;
    phone: string;
    email: string;
    username: string;
    duties: string;
    demoAccount: boolean;
  }[];
};

const history = JSON.parse(
  readFileSync(join(DATA_DIR, 'historical-projects-2024-2025.json'), 'utf8'),
) as {
  customers: string[];
  projects: {
    code: string;
    name: string;
    customer: string | null;
    location: string | null;
    contractNo: string | null;
    signedAt: string | null;
    status: string;
    archived: boolean;
    demoEnriched: boolean;
    remark: string | null;
  }[];
};

const DEMO_PASSWORD = 'demo123456';

// ═══════════ §10.1 岗位字典（13）═══════════
const JOB_TITLES = [
  '商务经理',
  '技术负责人',
  '工艺工程师',
  '电气工程师',
  '机械工程师',
  '采购专员',
  '生产主管',
  '物流专员',
  '现场工程师',
  '调试工程师',
  '售后工程师',
  '资料员',
  '项目经理',
];

// ═══════════ §10.2 标准流程模板（20 阶段）═══════════
// 每条 deliverable: { name, required, purpose, scope }
type Deliverable = { name: string; required: boolean; purpose: string; scope: string };
const STAGES_20: { order: number; name: string; ownerJobTitle: string; deliverables: Deliverable[] }[] = [
  {
    order: 1,
    name: '商务拜访',
    ownerJobTitle: '商务经理',
    deliverables: [
      { name: '拜访记录', required: true, purpose: '存档', scope: 'PUBLIC' },
      { name: '客户需求纪要', required: true, purpose: '存档', scope: 'PUBLIC' },
    ],
  },
  {
    order: 2,
    name: '方案设计',
    ownerJobTitle: '技术负责人',
    deliverables: [
      { name: '技术方案书', required: true, purpose: '报审', scope: 'RESTRICTED' },
      { name: '报价单', required: true, purpose: '存档', scope: 'PRIVATE' },
    ],
  },
  {
    order: 3,
    name: '项目签订',
    ownerJobTitle: '商务经理',
    deliverables: [
      { name: '合同', required: true, purpose: '存档', scope: 'PRIVATE' },
      { name: '技术协议', required: true, purpose: '存档', scope: 'RESTRICTED' },
    ],
  },
  {
    order: 4,
    name: '工艺设计',
    ownerJobTitle: '工艺工程师',
    deliverables: [
      { name: '工艺流程图', required: true, purpose: '报审', scope: 'RESTRICTED' },
      { name: 'PFMEA', required: false, purpose: '存档', scope: 'RESTRICTED' },
    ],
  },
  {
    order: 5,
    name: '电气设计',
    ownerJobTitle: '电气工程师',
    deliverables: [
      { name: '电气原理图', required: true, purpose: '报审', scope: 'RESTRICTED' },
      { name: '元件清单', required: true, purpose: '采购依据', scope: 'PUBLIC' },
      { name: 'PLC程序', required: true, purpose: '存档', scope: 'RESTRICTED' },
    ],
  },
  {
    order: 6,
    name: '容器设计',
    ownerJobTitle: '机械工程师',
    deliverables: [
      { name: '容器图纸', required: true, purpose: '报审', scope: 'RESTRICTED' },
      { name: '三维模型', required: false, purpose: '存档', scope: 'RESTRICTED' },
    ],
  },
  {
    order: 7,
    name: '采购',
    ownerJobTitle: '采购专员',
    deliverables: [
      { name: '采购订单', required: true, purpose: '存档', scope: 'PRIVATE' },
      { name: '到货计划', required: true, purpose: '施工依据', scope: 'PUBLIC' },
    ],
  },
  {
    order: 8,
    name: '车间生产',
    ownerJobTitle: '生产主管',
    deliverables: [
      { name: '生产计划', required: true, purpose: '存档', scope: 'PUBLIC' },
      { name: '工序记录', required: true, purpose: '存档', scope: 'PUBLIC' },
    ],
  },
  {
    order: 9,
    name: '电柜制作',
    ownerJobTitle: '电气工程师',
    deliverables: [
      { name: '线束表', required: true, purpose: '施工依据', scope: 'RESTRICTED' },
      { name: '检验记录', required: true, purpose: '存档', scope: 'RESTRICTED' },
    ],
  },
  {
    order: 10,
    name: '发货',
    ownerJobTitle: '物流专员',
    deliverables: [
      { name: '装箱单', required: true, purpose: '客户交付', scope: 'PUBLIC' },
      { name: '发运记录', required: true, purpose: '存档', scope: 'PUBLIC' },
    ],
  },
  {
    order: 11,
    name: '现场机械安装',
    ownerJobTitle: '现场工程师',
    deliverables: [{ name: '安装记录', required: true, purpose: '存档', scope: 'PUBLIC' }],
  },
  {
    order: 12,
    name: '现场电气安装',
    ownerJobTitle: '电气工程师',
    deliverables: [{ name: '接线核对记录', required: true, purpose: '存档', scope: 'RESTRICTED' }],
  },
  {
    order: 13,
    name: '现场调试',
    ownerJobTitle: '调试工程师',
    deliverables: [{ name: '调试报告', required: true, purpose: '客户交付', scope: 'PUBLIC' }],
  },
  {
    order: 14,
    name: '客户培训',
    ownerJobTitle: '现场工程师',
    deliverables: [
      { name: '培训签到表', required: true, purpose: '存档', scope: 'PUBLIC' },
      { name: '培训资料', required: true, purpose: '客户交付', scope: 'PUBLIC' },
    ],
  },
  {
    order: 15,
    name: '陪产',
    ownerJobTitle: '现场工程师',
    deliverables: [{ name: '陪产记录', required: true, purpose: '存档', scope: 'PUBLIC' }],
  },
  {
    order: 16,
    name: '项目验收',
    ownerJobTitle: '项目经理',
    deliverables: [{ name: '验收单', required: true, purpose: '存档', scope: 'PRIVATE' }],
  },
  {
    order: 17,
    name: '竣工资料',
    ownerJobTitle: '资料员',
    deliverables: [
      { name: '竣工资料包', required: true, purpose: '客户交付', scope: 'PUBLIC' },
      { name: '归档清单', required: true, purpose: '存档', scope: 'PRIVATE' },
    ],
  },
  {
    order: 18,
    name: '结清尾款',
    ownerJobTitle: '商务经理',
    deliverables: [{ name: '收款凭证', required: true, purpose: '存档', scope: 'PRIVATE' }],
  },
  {
    order: 19,
    name: '售后服务',
    ownerJobTitle: '售后工程师',
    deliverables: [{ name: '服务记录', required: false, purpose: '存档', scope: 'PUBLIC' }],
  },
  {
    order: 20,
    name: '项目归档',
    ownerJobTitle: '项目经理',
    deliverables: [{ name: '归档核对表', required: true, purpose: '存档', scope: 'PRIVATE' }],
  },
];

// 精简 10 步模板（1,2,3,5,7,9,13,16,18,20）
const SLIM_ORDER = [1, 2, 3, 5, 7, 9, 13, 16, 18, 20];
const STAGES_10 = STAGES_20.filter((s) => SLIM_ORDER.includes(s.order)).map((s, i) => ({
  ...s,
  order: i + 1,
}));

// ═══════════ §10.4 费用分类字典（11 类，isSystem）═══════════
const EXPENSE_CATEGORIES: { name: string; code: string; sort: number }[] = [
  { name: '差旅费', code: 'TRIP', sort: 1 },
  { name: '物流快递费', code: 'LOGISTICS', sort: 2 },
  { name: '现场采购费', code: 'SITE_PURCHASE', sort: 3 },
  { name: '招待费', code: 'RECEPTION', sort: 4 },
  { name: '租赁费', code: 'RENTAL', sort: 5 },
  { name: '维修费', code: 'REPAIR', sort: 6 },
  { name: '通讯费', code: 'TELECOM', sort: 7 },
  { name: '办公费', code: 'OFFICE', sort: 8 },
  { name: '保险费', code: 'INSURANCE', sort: 9 },
  { name: '检测费', code: 'INSPECTION', sort: 10 },
  { name: '其他', code: 'OTHER', sort: 11 },
];

// ═══════════ §10.4 虚构主体（5 家，保留类型覆盖）═══════════
const FICTIONAL_ORGS: { name: string; type: ExternalOrgType; contact: string; remark: string }[] = [
  { name: '东岳电气元件', type: 'SUPPLIER', contact: '赵主管', remark: '演示用（正式上线前替换）' },
  { name: '宏达机柜', type: 'SUPPLIER', contact: '孙经理', remark: '演示用（正式上线前替换）' },
  { name: '精工传感器', type: 'SUPPLIER', contact: '周工', remark: '演示用（正式上线前替换）' },
  { name: '锐图钣金加工', type: 'OUTSOURCER', contact: '吴厂长', remark: '演示用（正式上线前替换）' },
  { name: '安迅安装工程', type: 'CONTRACTOR', contact: '郑队', remark: '演示用（正式上线前替换）' },
];

function toDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 生成非空的样例 DWG 字节（约 1KB，内容随意仅需非空）。
 * 用于 seed 演示项目文件条目真实落盘，避免下载/预览 404（见 audit P1-4）。
 */
function sampleDwgBuffer(name: string): Buffer {
  const header = 'AC1027\n0\nSECTION\n2\nHEADER\n9\n$PM_SEED_SAMPLE\n0\nENDSEC\n0\nEOF\n';
  const pad = `; PM 演示样例：${name}\n`.padEnd(1000, '#');
  return Buffer.from(header + pad, 'utf8');
}

async function main() {
  // ═══════════ 1. 岗位字典（13）═══════════
  for (let i = 0; i < JOB_TITLES.length; i++) {
    await prisma.jobTitle.upsert({
      where: { name: JOB_TITLES[i] },
      update: { sort: i },
      create: { name: JOB_TITLES[i], sort: i },
    });
  }

  // ═══════════ 1.5 费用分类字典（11 类，isSystem）═══════════
  for (let i = 0; i < EXPENSE_CATEGORIES.length; i++) {
    await prisma.expenseCategory.upsert({
      where: { code: EXPENSE_CATEGORIES[i].code },
      update: { name: EXPENSE_CATEGORIES[i].name, sort: EXPENSE_CATEGORIES[i].sort, isSystem: true, isActive: true },
      create: {
        name: EXPENSE_CATEGORIES[i].name,
        code: EXPENSE_CATEGORIES[i].code,
        sort: EXPENSE_CATEGORIES[i].sort,
        isSystem: true,
      },
    });
  }

  // ═══════════ 2. 流程模板（20 步默认 + 10 步精简）═══════════
  async function seedTemplate(name: string, isDefault: boolean, stages: typeof STAGES_20) {
    const existing = await prisma.processTemplate.findFirst({ where: { name } });
    if (existing) return existing;
    return prisma.processTemplate.create({
      data: {
        name,
        isDefault,
        stages: {
          create: stages.map((s) => ({
            name: s.name,
            order: s.order,
            ownerJobTitle: s.ownerJobTitle,
            deliverables: s.deliverables,
          })),
        },
      },
    });
  }
  const tpl20 = await seedTemplate('标准交付流程20步', true, STAGES_20);
  await seedTemplate('精简流程10步', false, STAGES_10);

  // ═══════════ 3. 员工 51（User）═══════════
  const pwdHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const userIdByName = new Map<string, string>();
  const userIdByEmail = new Map<string, string>();

  for (const s of employees.staff) {
    const u = await prisma.user.upsert({
      where: { email: s.email },
      update: {},
      create: {
        email: s.email,
        username: s.username,
        password: pwdHash,
        name: s.name,
        phone: s.phone || null,
        jobTitle: s.jobTitle || null,
        duties: s.duties || null,
        role: (s.globalRole as 'ADMIN') || 'MEMBER',
        isActive: true,
      },
    });
    userIdByName.set(s.name, u.id);
    userIdByEmail.set(s.email, u.id);
  }

  // ═══════════ 4. 部门树（9 顶级 + 子级）═══════════
  const deptIdByPath = new Map<string, string>(); // 路径 "技术部/工艺组" → id

  async function ensureDept(name: string, parentId: string | null, managerId: string | null, sort: number) {
    const existing = await prisma.department.findFirst({ where: { name, parentId } });
    if (existing) return existing;
    return prisma.department.create({ data: { name, parentId, managerId, sort } });
  }

  let topSort = 0;
  for (const d of employees.departments) {
    const managerId = d.manager ? userIdByName.get(d.manager) ?? null : null;
    const top = await ensureDept(d.name, null, managerId, topSort++);
    deptIdByPath.set(d.name, top.id);
    if (d.children) {
      let childSort = 0;
      for (const c of d.children) {
        const child = await ensureDept(c.name, top.id, null, childSort++);
        deptIdByPath.set(`${d.name}/${c.name}`, child.id);
      }
    }
  }

  // 回填 User.departmentId
  for (const s of employees.staff) {
    const deptId = deptIdByPath.get(s.dept);
    if (deptId) {
      await prisma.user.update({ where: { email: s.email }, data: { departmentId: deptId } });
    }
  }

  // ═══════════ 5. 外部主体（客户 32 + 虚构 5 + 地区名 1）═══════════
  const orgIdByName = new Map<string, string>();

  async function ensureOrg(name: string, type: ExternalOrgType, remark: string | null, contact: string | null) {
    const existing = await prisma.externalOrg.findFirst({ where: { name, type } });
    if (existing) {
      orgIdByName.set(name, existing.id);
      return existing;
    }
    const org = await prisma.externalOrg.create({
      data: { name, type, remark, contacts: contact ? { create: [{ name: contact }] } : undefined },
    });
    orgIdByName.set(name, org.id);
    return org;
  }

  // 真实客户 32
  for (const c of history.customers) {
    await ensureOrg(c, 'CUSTOMER', null, null);
  }
  // 联合体项目牵头方归档备注（客户列表中的“国建工程建设集团有限公司”被联合体项目引用）
  const unionOrg = orgIdByName.get('国建工程建设集团有限公司');
  if (unionOrg) {
    await prisma.externalOrg.update({
      where: { id: unionOrg },
      data: { remark: '联合体项目牵头方归档；完整：安徽益祥建设集团有限公司/国建工程建设集团有限公司' },
    });
  }
  // 意向项目客户档案按通用名称入库
  await ensureOrg('启帆智能制造有限公司', 'CUSTOMER', '意向项目，客户名以通用名称登记（DEMO25028）', null);
  // 虚构主体 5（演示用）
  for (const f of FICTIONAL_ORGS) {
    await ensureOrg(f.name, f.type, f.remark, f.contact);
  }

  // ═══════════ 6. 历史项目 64（Project 档案，不实例化流程）═══════════
  const adminId = userIdByName.get('陈牧之') ?? userIdByEmail.values().next().value;
  if (!adminId) {
    throw new Error('种子数据缺少可用管理员账号（陈牧之或首个员工），无法关联 createdBy');
  }

  function resolveCustomerOrgId(customerName: string | null): string | null {
    if (!customerName) return null;
    if (customerName.includes('/')) {
      for (const part of customerName.split('/')) {
        const t = part.trim();
        const id = orgIdByName.get(t);
        if (id) return id;
      }
    }
    return orgIdByName.get(customerName) ?? null;
  }

  const projectIdByCode = new Map<string, string>();
  for (const p of history.projects) {
    const signedAt = toDate(p.signedAt);
    const proj = await prisma.project.upsert({
      where: { code: p.code },
      update: {},
      create: {
        code: p.code,
        name: p.name,
        contractNo: p.contractNo,
        location: p.location,
        signedAt,
        plannedStart: signedAt,
        status: (p.status as 'ACTIVE') || 'ACTIVE',
        customerId: resolveCustomerOrgId(p.customer),
        isArchived: p.archived,
        description: p.remark,
        createdBy: adminId,
      },
    });
    projectIdByCode.set(p.code, proj.id);
  }

  // ═══════════ 7. DEMO25021 深度实例化（§10.5，幂等）═══════════
  const demoProjectId = projectIdByCode.get('DEMO25021');
  if (demoProjectId) {
    const phaseCount = await prisma.phase.count({ where: { projectId: demoProjectId } });
    if (phaseCount === 0) {
      await seedDemoProject(demoProjectId, tpl20.id, userIdByName, adminId);
    }
  }

  console.log('✓ 数据库种子完成');
}

// 岗位 → 在职人员匹配（§10.3 岗位映射；现场/调试/售后/物流无在册 → null）
function matchOwner(jobTitle: string, userIdByName: Map<string, string>): string | null {
  const map: Record<string, string> = {
    商务经理: '朱子安',
    技术负责人: '周锦程',
    工艺工程师: '胡云帆',
    电气工程师: '孙若清',
    机械工程师: '林晚舟',
    采购专员: '赵望舒',
    生产主管: '杨景行',
    物流专员: '',
    现场工程师: '',
    调试工程师: '',
    售后工程师: '',
    资料员: '何雨桐',
    项目经理: '吴月桐',
  };
  const name = map[jobTitle];
  return name ? userIdByName.get(name) ?? null : null;
}

async function seedDemoProject(projectId: string, templateId: string, userIdByName: Map<string, string>, adminId: string) {
  const byName = (n: string) => userIdByName.get(n) ?? adminId;

  // 更新项目：绑定 20 步模板 + 计划日期
  await prisma.project.update({
    where: { id: projectId },
    data: {
      templateId,
      plannedStart: new Date('2025-08-20'),
      plannedEnd: new Date('2025-12-31'),
    },
  });

  // 项目成员（吴月桐 MANAGER，其余 MEMBER）
  const memberDefs = [
    { name: '吴月桐', role: 'MANAGER', title: '项目负责人' },
    { name: '周锦程', role: 'MEMBER', title: '技术负责人' },
    { name: '孙若清', role: 'MEMBER', title: '电气工程师' },
    { name: '马承志', role: 'MEMBER', title: '电气工程师' },
    { name: '胡云帆', role: 'MEMBER', title: '工艺工程师' },
    { name: '何雨桐', role: 'MEMBER', title: '资料员' },
    { name: '朱子安', role: 'MEMBER', title: '商务经理' },
  ];
  for (const m of memberDefs) {
    const uid = byName(m.name);
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId: uid } },
      update: {},
      create: { projectId, userId: uid, role: m.role as never, title: m.title },
    });
  }

  // 20 个阶段
  const phaseDates: Record<number, { status: string; actualStart?: string; actualEnd?: string; progress: number }> = {
    1: { status: 'DONE', actualStart: '2025-08-07', actualEnd: '2025-08-10', progress: 100 },
    2: { status: 'DONE', actualStart: '2025-08-11', actualEnd: '2025-08-20', progress: 100 },
    3: { status: 'DONE', actualStart: '2025-08-06', actualEnd: '2025-08-06', progress: 100 },
    4: { status: 'DONE', actualStart: '2025-08-21', actualEnd: '2025-09-05', progress: 100 },
    5: { status: 'IN_PROGRESS', actualStart: '2025-09-06', progress: 40 },
  };

  const phaseIdByOrder = new Map<number, string>();
  for (const s of STAGES_20) {
    const cfg = phaseDates[s.order] ?? { status: 'NOT_STARTED', progress: 0 };
    const ph = await prisma.phase.create({
      data: {
        projectId,
        code: `PH${String(s.order).padStart(2, '0')}`,
        name: s.name,
        order: s.order,
        status: cfg.status as never,
        ownerId: matchOwner(s.ownerJobTitle, userIdByName),
        actualStart: cfg.actualStart ? new Date(cfg.actualStart) : null,
        actualEnd: cfg.actualEnd ? new Date(cfg.actualEnd) : null,
        progress: cfg.progress,
      },
    });
    phaseIdByOrder.set(s.order, ph.id);
  }

  // 6 个任务
  const ph5 = phaseIdByOrder.get(5)!;
  const ph4 = phaseIdByOrder.get(4)!;
  const sunruoqing = byName('孙若清');
  const machengzhi = byName('马承志');
  const huyunfan = byName('胡云帆');
  const wuyuetong = byName('吴月桐');

  const t1 = await prisma.task.create({
    data: { phaseId: ph5, projectId, title: '绘制电气原理图', status: 'IN_PROGRESS', assigneeId: sunruoqing, creatorId: wuyuetong, description: '产线三期工程主电柜原理图' },
  });
  await prisma.task.create({
    data: { phaseId: ph5, projectId, title: '元件清单编制', status: 'TODO', assigneeId: machengzhi, creatorId: wuyuetong },
  });
  await prisma.task.create({
    data: { phaseId: ph4, projectId, title: '工艺流程图绘制', status: 'DONE', assigneeId: huyunfan, creatorId: wuyuetong, startedAt: new Date('2025-08-21'), completedAt: new Date('2025-09-04') },
  });
  const t4 = await prisma.task.create({
    data: { phaseId: ph5, projectId, title: 'PLC程序设计', status: 'TODO', assigneeId: sunruoqing, creatorId: wuyuetong, revision: 2 },
  });
  const t5 = await prisma.task.create({
    data: { phaseId: ph5, projectId, title: '电气元件选型', status: 'TODO', assigneeId: machengzhi, creatorId: wuyuetong },
  });
  const t6 = await prisma.task.create({
    data: { phaseId: ph5, projectId, title: '电柜布局设计', status: 'REVIEW', assigneeId: sunruoqing, creatorId: wuyuetong },
  });

  // 1 条修订历史（t4：PLC程序设计，v1→v2）
  await prisma.taskRevision.create({
    data: {
      taskId: t4.id,
      version: 2,
      changeSummary: 'PLC 点数由 128 点扩容为 256 点，增加 4 个模拟量通道',
      changedById: wuyuetong,
      snapshot: { title: 'PLC程序设计', status: 'TODO', assigneeId: sunruoqing, revision: 1 },
    },
  });

  // 1 条标注（t5：电气元件选型）
  await prisma.annotation.create({
    data: { taskId: t5.id, userId: wuyuetong, field: null, color: 'red', note: '元件型号需与客户确认变频器品牌', resolved: false },
  });

  // 文件目录 + 3 个文件条目（2 APPROVED / 1 REJECTED）
  const catalog = await prisma.fileCatalog.create({
    data: { projectId, name: '05-电气设计', phaseCode: 'PH05', order: 5, remark: '电气设计交付物' },
  });
  const reqDefs = [
    { name: '电气原理图', code: 'PROJ-PH05-E-001', status: 'APPROVED', ownerId: sunruoqing },
    { name: '元件清单', code: 'PROJ-PH05-E-002', status: 'APPROVED', ownerId: machengzhi },
    { name: 'PLC程序', code: 'PROJ-PH05-E-003', status: 'REJECTED', ownerId: sunruoqing },
  ];
  for (const r of reqDefs) {
    const req = await prisma.fileRequirement.create({
      data: {
        projectId,
        catalogId: catalog.id,
        phaseCode: 'PH05',
        name: r.name,
        code: r.code,
        required: true,
        ownerId: r.ownerId,
        purpose: r.status === 'APPROVED' ? '存档' : '报审',
        scope: 'RESTRICTED',
        status: r.status as never,
        reviewerId: byName('周锦程'),
      },
    });
    // 已上传文件条目 → 建 File 记录（用 file-storage 真实落盘，storagePath 存相对路径，见 audit P1-4）
    const { storagePath, size } = await writeUploadFile(
      projectId,
      catalog.id,
      `${r.name}.dwg`,
      'application/acad',
      sampleDwgBuffer(r.name),
    );
    await prisma.file.create({
      data: {
        requirementId: req.id,
        projectId,
        name: `${r.name} v1.0`,
        originalName: `${r.name}.dwg`,
        storagePath,
        size,
        mimeType: 'application/acad',
        uploadedById: r.ownerId,
      },
    });
  }

  // 项目群 + 成员 + 群聊 10 条（含 1 任务卡）+ 1 条日报
  const conv = await prisma.conversation.create({
    data: {
      type: 'PROJECT_GROUP',
      name: 'DEMO25021 中部产线三期工程群',
      projectId,
      createdBy: adminId,
    },
  });
  const convMemberDefs = [
    { name: '吴月桐', role: 'OWNER' },
    { name: '周锦程', role: 'MEMBER' },
    { name: '孙若清', role: 'MEMBER' },
    { name: '马承志', role: 'MEMBER' },
    { name: '胡云帆', role: 'MEMBER' },
    { name: '何雨桐', role: 'MEMBER' },
    { name: '朱子安', role: 'MEMBER' },
  ];
  for (const m of convMemberDefs) {
    await prisma.conversationMember.create({
      data: { conversationId: conv.id, userId: byName(m.name), role: m.role as never },
    });
  }

  const msgs: { sender: string; type: string; content: string; minutesAgo: number }[] = [
    { sender: '吴月桐', type: 'TEXT', content: '中部产线三期工程已启动，电气设计阶段推进中，大家注意节点。', minutesAgo: 600 },
    { sender: '孙若清', type: 'TEXT', content: '收到，电气原理图初稿已完成，待审核。', minutesAgo: 590 },
    { sender: '何雨桐', type: 'TEXT', content: '相关资料我已经归档到文件目录了。', minutesAgo: 580 },
    { sender: '吴月桐', type: 'TEXT', content: '@孙若清 元件清单今天下班前提交一下。', minutesAgo: 500 },
    { sender: '孙若清', type: 'TEXT', content: '好的，正在整理。', minutesAgo: 490 },
    { sender: '马承志', type: 'TEXT', content: '电柜布局方案我这边同步推进。', minutesAgo: 480 },
    { sender: '胡云帆', type: 'TEXT', content: '工艺流程图已更新到最新版。', minutesAgo: 400 },
    { sender: '朱子安', type: 'TEXT', content: '客户那边催进度了，电气设计要抓紧。', minutesAgo: 300 },
    { sender: '周锦程', type: 'TEXT', content: '我来协调资源。', minutesAgo: 290 },
    { sender: '吴月桐', type: 'TASK_CARD', content: JSON.stringify({ taskId: t1.id, taskTitle: '绘制电气原理图' }), minutesAgo: 280 },
  ];
  const now = Date.now();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        senderId: byName(m.sender),
        type: m.type as never,
        content: m.content,
        createdAt: new Date(now - m.minutesAgo * 60 * 1000),
      },
    });
  }

  // 1 条日报（REPORT）
  await prisma.message.create({
    data: {
      conversationId: conv.id,
      senderId: byName('吴月桐'),
      type: 'REPORT',
      content: JSON.stringify({
        kind: 'daily',
        date: '2025-09-06',
        summary: '今日完成电气原理图绘制，元件清单编制中，PLC程序待修订扩容。',
        nextPlan: '明日完成元件清单，推进 PLC 程序修订。',
      }),
      createdAt: new Date(now - 60 * 60 * 1000),
    },
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
