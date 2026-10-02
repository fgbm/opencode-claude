/**
 * The host Claude is told about and the name of the tool bridge follow
 * OPENCHAMBER_RUNTIME: OpenChamber's managed OpenCode sets it, an OpenCode
 * the user started does not.
 */
import assert from "node:assert/strict";
import { currentHost, mcpToolName, openCodeToolName } from "../src/host.ts";

const chamber = currentHost({ OPENCHAMBER_RUNTIME: "desktop" });
assert.deepEqual(chamber, { name: "OpenChamber", mcpServer: "openchamber" });
assert.equal(mcpToolName("read", chamber), "mcp__openchamber__read");

const plain = currentHost({});
assert.deepEqual(plain, { name: "OpenCode", mcpServer: "opencode" });
assert.equal(currentHost({ OPENCHAMBER_RUNTIME: "  " }).name, "OpenCode");
assert.equal(mcpToolName("read", plain), "mcp__opencode__read");

// Sessions carry calls under either name after the switch.
assert.equal(openCodeToolName("mcp__openchamber__edit"), "edit");
assert.equal(openCodeToolName("mcp__opencode__edit"), "edit");

// The runtime note names the host this process runs under.
delete process.env.OPENCHAMBER_RUNTIME;
const { buildRuntimeInstructions } = await import("../src/prompt.ts");
assert.match(buildRuntimeInstructions({}), /running in OpenCode through the Claude Code harness/);
process.env.OPENCHAMBER_RUNTIME = "web";
assert.match(buildRuntimeInstructions({}), /running in OpenChamber through the Claude Code harness/);

console.log("host regression ok");
