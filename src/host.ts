/**
 * Which app runs this OpenCode server, as far as the plugin can tell.
 *
 * OpenChamber starts its managed OpenCode with OPENCHAMBER_RUNTIME set (web,
 * desktop, ssh-remote). An OpenCode the user started themselves carries no
 * such marker, even when OpenChamber connects to it, so it counts as plain
 * OpenCode. The name is what Claude is told it runs in and what its tools
 * are called: stated plainly, never dressed up as Claude Code.
 */
export type Host = { name: "OpenChamber" | "OpenCode"; mcpServer: "openchamber" | "opencode" };

export function currentHost(env: NodeJS.ProcessEnv = process.env): Host {
  return env.OPENCHAMBER_RUNTIME?.trim()
    ? { name: "OpenChamber", mcpServer: "openchamber" }
    : { name: "OpenCode", mcpServer: "opencode" };
}

/** Claude Code's name for a bridged tool. */
export function mcpToolName(tool: string, host: Host = currentHost()): string {
  return `mcp__${host.mcpServer}__${tool}`;
}

/** OpenCode's name for a tool Claude called through either bridge name. */
export function openCodeToolName(mcpName: string): string {
  return mcpName.replace(/^mcp__(?:openchamber|opencode)__/, "");
}
