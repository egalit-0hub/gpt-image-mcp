import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { type Credentials } from "./oauth.js";

const BASE_URL = "https://chatgpt.com/backend-api/codex/responses";

export type ImageModel = "gpt-5.4-mini" | "gpt-5.4" | "gpt-5.5";
export type ImageQuality = "low" | "medium" | "high";
export type ImageSize = "1024x1024" | "1792x1024" | "1024x1792" | "512x512";
export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface GenerateOptions {
  prompt: string;
  model?: ImageModel;
  quality?: ImageQuality;
  size?: ImageSize;
  reasoning?: ReasoningEffort;
  /** Absolute path to a reference image for image-to-image */
  referencePath?: string;
}

export interface GenerateResult {
  base64: string;
  mimeType: string;
  revisedPrompt?: string;
}

// SSE event shapes we care about
interface OutputItemDoneEvent {
  type: "response.output_item.done";
  item: {
    type: string;
    result?: string;           // base64 when type === "image_generation_call"
    revised_prompt?: string;
  };
}

interface ResponseCompletedEvent {
  type: "response.completed";
}

type SseEvent = OutputItemDoneEvent | ResponseCompletedEvent | { type: string };

function buildHeaders(creds: Credentials): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${creds.accessToken}`,
    "openai-beta": "responses=experimental",
  };
  if (creds.accountId) headers["chatgpt-account-id"] = creds.accountId;
  return headers;
}

function fileToDataUrl(filePath: string): string {
  const ext = extname(filePath).toLowerCase().slice(1);
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  };
  const mime = mimeMap[ext] ?? "image/png";
  const b64 = readFileSync(filePath).toString("base64");
  return `data:${mime};base64,${b64}`;
}

function buildRequestBody(opts: GenerateOptions): Record<string, unknown> {
  const userContent = opts.referencePath
    ? [
        { type: "input_image", image_url: fileToDataUrl(opts.referencePath) },
        { type: "input_text", text: opts.prompt },
      ]
    : opts.prompt;

  // chatgpt.com/backend-api/codex requires top-level `instructions`, not a developer role in input
  return {
    model: opts.model ?? "gpt-5.4-mini",
    instructions: "You are a helpful image generation assistant.",
    input: [{ role: "user", content: userContent }],
    tools: [
      {
        type: "image_generation",
        quality: opts.quality ?? "medium",
        size: opts.size ?? "1024x1024",
        moderation: "auto",
      },
    ],
    tool_choice: "required",
    reasoning: { effort: opts.reasoning ?? "none" },
    store: false,
    stream: true,
  };
}

async function parseImageFromStream(response: Response): Promise<GenerateResult> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let base64: string | undefined;
  let revisedPrompt: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") continue;
      let event: SseEvent;
      try {
        event = JSON.parse(raw) as SseEvent;
      } catch {
        continue;
      }
      if (
        event.type === "response.output_item.done" &&
        (event as OutputItemDoneEvent).item.type === "image_generation_call"
      ) {
        const item = (event as OutputItemDoneEvent).item;
        if (item.result) base64 = item.result;
        if (item.revised_prompt) revisedPrompt = item.revised_prompt;
      }
    }
  }

  if (!base64) throw new Error("No image returned from API. The model may not have generated an image.");

  return { base64, mimeType: "image/png", revisedPrompt };
}

export async function generateImage(creds: Credentials, opts: GenerateOptions): Promise<GenerateResult> {
  const body = buildRequestBody(opts);

  const response = await fetch(BASE_URL, {
    method: "POST",
    headers: buildHeaders(creds),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  return parseImageFromStream(response);
}
