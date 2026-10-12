import { expect, test, type Page } from "@playwright/test";
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
test.use({ viewport: { width: 1440, height: 1000 } });

const projects = Array.from({ length: 4 }, (_, index) => ({
  id: String(index + 1).repeat(16),
  name: index ? `tree${index}` : "donkey",
  path: `/repo/${index ? `tree${index}` : "donkey"}`,
}));
const hash = (index: number) => (index + 1).toString(16).padStart(40, "0");
const commit = (index: number) => ({
  hash: hash(index),
  short: hash(index).slice(-7),
  parents:
    index === 0 ? `${hash(2)} ${hash(1)}` : hash(index === 1 ? 10 : index + 1),
  author: "Test Author",
  date: "2026-09-30T00:00:00Z",
  subject: `Change ${index}`,
  refs: index === 0 ? "HEAD -> branch00" : "",
});
const files = Array.from({ length: 8 }, (_, i) => ({
  path: `src/${String(i).padStart(2, "0")}.ts`,
  status: "M",
  staged: i >= 4,
  unstaged: i < 4,
  conflict: false,
  additions: 1,
  deletions: 1,
}));
const snapshot = (index: number) => ({
  project: projects[index],
  branch: `branch0${index}`,
  files,
  commits: Array.from({ length: 150 }, (_, i) => commit(i + index)),
  branches: [
    ...Array.from({ length: 6 }, (_, i) => ({
      name: `branch0${i}`,
      ref: `refs/heads/branch0${i}`,
      current: i === index,
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      name: `origin/remote0${i}`,
      ref: `refs/remotes/origin/remote0${i}`,
      remote: true,
      current: false,
    })),
  ],
  worktrees: projects.map((p, i) => ({ path: p.path, branch: `branch0${i}` })),
  tags: Array.from({ length: 80 }, (_, i) => `v${String(i).padStart(2, "0")}`),
  remotes: ["origin"],
  stashes: [0, 1, 2].map((i) => ({
    ref: `stash@{${i}}`,
    subject: `Saved ${i}`,
  })),
  ahead: 0,
  behind: 0,
});

async function fixture(
  page: Page,
  registerOnDemand = false,
  empty = false,
  tabs = empty ? projects.slice(0, 2) : projects.slice(0, 1),
) {
  const errors: string[] = [];
  const writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    (tabs) => {
      sessionStorage.setItem("donkey-diff-token", "test");
      localStorage.setItem("donkey-diff-auto-sync", "false");
      localStorage.setItem("donkey-diff-tabs", JSON.stringify(tabs));
    },
    tabs.map((p) => p.id),
  );
  let sequence = 0;
  await page.route("http://127.0.0.1:43127/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["GET", "OPTIONS"].includes(request.method()))
      writes.push(url.pathname);
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
      return;
    }
    const index = Math.max(
      0,
      projects.findIndex((p) => url.pathname.includes(p.id)),
    );
    let data: unknown = { ...snapshot(index), files: empty ? [] : files };
    if (url.pathname === "/projects") {
      if (request.method() === "POST") {
        const selected = projects.find(
          (project) => project.path === request.postDataJSON().path,
        )!;
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            selected === projects[1]
              ? 120
              : selected === projects[2]
                ? 60
                : 250,
          ),
        );
        data = selected;
      } else data = registerOnDemand ? [projects[0]] : projects;
    } else if (url.pathname.endsWith("/history")) {
      const ref = url.searchParams.get("ref") || "HEAD";
      const offset =
        ref === "HEAD" ? index : Number(ref.match(/(\d+)\D*$/)?.[1] || 0);
      data = Array.from({ length: 150 }, (_, i) => commit(offset + i));
    } else if (url.pathname.endsWith("/files")) data = empty ? [] : files;
    else if (url.pathname.endsWith("/tree")) data = files.map((f) => f.path);
    else if (url.pathname.endsWith("/file")) {
      const path = url.searchParams.get("path") || "";
      const version = parseInt(url.searchParams.get("commit") || "1", 16) - 1;
      const before = Array.from(
        { length: 400 },
        (_, i) =>
          `export const line${i} = ${i};${i === 200 ? " // Keep this readable" : ""}`,
      ).join("\n");
      data = {
        path,
        old: before,
        current: before.replace("line200 = 200", `line200 = ${500 + version}`),
        binary: false,
        conflict: false,
      };
    }
    // Deterministic out-of-order responses exercise cancellation while keys repeat.
    await new Promise((resolve) =>
      setTimeout(resolve, [15, 90, 35][sequence++ % 3]),
    );
    await route.fulfill({
      json: data,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  });
  await page.goto(origin);
  await expect(page.locator(".project-heading")).toHaveText("donkey");
  return { errors, writes };
}

test("cached empty project tabs stay empty throughout background refresh", async ({
  page,
}) => {
  await fixture(page, false, true);
  const tabs = page.locator(".tab-select");
  await expect(page.locator(".empty-workspace")).toBeVisible();
  await tabs.nth(1).click();
  await expect(page.locator(".project-heading")).toHaveText("tree1");
  await expect(page.locator(".empty-workspace")).toBeVisible();
  // Wait for the first snapshot so both tabs have a cached empty state.
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const violations: string[] = [];
    const observer = new MutationObserver(() => {
      if (!document.querySelector(".empty-workspace"))
        violations.push("empty workspace disappeared");
    });
    observer.observe(document.querySelector(".app-shell")!, {
      subtree: true,
      childList: true,
    });
    Object.assign(window, { emptyTabAudit: { violations, observer } });
  });
  for (const index of [0, 1, 0, 1]) {
    await tabs.nth(index).click();
    await page.waitForTimeout(150);
  }
  const violations = await page.evaluate(() => {
    const audit = (
      window as unknown as {
        emptyTabAudit: { violations: string[]; observer: MutationObserver };
      }
    ).emptyTabAudit;
    audit.observer.disconnect();
    return audit.violations;
  });
  expect(violations).toEqual([]);
});

type Audit = { frames: number; violations: string[]; stop: () => void };
async function auditChrome(page: Page, selectors: string[]) {
  await page.evaluate((selectors) => {
    const nodes = selectors.map((selector) =>
      document.querySelector<HTMLElement>(selector)!,
    );
    const signature = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return JSON.stringify([
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        style.backgroundColor,
        style.opacity,
        style.visibility,
      ]);
    };
    const baseline = nodes.map(signature);
    const audit: Audit = { frames: 0, violations: [], stop: () => {} };
    let running = true;
    const fail = (message: string) => {
      if (!audit.violations.includes(message)) audit.violations.push(message);
    };
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const removed of record.removedNodes)
          nodes.forEach((node, i) => {
            if (removed === node || removed.contains(node))
              fail(`removed ${selectors[i]}`);
          });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    function frame() {
      if (!running) return;
      audit.frames++;
      nodes.forEach((node, i) => {
        if (!node.isConnected || document.querySelector(selectors[i]) !== node)
          fail(`replaced ${selectors[i]}`);
        else if (signature(node) !== baseline[i])
          fail(`changed chrome ${selectors[i]}`);
      });
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    audit.stop = () => {
      running = false;
      observer.disconnect();
    };
    (window as unknown as { navigationAudit: Audit }).navigationAudit = audit;
  }, selectors);
}
async function finishAudit(page: Page) {
  return page.evaluate(() => {
    const audit = (window as unknown as { navigationAudit: Audit })
      .navigationAudit;
    audit.stop();
    return { frames: audit.frames, violations: audit.violations };
  });
}
const chrome = [
  ".project-tabs",
  ".sidebar",
  ".toolbar",
  ".workspace-tabs",
  ".change-summary",
  ".file-filter",
  ".diff-toolbar",
  ".diff-controls",
  '.diff-controls button[aria-label="Next change"]',
  '.diff-controls button[aria-label="Wrap lines"]',
];
async function keys(page: Page, key: "ArrowDown" | "ArrowUp", count: number) {
  for (let i = 0; i < count; i++) await page.keyboard.press(key);
}
async function ready(page: Page) {
  await expect(page.locator(".diff-pane")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(
    page.getByRole("button", { name: "Next change", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".diff-content .empty")).toHaveCount(0);
}

test("merge graph shows parallel ancestry and badges stay readable on selection", async ({
  page,
}, testInfo) => {
  const { errors } = await fixture(page);
  await page.getByRole("button", { name: "All Commits", exact: true }).click();
  await ready(page);
  const rows = page.locator(".commit-row");
  await rows.first().click();
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  const graphs = page.locator(".commit-graph");
  const positions = await graphs.evaluateAll((nodes) =>
    nodes.map((node) => ({
      width: node.getBoundingClientRect().width,
      cx: node.querySelector("circle")!.getAttribute("cx"),
      paths: Array.from(node.querySelectorAll("path"), (p) =>
        p.getAttribute("d"),
      ),
    })),
  );
  expect(positions[0].width).toBeGreaterThan(18);
  expect(positions[1].cx).not.toBe(positions[2].cx);
  expect(positions[0].paths).toHaveLength(2);
  const badge = rows.first().locator(".branch-label");
  await expect(badge).toHaveText("branch00");
  const colors = await badge.evaluate((node) => {
    const style = getComputedStyle(node);
    const luminance = (color: string) => {
      const channels = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    return {
      contrast:
        (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05),
      background: style.backgroundColor,
      text: style.color,
      icon: getComputedStyle(node.querySelector("svg")!).color,
    };
  });
  expect(colors.contrast).toBeGreaterThanOrEqual(4.5);
  expect(colors.icon).toBe(colors.text);
  expect(colors.background).not.toContain("rgba");
  await keys(page, "ArrowDown", 9);
  await keys(page, "ArrowUp", 9);
  await ready(page);
  expect(
    await graphs.evaluateAll((nodes) =>
      nodes.map((node) => ({
        width: node.getBoundingClientRect().width,
        cx: node.querySelector("circle")!.getAttribute("cx"),
        paths: Array.from(node.querySelectorAll("path"), (p) =>
          p.getAttribute("d"),
        ),
      })),
    ),
  ).toEqual(positions);
  await testInfo.attach("merge-graph", {
    body: await page.locator(".history").screenshot(),
    contentType: "image/png",
  });
  await page.screenshot({ path: testInfo.outputPath("merge-graph.png") });
  expect(errors).toEqual([]);
});

test("arrows across commits, files, refs and worktrees preserve chrome on every rendered frame", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const { errors, writes } = await fixture(page);
  await page.getByRole("button", { name: "All Commits", exact: true }).click();
  await ready(page);
  await auditChrome(page, chrome);
  const controls = await page.locator(".diff-controls").screenshot();
  await page.getByRole("option").first().click();
  await keys(page, "ArrowDown", 12);
  await expect(page.locator('.commit-row[aria-selected="true"]')).toContainText(
    "Change 12",
  );
  await keys(page, "ArrowUp", 7);
  await expect(page.locator('.commit-row[aria-selected="true"]')).toContainText(
    "Change 5",
  );
  await ready(page);
  await page.keyboard.press("End");
  await expect(page.locator('.commit-row[aria-selected="true"]')).toContainText(
    "Change 149",
  );
  await page.keyboard.press("Home");
  await ready(page);
  await page.locator('.tree-item-select[data-path="src/00.ts"]').click();
  await keys(page, "ArrowDown", 7);
  await keys(page, "ArrowUp", 4);
  await expect(page.locator(".diff-toolbar")).toContainText("src/03.ts");
  await ready(page);
  await expect(
    page.locator('.tree-item-select[data-path="src/03.ts"]'),
  ).toBeFocused();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "branch00", exact: true })
    .click();
  await keys(page, "ArrowDown", 5);
  await keys(page, "ArrowUp", 2);
  await expect(page.locator(".history-heading")).toContainText("branch03");
  await ready(page);
  await expect(
    page
      .locator(".sidebar")
      .getByRole("button", { name: "branch03", exact: true }),
  ).toBeFocused();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "remote00", exact: true })
    .click();
  await keys(page, "ArrowDown", 3);
  await keys(page, "ArrowUp", 1);
  await expect(page.locator(".history-heading")).toContainText(
    "origin/remote02",
  );
  await ready(page);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "v00", exact: true })
    .click();
  await keys(page, "ArrowDown", 18);
  await keys(page, "ArrowUp", 6);
  await expect(page.locator(".history-heading")).toContainText("v12");
  await ready(page);
  await expect(
    page.locator(".sidebar").getByRole("button", { name: "v12", exact: true }),
  ).toBeFocused();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Saved 0", exact: true })
    .click();
  await keys(page, "ArrowDown", 2);
  await keys(page, "ArrowUp", 1);
  await expect(page.locator(".history-heading")).toContainText("stash@{1}");
  await ready(page);
  await page.locator('.sidebar .nav-row[title="/repo/donkey"]').click();
  await keys(page, "ArrowDown", 3);
  await keys(page, "ArrowUp", 2);
  await expect(
    page.locator('.sidebar .nav-row[title="/repo/tree1"] .current-dot'),
  ).toBeVisible();
  await ready(page);
  await expect(page.locator(".tab-label")).toHaveText(["donkey"]);
  await expect(
    page.locator('.sidebar .nav-row[title="/repo/tree1"]'),
  ).toBeFocused();
  expect(await page.locator(".diff-controls").screenshot()).toEqual(controls);
  const audit = await finishAudit(page);
  expect(audit.frames).toBeGreaterThan(20);
  expect(audit.violations).toEqual([]);
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
  await testInfo.attach("navigation-frame-audit", {
    body: JSON.stringify(audit),
    contentType: "application/json",
  });
  await page.screenshot({ path: testInfo.outputPath("navigation.png") });
});

test("staged and unstaged file arrows change only the content and selection", async ({
  page,
}, testInfo) => {
  const { errors, writes } = await fixture(page);
  await ready(page);
  await auditChrome(
    page,
    chrome.filter((selector) => selector !== ".workspace-tabs"),
  );
  const controls = await page.locator(".diff-controls").screenshot();
  const unstaged = page
    .locator(".staging-section")
    .filter({ has: page.getByText("Unstaged", { exact: false }) })
    .first();
  await unstaged.locator('.tree-item-select[data-path="src/00.ts"]').click();
  await keys(page, "ArrowDown", 3);
  await keys(page, "ArrowUp", 2);
  await expect(page.locator(".diff-toolbar")).toContainText("src/01.ts");
  await ready(page);
  const staged = page.locator(".staging-section").nth(1);
  await staged.locator('.tree-item-select[data-path="src/04.ts"]').click();
  await keys(page, "ArrowDown", 3);
  await keys(page, "ArrowUp", 2);
  await expect(page.locator(".diff-toolbar")).toContainText("src/05.ts");
  await ready(page);
  expect(await page.locator(".diff-controls").screenshot()).toEqual(controls);
  const audit = await finishAudit(page);
  expect(audit.violations).toEqual([]);
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
  await testInfo.attach("staging-frame-audit", {
    body: JSON.stringify(audit),
    contentType: "application/json",
  });
});

test("ref and worktree arrows preserve File Tree mode and collapsed history", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "All Commits", exact: true }).click();
  await ready(page);
  await page
    .locator(".workspace-tabs")
    .getByRole("button", { name: "File Tree", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Collapse commit history", exact: true })
    .click();
  const treeMode = page
    .locator(".workspace-tabs")
    .getByRole("button", { name: "File Tree", exact: true });
  await auditChrome(
    page,
    chrome.filter((selector) => !selector.includes("Next change")),
  );
  await page.locator('.tree-item-select[data-path="src/00.ts"]').click();
  await keys(page, "ArrowDown", 6);
  await keys(page, "ArrowUp", 4);
  await expect(page.locator(".diff-toolbar")).toContainText("src/02.ts");
  await expect(page.locator(".diff-pane")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "v00", exact: true })
    .click();
  await keys(page, "ArrowDown", 3);
  await expect(treeMode).toHaveClass("selected");
  await expect(page.locator(".history")).toHaveCount(0);
  await page.locator('.sidebar .nav-row[title="/repo/donkey"]').click();
  await keys(page, "ArrowDown", 2);
  await expect(
    page.locator('.sidebar .nav-row[title="/repo/tree2"] .current-dot'),
  ).toBeVisible();
  await expect(treeMode).toHaveClass("selected");
  await expect(page.locator(".history")).toHaveCount(0);
  await expect(page.locator(".diff-pane")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  expect((await finishAudit(page)).violations).toEqual([]);
});

test("worktree arrows in Local Changes preserve the staging panes, form and isolated drafts", async ({
  page,
}, testInfo) => {
  const { errors, writes } = await fixture(page);
  await ready(page);
  await auditChrome(page, [
    ...chrome.filter((selector) => selector !== ".workspace-tabs"),
    ".staging-tree",
    ".staging-section header",
    ".commit-form",
    ".commit-form input",
  ]);
  await page.locator('.sidebar .nav-row[title="/repo/donkey"]').click();
  await keys(page, "ArrowDown", 3);
  await keys(page, "ArrowUp", 2);
  await expect(
    page.locator('.sidebar .nav-row[title="/repo/tree1"] .current-dot'),
  ).toBeVisible();
  await ready(page);
  await expect(page.locator(".history")).toHaveCount(0);
  await expect(page.locator(".staging-section")).toHaveCount(2);
  await expect(page.locator(".tab-label")).toHaveText(["donkey"]);
  await expect(
    page.locator('.sidebar .nav-row[title="/repo/tree1"]'),
  ).toBeFocused();
  const audit = await finishAudit(page);
  expect(audit.violations).toEqual([]);
  await page
    .getByRole("textbox", { name: "Commit subject", exact: true })
    .fill("tree one draft");
  await page.locator('.sidebar .nav-row[title="/repo/tree1"]').click();
  await keys(page, "ArrowDown", 1);
  await expect(
    page.locator('.sidebar .nav-row[title="/repo/tree2"] .current-dot'),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Commit subject", exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("textbox", { name: "Commit subject", exact: true })
    .fill("tree two draft");
  await page.locator('.sidebar .nav-row[title="/repo/tree2"]').click();
  await keys(page, "ArrowUp", 1);
  await expect(
    page.locator('.sidebar .nav-row[title="/repo/tree1"] .current-dot'),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Commit subject", exact: true }),
  ).toHaveValue("tree one draft");
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
  await testInfo.attach("local-worktree-frame-audit", {
    body: JSON.stringify(audit),
    contentType: "application/json",
  });
});

test("unstaging all files gives the viewer its full height and preserves the commit draft", async ({
  page,
}) => {
  await fixture(page);
  await ready(page);
  let staged = true;
  const endpoint = `http://127.0.0.1:43127/projects/${projects[0].id}`;
  const headers = { "Access-Control-Allow-Origin": "*" };
  await page.route(endpoint, (route) =>
    route.fulfill({
      headers,
      json: {
        ...snapshot(0),
        files: files.map((file) => ({ ...file, staged, unstaged: !staged })),
      },
    }),
  );
  await page.route(`${endpoint}/action`, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    staged = route.request().postDataJSON().action === "stage";
    await route.fulfill({ headers, json: { message: "Done" } });
  });
  const subject = page.getByRole("textbox", {
    name: "Commit subject",
    exact: true,
  });
  await subject.fill("Keep this draft");
  const before = await page.locator(".diff-content").boundingBox();
  await page.getByRole("button", { name: "Unstage all", exact: true }).click();
  await expect(page.locator(".commit-form")).toHaveCount(0);
  const after = await page.locator(".diff-content").boundingBox();
  expect(after!.height).toBeGreaterThan(before!.height);
  await ready(page);
  // The code's outer padding must blend with its lines, rather than make a footer strip.
  const surfaces = await page.locator("diffs-container").evaluate((host) => {
    const root = host.shadowRoot!;
    return ["[data-code]", "[data-content]"].map(
      (selector) =>
        getComputedStyle(root.querySelector(selector)!).backgroundColor,
    );
  });
  expect(surfaces[0]).toEqual(surfaces[1]);
  await page.getByRole("button", { name: "Stage all", exact: true }).click();
  await expect(subject).toHaveValue("Keep this draft");
});

test("file endings can scroll near the top in diff and whole-file views", async ({
  page,
}, testInfo) => {
  await fixture(page);
  await ready(page);
  await expect
    .poll(() =>
      page.locator("diffs-container").evaluate((host) => {
        const comments = [
          ...host.shadowRoot!.querySelectorAll("[data-line] span"),
        ].filter((node) => node.textContent === " // Keep this readable");
        return (
          comments.length >= 2 &&
          comments.every(
            (node) => getComputedStyle(node).color === "rgb(201, 205, 209)",
          )
        );
      }),
    )
    .toBe(true);
  await testInfo.attach("diff-colors", {
    body: await page.locator(".diff-pane").screenshot(),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "Full file", exact: true }).click();
  const checkEnd = async () => {
    const viewer = page.locator(".diff-content");
    await viewer.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect
      .poll(async () => {
        await viewer.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        return viewer.evaluate((node) => {
          const lastLine = node
            .querySelector("diffs-container")
            ?.shadowRoot?.querySelector('[data-line="400"]');
          if (!lastLine) return -1;
          const top =
            lastLine.getBoundingClientRect().top -
            node.getBoundingClientRect().top;
          return top >= 0 && top < 80 ? 1 : 0;
        });
      })
      .toBe(1);
  };
  await checkEnd();
  await page
    .getByRole("button", { name: "Toggle split diff", exact: true })
    .click();
  await checkEnd();
  await page.setViewportSize({ width: 1440, height: 750 });
  await checkEnd();
  await page.getByRole("button", { name: "All Commits", exact: true }).click();
  await page
    .locator(".workspace-tabs")
    .getByRole("button", { name: "File Tree", exact: true })
    .click();
  await expect(page.locator(".diff-pane")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await checkEnd();
});

test("switching files starts at the top in diff and whole-file views", async ({
  page,
}) => {
  await fixture(page);
  await ready(page);
  await page.getByRole("button", { name: "Full file", exact: true }).click();
  const viewer = page.locator(".diff-content");
  const waitForFile = async () => {
    await expect(page.locator(".diff-pane")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(page.locator(".diff-content .empty")).toHaveCount(0);
    await expect(page.locator("diffs-container")).toBeVisible();
  };
  const switchFiles = async () => {
    for (const path of ["src/01.ts", "src/00.ts"]) {
      await viewer.evaluate((node) => {
        node.scrollTop = 1500;
      });
      await expect
        .poll(() => viewer.evaluate((node) => node.scrollTop))
        .toBeGreaterThan(0);
      await page.locator(`.tree-item-select[data-path="${path}"]`).click();
      await expect(page.locator(".diff-toolbar")).toContainText(path);
      await waitForFile();
      await expect
        .poll(() => viewer.evaluate((node) => node.scrollTop))
        .toBe(0);
    }
  };
  await switchFiles();
  await page.getByRole("button", { name: "All Commits", exact: true }).click();
  await page
    .locator(".workspace-tabs")
    .getByRole("button", { name: "File Tree", exact: true })
    .click();
  await waitForFile();
  await switchFiles();
});

test("plain dividers resize from both ends of each panel boundary", async ({
  page,
}) => {
  await fixture(page);
  await ready(page);
  const dragDivider = async (name: string) => {
    const divider = page.getByRole("separator", { name, exact: true });
    await expect(divider.locator("svg, div")).toHaveCount(0);
    const horizontal =
      (await divider.getAttribute("aria-orientation")) === "horizontal";
    for (const [fraction, delta] of [
      [0.1, 30],
      [0.9, -30],
    ]) {
      await page.mouse.move(0, 0);
      const box = (await divider.boundingBox())!;
      const before = await divider.getAttribute("aria-valuenow");
      const rest = await divider.evaluate(
        (node) => getComputedStyle(node).backgroundColor,
      );
      const x = box.x + (horizontal ? box.width * fraction : box.width / 2 + 2);
      const y =
        box.y + (horizontal ? box.height / 2 + 2 : box.height * fraction);
      await page.mouse.move(x, y);
      await expect
        .poll(() =>
          divider.evaluate((node) => getComputedStyle(node).backgroundColor),
        )
        .not.toBe(rest);
      await page.mouse.down();
      await page.mouse.move(
        x + (horizontal ? 0 : delta),
        y + (horizontal ? delta : 0),
        { steps: 5 },
      );
      await page.mouse.up();
      await expect(divider).not.toHaveAttribute("aria-valuenow", before!);
      const after = (await divider.boundingBox())!;
      expect(horizontal ? after.height : after.width).toBe(1);
    }
  };
  await dragDivider("Resize repository sidebar");
  await dragDivider("Resize file tree");
  await dragDivider("Resize staged files");
  await page.getByRole("button", { name: "All Commits", exact: true }).click();
  await ready(page);
  await dragDivider("Resize commit history");
});

test("rapid arrows through newly discovered worktrees honor the last selection", async ({
  page,
}) => {
  const { errors, writes } = await fixture(page, true);
  await ready(page);
  await auditChrome(
    page,
    chrome.filter((selector) => selector !== ".workspace-tabs"),
  );
  const earlierResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.request().postDataJSON().path === "/repo/tree1",
  );
  await page.locator('.sidebar .nav-row[title="/repo/donkey"]').click();
  await keys(page, "ArrowDown", 3);
  await expect(
    page.locator('.sidebar .nav-row[title="/repo/tree3"] .current-dot'),
  ).toBeVisible();
  await earlierResponse;
  await ready(page);
  await expect(
    page.locator('.sidebar .nav-row[title="/repo/tree3"] .current-dot'),
  ).toBeVisible();
  await expect(
    page.locator('.sidebar .nav-row[title="/repo/tree3"]'),
  ).toBeFocused();
  await expect(page.locator(".tab-label")).toHaveText(["donkey"]);
  expect((await finishAudit(page)).violations).toEqual([]);
  expect(writes).toEqual(["/projects", "/projects", "/projects"]);
  expect(errors).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("file viewing errors disappear when cycling to another file", async ({
  page,
}) => {
  await fixture(page);
  await ready(page);
  await page.route("**/projects/*/file?**", async (route) => {
    const name = new URL(route.request().url()).searchParams.get("path")!;
    await route.fulfill({
      status: name === "src/01.ts" ? 400 : 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      json:
        name === "src/01.ts"
          ? { error: "File exceeds the 5 MB viewing limit" }
          : {
              path: name,
              old: "before\n",
              current: "after\n",
              binary: false,
              conflict: false,
            },
    });
  });
  await page.locator('.tree-item-select[data-path="src/00.ts"]').click();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("alert")).toContainText("5 MB viewing limit");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".diff-toolbar")).toContainText("src/02.ts");
});

test("fast file arrows cancel stale reads and display the final file without waiting for them", async ({
  page,
}) => {
  const { errors } = await fixture(page);
  await ready(page);
  const reads: string[] = [];
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  await page.route("**/projects/*/file?**", async (route) => {
    const name = new URL(route.request().url()).searchParams.get("path")!;
    reads.push(name);
    if (name === "src/01.ts") await slow;
    await route.fulfill({
      headers: { "Access-Control-Allow-Origin": "*" },
      json: {
        path: name,
        old: "before\n",
        current: `selected_${name.replace(/\W/g, "_")}\n`,
        binary: false,
        conflict: false,
      },
    });
  });
  await page.locator('.tree-item-select[data-path="src/00.ts"]').click();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => reads.includes("src/01.ts")).toBe(true);
  await keys(page, "ArrowDown", 2);
  await expect(page.locator(".diff-toolbar")).toContainText("src/03.ts");
  await expect(page.locator("diffs-container")).toContainText(
    "selected_src_03_ts",
  );
  releaseSlow();
  await expect(page.locator("diffs-container")).toContainText(
    "selected_src_03_ts",
  );
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("diffs-container")).toContainText(
    "selected_src_02_ts",
  );
  // A revisit displays the cached final file even while its refresh is held.
  let releaseRefresh!: () => void;
  const refresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route("**/file?**", async (route) => {
    await refresh;
    await route.fallback();
  });
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("diffs-container")).toContainText(
    "selected_src_03_ts",
  );
  releaseRefresh();
  expect(errors).toEqual([]);
});

test("right-edge change markers jump to changes and hide in file mode", async ({
  page,
}) => {
  await fixture(page);
  await ready(page);
  await page.getByRole("button", { name: "Full file", exact: true }).click();
  const overview = page.getByRole("navigation", { name: "Changes in file" });
  const marker = overview.getByRole("button").first();
  await expect(marker).toBeVisible();
  await expect
    .poll(() => marker.evaluate((node) => parseFloat(node.style.top)))
    .toBeGreaterThan(40);
  await marker.click();
  await expect
    .poll(() =>
      page.locator(".diff-content").evaluate((node) => node.scrollTop),
    )
    .toBeGreaterThan(1000);
  await page
    .getByRole("button", { name: "Toggle split diff", exact: true })
    .click();
  await expect(marker).toBeVisible();
  await page.locator(".diff-content").evaluate((node) => {
    node.scrollTop = 0;
  });
  await marker.click();
  await expect
    .poll(() =>
      page.locator(".diff-content").evaluate((node) => node.scrollTop),
    )
    .toBeGreaterThan(1000);
  await page.getByRole("button", { name: "All Commits", exact: true }).click();
  await page
    .locator(".workspace-tabs")
    .getByRole("button", { name: "File Tree", exact: true })
    .click();
  await expect(overview).toHaveCount(0);
});

test("project tabs reorder by dragging like browser tabs", async ({ page }) => {
  const { errors } = await fixture(page, false, false, projects.slice(0, 3));
  const tabs = page.locator(".project-tab");
  const labels = page.locator(".project-tab .tab-select");
  const names = () =>
    labels.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  expect(await names()).toEqual(["donkey", "tree1", "tree2"]);

  const first = (await tabs.nth(0).boundingBox())!;
  const third = (await tabs.nth(2).boundingBox())!;
  await page.mouse.move(first.x + 20, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + third.width / 2 + 20, first.y + 12, {
    steps: 12,
  });
  // Neighbors slide left out of the dragged tab's way while it is held.
  await page.waitForTimeout(200);
  const held = (await tabs.nth(1).boundingBox())!;
  expect(held.x).toBeLessThan(first.x + 10);
  await page.screenshot({ path: "test-results/tab-drag.png" });
  await page.mouse.up();

  await expect.poll(names).toEqual(["tree1", "tree2", "donkey"]);
  await expect(page.locator(".project-heading")).toHaveText("donkey");
  expect(
    await page.evaluate(() => localStorage.getItem("donkey-diff-tabs")),
  ).toBe(
    JSON.stringify([projects[1], projects[2], projects[0]].map((p) => p.id)),
  );
  expect(await tabs.nth(2).evaluate((el) => el.style.transform)).toBe("");

  // A plain click still just selects, without reordering.
  await labels.nth(0).click();
  await expect(page.locator(".project-heading")).toHaveText("tree1");
  expect(await names()).toEqual(["tree1", "tree2", "donkey"]);
  expect(errors).toEqual([]);
});
