import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { observeWorkspace } from "./perceptionService.js";
import { runListWindows } from "./perceptionRunner.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "izabot-mcp-bridge",
    version: "0.1.0",
  });

  server.tool(
    "perception_observe_workspace",
    "Membaca tampilan aplikasi yang sedang aktif di CUA Workspace menggunakan Apple Vision OCR atau ChatGPT/Luna Vision untuk mendapatkan daftar elemen dan koordinat klik yang valid.",
    {
      provider: z
        .enum(["apple_vision", "vlm_luna", "hybrid"])
        .describe(
          "Gunakan 'apple_vision' untuk pencarian teks cepat lokal, 'vlm_luna' untuk pemahaman visual/ikon, atau 'hybrid' untuk gabungan keduanya."
        ),
      query: z
        .string()
        .optional()
        .describe(
          "Opsional: Instruksi spesifik tentang elemen apa yang sedang dicari (misal: 'kolom input' atau 'kontak Budi')."
        ),
      settle_delay_ms: z
        .number()
        .optional()
        .default(300)
        .describe(
          "Jeda waktu tunggu (ms) sebelum mengambil tangkapan layar untuk memastikan animasi UI selesai."
        ),
      target_window_id: z
        .number()
        .optional()
        .describe(
          "Opsional: Window ID jendela aplikasi yang sedang diikat di CUA Space."
        ),
      image_path: z
        .string()
        .optional()
        .describe(
          "Opsional: Path file tangkapan layar langsung jika sudah disediakan oleh CUA Space frame buffer."
        ),
    },
    async (params) => {
      try {
        const result = await observeWorkspace({
          provider: params.provider,
          query: params.query,
          settle_delay_ms: params.settle_delay_ms,
          target_window_id: params.target_window_id,
          image_path: params.image_path,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "error",
                  error: message,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "workspace_list_windows",
    "Mendapatkan daftar seluruh jendela aplikasi macOS yang sedang aktif beserta window_id dan dimensi logisnya untuk pemilihan target CUA Space secara dinamis.",
    {},
    async () => {
      try {
        const windows = await runListWindows();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  count: windows.length,
                  windows,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "error",
                  error: message,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  return server;
}
