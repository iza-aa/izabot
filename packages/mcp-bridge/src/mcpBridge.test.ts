import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runListWindows, resolvePerceptionEyeBin } from "./perceptionRunner.js";
import { observeWorkspace } from "./perceptionService.js";
import { createMcpServer } from "./server.js";
import { resolveCodexBinaryPath, resolveCodexHome } from "./lunaAdapter.js";

const sampleImagePath = "/tmp/chat_ui_mock.png";

test("resolvePerceptionEyeBin returns valid executable path", () => {
  const bin = resolvePerceptionEyeBin();
  assert.ok(bin.length > 0, "Binary path should not be empty");
});

test("resolveCodexBinaryPath resolves codex binary path if present", () => {
  const codex = resolveCodexBinaryPath();
  // On this workstation ChatGPT.app codex-cli is installed
  if (codex) {
    assert.ok(codex.includes("codex"), "Codex binary path should contain 'codex'");
  }
});

test("resolveCodexHome resolves valid home directory if pool or default exists", () => {
  const home = resolveCodexHome();
  if (home) {
    assert.ok(typeof home === "string" && home.length > 0);
  }
});

test("runListWindows retrieves active window list from host", async () => {
  const windows = await runListWindows();
  assert.ok(Array.isArray(windows), "Windows should be an array");
  assert.ok(windows.length > 0, "Should detect at least one window on macOS");
  const first = windows[0];
  assert.ok(first !== undefined);
  assert.ok(typeof first.window_id === "number");
  assert.ok(typeof first.logical_width === "number");
  assert.ok(typeof first.logical_height === "number");
});

test("observeWorkspace with apple_vision on sample image validates exact schema", async () => {
  const result = await observeWorkspace({
    provider: "apple_vision",
    image_path: sampleImagePath,
    settle_delay_ms: 10,
  });

  assert.ok(result.workspace_info, "workspace_info must be present");
  assert.ok(typeof result.workspace_info.active_app_name === "string");
  assert.ok(typeof result.workspace_info.window_id === "number");
  assert.ok(typeof result.workspace_info.logical_width === "number");
  assert.ok(typeof result.workspace_info.logical_height === "number");
  assert.ok(typeof result.workspace_info.scale_factor === "number");

  assert.ok(Array.isArray(result.elements), "elements must be an array");
  assert.ok(result.elements.length >= 3, "Sample image should detect at least 3 elements");

  for (const el of result.elements) {
    assert.ok(typeof el.id === "string", "el.id must be string");
    assert.ok(typeof el.type === "string", "el.type must be string");
    assert.ok(typeof el.label === "string", "el.label must be string");
    assert.ok(typeof el.center_x === "number", "el.center_x must be number");
    assert.ok(typeof el.center_y === "number", "el.center_y must be number");
    assert.equal(el.source, "apple_vision");
    assert.ok(typeof el.bounds.x === "number");
    assert.ok(typeof el.bounds.y === "number");
    assert.ok(typeof el.bounds.w === "number");
    assert.ok(typeof el.bounds.h === "number");
  }
});

test("observeWorkspace with query filtering returns matched items", async () => {
  const result = await observeWorkspace({
    provider: "apple_vision",
    image_path: sampleImagePath,
    query: "Andi",
    settle_delay_ms: 10,
  });

  assert.equal(result.elements.length, 1);
  const el = result.elements[0];
  assert.ok(el !== undefined);
  assert.ok(el.label.includes("Andi"));
  assert.equal(el.source, "apple_vision");
});

test("observeWorkspace with non-matching query returns empty elements", async () => {
  const result = await observeWorkspace({
    provider: "apple_vision",
    image_path: sampleImagePath,
    query: "NonExistentString12345",
    settle_delay_ms: 10,
  });

  assert.equal(result.elements.length, 0);
});

test("observeWorkspace hybrid mode falls back to Luna VLM with gpt-6-luna medium parameters", async () => {
  let receivedModel = "";
  let receivedReasoningEffort = "";

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const parsedBody = JSON.parse(body);
        receivedModel = parsedBody.model;
        receivedReasoningEffort = parsedBody.reasoning_effort;
      } catch {}

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  elements: [
                    {
                      id: "vlm_icon_1",
                      type: "icon",
                      label: "camera_attachment_button",
                      center_x: 50,
                      center_y: 720,
                      bounds: { x: 30, y: 700, w: 40, h: 40 },
                      confidence: 0.98,
                    },
                  ],
                }),
              },
            },
          ],
        })
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  process.env.LUNA_VLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
  delete process.env.LUNA_VLM_MODEL; // Should default to gpt-6-luna
  delete process.env.LUNA_VLM_REASONING_EFFORT; // Should default to medium

  try {
    const result = await observeWorkspace({
      provider: "hybrid",
      image_path: sampleImagePath,
      query: "camera_attachment_button",
      settle_delay_ms: 10,
    });

    assert.equal(receivedModel, "gpt-6-luna", "Default model should be gpt-6-luna");
    assert.equal(
      receivedReasoningEffort,
      "medium",
      "Default reasoning_effort should be medium"
    );

    assert.equal(result.elements.length, 1);
    const el = result.elements[0];
    assert.ok(el !== undefined);
    assert.equal(el.id, "vlm_icon_1");
    assert.equal(el.source, "vlm_luna");
    assert.equal(el.center_x, 50);
    assert.equal(el.center_y, 720);
  } finally {
    server.close();
    delete process.env.LUNA_VLM_BASE_URL;
  }
});

test("observeWorkspace error handling for non-existent image", async () => {
  await assert.rejects(
    async () => {
      await observeWorkspace({
        provider: "apple_vision",
        image_path: "/tmp/non_existent_image_123.png",
        settle_delay_ms: 0,
      });
    },
    {
      name: "Error",
    }
  );
});

test("MCP Client connects to McpServer and executes perception_observe_workspace over protocol", async () => {
  const mcpServer = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await mcpServer.connect(serverTransport);

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(clientTransport);

  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((t) => t.name);
  assert.ok(
    toolNames.includes("perception_observe_workspace"),
    "Should include perception_observe_workspace tool"
  );
  assert.ok(
    toolNames.includes("workspace_list_windows"),
    "Should include workspace_list_windows tool"
  );

  const callResult = (await client.callTool({
    name: "perception_observe_workspace",
    arguments: {
      provider: "apple_vision",
      image_path: sampleImagePath,
      query: "Search Contacts",
      settle_delay_ms: 10,
    },
  })) as { content: Array<{ type: string; text: string }> };

  assert.ok(Array.isArray(callResult.content));
  assert.equal(callResult.content[0]?.type, "text");

  const parsed = JSON.parse(callResult.content[0]?.text ?? "{}");
  assert.ok(parsed.workspace_info);
  assert.equal(parsed.elements.length, 1);
  assert.equal(parsed.elements[0].label, "Search Contacts");

  const listCallResult = (await client.callTool({
    name: "workspace_list_windows",
    arguments: {},
  })) as { content: Array<{ type: string; text: string }> };

  const parsedList = JSON.parse(listCallResult.content[0]?.text ?? "{}");
  assert.equal(parsedList.status, "success");
  assert.ok(Array.isArray(parsedList.windows));

  await client.close();
  await mcpServer.close();
});
