/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@sms/ui', '@sms/contracts'],
  eslint: { ignoreDuringBuilds: true },
  output: 'standalone',
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;