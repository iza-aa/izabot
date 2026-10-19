#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

export * from "./types.js";
export * from "./perceptionRunner.js";
export * from "./lunaAdapter.js";
export * from "./captureProvider.js";
export * from "./perceptionService.js";
export * from "./server.js";

async function run() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("izabot-mcp-bridge running on stdio\n");
}

const isEntrypoint =
  process.argv[1] &&
  (process.argv[1].endsWith("index.js") || process.argv[1].endsWith("index.ts"));

if (isEntrypoint) {
  run().catch((err: unknown) => {
    process.stderr.write(`Fatal error in izabot-mcp-bridge: ${String(err)}\n`);
    process.exit(1);
  });
}
