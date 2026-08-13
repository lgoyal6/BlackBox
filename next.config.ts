import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "mongodb",
    "unpdf",
    "@langchain/langgraph-checkpoint-mongodb",
  ],
};

export default nextConfig;
