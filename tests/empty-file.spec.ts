import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { changedFiles, fileContent, git } from "../bridge/git";
import type { FileContent } from "../src/types";

let server: ViteDevServer;
let origin: string;
let repo: string;

test.beforeAll(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), "donkey-empty-file-"));
  await git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "new.md"), "");
  server = await createServer({
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0];
});
test.afterAll(async () => {
  await server?.close();
  await rm(repo, { recursive: true, force: true });
});

test("empty added files explain the blank preview and display later additions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const [added] = await changedFiles(repo);
  expect(added.status).toBe("A");
  expect(added.staged).toBe(false);
  expect(added.additions).toBe(0);
  const empty = await fileContent(
    repo,
    "new.md",
    undefined,
    undefined,
    "unstaged",
  );
  await page.route("**/empty-file-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><div id="root" style="height:100vh;display:flex"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { DiffPane } = await import('/src/components/DiffPane.tsx');
      await import('/src/styles.css');
      function Fixture({ content, fileMode }) {
        const [full, setFull] = React.useState(false);
        const [split, setSplit] = React.useState(true);
        return React.createElement(DiffPane, {
          content, fileMode, loading: false, full, split, setFull, setSplit,
          onResolve: () => {}
        });
      }
      const root = ReactDOM.createRoot(document.getElementById('root'));
      window.renderContent = (content, fileMode) => root.render(React.createElement(Fixture, { content, fileMode }));
      window.renderContent(${JSON.stringify(empty)}, false);
    </script></body></html>`,
    }),
  );
  await page.goto(`${origin}empty-file-test`);
  const message = page.getByRole("heading", { name: "Empty file" });
  await expect(message).toBeVisible();
  await expect(page.getByText("This file has no content.")).toBeVisible();
  await page.getByRole("button", { name: "Full file", exact: true }).click();
  await page
    .getByRole("button", { name: "Toggle split diff", exact: true })
    .click();
  await expect(message).toBeVisible();
  const render = async (content: FileContent, fileMode = false) => {
    await page.evaluate(
      ({ content, fileMode }) => {
        (
          window as unknown as {
            renderContent: (content: FileContent, fileMode: boolean) => void;
          }
        ).renderContent(content, fileMode);
      },
      { content, fileMode },
    );
  };
  await writeFile(path.join(repo, "new.md"), "# Newly added content\n");
  await render(
    await fileContent(repo, "new.md", undefined, undefined, "unstaged"),
  );
  await expect(page.locator("diffs-container")).toContainText(
    "Newly added content",
  );
  await expect(
    page.getByRole("button", { name: "Next change", exact: true }),
  ).toBeEnabled();
  await render(empty);
  await expect(message).toBeVisible();
  await expect(page.locator("diffs-container")).toHaveCount(0);
  for (const name of ["Next change", "Previous change"])
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await render(empty, true);
  await expect(message).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(message).toBeVisible();
  expect(errors).toEqual([]);
});
