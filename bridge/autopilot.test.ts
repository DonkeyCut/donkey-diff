import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  AutopilotService,
  formatException,
  isAutopilotCommit,
  posthogCandidates,
  type AutopilotDeps,
  type AutopilotEvent,
  type RunAgentInput,
} from "./autopilot.js";
import type { Project } from "../src/types.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec("git", args, { cwd })).stdout.trim();

/** A clone of a local bare origin: pushes never leave the temp folder. */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "diffs-autopilot-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  await exec("git", ["init", "--bare", "-b", "main", origin]);
  await exec("git", ["clone", "-q", origin, repo]);
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
  await writeFile(path.join(repo, "a.txt"), "one\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "init");
  await git(repo, "push", "-q", "origin", "main");
  const project: Project = { id: "a".repeat(16), name: "repo", path: repo };
  const data = path.join(root, "data");
  await mkdir(data);
  const pushHuman = async (text: string) => {
    await git(repo, "pull", "-q", "--ff-only", "origin", "main");
    await writeFile(path.join(repo, "a.txt"), text);
    await git(repo, "commit", "-qam", `change ${text.trim()}`);
    await git(repo, "push", "-q", "origin", "main");
  };
  return { root, origin, repo, project, data, pushHuman };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const noGh = async () => {
  throw new Error("Install the GitHub CLI (gh) so Autopilot can watch CI.");
};
function service(
  f: Fixture,
  deps: AutopilotDeps & { events?: AutopilotEvent[] } = {},
) {
  const events = deps.events || [];
  return new AutopilotService(f.data, () => [f.project], {
    gh: noGh,
    fetch: (async () => {
      throw new Error("PostHog must not be called");
    }) as typeof fetch,
    emit: (event) => events.push(event),
    runAgent: async () => {
      throw new Error("Agent must not run");
    },
    ...deps,
  });
}
const fixAgent = async (input: RunAgentInput) => {
  await writeFile(path.join(input.cwd, "a.txt"), "fixed\n");
  await writeFile(
    input.resultPath,
    JSON.stringify({
      status: "fixed",
      summary: "Fixed the bug",
      commitMessage: "fix: repair a.txt",
      checks: "passed",
    }),
  );
};
const quietAgent = async (input: RunAgentInput) =>
  writeFile(
    input.resultPath,
    JSON.stringify({
      status: "nothing_to_do",
      summary: "Looks fine",
      checks: "passed",
    }),
  );

test("config persists privately and never returns the PostHog key", async () => {
  const f = await fixture();
  try {
    const first = service(f);
    const state = await first.setConfig(f.project, {
      dailyCap: 4,
      posthog: { projectId: "123", apiKey: "phx_secretkey1234" },
    });
    assert.equal(state.config.enabled, false);
    assert.equal(state.config.posthog.apiKeyHint, "••••1234");
    assert.equal(JSON.stringify(state).includes("phx_secretkey"), false);
    await first.close();
    const file = path.join(
      f.data,
      "autopilot/projects",
      `${f.project.id}.json`,
    );
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const second = service(f);
    const reloaded = await second.state(f.project);
    assert.equal(reloaded.config.dailyCap, 4);
    assert.equal(reloaded.config.posthog.projectId, "123");
    await second.setConfig(f.project, {
      posthog: { host: "https://eu.posthog.com" },
    });
    assert.match(await readFile(file, "utf8"), /phx_secretkey1234/);
    await second.close();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a push is reviewed, the fix is pushed with a trailer, and its own commit is not reviewed again", async () => {
  const f = await fixture();
  const events: AutopilotEvent[] = [];
  const prompts: string[] = [];
  try {
    const autopilot = service(f, {
      events,
      runAgent: async (input) => {
        prompts.push(input.prompt);
        assert.notEqual(input.cwd, f.repo);
        await fixAgent(input);
      },
    });
    await autopilot.setConfig(f.project, { enabled: true });
    await autopilot.teach(f.project.id, "Never touch the changelog");
    await autopilot.check(f.project, {});
    assert.equal((await autopilot.state(f.project)).jobs.length, 0);
    await f.pushHuman("two\n");
    await autopilot.check(f.project, {});
    await autopilot.idle();
    const [job] = (await autopilot.state(f.project)).jobs;
    assert.equal(job.kind, "review");
    assert.equal(job.status, "pushed", job.error);
    assert.match(prompts[0], /Never touch the changelog/);
    const body = await git(f.origin, "log", "-1", "--format=%B", "main");
    assert.ok(isAutopilotCommit(body));
    assert.match(body, /^fix: repair a.txt/);
    assert.equal(job.commits[0], await git(f.origin, "rev-parse", "main"));
    assert.ok(
      events.some((e) => e.type === "notify" && /pushed a fix/.test(e.title)),
    );
    // The user's checkout is untouched and the worktree is gone.
    assert.equal(await readFile(path.join(f.repo, "a.txt"), "utf8"), "two\n");
    assert.equal((await git(f.repo, "worktree", "list")).split("\n").length, 1);
    await autopilot.check(f.project, {});
    await autopilot.idle();
    assert.equal((await autopilot.state(f.project)).jobs.length, 1);
    await autopilot.close();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("changes are not pushed when checks fail or the agent reports nothing", async () => {
  const f = await fixture();
  try {
    const autopilot = service(f, {
      runAgent: async (input) => {
        await writeFile(path.join(input.cwd, "a.txt"), "broken\n");
        await writeFile(
          input.resultPath,
          JSON.stringify({ status: "fixed", summary: "x", checks: "failed" }),
        );
      },
    });
    await autopilot.setConfig(f.project, { enabled: true });
    await autopilot.check(f.project, {});
    await f.pushHuman("two\n");
    await autopilot.check(f.project, {});
    await autopilot.idle();
    const [job] = (await autopilot.state(f.project)).jobs;
    assert.equal(job.status, "needs_user");
    assert.match(job.error || "", /Tests or lint failed/);
    assert.equal(
      await git(f.origin, "log", "-1", "--format=%s", "main"),
      "change two",
    );
    await autopilot.close();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("CI failures get at most two fix attempts per human commit", async () => {
  const f = await fixture();
  const events: AutopilotEvent[] = [];
  let run = 100;
  try {
    const autopilot = service(f, {
      events,
      runAgent: quietAgent,
      gh: async (_cwd, args) => {
        if (args[0] === "auth") return "";
        if (args[1] === "view") return "error TS2322: bad type";
        const head = await git(f.origin, "rev-parse", "main");
        // Each poll sees a fresh rerun that failed again.
        return JSON.stringify([
          {
            databaseId: ++run,
            headSha: head,
            status: "completed",
            conclusion: "failure",
            workflowName: "CI",
            url: "https://example.test/run",
          },
          {
            databaseId: 1,
            headSha: head,
            status: "completed",
            conclusion: "success",
            workflowName: "Daily build",
          },
        ]);
      },
    });
    await autopilot.setConfig(f.project, { enabled: true });
    for (let i = 0; i < 4; i++) {
      await autopilot.check(f.project, { push: false });
      await autopilot.idle();
    }
    const jobs = (await autopilot.state(f.project)).jobs;
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((j) => j.kind === "ci" && j.title === "Fix CI"));
    const job = await autopilot.job(f.project.id, jobs[0].id);
    assert.match(job.entries[0].text, /error TS2322/);
    assert.equal(
      events.filter((e) => e.type === "notify" && /still failing/.test(e.body))
        .length,
      1,
    );
    await autopilot.close();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("missing gh is reported instead of failing", async () => {
  const f = await fixture();
  try {
    const autopilot = service(f);
    const result = await autopilot.run(f.project, "ci");
    assert.match(result.message, /Install the GitHub CLI/);
    const state = await autopilot.state(f.project);
    assert.equal(state.integrations.gh.ok, false);
    await autopilot.close();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("PostHog issues are baselined, deduplicated and include the stack trace", async () => {
  const f = await fixture();
  const requests: { url: string; auth: string }[] = [];
  let rows: unknown[][] = [
    ["old", 50, 1, "[]", "", '["TypeError"]', '["old"]'],
  ];
  const list = JSON.stringify([
    {
      type: "TypeError",
      value: "x is undefined",
      stacktrace: {
        frames: [{ function: "render", filename: "src/App.tsx", lineno: 12 }],
      },
    },
  ]);
  try {
    let now = Date.now();
    const autopilot = service(f, {
      now: () => now,
      runAgent: quietAgent,
      fetch: (async (url: URL, init: RequestInit) => {
        requests.push({
          url: String(url),
          auth: String((init.headers as Record<string, string>).Authorization),
        });
        return new Response(
          JSON.stringify({
            columns: [
              "issue",
              "events",
              "recent",
              "exception_list",
              "url",
              "types",
              "messages",
            ],
            results: rows,
          }),
        );
      }) as typeof fetch,
    });
    await autopilot.setConfig(f.project, {
      posthog: { projectId: "42", apiKey: "phx_key" },
    });
    await autopilot.run(f.project, "posthog");
    assert.equal((await autopilot.state(f.project)).jobs.length, 0);
    assert.equal(
      requests[0].url,
      "https://us.posthog.com/api/projects/42/query/",
    );
    assert.equal(requests[0].auth, "Bearer phx_key");
    rows = [
      ...rows,
      [
        "new",
        3,
        1,
        list,
        "https://app.test/x",
        '["TypeError"]',
        '["x is undefined"]',
      ],
    ];
    await autopilot.run(f.project, "posthog");
    await autopilot.run(f.project, "posthog");
    await autopilot.idle();
    const jobs = (await autopilot.state(f.project)).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].title, "Fix TypeError: x is undefined");
    const job = await autopilot.job(f.project.id, jobs[0].id);
    assert.match(job.entries[0].text, /at render \(src\/App.tsx:12\)/);
    // A known issue only comes back when it spikes well after the attempt.
    now += 7 * 3600_000;
    rows = [["new", 40, 30, list, "", "", ""]];
    await autopilot.run(f.project, "posthog");
    await autopilot.idle();
    assert.equal((await autopilot.state(f.project)).jobs.length, 2);
    await autopilot.close();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("posthog candidates and exception formatting", () => {
  const now = Date.now();
  const row = (issue: string, events: number, recent: number) => ({
    issue,
    name: issue,
    events,
    recent,
    details: "",
  });
  assert.deepEqual(
    posthogCandidates([row("a", 10, 1), row("b", 30, 20)], {}, true, now).map(
      (r) => r.issue,
    ),
    ["b"],
  );
  assert.equal(
    posthogCandidates(
      [row("a", 40, 30)],
      { a: { attempts: 2, handledAt: 0 } },
      false,
      now,
    ).length,
    0,
  );
  assert.match(formatException("not json"), /not json/);
});

test("the daily cap holds triggers until there is room and notifies once", async () => {
  const f = await fixture();
  const events: AutopilotEvent[] = [];
  try {
    const autopilot = service(f, { events, runAgent: quietAgent });
    await autopilot.setConfig(f.project, { enabled: true, dailyCap: 1 });
    await autopilot.check(f.project, {});
    await f.pushHuman("two\n");
    await autopilot.check(f.project, {});
    await autopilot.idle();
    await f.pushHuman("three\n");
    await autopilot.check(f.project, {});
    await autopilot.check(f.project, {});
    await autopilot.idle();
    const state = await autopilot.state(f.project);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.usedToday, 1);
    assert.equal(
      events.filter((e) => e.type === "notify" && /paused/.test(e.title))
        .length,
      1,
    );
    // Raising the cap reviews the held push, covering both commits.
    await autopilot.setConfig(f.project, { dailyCap: 5 });
    await autopilot.check(f.project, {});
    await autopilot.idle();
    const jobs = (await autopilot.state(f.project)).jobs;
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].title, "Review 1 commit");
    await autopilot.close();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("jobs running when the app closed are marked interrupted on load", async () => {
  const f = await fixture();
  try {
    const file = path.join(
      f.data,
      "autopilot/projects",
      `${f.project.id}.json`,
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        config: { enabled: false },
        cursor: {},
        jobs: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            projectId: f.project.id,
            kind: "review",
            title: "Review",
            trigger: "Push",
            status: "running",
            activity: "Thinking",
            createdAt: Date.now(),
            commits: [],
            seen: false,
            meta: {},
            entries: [
              {
                id: "t",
                kind: "activity",
                text: "npm test",
                status: "running",
              },
            ],
          },
        ],
      }),
    );
    const autopilot = service(f);
    const [job] = (await autopilot.state(f.project)).jobs;
    assert.equal(job.status, "interrupted");
    const full = await autopilot.job(f.project.id, job.id);
    assert.equal(full.entries[0].status, "error");
    await autopilot.close();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
