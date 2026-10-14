import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0];
});
test.afterAll(async () => {
  await server?.close();
});
test("project chat supports skill selection, real run state, stop, model switching, reload and project isolation", async ({
  page,
}) => {
  const project = {
    id: "1111111111111111",
    name: "donkey",
    path: "/repo/donkey",
  };
  const second = { id: "2222222222222222", name: "other", path: "/repo/other" };
  const makeSnapshot = (p: typeof project) => ({
    project: p,
    branch: "main",
    files: [],
    commits: [],
    branches: [{ name: "main", current: true, ref: "refs/heads/main" }],
    worktrees: [],
    tags: [],
    remotes: [],
    stashes: [],
    ahead: 0,
    behind: 0,
  });
  const skill = {
    id: "abcdef0123456789",
    name: "code-review",
    description: "Find actionable regressions in local changes",
    path: ".agents/skills/code-review/SKILL.md",
  };
  let session: Record<string, unknown> | undefined;
  let sent: Record<string, unknown> | undefined;
  await page.addInitScript(() => {
    sessionStorage.setItem("donkey-diff-token", "test");
    localStorage.setItem("donkey-diff-auto-sync", "false");
    localStorage.setItem(
      "donkey-diff-tabs",
      JSON.stringify(["1111111111111111", "2222222222222222"]),
    );
    localStorage.setItem("donkey-diff-active", "1111111111111111");
    localStorage.setItem("donkey-diff-selected-tab", "1111111111111111");
  });
  await page.route("http://127.0.0.1:43127/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (pathname === "/projects") data = [project, second];
    else if (pathname.endsWith("/chat/providers"))
      data = [
        {
          id: "codex",
          name: "Codex",
          available: true,
          defaultModel: "gpt-6.1-sol",
          defaultEffort: "low",
          models: [
            {
              id: "gpt-6.1-sol",
              name: "GPT-6.1 Sol",
              efforts: ["low", "high"],
              defaultEffort: "medium",
            },
            {
              id: "local-model",
              name: "Local Model",
              efforts: ["low", "high"],
            },
          ],
        },
        {
          id: "claude",
          name: "Claude Code",
          available: true,
          models: [
            { id: "sonnet", name: "Claude Sonnet", efforts: ["low", "high"] },
            { id: "opus", name: "Claude Opus 5.5", efforts: [] },
            { id: "claude-opus-4-8", name: "Claude Opus 4.8", efforts: [] },
          ],
        },
      ];
    else if (pathname.endsWith("/chat/send")) {
      sent = route.request().postDataJSON();
      session = {
        id: "00000000-0000-4000-8000-000000000001",
        projectId: project.id,
        provider: sent?.provider,
        title: String(sent?.text),
        model: "",
        effort: "",
        status: "running",
        activity: "Thinking",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        entries: [
          { id: "u1", kind: "user", text: sent?.text },
          {
            id: "a1",
            kind: "assistant",
            text: "I’ll inspect the working tree and review the changes.",
          },
          {
            id: "tool1",
            kind: "activity",
            text: "git diff --stat",
            detail: "src/App.tsx | 14 ++++++",
            status: "running",
          },
        ],
      };
      data = { sessionId: session.id };
    } else if (pathname.endsWith("/chat/stop")) {
      session = {
        ...session,
        status: "stopped",
        activity: "Stopped",
        updatedAt: Date.now(),
      };
      data = { ok: true };
    } else if (pathname.endsWith("/chat"))
      data = {
        sessions: pathname.includes(project.id) && session ? [session] : [],
        skills: [skill],
      };
    else if (
      pathname.endsWith("/navigation") ||
      /^\/projects\/[a-f0-9]+$/.test(pathname)
    )
      data = makeSnapshot(pathname.includes(second.id) ? second : project);
    await route.fulfill({
      json: data,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization,Content-Type",
      },
    });
  });
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(origin);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Project chat" });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Select model", exact: true }),
  ).toHaveText("GPT-6.1 Sol");
  await expect(
    panel.getByRole("button", { name: "Select effort", exact: true }),
  ).toHaveText("low");
  await expect(panel.getByText("Default", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("Full access")).toHaveCount(0);
  await expect(panel.getByText("Local connection")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Chat history" })).toHaveCount(
    0,
  );
  await panel
    .getByRole("button", { name: "Select model", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Local Model", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /default/i })).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Claude Opus 4.8", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("menuitem", { name: "Older Claude Code models", exact: true })
    .hover();
  await expect(
    page.getByRole("menuitem", { name: "Claude Opus 4.8", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Claude Sonnet", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Select model", exact: true }),
  ).toHaveText("Claude Sonnet");
  await page.screenshot({ path: "test-results/chat-clean.png" });
  const input = panel.getByRole("textbox", {
    name: "Message your project agent",
  });
  await input.fill("/code review");
  await expect(panel.getByRole("option")).toContainText("code review");
  await input.press("Enter");
  await expect(panel.getByText("code-review", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => sent?.skillId).toBe(skill.id);
  expect(sent?.provider).toBe("claude");
  expect(sent?.model).toBe("sonnet");
  await expect(panel.getByText("Thinking", { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Stop response" }),
  ).toBeEnabled();
  await page.screenshot({ path: "test-results/chat-working.png" });
  await panel.getByRole("button", { name: "Close chat" }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(panel.getByText("Thinking", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Stop response" }).click();
  await expect(
    panel.getByRole("button", { name: "Send message" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(
    panel.getByText("I’ll inspect the working tree and review the changes."),
  ).toBeVisible();
  await page.getByRole("button", { name: "other", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Review changes", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("I’ll inspect the working tree and review the changes."),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 740, height: 700 });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Close chat" }),
  ).toBeInViewport();
});
