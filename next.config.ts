import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 增加请求体大小限制
  experimental: {
    serverActions: {
      bodySizeLimit: '100mb',
    },
  },
};

export default nextConfig;
