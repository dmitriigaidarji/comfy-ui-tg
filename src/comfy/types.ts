// ---- ComfyUI prompt JSON ----

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export type ComfyWorkflow = Record<string, ComfyNode>;

// ---- ComfyUI HTTP responses ----

export interface UploadImageResponse {
  name: string;
  subfolder: string;
  type: string;
}

export interface HistoryImageOutput {
  filename: string;
  subfolder: string;
  type: string;
}

export interface HistoryEntry {
  outputs: Record<string, { images?: HistoryImageOutput[] }>;
}

export type HistoryResponse = Record<string, HistoryEntry>;

// ---- ComfyUI websocket messages ----

export interface WsMessage {
  type: string;
  data: {
    node?: string | null;
    prompt_id?: string;
    exception_message?: string;
    [key: string]: unknown;
  };
}

// ---- Workflow param config (`<name>.config.json`) ----

export type ParamType =
  | "string"
  | "int"
  | "float"
  | "bool"
  | "seed"
  | "enum"
  | "image";

export interface ParamDef {
  key: string;
  label: string;
  path: string;
  type: ParamType;
  default?: unknown;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** "message" = plain text messages fill this param (typically the prompt). */
  source?: "message";
  /** Computed per run rather than set by hand — kept out of /params and the keyboards. */
  hidden?: boolean;
}

/** How finished images are sent back. "document" preserves full resolution;
 *  Telegram re-encodes and downscales anything sent as a photo. */
export type Delivery = "photo" | "document";

export interface WorkflowConfig {
  name: string;
  title: string;
  description?: string;
  delivery?: Delivery;
  params: ParamDef[];
}

export interface RegisteredWorkflow {
  name: string;
  title: string;
  workflow: ComfyWorkflow;
  config: WorkflowConfig;
}
