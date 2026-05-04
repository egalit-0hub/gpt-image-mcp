#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";

import { loginWithBrowser } from "./oauth.js";
import { saveCredentials, loadCredentials, clearCredentials, getValidCredentials, getImagesDir } from "./store.js";
import { generateImage, type ImageModel, type ImageQuality, type ImageSize } from "./api.js";

const TOOLS: Tool[] = [
  {
    name: "auth_login",
    description:
      "Authenticate with ChatGPT subscription via browser OAuth. Opens a browser window, wait for the user to log in (up to 3 minutes). No API key required — uses your ChatGPT Plus/Pro subscription.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "auth_status",
    description: "Check current authentication status and token expiry.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "auth_logout",
    description: "Clear saved credentials.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "generate_image",
    description:
      "Generate an image from a text prompt using GPT image model via ChatGPT subscription. Returns the path to the saved image file.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "Description of the image to generate" },
        model: {
          type: "string",
          enum: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5"],
          description: "Model to use. Default: gpt-5.4-mini (fastest). gpt-5.4 is balanced. gpt-5.5 is highest quality.",
        },
        quality: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Image quality. Default: medium.",
        },
        size: {
          type: "string",
          enum: ["1024x1024", "1792x1024", "1024x1792", "512x512"],
          description: "Image dimensions. Default: 1024x1024.",
        },
        output_path: {
          type: "string",
          description: "Where to save the image. Default: ~/.gpt-image-mcp/images/<uuid>.png",
        },
      },
    },
  },
  {
    name: "edit_image",
    description:
      "Edit or transform an existing image with a text prompt (image-to-image). Returns the path to the saved result.",
    inputSchema: {
      type: "object",
      required: ["prompt", "image_path"],
      properties: {
        prompt: { type: "string", description: "Instructions for how to edit or transform the image" },
        image_path: { type: "string", description: "Absolute path to the source image (PNG, JPEG, WebP)" },
        model: {
          type: "string",
          enum: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5"],
          description: "Model to use. Default: gpt-5.4-mini.",
        },
        quality: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Output quality. Default: medium.",
        },
        size: {
          type: "string",
          enum: ["1024x1024", "1792x1024", "1024x1792", "512x512"],
          description: "Output dimensions. Default: 1024x1024.",
        },
        output_path: {
          type: "string",
          description: "Where to save the result. Default: ~/.gpt-image-mcp/images/<uuid>.png",
        },
      },
    },
  },
];

function resolveOutputPath(outputPath?: string): string {
  if (outputPath) {
    return isAbsolute(outputPath) ? outputPath : resolve(process.cwd(), outputPath);
  }
  return join(getImagesDir(), `${randomBytes(8).toString("hex")}.png`);
}

function saveImage(base64: string, filePath: string): void {
  writeFileSync(filePath, Buffer.from(base64, "base64"));
}

const server = new Server(
  { name: "gpt-image-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "auth_login": {
        const { credentials, authUrl } = await loginWithBrowser();
        saveCredentials(credentials);
        const expiry = new Date(credentials.expiresAt).toLocaleString();
        return {
          content: [
            {
              type: "text",
              text: [
                "✓ Authenticated successfully!",
                `Account ID: ${credentials.accountId ?? "unknown"}`,
                `Token expires: ${expiry}`,
                `Credentials saved to ~/.gpt-image-mcp/auth.json`,
                "",
                "You can now use generate_image and edit_image tools.",
              ].join("\n"),
            },
          ],
        };
      }

      case "auth_status": {
        const creds = loadCredentials();
        if (!creds?.accessToken) {
          return {
            content: [{ type: "text", text: "Not authenticated. Use auth_login to connect your ChatGPT account." }],
          };
        }
        const expiry = new Date(creds.expiresAt).toLocaleString();
        const remainingMs = creds.expiresAt - Date.now();
        const remainingHours = Math.max(0, Math.floor(remainingMs / 3_600_000));
        const status = remainingMs <= 0 ? "⚠ EXPIRED" : remainingMs < 5 * 60_000 ? "⚠ expiring soon" : "✓ valid";
        return {
          content: [
            {
              type: "text",
              text: [
                `Status: ${status}`,
                `Account ID: ${creds.accountId ?? "unknown"}`,
                `Expires: ${expiry} (${remainingHours}h remaining)`,
              ].join("\n"),
            },
          ],
        };
      }

      case "auth_logout": {
        clearCredentials();
        return { content: [{ type: "text", text: "✓ Credentials cleared." }] };
      }

      case "generate_image":
      case "edit_image": {
        const prompt = a.prompt as string;
        if (!prompt?.trim()) throw new Error("prompt is required");

        const referencePath = name === "edit_image" ? (a.image_path as string) : undefined;
        if (referencePath && !existsSync(referencePath)) {
          throw new Error(`image_path not found: ${referencePath}`);
        }

        const creds = await getValidCredentials();
        const result = await generateImage(creds, {
          prompt,
          model: (a.model as ImageModel) ?? "gpt-5.4-mini",
          quality: (a.quality as ImageQuality) ?? "medium",
          size: (a.size as ImageSize) ?? "1024x1024",
          referencePath,
        });

        const outputPath = resolveOutputPath(a.output_path as string | undefined);
        saveImage(result.base64, outputPath);

        const lines = [`✓ Image saved to: ${outputPath}`];
        if (result.revisedPrompt && result.revisedPrompt !== prompt) {
          lines.push(`Revised prompt: ${result.revisedPrompt}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
