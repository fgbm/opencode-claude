// OpenCode 2.0.15 loads this package root, not a ./server export.
// Default is the V2 plugin. ClaudeCodePlugin remains the V1 function.
export { ClaudeCodePlugin } from "./dist/index.js";
export { default } from "./dist/v2.js";
