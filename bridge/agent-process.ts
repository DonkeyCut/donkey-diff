import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import type { ChatProvider, ChatModel, ChatEntry } from "../src/chat-types.js";

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown) => (typeof value === "string" ? value : "");
export function agentExecutableCandidates(
  provider: ChatProvider,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
) {
  const override =
    env[
      provider === "codex" ? "DONKEY_DIFF_CODEX_BIN" : "DONKEY_DIFF_CLAUDE_BIN"
    ];
  if (override) return [override];
  // Use the desktop app's runtime and model support when it is installed.
  const desktop =
    provider === "codex" && platform === "darwin"
      ? ["/Applications", path.join(home, "Applications")].flatMap((folder) => [
          path.join(
            folder,
            "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
          ),
          path.join(folder, "Codex.app/Contents/Resources/codex"),
        ])
      : [];
  return [
    ...desktop,
    ...(env.PATH || "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((p) => path.join(p, provider)),
    path.join(home, ".local/bin", provider),
    `/opt/homebrew/bin/${provider}`,
    `/usr/local/bin/${provider}`,
  ];
}
export async function agentExecutable(provider: ChatProvider) {
  const candidates = agentExecutableCandidates(provider);
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next install location. */
    }
  }
  throw new Error(
    `Install ${provider === "codex" ? "the Codex desktop app" : "Claude Code"} and sign in, then retry. A custom executable can be set with DONKEY_DIFF_${provider.toUpperCase()}_BIN.`,
  );
}

export class AgentProcess {
  child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private sequence = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private exited = false;
  private stderr = "";
  onEvent: (event: Record<string, unknown>) => void = () => {};
  onExit: (error: Error) => void = () => {};
  constructor(executable: string, args: string[], cwd: string) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH || ""}`,
    };
    // These mark an enclosing interactive session, not this independent client.
    delete env.CLAUDECODE;
    this.child = spawn(executable, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    this.child.once("close", () => {
      this.exited = true;
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    this.child.stdin.on("error", (error) => this.fail(error));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = record(JSON.parse(line));
      } catch {
        return;
      }
      if (typeof message.id === "number" && !message.method) {
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error)
          waiting.reject(
            new Error(
              str(record(message.error).message) || "Agent request failed",
            ),
          );
        else waiting.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        // Never silently grant unexpected server requests or leave the agent hanging.
        this.send({
          id: message.id,
          error: {
            code: -32601,
            message:
              "This client does not support interactive requests. Ask the user in your response.",
          },
        });
      } else this.onEvent(message);
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code) =>
      this.fail(
        new Error(this.stderr.trim() || `Agent exited (${code ?? "signal"}).`),
      ),
    );
  }
  send(message: unknown) {
    if (!this.stopped) this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(
    method: string,
    params: unknown,
    timeoutMs = 30000,
  ): Promise<unknown> {
    if (this.stopped)
      return Promise.reject(new Error("Agent connection closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent timed out during ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  private fail(error: Error) {
    if (this.stopped) return;
    this.onExit(error);
    void this.close();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Agent connection closed"));
    }
    this.pending.clear();
    const pid = this.child.pid;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (pid && process.platform !== "win32") process.kill(-pid, signal);
        else this.child.kill(signal);
      } catch {
        /* Already exited. */
      }
    };
    const groupExists = () => {
      if (!pid || process.platform === "win32") return !this.exited;
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    this.closing = new Promise<void>((resolve) => {
      kill("SIGTERM");
      // A child can outlive the agent and close its inherited stdio. Keep the
      // process group reserved until it is gone, including forced termination.
      const force = setTimeout(() => kill("SIGKILL"), 2000);
      const poll = setInterval(() => {
        if (!this.exited || groupExists()) return;
        clearTimeout(force);
        clearInterval(poll);
        resolve();
      }, 20);
    });
    return this.closing;
  }
  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "donkey_diff",
        title: "Donkey Diff",
        version: "0.1.0",
      },
    });
    this.send({ method: "initialized", params: {} });
  }
}
export async function codexModels(
  executable: string,
  cwd: string,
): Promise<{
  models: ChatModel[];
  defaultModel: string;
  defaultEffort: string;
}> {
  const agent = new AgentProcess(
    executable,
    ["app-server", "--listen", "stdio://"],
    cwd,
  );
  try {
    await agent.initialize();
    const result = record(await agent.request("model/list", { limit: 100 }));
    const config = record(
      record(await agent.request("config/read", { cwd })).config,
    );
    const data = (Array.isArray(result.data) ? result.data : [])
      .map(record)
      .filter((m) => m.hidden !== true);
    const models: ChatModel[] = data
      .map((value) => {
        const m = record(value);
        return {
          id: str(m.model || m.id),
          name: str(m.displayName || m.model),
          defaultEffort: str(m.defaultReasoningEffort),
          efforts: (Array.isArray(m.supportedReasoningEfforts)
            ? m.supportedReasoningEfforts
            : []
          )
            .map((v) => str(record(v).reasoningEffort))
            .filter(Boolean),
        };
      })
      .filter((m) => m.id);
    const defaultModel =
      str(config.model) ||
      str(data.find((m) => m.isDefault)?.model) ||
      models[0]?.id ||
      "";
    // Configured custom models may be absent from the bundled catalog.
    if (defaultModel && !models.some((m) => m.id === defaultModel))
      models.unshift({ id: defaultModel, name: defaultModel, efforts: [] });
    return {
      models,
      defaultModel,
      defaultEffort: str(config.model_reasoning_effort),
    };
  } finally {
    await agent.close();
  }
}
export type AgentUpdate = {
  entry?: ChatEntry;
  delta?: { id: string; text: string };
  activity?: string;
  sessionId?: string;
  done?: boolean;
  error?: string;
};
export function codexUpdate(message: Record<string, unknown>): AgentUpdate {
  const p = record(message.params);
  const item = record(p.item);
  const type = str(item.type);
  if (message.method === "item/agentMessage/delta")
    return {
      delta: { id: str(p.itemId), text: str(p.delta) },
      activity: "Writing a response",
    };
  if (message.method === "turn/completed") {
    const turn = record(p.turn);
    return {
      done: true,
      error:
        str(record(turn.error).message) ||
        (turn.status === "failed" ? "Agent turn failed" : undefined),
    };
  }
  if (message.method === "error")
    return { activity: str(record(p.error).message) || "Reconnecting…" };
  if (message.method !== "item/started" && message.method !== "item/completed")
    return {};
  const complete = message.method === "item/completed";
  if (type === "agentMessage")
    return complete
      ? { entry: { id: str(item.id), kind: "assistant", text: str(item.text) } }
      : { activity: "Writing a response" };
  if (type === "reasoning") return { activity: "Thinking" };
  const labels: Record<string, string> = {
    commandExecution: "Running a command",
    fileChange: "Editing files",
    mcpToolCall: "Using a tool",
    webSearch: "Searching the web",
    imageView: "Viewing an image",
  };
  if (!labels[type]) return {};
  const text =
    type === "commandExecution"
      ? str(item.command)
      : type === "mcpToolCall"
        ? `${str(item.server)} · ${str(item.tool)}`
        : labels[type];
  const detail =
    type === "commandExecution"
      ? str(item.aggregatedOutput)
      : type === "fileChange"
        ? JSON.stringify(item.changes, null, 2)
        : "";
  return {
    activity: complete ? "Thinking" : labels[type],
    entry: {
      id: str(item.id),
      kind: "activity",
      text,
      detail: detail.slice(-16000),
      status:
        item.status === "failed" || item.status === "declined"
          ? "error"
          : complete
            ? "done"
            : "running",
    },
  };
}
export function claudeUpdate(message: Record<string, unknown>): AgentUpdate {
  if (message.parent_tool_use_id) return {};
  if (message.type === "system" && message.subtype === "init")
    return { sessionId: str(message.session_id), activity: "Thinking" };
  if (message.type === "system" && message.subtype === "api_retry")
    return { activity: `Retrying (${message.attempt})` };
  if (message.type === "result")
    return {
      done: true,
      sessionId: str(message.session_id),
      error: message.is_error
        ? (Array.isArray(message.errors)
            ? message.errors.join("\n")
            : str(message.result)) || "Claude could not complete the request"
        : undefined,
    };
  const event = record(message.event);
  if (message.type === "stream_event") {
    const delta = record(event.delta);
    if (delta.type === "text_delta")
      return {
        delta: { id: "claude-stream", text: str(delta.text) },
        activity: "Writing a response",
      };
    if (delta.type === "thinking_delta") return { activity: "Thinking" };
  }
  return {};
}

export async function claudeModels(
  executable: string,
  cwd: string,
): Promise<{ models: ChatModel[]; defaultModel: string }> {
  const agent = new AgentProcess(
    executable,
    [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    cwd,
  );
  try {
    return await new Promise<{ models: ChatModel[]; defaultModel: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Claude model discovery timed out")),
          30000,
        );
        agent.onExit = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        agent.onEvent = (event) => {
          if (event.type !== "control_response") return;
          const response = record(event.response);
          if (response.request_id !== "models") return;
          clearTimeout(timer);
          if (response.subtype !== "success") {
            reject(
              new Error(str(response.error) || "Could not load Claude models"),
            );
            return;
          }
          const data = record(response.response);
          const catalog = (Array.isArray(data.models) ? data.models : []).map(
            record,
          );
          const models = catalog
            .filter((m) => m.value !== "default")
            .map((m) => ({
              id: str(m.value),
              name: `Claude ${str(m.displayName)}`,
              efforts: (Array.isArray(m.supportedEffortLevels)
                ? m.supportedEffortLevels
                : []
              ).filter((e): e is string => typeof e === "string"),
            }));
          const resolved = catalog.find(
            (m) => m.value === "default",
          )?.resolvedModel;
          const defaultModel =
            str(
              catalog.find(
                (m) => m.value !== "default" && m.resolvedModel === resolved,
              )?.value,
            ) ||
            models[0]?.id ||
            "";
          resolve({ models, defaultModel });
        };
        agent.send({
          type: "control_request",
          request_id: "models",
          request: { subtype: "initialize" },
        });
      },
    );
  } finally {
    await agent.close();
  }
}
