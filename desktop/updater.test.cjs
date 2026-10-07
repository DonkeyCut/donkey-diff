const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createUpdater } = require("./updater.cjs");

function setup() {
  let callback;
  const calls = [];
  const states = [];
  const native = {
    start(fn) {
      callback = fn;
    },
    check() {
      calls.push("check");
      callback(JSON.stringify({ status: "checking" }));
    },
    install() {
      calls.push("install");
    },
  };
  const updater = createUpdater({
    currentVersion: "1.0",
    supported: true,
    nativePath: "test",
    loadNative: () => native,
    publish: (state) => states.push(state),
  });
  updater.start();
  return {
    updater,
    calls,
    states,
    emit: (state) => callback(JSON.stringify(state)),
  };
}

test("discovery waits for a click, installation is single-shot, and failures can retry", () => {
  const { updater, calls, emit } = setup();
  emit({ status: "available", latestVersion: "1.1" });
  assert.deepEqual(calls, []);
  assert.equal(updater.getState().currentVersion, "1.0");
  updater.activate();
  updater.activate();
  assert.deepEqual(calls, ["install"]);
  assert.equal(updater.getState().status, "installing");
  emit({ status: "failed", message: "Invalid signature" });
  updater.activate();
  assert.deepEqual(calls, ["install", "check"]);
  updater.activate();
  assert.deepEqual(calls, ["install", "check"]);
  emit({ status: "upToDate" });
  assert.equal(updater.getState().status, "upToDate");
});

test("non-writable or unconfigured apps cannot start an install", () => {
  const { updater, calls, emit } = setup();
  for (const status of ["requiresAdmin", "unavailable"]) {
    emit({ status, latestVersion: "1.1" });
    updater.activate();
  }
  assert.deepEqual(calls, []);
});

test("missing native support and invalid events report a recoverable status", () => {
  const unsupported = createUpdater({
    currentVersion: "1",
    supported: false,
    publish() {},
    loadNative() {
      throw new Error("should not load");
    },
  });
  unsupported.start();
  assert.equal(unsupported.getState().status, "unavailable");
  const { updater, emit } = setup();
  emit({ status: "not-a-state" });
  assert.equal(updater.getState().status, "failed");
});

test("manual checks report an available update without installing it", () => {
  const { updater, calls, emit } = setup();
  updater.check();
  updater.check();
  assert.deepEqual(calls, ["check"]);
  emit({ status: "available", latestVersion: "1.1" });
  assert.equal(updater.check().status, "available");
  assert.deepEqual(calls, ["check"]);
  updater.activate();
  assert.deepEqual(calls, ["check", "install"]);
});

test("manual checks can retry after an up-to-date result or error", () => {
  const { updater, calls, emit } = setup();
  emit({ status: "upToDate" });
  assert.equal(updater.check().status, "checking");
  emit({ status: "failed", message: "Offline" });
  assert.equal(updater.check().status, "checking");
  assert.deepEqual(calls, ["check", "check"]);
});
