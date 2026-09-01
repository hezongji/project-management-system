/** @type {import('next').BatchAddOptions | import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // 网盘化（20260830-drive-war）：zip 流式打包依赖为 CJS callable，禁止 webpack 打包改写 require 语义
  // MCP（2026-09-01）：官方 SDK 为 ESM + Node 内置模块，外部化避免 standalone 构建 trace 异常
  serverExternalPackages: ['archiver', '@modelcontextprotocol/sdk'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
  env: {
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
    API_BASE_URL: process.env.API_BASE_URL || 'http://localhost:3001',
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'origin-when-cross-origin',
          },
        ],
      },
    ];
  },
  async redirects() {
    // ── 旧路由 → 新路由 301 重定向映射表（P0-3，依据文档 §8.1 + 附录 A）──
    // 对照表同步维护在 src/components/layout/sidebar.tsx 的 LEGACY_REDIRECTS
    return [
      { source: '/dashboard', destination: '/', statusCode: 301 },     // 工作台迁至根路由 (main)/page.tsx
      { source: '/teams', destination: '/organization', statusCode: 301 },  // 团队页由组织架构内部树替代（P0-4）
      { source: '/org', destination: '/organization', statusCode: 301 },     // P0-4 占位路由转正
      { source: '/gantt', destination: '/views/gantt', statusCode: 301 }, // 甘特图归入视图组
      { source: '/projects/create', destination: '/projects/new', statusCode: 302 }, // 旧单页表单 → 新建项目向导（P1-2）
      { source: '/debug', destination: '/', statusCode: 301 },          // 调试页删除（附录 A）
    ];
  },
};

module.exports = nextConfig;