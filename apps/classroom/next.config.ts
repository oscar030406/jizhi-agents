import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: process.env.VERCEL ? undefined : 'standalone',
  transpilePackages: ['mathml2omml', 'pptxgenjs', '@openmaic/importer'],
  // These agent packages do a runtime `import(specifier)` with a computed
  // specifier (to lazily load node:fs/os/path without breaking browser/Vite
  // builds). webpack can't statically analyze that and bundling it throws
  // "Cannot find module as expression is too dynamic" at runtime on the server
  // (the "Edit with AI" Pro-mode path), which broke the #619 keep-alive e2e.
  // Mark them server-external so Next loads them natively and the dynamic
  // import resolves as a real Node call.
  serverExternalPackages: ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core'],
  experimental: {
    // 投币口要收整包语料。Next 的默认克隆上限是 10MB，之前调到 200mb 仍然不够：
    // 2026-08-22 验收投一个 392.9MB 的 zip，**完整传完之后**才失败，报
    // 「请求体不是合法的表单」——日志里是
    // `Request body exceeded 200MB for /api/knowledge/intake-runs`。
    //
    // 注意它的失败形态：不是拒收，是**静默截断到前 200MB**，于是 multipart
    // 的结尾边界丢了，`req.formData()` 解析时才炸。管理者看到的是「你的表单不合法」，
    // 实际是服务端自己把包切了一刀。这种「传完了才失败」最费时间——那次白等了
    // 十几分钟。
    //
    // 2gb 与 nginx 那侧的 client_max_body_size 1g 留了一倍余量（nginx 先拦，
    // 这里不该成为第二道更严的闸）。真正的内存底线不在这条上：body 是流式转发的，
    // 落盘由接入链自己控。
    proxyClientMaxBodySize: '2gb',
  },
  async headers() {
    const extraAncestors = process.env.ALLOWED_FRAME_ANCESTORS?.trim();
    const frameAncestors = extraAncestors ? `'self' ${extraAncestors}` : "'self'";

    return [
      {
        source: '/(.*)',
        headers: [
          // X-Frame-Options only supports SAMEORIGIN (no allow-list),
          // so we omit it when custom ancestors are configured.
          ...(!extraAncestors ? [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }] : []),
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors ${frameAncestors}`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
