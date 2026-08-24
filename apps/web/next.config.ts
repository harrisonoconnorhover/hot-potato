import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@hot-potato/db", "@hot-potato/router"],
};

export default config;
