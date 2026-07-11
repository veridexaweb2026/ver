import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerVeridexaTools } from "./tools.js";

const port = Number(process.env.PORT ?? 3000);
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;

    if (total > 1_000_000) {
      throw new Error("Request body too large");
    }

    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function getConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.VERIDEXA_API_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.VERIDEXA_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error("Veridexa API configuration is missing");
  }

  return { baseUrl, apiKey };
}

type OpenAIFileRef = {
  name?: string;
  mime_type?: string;
  download_link?: string;
};

async function handleVerify(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readJson(req);

    if (!body || typeof body !== "object") {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const refs = (body as { openaiFileIdRefs?: OpenAIFileRef[] })
      .openaiFileIdRefs;

    if (!Array.isArray(refs) || refs.length !== 1) {
      sendJson(res, 400, {
        error: "Exactly one uploaded document is required",
      });
      return;
    }

    const file = refs[0];
    const fileName = file.name?.trim();
    const mimeType = file.mime_type?.trim();
    const downloadLink = file.download_link?.trim();

    if (!fileName || !mimeType || !downloadLink) {
      sendJson(res, 400, {
        error: "Uploaded file metadata is incomplete",
      });
      return;
    }

    const allowedMimeTypes = new Set([
      "application/pdf",
      "image/jpeg",
      "image/png",
    ]);

    if (!allowedMimeTypes.has(mimeType)) {
      sendJson(res, 400, { error: "Unsupported file type" });
      return;
    }

    const downloadResponse = await fetch(downloadLink, {
      signal: AbortSignal.timeout(60_000),
    });

    if (!downloadResponse.ok) {
      sendJson(res, 502, {
        error: `Failed to download uploaded document: HTTP ${downloadResponse.status}`,
      });
      return;
    }

    const bytes = await downloadResponse.arrayBuffer();

    if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) {
      sendJson(res, 400, {
        error: "Document is empty or exceeds the 20 MiB limit",
      });
      return;
    }

    const { baseUrl, apiKey } = getConfig();

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([bytes], { type: mimeType }),
      fileName,
    );

    const verifyResponse = await fetch(`${baseUrl}/api/s2s/verify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal: AbortSignal.timeout(300_000),
    });

    const verifyText = await verifyResponse.text();
    let verifyBody: unknown;

    try {
      verifyBody = JSON.parse(verifyText);
    } catch {
      verifyBody = { error: verifyText };
    }

    if (!verifyResponse.ok) {
      sendJson(res, verifyResponse.status, {
        error: "Veridexa verification failed",
        details: verifyBody,
      });
      return;
    }

    const jobId =
      verifyBody &&
      typeof verifyBody === "object" &&
      typeof (verifyBody as { jobId?: unknown }).jobId === "string"
        ? (verifyBody as { jobId: string }).jobId
        : null;

    if (!jobId) {
      sendJson(res, 502, {
        error: "Veridexa returned an invalid verification response",
      });
      return;
    }

    const reportResponse = await fetch(
      `${baseUrl}/api/s2s/report/${encodeURIComponent(jobId)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(30_000),
      },
    );

    const reportText = await reportResponse.text();
    let reportBody: unknown;

    try {
      reportBody = JSON.parse(reportText);
    } catch {
      reportBody = { error: reportText };
    }

    if (!reportResponse.ok) {
      sendJson(res, reportResponse.status, {
        jobId,
        error: "Verification completed but report retrieval failed",
        details: reportBody,
      });
      return;
    }

    sendJson(res, 200, {
      jobId,
      verificationId: jobId,
      reportId: jobId,
      status: "completed",
      ...(reportBody as object),
    });
  } catch (error) {
    sendJson(res, 500, {
      error:
        error instanceof Error
          ? error.message
          : "Unexpected Gateway error",
    });
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    sendJson(res, 200, {
      service: "veridexa-mcp-gateway",
      status: "ok",
    });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "POST" && req.url === "/verify") {
    await handleVerify(req, res);
    return;
  }

  if (req.url === "/mcp") {
    const mcpServer = new McpServer({
      name: "veridexa-mcp-gateway",
      version: "1.0.0",
    });

    registerVeridexaTools(mcpServer);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`veridexa-mcp-gateway listening on port ${port}`);
});
