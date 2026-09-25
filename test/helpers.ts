/**
 * Shared setup for the *-regression.ts files: isolated plugin data, a
 * signed-in plan, and a proxy driven by a mocked Agent SDK turn.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function startMockedProxy(label: string) {
  // Env must be set before the proxy modules load.
  const tmp = mkdtempSync(join(tmpdir(), `opencode-claude-${label}-`));
  process.env.XDG_DATA_HOME = tmp;
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");
  const { setAuthStatusProbe } = await import("../src/detect.ts");
  setAuthStatusProbe(() => ({ loggedIn: true, detail: "auth-status-oauth" }));
  const proxy = await import("../src/proxy.ts");
  const port = await proxy.startProxy();
  const post = (
    session: string,
    body: Record<string, unknown>,
  ): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": session,
      },
      body: JSON.stringify({ model: "sonnet", stream: false, ...body }),
    });
  return { tmp, port, post, proxy };
}

/** The in-process MCP server's request handlers, as the SDK would call them. */
export function mcpHandlers(params: { mcpServers?: unknown }) {
  const server = (params.mcpServers as Record<string, any>).opencode;
  return server.instance.server._requestHandlers as Map<
    string,
    (req: unknown, extra: unknown) => Promise<any>
  >;
}

export const mcpExtra = {
  signal: new AbortController().signal,
  sendNotification: async () => {},
  sendRequest: async () => {},
};

export function callTool(
  params: { mcpServers?: unknown },
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<Record<string, any>> }> {
  return mcpHandlers(params).get("tools/call")!(
    { method: "tools/call", params: { name, arguments: args } },
    mcpExtra,
  );
}

export function mockHandle(stream: AsyncIterable<unknown>, onClose?: () => void) {
  return {
    stream,
    interrupt: async () => {},
    close: () => onClose?.(),
    getPid: () => null,
  };
}

export const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

export const bashTool = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a command",
    parameters: { type: "object", properties: { command: { type: "string" } } },
  },
};

export { assert };
