import {
  _electron as electron,
  expect,
  test,
  type Page,
} from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

async function fixture(
  page: Page,
  mode: "desktop" | "browser" | "native" = "desktop",
) {
  await page.route("**/staging-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => (type) => type;
        window.__vite_plugin_react_preamble_installed__ = true;
        const { default: React } = await import('/node_modules/.vite/deps/react.js');
        const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
        const { StagingTree } = await import('/src/components/StagingTree.tsx');
        await import('/src/styles.css');
        const h = React.createElement;
        const record = value => {
          document.getElementById('calls').textContent = JSON.stringify(value);
        };
        ${
          mode === "desktop"
            ? `
          window.donkeyDiffDesktop = {
            fileAction: async (projectId, path, action) => record({ projectId, path, action }),
            writeClipboardText: async text => record({ text }),
          };
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
            writeText: async () => { throw new Error('Browser clipboard permission denied'); },
          } });
        `
            : ""
        }
        function Fixture() {
          const [selected, setSelected] = React.useState('src/a file.ts');
          const [layer, setLayer] = React.useState('unstaged');
          const [busy, setBusy] = React.useState(false);
          const [loading, setLoading] = React.useState(false);
          const [error, setError] = React.useState('');
          return h('div', null,
            h('output', { id: 'calls', 'aria-label': 'Calls' }),
            h('output', { 'aria-label': 'Error' }, error),
            h('button', { onClick: () => setBusy(value => !value) }, 'Toggle busy'),
            h('button', { onClick: () => setLoading(value => !value) }, 'Toggle loading'),
            h('div', { style: { width: 350, height: 500, display: 'flex', flexDirection: 'column' } }, h(StagingTree, {
              projectId: 'repository', projectPath: '/repo/with spaces/', treeStateId: 'menu-test',
              selected, layer, busy, loading, filter: '', onError: setError,
              files: [
                { path: 'src/a file.ts', status: 'M', staged: false, unstaged: true },
                { path: 'src/日本語.ts', status: 'M', staged: false, unstaged: true },
                { path: 'staged/b.ts', status: 'M', staged: true, unstaged: false },
              ],
              onSelect: (path, layer) => { setSelected(path); setLayer(layer); },
              onStage: (path, layer) => record({ path, layer }),
            })));
        }
        ReactDOM.createRoot(document.getElementById('root')).render(h(Fixture));
      </script></body></html>`,
    }),
  );
  await page.goto(`${origin}staging-test`);
  await expect(page.getByRole("tree").first()).toBeVisible();
}

async function choose(page: Page, file: string, label: string) {
  await page.getByTitle(file, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}

for (const layer of ["unstaged", "staged"] as const) {
  test(`all ${layer} file and folder menu items dispatch the correct action`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await fixture(page);
    const verb = layer === "staged" ? "Unstage" : "Stage";
    for (const file of layer === "staged"
      ? ["staged/b.ts", "staged"]
      : ["src/a file.ts", "src"]) {
      for (const action of ["open", "reveal"] as const) {
        await choose(page, file, action === "open" ? "Open" : "Show in Finder");
        await expect(page.getByLabel("Calls", { exact: true })).toHaveText(
          JSON.stringify({ projectId: "repository", path: file, action }),
        );
      }
      await choose(page, file, verb);
      await expect(page.getByLabel("Calls", { exact: true })).toHaveText(
        JSON.stringify({ path: file, layer }),
      );
      await choose(page, file, `${verb} all`);
      await expect(page.getByLabel("Calls", { exact: true })).toHaveText(
        JSON.stringify({ path: ".", layer }),
      );
      await choose(page, file, "Copy Path");
      await expect(page.getByLabel("Calls", { exact: true })).toHaveText(
        JSON.stringify({ text: `/repo/with spaces/${file}` }),
      );
      await choose(page, file, "Copy Relative Path");
      await expect(page.getByLabel("Calls", { exact: true })).toHaveText(
        JSON.stringify({ text: file }),
      );
    }
    await expect(page.getByLabel("Error", { exact: true })).toBeEmpty();
    expect(errors).toEqual([]);
  });
}

test("keyboard activation copies unicode paths using the desktop bridge", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByTitle("src/日本語.ts", { exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Copy Relative Path", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Calls", { exact: true })).toHaveText(
    JSON.stringify({ text: "src/日本語.ts" }),
  );
  await expect(page.getByRole("menu")).toHaveCount(0);
});

for (const state of ["busy", "loading"]) {
  test(`staging actions are disabled while ${state} and copying remains available`, async ({
    page,
  }) => {
    await fixture(page);
    await page
      .getByRole("button", { name: `Toggle ${state}`, exact: true })
      .click();
    for (const [file, verb] of [
      ["src/a file.ts", "Stage"],
      ["staged/b.ts", "Unstage"],
    ]) {
      await page.getByTitle(file, { exact: true }).click({ button: "right" });
      await expect(
        page.getByRole("menuitem", { name: verb, exact: true }),
      ).toHaveAttribute("data-disabled", "");
      await expect(
        page.getByRole("menuitem", { name: `${verb} all`, exact: true }),
      ).toHaveAttribute("data-disabled", "");
      await page
        .getByRole("menuitem", { name: "Copy Relative Path", exact: true })
        .click();
      await expect(page.getByLabel("Calls", { exact: true })).toHaveText(
        JSON.stringify({ text: file }),
      );
    }
  });
}

test("clipboard and file action failures reach the visible error handler", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    window.donkeyDiffDesktop!.writeClipboardText = async () => {
      throw new Error("Clipboard unavailable");
    };
    window.donkeyDiffDesktop!.fileAction = async () => {
      throw new Error("File unavailable");
    };
  });
  await choose(page, "src/a file.ts", "Copy Path");
  await expect(page.getByLabel("Error", { exact: true })).toHaveText(
    "Clipboard unavailable",
  );
  await choose(page, "src/a file.ts", "Open");
  await expect(page.getByLabel("Error", { exact: true })).toHaveText(
    "File unavailable",
  );
  await choose(page, "src/a file.ts", "Show in Finder");
  await expect(page.getByLabel("Error", { exact: true })).toHaveText(
    "File unavailable",
  );
});

test("browser menu copies both paths and reports an unavailable clipboard", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await fixture(page, "browser");
  await page
    .getByTitle("src/a file.ts", { exact: true })
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Open", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  for (const label of ["Copy Path", "Copy Relative Path"]) {
    await choose(page, "src/a file.ts", label);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      label === "Copy Path"
        ? "/repo/with spaces/src/a file.ts"
        : "src/a file.ts",
    );
  }
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", { value: undefined }),
  );
  await choose(page, "src/a file.ts", "Copy Relative Path");
  await expect(page.getByLabel("Error", { exact: true })).toHaveText(
    "Clipboard access is unavailable in this browser.",
  );
});

test("real Electron preload copies paths despite denied browser clipboard permissions", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "donkey-diff-clipboard-"),
  );
  const entry = path.join(directory, "main.cjs");
  await writeFile(
    entry,
    `
    const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
    const { registerClipboardHandler } = require(${JSON.stringify(path.resolve("desktop/clipboard.cjs"))});
    app.setPath('userData', ${JSON.stringify(directory)});
    let window;
    app.whenReady().then(async () => {
      registerClipboardHandler({ ipcMain, clipboard, ownedFrame: event => {
        if (event.senderFrame.url !== ${JSON.stringify(`${origin}staging-test`)}) throw new Error('Untrusted window');
      } });
      window = new BrowserWindow({ show: false, webPreferences: {
        preload: ${JSON.stringify(path.resolve("desktop/preload.cjs"))}, contextIsolation: true, sandbox: true, nodeIntegration: false,
      } });
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      await window.loadURL('about:blank');
    });
  `,
  );
  const app = await electron.launch({ args: [entry] });
  const originalText = await app.evaluate(
    async ({ clipboard }) => await clipboard.readText(),
  );
  try {
    const page = await app.firstWindow();
    await fixture(page, "native");
    expect(
      await page.evaluate(async () => {
        try {
          await navigator.clipboard.writeText("browser attempt");
          return "allowed";
        } catch {
          return "denied";
        }
      }),
    ).toBe("denied");
    for (const label of ["Copy Path", "Copy Relative Path"]) {
      await choose(page, "src/日本語.ts", label);
      await expect
        .poll(() =>
          app.evaluate(async ({ clipboard }) => await clipboard.readText()),
        )
        .toBe(
          label === "Copy Path"
            ? "/repo/with spaces/src/日本語.ts"
            : "src/日本語.ts",
        );
    }
    await expect(page.getByLabel("Error", { exact: true })).toBeEmpty();
  } finally {
    await app.evaluate(
      async ({ clipboard }, text) => await clipboard.writeText(text),
      originalText,
    );
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
