import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { fileContent, git } from "../bridge/git";
import type { FileContent } from "../src/types";

let server: ViteDevServer;
// Enough unchanged lines that Git still detects the rename after an edit.
const source = (steps: number) =>
  `let steps = ${steps}\n${Array.from({ length: 8 }, (_, i) => `let line${i} = ${i}\n`).join("")}`;
let origin: string;
let repo: string;

test.beforeAll(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), "donkey-rename-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "tests@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await writeFile(path.join(repo, "Old.swift"), source(1));
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "Initial"]);
  await git(repo, ["mv", "Old.swift", "PhoneSteps.swift"]);
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

test("pure renames show the source path and file text instead of a blank diff", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const renamed = await fileContent(
    repo,
    "PhoneSteps.swift",
    undefined,
    undefined,
    "staged",
  );
  expect(renamed.oldPath).toBe("Old.swift");
  await page.route("**/rename-test", (route) =>
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
      function Fixture({ content }) {
        const [full, setFull] = React.useState(false);
        const [split, setSplit] = React.useState(true);
        return React.createElement(DiffPane, {
          content, fileMode: false, loading: false, full, split, setFull, setSplit,
          onResolve: () => {}
        });
      }
      const root = ReactDOM.createRoot(document.getElementById('root'));
      window.renderContent = (content) => root.render(React.createElement(Fixture, { content }));
      window.renderContent(${JSON.stringify(renamed)});
    </script></body></html>`,
    }),
  );
  await page.goto(`${origin}rename-test`);
  const banner = page.getByRole("note");
  await expect(banner).toContainText("Renamed from Old.swift");
  await expect(banner).toContainText("No content changes");
  await expect(page.locator("diffs-container")).toContainText("let steps = 1");
  for (const name of ["Next change", "Previous change"])
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeDisabled();

  await writeFile(path.join(repo, "PhoneSteps.swift"), source(2));
  await git(repo, ["add", "PhoneSteps.swift"]);
  const edited = await fileContent(
    repo,
    "PhoneSteps.swift",
    undefined,
    undefined,
    "staged",
  );
  await page.evaluate((content) => {
    (
      window as unknown as { renderContent: (content: FileContent) => void }
    ).renderContent(content);
  }, edited);
  await expect(banner).toContainText("Renamed from Old.swift");
  await expect(banner).not.toContainText("No content changes");
  await expect(
    page.getByRole("button", { name: "Next change", exact: true }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});
