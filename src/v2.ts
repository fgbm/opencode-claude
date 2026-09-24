/**
 * OpenCode 2.0.15 entrypoint.
 *
 * The host loads the package root and requires a default object with `id` and
 * `setup`. It does not select a `./server` export, and this release has
 * `ctx.provider`, not the newer `ctx.catalog`.
 */
import { Integration, Model, Plugin, Provider } from "@opencode/plugin";
import {
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  EFFORT_LEVELS,
  PROVIDER_ID,
  SESSION_HEADER,
} from "./constants.js";
import { detectClaudeCode } from "./detect.js";
import { buildAuthMethods } from "./index.js";
import {
  encodeClaudeModelSelection,
  resolveClaudeModelSelection,
} from "./model-selection.js";
import { getClaudeModels } from "./models.js";
import { getClaudeProxyBaseUrl, startProxy } from "./proxy.js";

const AUTH_METHOD_ID = "claude-cli";
const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible";
const CONNECTION_MARKER = "managed-by-claude-code-cli";
const CONNECTION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

type LoginResult = { type?: string };

function marker() {
  return {
    type: "oauth" as const,
    methodID: Integration.MethodID.make(AUTH_METHOD_ID),
    access: CONNECTION_MARKER,
    refresh: CONNECTION_MARKER,
    expires: Date.now() + CONNECTION_TTL_MS,
  };
}

async function requireLoginSuccess(result: LoginResult) {
  if (result?.type !== "success") {
    throw new Error("Claude Code CLI sign-in failed");
  }
  return marker();
}

function toAuthorization(authorization: {
  method?: string;
  url: string;
  instructions: string;
  callback: (code?: string) => Promise<LoginResult>;
}) {
  if (authorization.method === "code") {
    return {
      url: authorization.url,
      instructions: authorization.instructions,
      mode: "code" as const,
      callback: async (code: string) => requireLoginSuccess(await authorization.callback(code)),
    };
  }
  return {
    url: authorization.url,
    instructions: authorization.instructions,
    mode: "auto" as const,
    callback: authorization.callback().then(requireLoginSuccess),
  };
}

async function directoryOf(
  ctx: Plugin.Context,
  sessionID: string,
): Promise<string> {
  try {
    const session = await ctx.session.get({ sessionID });
    return session.location?.directory || ctx.location.directory;
  } catch {
    return ctx.location.directory;
  }
}

function stamp(
  headers: Headers | Record<string, string> | undefined,
  name: string,
  value: string,
) {
  if (!headers) return;
  if (typeof (headers as Headers).set === "function") {
    (headers as Headers).set(name, value);
    return;
  }
  (headers as Record<string, string>)[name] = value;
}

export default Plugin.define({
  id: "opencode.provider.claude-code",
  async setup(ctx) {
    await startProxy();

    try {
      const providerID = Provider.ID.make(PROVIDER_ID);
      const baseURL = getClaudeProxyBaseUrl();

      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: "Claude Code",
            activation: "enabled",
            package: PROVIDER_PACKAGE,
            integrationID: Integration.ID.make(PROVIDER_ID),
            settings: {
              apiKey: CONNECTION_MARKER,
              baseURL,
            },
          },
          models: getClaudeModels().map((definition) => ({
            ...Model.Info.default(providerID, Model.ID.make(definition.id)),
            name: definition.name,
            capabilities: {
              tools: true,
              input: ["text", "image", "pdf"],
              output: ["text"],
            },
            variants: EFFORT_LEVELS.map((id) => ({ id: Model.VariantID.make(id) })),
            limit: {
              context: definition.contextWindow,
              output: definition.maxTokens,
            },
          })),
        });
      });

      try {
        const detection = await detectClaudeCode();
        const method = buildAuthMethods(
          detection.status !== "missing-cli",
          ctx.location.directory,
        )[0];
        if (method) {
          await ctx.integration.transform((editor) => {
            editor.update(PROVIDER_ID, (draft) => {
              draft.name = "Claude Code";
            });
            editor.method.update({
              integrationID: PROVIDER_ID,
              method: {
                id: AUTH_METHOD_ID,
                type: "oauth",
                label: method.label,
              },
              authorize: async () =>
                toAuthorization(
                  (await method.authorize()) as Parameters<typeof toAuthorization>[0],
                ),
              refresh: async (credential) => {
                const current = await detectClaudeCode();
                if (!current.loggedIn) {
                  throw new Error(
                    "Claude Code CLI is not signed in. Run `claude auth login --claudeai`.",
                  );
                }
                return { ...credential, expires: Date.now() + CONNECTION_TTL_MS };
              },
              label: () => "Claude Code CLI",
            });
          });
        }
      } catch (error) {
        console.error("[opencode-claude] V2 integration registration skipped", error);
      }

      const onRequest = async (event: {
        sessionID: string;
        model: { id: string; variant?: string };
        request?: { headers?: Headers };
        headers?: Record<string, string>;
      }) => {
        const headers = event.request?.headers ?? event.headers;
        const selected = resolveClaudeModelSelection(event.model.id, event.model.variant);
        stamp(headers, EFFORT_HEADER, encodeClaudeModelSelection(selected));
        stamp(headers, SESSION_HEADER, event.sessionID);
        stamp(headers, DIRECTORY_HEADER, await directoryOf(ctx, event.sessionID));
      };

      await ctx.session.hook("http.request", onRequest, { providerID: PROVIDER_ID });
      await ctx.session.hook("model.request", onRequest, { providerID: PROVIDER_ID });
    } catch (error) {
      // The proxy is shared process-wide: a failed location setup must not
      // stop the listener that other locations are already using.
      throw error;
    }

    // No cleanup: the proxy lives for the whole server process, so unloading
    // one location never interrupts Claude turns running in another.
  },
});
