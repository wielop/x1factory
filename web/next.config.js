/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: import.meta.dirname
  },
  async rewrites() {
    return [
      {
        source: "/telegrambot",
        destination: "/reactor.html"
      },
      {
        source: "/reactor",
        destination: "/reactor.html"
      }
    ];
  }
};

export default nextConfig;
