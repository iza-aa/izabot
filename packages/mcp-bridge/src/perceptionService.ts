import fs from "node:fs";
import { captureWorkspace } from "./captureProvider.js";
import { runAppleVisionOCR } from "./perceptionRunner.js";
import { runLunaVLM } from "./lunaAdapter.js";
import { PerceptionInput, PerceptionResult, UIElement } from "./types.js";

export async function observeWorkspace(
  input: PerceptionInput
): Promise<PerceptionResult> {
  const capture = await captureWorkspace({
    targetWindowId: input.target_window_id,
    settleDelayMs: input.settle_delay_ms,
    imagePath: input.image_path,
  });

  const { imagePath, workspaceInfo, isTemporaryFile } = capture;

  try {
    let elements: UIElement[] = [];

    switch (input.provider) {
      case "apple_vision": {
        elements = await runAppleVisionOCR(
          imagePath,
          workspaceInfo.logical_width,
          workspaceInfo.logical_height,
          input.query
        );
        break;
      }

      case "vlm_luna": {
        elements = await runLunaVLM(
          imagePath,
          workspaceInfo.logical_width,
          workspaceInfo.logical_height,
          input.query
        );
        break;
      }

      case "hybrid": {
        // Run fast local OCR first
        const ocrElements = await runAppleVisionOCR(
          imagePath,
          workspaceInfo.logical_width,
          workspaceInfo.logical_height,
          input.query
        );

        if (ocrElements.length > 0) {
          elements = ocrElements;
        } else {
          // If query was given and OCR returned nothing, fallback to VLM Luna
          try {
            elements = await runLunaVLM(
              imagePath,
              workspaceInfo.logical_width,
              workspaceInfo.logical_height,
              input.query
            );
          } catch (vlmErr: unknown) {
            // If VLM is not configured or fails, gracefully return the OCR empty list
            const isMissingConfig =
              vlmErr instanceof Error &&
              vlmErr.message.includes("LUNA_VLM_BASE_URL is not set");

            if (isMissingConfig) {
              elements = ocrElements;
            } else {
              throw vlmErr;
            }
          }
        }
        break;
      }

      default: {
        throw new Error(`Unsupported perception provider: '${input.provider}'`);
      }
    }

    return {
      workspace_info: workspaceInfo,
      elements,
    };
  } finally {
    if (isTemporaryFile && fs.existsSync(imagePath)) {
      try {
        fs.unlinkSync(imagePath);
      } catch {
        // Non-critical temporary cleanup
      }
    }
  }
}
