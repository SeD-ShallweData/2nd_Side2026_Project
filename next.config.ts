import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // The server environment drops captured stdout from Next's detached tsc child process.
    // Use the TypeScript compiler API so production builds still run the same type checks.
    useTypeScriptCli: false,
  },
};

export default nextConfig;
