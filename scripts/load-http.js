'use strict';
/**
 * P6 压测脚本（HTTP/API 部分）—— Node 原生 fetch 并发压测。
 * 用法: node scripts/load-http.js
 * 输出: 控制台表格 + scripts/p6-load-http-results.json
 */
const BASE = process.env.BASE || 'http://localhost:3000';
const CONCURRENCY = Number(process.env.CONCURRENCY || 50);
const DURATION_MS = Number(process.env.DURATION_MS || 10000);

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

async function runLoad({ name, path, method = 'GET', headers = {}, body }) {
  const url = BASE + path;
  const results = [];
  const deadline = Date.now() + DURATION_MS;

  async function worker() {
    while (Date.now() < deadline) {
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15000),
        });
        const lat = Date.now() - t0;
        await res.text(); // 排空 body，模拟真实读取
        results.push({ latency: lat, status: res.status, ok: res.status >= 200 && res.status < 300 });
      } catch (e) {
        results.push({ latency: Date.now() - t0, status: 0, ok: false, err: String(e && e.message || e) });
      }
    }
  }

  const tStart = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const wallMs = Date.now() - tStart;

  const latencies = results.map((r) => r.latency).sort((a, b) => a - b);
  const okCount = results.filter((r) => r.ok).length;
  const total = results.length;
  const rps = total / (wallMs / 1000);

  const stat = {
    name,
    path,
    concurrency: CONCURRENCY,
    durationMs: Math.round(wallMs),
    requests: total,
    rps: Math.round(rps * 100) / 100,
    errorRate: total ? Math.round(((total - okCount) / total) * 10000) / 100 : 0,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.length ? latencies[latencies.length - 1] : 0,
    statusCodes: results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
  };
  console.log(`[${name}] ${path}  requests=${total} rps=${stat.rps} err=${stat.errorRate}%  p50=${stat.p50}ms p95=${stat.p95}ms p99=${stat.p99}ms max=${stat.max}ms`);
  return stat;
}

async function login() {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL || 'chenmuzhi@example.com', password: process.env.ADMIN_PASS || 'demo123456' }),
  });
  const j = await res.json();
  return j.data.token;
}

(async () => {
  console.log(`压测目标: ${BASE}  并发=${CONCURRENCY}  每接口持续=${DURATION_MS}ms`);
  const token = await login();
  if (!token) { console.error('登录失败，无法获取 token'); process.exit(1); }
  console.log(`已获取 token（${token.length} 字符）\n`);

  const auth = { Authorization: `Bearer ${token}` };
  const json = { 'Content-Type': 'application/json' };

  const results = [];
  // 登录接口（POST，50 并发）
  results.push(await runLoad({ name: 'login', path: '/api/auth/login', method: 'POST', headers: json, body: { email: 'chenmuzhi@example.com', password: 'demo123456' } }));
  results.push(await runLoad({ name: 'projects', path: '/api/projects', headers: auth }));
  results.push(await runLoad({ name: 'project-tree', path: '/api/projects/cmszmbz47007iu75c7mdm10rx/tree', headers: auth }));
  results.push(await runLoad({ name: 'tasks', path: '/api/tasks?projectId=cmszmbz47007iu75c7mdm10rx', headers: auth }));
  results.push(await runLoad({ name: 'todos', path: '/api/todos', headers: auth }));
  results.push(await runLoad({ name: 'notifications', path: '/api/notifications', headers: auth }));

  require('fs').writeFileSync(__dirname + '/p6-load-http-results.json', JSON.stringify({ base: BASE, concurrency: CONCURRENCY, durationMs: DURATION_MS, generatedAt: new Date().toISOString(), results }, null, 2));
  console.log('\n结果已写入 scripts/p6-load-http-results.json');
})().catch((e) => { console.error(e); process.exit(1); });
