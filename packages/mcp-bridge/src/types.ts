export interface ElementBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UIElement {
  id: string;
  type: string;
  label: string;
  center_x: number;
  center_y: number;
  bounds: ElementBounds;
  confidence: number;
  source: "apple_vision" | "vlm_luna";
}

export interface WorkspaceInfo {
  active_app_name: string;
  window_id: number;
  logical_width: number;
  logical_height: number;
  scale_factor: number;
}

export interface PerceptionResult {
  workspace_info: WorkspaceInfo;
  elements: UIElement[];
}

export type PerceptionProvider = "apple_vision" | "vlm_luna" | "hybrid";

export interface PerceptionInput {
  provider: PerceptionProvider;
  query?: string;
  settle_delay_ms?: number;
  target_window_id?: number;
  image_path?: string;
}

export interface WindowItem {
  window_id: number;
  owner_name: string;
  owner_pid: number;
  title: string;
  logical_width: number;
  logical_height: number;
  bounds: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  layer: number;
  alpha: number;
}

export interface WindowListResponse {
  status: string;
  count: number;
  windows: WindowItem[];
}

export interface OCRCliResponse {
  status: string;
  provider: string;
  logical_width: number;
  logical_height: number;
  image_path: string;
  element_count: number;
  elements: UIElement[];
}
