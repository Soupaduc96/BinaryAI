import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The dashboard is a pure client of the API. It holds no secrets and performs
  // no market analysis of its own -- see docs/development-principles.md (rule 5).
  env: {},
  typedRoutes: true,
};

export default nextConfig;
