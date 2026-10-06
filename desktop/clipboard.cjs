function registerClipboardHandler({ ipcMain, clipboard, ownedFrame }) {
  ipcMain.handle("clipboard-write-text", async (event, text) => {
    ownedFrame(event);
    if (typeof text !== "string") throw new Error("Invalid clipboard text");
    await clipboard.writeText(text);
  });
}

module.exports = { registerClipboardHandler };
