import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  symlink,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ChatService } from "./chat.js";
import { discoverSkills, expandSkill } from "./chat-skills.js";
import {
  agentExecutableCandidates,
  codexModels,
  claudeModels,
  codexUpdate,
  claudeUpdate,
} from "./agent-process.js";

test("Codex discovery prefers the desktop runtime, respects overrides and retains CLI fallback", () => {
  const env = { PATH: "/old-cli/bin:/usr/bin" };
  const desktop = agentExecutableCandidates(
    "codex",
    env,
    "darwin",
    "/Users/test",
  );
  assert.equal(
    desktop[0],
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  );
  assert.ok(
    desktop.indexOf("/old-cli/bin/codex") >
      desktop.indexOf(
        "/Users/test/Applications/Codex.app/Contents/Resources/codex",
      ),
  );
  assert.deepEqual(
    agentExecutableCandidates(
      "codex",
      { ...env, DONKEY_DIFF_CODEX_BIN: "/custom/codex" },
      "darwin",
    ),
    ["/custom/codex"],
  );
  assert.equal(
    agentExecutableCandidates("codex", env, "linux")[0],
    "/old-cli/bin/codex",
  );
  assert.equal(
    agentExecutableCandidates("claude", env, "darwin")[0],
    "/old-cli/bin/claude",
  );
});

test("model discovery resolves the configured Codex model and Claude default alias to model names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "diffs-models-"));
  const bin = path.join(root, "agent");
  try {
    await writeFile(
      bin,
      `#!/usr/bin/env node
const { createInterface } = require('node:readline');
const { realpathSync } = require('node:fs');
const send = v => process.stdout.write(JSON.stringify(v)+'\\n');
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='model/list') send({id:m.id,result:{data:[
  {model:'gpt-6-astra',displayName:'GPT-6 Astra',isDefault:true},
  {model:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]},
  {model:'gpt-5-hidden',displayName:'GPT-5 Hidden',hidden:true}
 ]}});
 if(m.method==='config/read') {
  if(realpathSync(m.params.cwd)!==process.cwd()) process.exit(1);
  send({id:m.id,result:{config:{model:'gpt-6.1-sol',model_reasoning_effort:'low'}}});
 }
 if(m.type==='control_request') send({type:'control_response',response:{request_id:'models',subtype:'success',response:{models:[
  {value:'default',resolvedModel:'claude-opus-5-5',displayName:'Default'},
  {value:'sonnet',resolvedModel:'claude-sonnet-5-5',displayName:'Sonnet 5.5'},
  {value:'opus',resolvedModel:'claude-opus-5-5',displayName:'Opus 5.5'}
 ]}}});
});
`,
      { mode: 0o755 },
    );
    const codex = await codexModels(bin, root);
    assert.equal(codex.defaultModel, "gpt-6.1-sol");
    assert.equal(codex.defaultEffort, "low");
    assert.equal(codex.models[1].name, "GPT-6.1 Sol");
    assert.deepEqual(codex.models[1].efforts, ["low", "high"]);
    assert.equal(codex.models.length, 2);
    const claude = await claudeModels(bin, root);
    assert.equal(claude.defaultModel, "opus");
    assert.equal(
      claude.models.find((m) => m.id === "opus")?.name,
      "Claude Opus 5.5",
    );
    assert.equal(
      claude.models.some((m) => m.id === "default"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository skills discover, match spaced slash names, and reject external files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "diffs-skills-"));
  const external = await mkdtemp(
    path.join(os.tmpdir(), "diffs-external-skill-"),
  );
  try {
    await mkdir(path.join(root, ".agents/skills/code-review"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, ".agents/skills/code-review/SKILL.md"),
      "---\nname: code-review\ndescription: Review changes\n---\nFind regressions.",
    );
    await mkdir(path.join(root, ".agents/skills/external"));
    await writeFile(path.join(external, "SKILL.md"), "secret instructions");
    await symlink(
      path.join(external, "SKILL.md"),
      path.join(root, ".agents/skills/external/SKILL.md"),
    );
    const skills = await discoverSkills(root);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].description, "Review changes");
    assert.match(
      await expandSkill(root, "/code review the staged files"),
      /Find regressions/,
    );
    assert.equal(await expandSkill(root, "/code reviewer"), "/code reviewer");
    await assert.rejects(
      expandSkill(root, "hello", "missing"),
      /no longer available/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("agent notifications expose text, tool progress, retries and failure without raw reasoning", () => {
  assert.deepEqual(
    codexUpdate({
      method: "item/agentMessage/delta",
      params: { itemId: "a", delta: "Hello" },
    }).delta,
    { id: "a", text: "Hello" },
  );
  assert.equal(
    codexUpdate({
      method: "item/started",
      params: { item: { type: "reasoning", text: "private" } },
    }).activity,
    "Thinking",
  );
  assert.equal(
    codexUpdate({
      method: "item/reasoning/textDelta",
      params: { delta: "private" },
    }).entry,
    undefined,
  );
  assert.equal(
    codexUpdate({
      method: "turn/completed",
      params: {
        turn: { status: "failed", error: { message: "Quota exceeded" } },
      },
    }).error,
    "Quota exceeded",
  );
  assert.equal(
    claudeUpdate({ type: "system", subtype: "api_retry", attempt: 2 }).activity,
    "Retrying (2)",
  );
  assert.equal(
    claudeUpdate({ type: "result", is_error: true, errors: ["Sign in first"] })
      .error,
    "Sign in first",
  );
});

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for chat");
}
test("chat scopes cwd, continues sessions, persists history, prevents parallel turns and stops subprocesses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "diffs-chat-"));
  const bin = path.join(root, "fake-codex");
  const savedOverride = process.env.DONKEY_DIFF_CODEX_BIN;
  const service = new ChatService(path.join(root, "data"));
  const project = { id: "1111111111111111", name: "fixture", path: root };
  try {
    await writeFile(
      bin,
      `#!/usr/bin/env node
const { createInterface } = require('node:readline');
const fs = require('node:fs');
const send = (v) => process.stdout.write(JSON.stringify(v)+'\\n');
createInterface({ input:process.stdin }).on('line', (line) => {
 const m = JSON.parse(line);
 if (m.method === 'initialized') return;
 if (m.method === 'initialize') return send({ id:m.id,result:{} });
 if (m.method === 'thread/start' || m.method === 'thread/resume') {
  fs.appendFileSync('requests.jsonl',JSON.stringify(m)+'\\n');
  return send({id:m.id,result:{thread:{id:'thread-fixture'},model:'gpt-6.1-sol'}});
 }
 if (m.method === 'turn/interrupt') { fs.appendFileSync('requests.jsonl',JSON.stringify(m)+'\\n'); return send({id:m.id,result:{}}); }
 if (m.method === 'turn/start') {
  send({method:'turn/started',params:{turn:{id:'turn-fixture'}}});
  send({method:'item/started',params:{item:{type:'commandExecution',id:'ready',command:'ready to interrupt'}}});
  send({id:m.id,result:{turn:{id:'turn-fixture'}}});
  if(m.params.input[0].text==='wait') return;
  setTimeout(() => {
   send({method:'item/agentMessage/delta',params:{itemId:String(m.id),delta:'Project: '+process.cwd()}});
   send({method:'turn/completed',params:{turn:{status:'completed'}}});
  }, 30);
 }
});
`,
    );
    await chmod(bin, 0o755);
    process.env.DONKEY_DIFF_CODEX_BIN = bin;
    const input = {
      provider: "codex" as const,
      model: "",
      effort: "",
      text: "hello",
    };
    const first = await service.send(project, input);
    await assert.rejects(service.send(project, input), /active chat/);
    await until(
      async () => (await service.state(project)).sessions[0].status === "idle",
    );
    let state = await service.state(project);
    assert.match(
      state.sessions[0].entries.find((entry) => entry.kind === "assistant")!
        .text,
      new RegExp(root),
    );
    assert.equal("engineSessionId" in state.sessions[0], false);
    assert.equal(state.sessions[0].model, "gpt-6.1-sol");
    await service.send(project, { ...input, sessionId: first.sessionId });
    await until(
      async () => (await service.state(project)).sessions[0].status === "idle",
    );
    const requests = (await readFile(path.join(root, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(requests[0].params.cwd, root);
    assert.equal(requests[1].method, "thread/resume");
    assert.equal(requests[1].params.threadId, "thread-fixture");
    await assert.rejects(
      service.send(
        { ...project, id: "2222222222222222" },
        { ...input, sessionId: first.sessionId },
      ),
      /not found in this project/,
    );
    await service.send(project, {
      ...input,
      sessionId: first.sessionId,
      text: "wait",
    });
    await until(async () =>
      (await service.state(project)).sessions[0].entries.some(
        (entry) => entry.id === "ready" && entry.status === "running",
      ),
    );
    await service.stop(project.id, first.sessionId);
    assert.match(
      await readFile(path.join(root, "requests.jsonl"), "utf8"),
      /turn\/interrupt/,
    );
    state = await service.state(project);
    assert.equal(state.sessions[0].status, "stopped");
    await service.close();
    const restored = new ChatService(path.join(root, "data"));
    assert.equal(
      (await restored.state(project)).sessions[0].entries.filter(
        (e) => e.kind === "user",
      ).length,
      3,
    );
    await restored.close();
  } finally {
    if (savedOverride === undefined) delete process.env.DONKEY_DIFF_CODEX_BIN;
    else process.env.DONKEY_DIFF_CODEX_BIN = savedOverride;
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stop and service shutdown retain the project until stubborn processes exit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "diffs-chat-stop-"));
  const bin = path.join(root, "fake-claude");
  const savedOverride = process.env.DONKEY_DIFF_CLAUDE_BIN;
  const service = new ChatService(path.join(root, "data"));
  const project = { id: "1111111111111111", name: "fixture", path: root };
  try {
    const worker = `
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync('worker-pid', String(process.pid));
setInterval(() => fs.appendFileSync('writes', 'x'), 10);
`;
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => process.exit(0));
fs.writeFileSync('agent-pid', String(process.pid));
spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );
    process.env.DONKEY_DIFF_CLAUDE_BIN = bin;
    const input = {
      provider: "claude" as const,
      model: "",
      effort: "",
      text: "wait",
    };
    for (const shutdown of [false, true]) {
      await rm(path.join(root, "worker-pid"), { force: true });
      const { sessionId } = await service.send(project, input);
      await until(
        async () =>
          !!(await readFile(path.join(root, "worker-pid"), "utf8").catch(
            () => "",
          )),
      );
      const pids = await Promise.all(
        ["agent-pid", "worker-pid"].map(async (file) =>
          Number(await readFile(path.join(root, file), "utf8")),
        ),
      );
      const stopped = shutdown
        ? service.close()
        : service.stop(project.id, sessionId);
      // The parent exits promptly, but its child keeps writing until SIGKILL.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(service.isRunning(project.id), true);
      assert.equal(
        (await service.state(project)).sessions[0].status,
        "running",
      );
      await assert.rejects(
        service.send(project, input),
        shutdown ? /shutting down/ : /active chat/,
      );
      await stopped;
      assert.equal(service.isRunning(project.id), false);
      assert.equal(
        (await service.state(project)).sessions[0].status,
        "stopped",
      );
      for (const pid of pids)
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      const writes = await readFile(path.join(root, "writes"), "utf8");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(await readFile(path.join(root, "writes"), "utf8"), writes);
    }
  } finally {
    if (savedOverride === undefined) delete process.env.DONKEY_DIFF_CLAUDE_BIN;
    else process.env.DONKEY_DIFF_CLAUDE_BIN = savedOverride;
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
