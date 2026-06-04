/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/panel",
        destination: "/panel.html"
      }
    ];
  }
};

export default nextConfig;
