// Directory entrypoint for OpenCode 2 plugin loading.
// OpenCode loads a configured plugin directory by importing its root index.js,
// ignoring package.json "main"/"exports", so the V2 default must be reachable here.
export { ClaudeCodePlugin } from "./opencode-claude.js";
export { default } from "./opencode-claude.js";
