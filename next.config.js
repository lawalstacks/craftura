/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
    ],
    unoptimized: true,
  },
  experimental: {
    serverActions: { allowedOrigins: ['localhost:3000'] },
  },
  typescript: {
    ignoreBuildErrors: true,
  },
}

module.exports = nextConfig
