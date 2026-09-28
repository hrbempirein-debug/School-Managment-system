/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@sms/ui', '@sms/contracts'],
  eslint: { ignoreDuringBuilds: true },
  output: 'standalone',
  experimental: {
    externalDir: true,
  },
  webpack: (config) => {
    // The workspace packages ship TypeScript sources and import each other with
    // NodeNext `.js` specifiers. Without an alias, webpack treats `./x.js` as a
    // literal file and can't resolve the compiled `.ts` counterpart.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;