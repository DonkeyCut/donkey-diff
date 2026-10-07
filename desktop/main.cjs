const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  utilityProcess,
  Menu,
  clipboard,
} = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { randomBytes } = require("node:crypto");
const { createTelemetry } = require("./telemetry.cjs");
const { resolveProjectFile } = require("./file-actions.cjs");
const { registerClipboardHandler } = require("./clipboard.cjs");
const { appEnvironment } = require("./environment.cjs");
const environment = appEnvironment({
  isPackaged: app.isPackaged,
  channel: require("../package.json").donkeyDiffChannel,
  appData: app.getPath("appData"),
});
app.setName(environment.name);
// Set this before the instance lock or Chromium session is initialized.
app.setPath("userData", environment.userData);
app.setAppUserModelId(environment.appId);
let bridgeProcess;
let window;
let token;
let activeMutations = 0;
let fileRead;
let manualUpdateCheck = false;
let showUpdateResult = () => {};
const { createUpdater } = require("./updater.cjs");
const updater = createUpdater({
  currentVersion: app.getVersion(),
  supported: process.platform === "darwin" && environment.productionServices,
  nativePath: path.join(process.resourcesPath, "sparkle.node"),
  publish: (state) => {
    if (window && !window.isDestroyed())
      window.webContents.send("update-state", state);
    const menuItem =
      Menu.getApplicationMenu()?.getMenuItemById("check-for-updates");
    if (menuItem)
      menuItem.enabled = !["checking", "installing"].includes(state.status);
    showUpdateResult(state);
  },
});
const port = environment.port;
const entry = path.join(__dirname, "../dist/index.html");
const entryUrl = pathToFileURL(entry).href;
const ownedFrame = (event) => {
  if (event.senderFrame?.url.split("#")[0] !== entryUrl)
    throw new Error("Untrusted window");
};
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      if (process.platform === "darwin" && environment.development)
        app.dock.setIcon(path.join(__dirname, "assets", environment.icon));
      const dataDir = path.join(app.getPath("userData"), "local-git");
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const tokenPath = path.join(dataDir, "token");
      try {
        token = (await readFile(tokenPath, "utf8")).trim();
      } catch {
        token = randomBytes(32).toString("hex");
        await writeFile(tokenPath, token, { mode: 0o600 });
      }
      bridgeProcess = utilityProcess.fork(
        path.join(__dirname, "../build/bridge.mjs"),
        [],
        {
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}:/usr/bin:/bin:/usr/sbin:/sbin`,
            DONKEY_DIFF_PORT: String(port),
            DONKEY_DIFF_DATA_DIR: dataDir,
            DONKEY_DIFF_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
          },
          stdio: "pipe",
          serviceName: `${environment.name} Git service`,
        },
      );
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                "The local Git service could not start. Please quit and reopen Donkey Diff.",
              ),
            ),
          15000,
        );
        let output = "";
        bridgeProcess.stdout.on("data", (chunk) => {
          output += chunk.toString();
          if (output.includes("listening")) {
            clearTimeout(timeout);
            resolve();
          }
        });
        bridgeProcess.stderr.on("data", (chunk) => process.stderr.write(chunk));
        bridgeProcess.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`Git service stopped (${code}).`));
        });
      });
      const telemetry = await createTelemetry({
        dataDir: app.getPath("userData"),
        resourcesPath: process.resourcesPath,
        version: app.getVersion(),
        packaged: environment.productionServices,
      });
      ipcMain.handle("git-request", async (event, route, method, body) => {
        ownedFrame(event);
        if (
          typeof route !== "string" ||
          !/^\/projects(?:\/[a-f0-9]{16}(?:\/(?:files|tree|file|action|navigation|history|chat(?:\/(?:providers|send|stop))?))?)?(?:\?.*)?$/.test(
            route,
          ) ||
          !["GET", "POST", "DELETE"].includes(method)
        )
          throw new Error("Invalid request");
        if (method !== "GET" && updater.getState().status === "installing") {
          return {
            ok: false,
            error:
              "An app update is installing. Try again after Donkey Diff restarts.",
          };
        }
        const readingFile =
          method === "GET" && /^\/projects\/[a-f0-9]{16}\/file\?/.test(route);
        const controller = readingFile ? new AbortController() : undefined;
        if (controller) {
          fileRead?.abort();
          fileRead = controller;
        }
        if (method !== "GET") activeMutations++;
        try {
          const response = await fetch(`http://127.0.0.1:${port}${route}`, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller
              ? AbortSignal.any([controller.signal, AbortSignal.timeout(70000)])
              : AbortSignal.timeout(70000),
          });
          const result = await response.json();
          if (
            response.ok &&
            method === "POST" &&
            route.split("?")[0] === "/projects"
          )
            void telemetry.capture("project_added");
          if (response.ok && method === "DELETE")
            void telemetry.capture("project_removed");
          return response.ok
            ? { ok: true, data: result }
            : { ok: false, error: result.error || "Git operation failed" };
        } catch {
          return {
            ok: false,
            error:
              "The Git service is unavailable. Quit and reopen Donkey Diff, then try again.",
          };
        } finally {
          if (fileRead === controller) fileRead = undefined;
          if (method !== "GET") activeMutations--;
        }
      });
      ipcMain.handle("update-state", (event) => {
        ownedFrame(event);
        return updater.getState();
      });
      registerClipboardHandler({ ipcMain, clipboard, ownedFrame });
      ipcMain.handle(
        "file-action",
        async (event, projectId, relativePath, action) => {
          ownedFrame(event);
          if (!["open", "reveal"].includes(action))
            throw new Error("Invalid file action");
          const response = await fetch(`http://127.0.0.1:${port}/projects`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw new Error("Could not load projects");
          const target = await resolveProjectFile(
            await response.json(),
            projectId,
            relativePath,
          );
          if (action === "reveal") shell.showItemInFolder(target);
          else {
            const error = await shell.openPath(target);
            if (error) throw new Error(error);
          }
        },
      );
      const activateUpdate = async () => {
        const chatStatus = await fetch(`http://127.0.0.1:${port}/chat-status`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        }).then((response) => {
          if (!response.ok) throw new Error("Could not check active chats");
          return response.json();
        });
        if (activeMutations || chatStatus.running)
          throw new Error(
            "Wait for the current Git operation or chat to finish before updating.",
          );
        void telemetry.capture("update_requested");
        return updater.activate();
      };
      ipcMain.handle("update-action", async (event) => {
        ownedFrame(event);
        return activateUpdate();
      });
      showUpdateResult = (state) => {
        if (
          !manualUpdateCheck ||
          ["notChecked", "checking", "installing"].includes(state.status)
        )
          return;
        manualUpdateCheck = false;
        const available = state.status === "available";
        const options = {
          type: available || state.status === "upToDate" ? "info" : "warning",
          title: "Check for Updates",
          message: available
            ? `${environment.name} ${state.latestVersion} is available.`
            : state.status === "upToDate"
              ? `${environment.name} is up to date.`
              : "Could not check for updates.",
          detail:
            state.status === "upToDate"
              ? `You’re running version ${state.currentVersion}.`
              : state.message ||
                "Install the update and restart to use the latest version.",
          buttons: available ? ["Install and Restart", "Not Now"] : ["OK"],
          defaultId: 0,
          cancelId: available ? 1 : 0,
        };
        const result =
          window && !window.isDestroyed()
            ? dialog.showMessageBox(window, options)
            : dialog.showMessageBox(options);
        void result
          .then(({ response }) => {
            if (available && response === 0) return activateUpdate();
          })
          .catch((error) =>
            dialog.showErrorBox("Could not update Donkey Diff", error.message),
          );
      };

      ipcMain.handle("choose-project", async (event) => {
        ownedFrame(event);
        const result = await dialog.showOpenDialog(window, {
          title: "Open a project",
          buttonLabel: "Open project",
          properties: ["openDirectory", "createDirectory"],
        });
        return result.canceled ? null : result.filePaths[0];
      });
      const createWindow = () => {
        window = new BrowserWindow({
          width: 1440,
          height: 920,
          minWidth: 700,
          minHeight: 500,
          title: environment.name,
          icon: path.join(__dirname, "assets", environment.icon),
          ...(process.platform === "darwin"
            ? {
                titleBarStyle: "hidden",
                trafficLightPosition: { x: 12, y: 12 },
              }
            : {}),
          backgroundColor: "#0a0a0a",
          webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            additionalArguments: environment.development
              ? ["--donkey-diff-dev"]
              : [],
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        window.on("page-title-updated", (event) => {
          event.preventDefault();
          window.setTitle(environment.name);
        });
        window.webContents.setWindowOpenHandler(({ url }) => {
          if (url.startsWith("https://github.com/DonkeyCut/donkey-diff"))
            shell.openExternal(url);
          return { action: "deny" };
        });
        window.webContents.on("will-navigate", (event, url) => {
          if (url.split("#")[0] !== entryUrl) event.preventDefault();
        });
        window.webContents.session.setPermissionRequestHandler(
          (_webContents, _permission, callback) => callback(false),
        );
        window.loadFile(entry);
      };
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: environment.name,
            submenu: [
              { role: "about" },
              {
                id: "check-for-updates",
                label: "Check for Updates…",
                click: () => {
                  manualUpdateCheck = true;
                  showUpdateResult(updater.check());
                },
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          {
            label: "File",
            submenu: [
              {
                label: "Open Project…",
                accelerator: "CmdOrCtrl+O",
                click: () => window?.webContents.send("open-project"),
              },
            ],
          },
          {
            label: "Privacy",
            submenu: [
              {
                label: "Send Anonymous Usage Statistics",
                type: "checkbox",
                checked: telemetry.isEnabled(),
                click: (item) => {
                  void telemetry.setEnabled(item.checked).catch(() => {
                    item.checked = telemetry.isEnabled();
                    dialog.showErrorBox(
                      "Could not save preference",
                      "Your usage preference could not be saved. Check that Donkey Diff can write its application data.",
                    );
                  });
                },
              },
            ],
          },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ]),
      );
      createWindow();
      void telemetry.capture("app_opened");
      updater.start();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((error) => {
      dialog.showErrorBox("Donkey Diff could not open", error.message);
      app.quit();
    });
  app.on("before-quit", () => bridgeProcess?.kill());
  app.on("window-all-closed", () => app.quit());
}
