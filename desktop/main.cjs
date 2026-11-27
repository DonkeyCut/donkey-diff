const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  utilityProcess,
  Menu,
  clipboard,
  Tray,
  Notification,
  nativeImage,
  nativeTheme,
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
let tray;
let autopilot = { running: 0, attention: 0, recent: [] };
let openWindow = () => {};
const autopilotStatusLabel = () =>
  autopilot.attention
    ? `Autopilot: ${autopilot.attention} need${autopilot.attention === 1 ? "s" : ""} you`
    : autopilot.running
      ? "Autopilot: working…"
      : "Autopilot: idle";
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
  app.on("second-instance", () => openWindow());
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
        let listening = false;
        bridgeProcess.stdout.on("data", (chunk) => {
          output += chunk.toString();
          const lines = output.split("\n");
          output = lines.pop();
          for (const line of lines) {
            // Autopilot reports status and notifications as tagged JSON lines.
            if (line.startsWith("@@autopilot ")) {
              try {
                handleAutopilotEvent(JSON.parse(line.slice(12)));
              } catch {
                /* Ignore a malformed event rather than stop the app. */
              }
            } else if (!listening && line.includes("listening")) {
              listening = true;
              clearTimeout(timeout);
              resolve();
            } else if (line) process.stdout.write(line + "\n");
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
          !(
            /^\/projects(?:\/[a-f0-9]{16}(?:\/(?:files|tree|file|action|navigation|history|chat(?:\/(?:providers|send|stop))?|autopilot(?:\/(?:config|run|teach|memory|jobs\/[a-f0-9-]{36}(?:\/(?:seen|stop))?))?))?)?(?:\?.*)?$/.test(
              route,
            ) || route === "/autopilot"
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
            "Wait for the current Git operation, chat or Autopilot job to finish before updating.",
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
      ipcMain.handle("login-item", (event, enabled) => {
        ownedFrame(event);
        if (typeof enabled === "boolean")
          app.setLoginItemSettings({ openAtLogin: enabled });
        return app.getLoginItemSettings().openAtLogin;
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
          if (
            url.startsWith("https://github.com/DonkeyCut/donkey-diff") ||
            /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/.test(
              url,
            )
          )
            shell.openExternal(url);
          return { action: "deny" };
        });
        window.webContents.on("will-navigate", (event, url) => {
          if (url.split("#")[0] !== entryUrl) event.preventDefault();
        });
        window.webContents.session.setPermissionRequestHandler(
          (_webContents, _permission, callback) => callback(false),
        );
        window.on("closed", () => {
          window = undefined;
        });
        window.loadFile(entry);
      };
      openWindow = (autopilotTarget) => {
        if (!window || window.isDestroyed()) createWindow();
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        if (!autopilotTarget) return;
        const send = () =>
          window?.webContents.send("open-autopilot", autopilotTarget);
        if (window.webContents.isLoading())
          window.webContents.once("did-finish-load", send);
        else send();
      };
      tray = new Tray(trayImage());
      nativeTheme.on("updated", updateTray);
      updateTray();
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
      // Opened at login, the app starts quietly in the menu bar.
      if (!app.getLoginItemSettings().wasOpenedAtLogin) createWindow();
      void telemetry.capture("app_opened");
      updater.start();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) openWindow();
      });
    })
    .catch((error) => {
      dialog.showErrorBox("Donkey Diff could not open", error.message);
      app.quit();
    });
  app.on("before-quit", () => bridgeProcess?.kill());
  // Keep running in the menu bar so Autopilot can work with the window closed.
  app.on("window-all-closed", () => {});
}

// Idle is a template image, which macOS tints to match the menu bar like its
// own icons. Working (green) and needs-you (orange) color the glyph's circles,
// and colored images are not tinted, so those pick white or black lines from
// the system appearance. Each @2x file beside its PNG is picked up automatically.
function trayImage() {
  const state = autopilot.attention
    ? "attention"
    : autopilot.running
      ? "working"
      : "";
  if (!state) {
    const image = nativeImage.createFromPath(
      path.join(__dirname, "assets", "trayTemplate.png"),
    );
    image.setTemplateImage(true);
    return image;
  }
  const appearance = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  return nativeImage.createFromPath(
    path.join(__dirname, "assets", `tray-${state}-${appearance}.png`),
  );
}

function updateTray() {
  if (!tray) return;
  tray.setImage(trayImage());
  tray.setToolTip(`${environment.name} · ${autopilotStatusLabel()}`);
  const label = {
    queued: "Queued",
    running: "Working",
    pushed: "Pushed",
    no_changes: "No changes",
    needs_user: "Needs you",
    failed: "Failed",
    stopped: "Stopped",
    interrupted: "Interrupted",
    skipped: "Skipped",
  };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: autopilotStatusLabel(), enabled: false },
      ...(autopilot.recent.length
        ? [
            { type: "separator" },
            ...autopilot.recent.map((job) => ({
              label: `${label[job.status] || job.status} · ${job.projectName}: ${job.title}`.slice(
                0,
                80,
              ),
              click: () =>
                openWindow({ projectId: job.projectId, jobId: job.jobId }),
            })),
          ]
        : []),
      { type: "separator" },
      { label: `Open ${app.getName()}`, click: () => openWindow() },
      {
        label: "Open at Login",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: "separator" },
      { label: `Quit ${app.getName()}`, role: "quit" },
    ]),
  );
}
function handleAutopilotEvent(event) {
  if (event?.type === "status") {
    autopilot = {
      running: Number(event.running) || 0,
      attention: Number(event.attention) || 0,
      recent: Array.isArray(event.recent) ? event.recent : [],
    };
    updateTray();
  } else if (event?.type === "notify" && Notification.isSupported()) {
    const notification = new Notification({
      title: String(event.title || "Autopilot"),
      body: String(event.body || ""),
    });
    notification.on("click", () =>
      openWindow(
        event.projectId
          ? { projectId: event.projectId, jobId: event.jobId }
          : undefined,
      ),
    );
    notification.show();
  }
}
