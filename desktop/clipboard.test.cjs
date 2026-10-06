const { test } = require("node:test");
const assert = require("node:assert/strict");
const { registerClipboardHandler } = require("./clipboard.cjs");

test("clipboard IPC accepts text only from the owned frame and awaits the write", async () => {
  let handler;
  const writes = [];
  let fail = false;
  registerClipboardHandler({
    ipcMain: {
      handle: (channel, callback) => {
        assert.equal(channel, "clipboard-write-text");
        handler = callback;
      },
    },
    ownedFrame: (event) => {
      if (event.url !== "file:///app/index.html")
        throw new Error("Untrusted window");
    },
    clipboard: {
      writeText: async (text) => {
        if (fail) throw new Error("Clipboard unavailable");
        writes.push(text);
      },
    },
  });
  const event = { url: "file:///app/index.html" };
  await handler(event, "/repo/with spaces/日本語.ts");
  assert.deepEqual(writes, ["/repo/with spaces/日本語.ts"]);
  for (const value of [undefined, null, 42, {}, ["path"]])
    await assert.rejects(handler(event, value), /Invalid clipboard text/);
  await assert.rejects(
    handler({ url: "https://other.test" }, "path"),
    /Untrusted window/,
  );
  assert.equal(writes.length, 1);
  fail = true;
  await assert.rejects(handler(event, "path"), /Clipboard unavailable/);
});
