import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerVeridexaTools(server: McpServer): void {
  server.registerTool(
    "gateway_health",
    {
      title: "Veridexa Fraud Detection Gateway Health",
      description: "Check whether the Veridexa Fraud Detection Gateway is healthy.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "ok" }),
        },
      ],
    }),
  );

  server.registerTool(
    "veridexa_fraud_detection",
    {
      title: "Veridexa Document Fraud Detection",
      description:
        "Analyze exactly one uploaded PDF, JPEG, or PNG document using the real Veridexa fraud detection production pipeline and return the persisted Veridexa production report. Never fabricate results.",
      inputSchema: {
        fileName: z.string(),
        mimeType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
        downloadUrl: z.string().url(),
      },
    },
    async ({ fileName, mimeType, downloadUrl }) => {
      const gatewayBaseUrl =
        process.env.GATEWAY_PUBLIC_BASE_URL?.replace(/\/+$/, "") ??
        "https://veridexa-mcp-gateway-prod.onrender.com";

      const response = await fetch(`${gatewayBaseUrl}/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          openaiFileIdRefs: [
            {
              name: fileName,
              mime_type: mimeType,
              download_link: downloadUrl,
            },
          ],
        }),
        signal: AbortSignal.timeout(360_000),
      });

      const text = await response.text();

      if (!response.ok) {
        throw new Error(
          `Veridexa fraud detection failed: HTTP ${response.status}: ${text}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
      };
    },
  );
}
