import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "mongodb",
    "unpdf",
    "@langchain/langgraph-checkpoint-mongodb",
  ],
  // The dev overlay badge sits bottom-left, exactly on top of the graph footer's "Graph"
  // label. The demo runs on `npm run dev`, so this is on screen in front of judges.
  devIndicators: false,
};

export default nextConfig;
