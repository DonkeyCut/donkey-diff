const statuses = new Set([
  "notChecked",
  "checking",
  "upToDate",
  "available",
  "installing",
  "requiresAdmin",
  "unavailable",
  "failed",
]);

function createUpdater({
  currentVersion,
  supported,
  nativePath,
  publish,
  loadNative = require,
}) {
  let state = { status: "notChecked", currentVersion };
  let native;
  const emit = (next) => {
    state = { ...next, currentVersion };
    publish(state);
  };
  const check = () => {
    if (
      !native ||
      [
        "checking",
        "installing",
        "available",
        "unavailable",
        "requiresAdmin",
      ].includes(state.status)
    )
      return state;
    try {
      emit({ status: "checking" });
      native.check();
    } catch (error) {
      emit({ status: "failed", message: error.message });
    }
    return state;
  };
  return {
    getState: () => state,
    check,
    start() {
      if (!supported) {
        emit({
          status: "unavailable",
          message: "Updates are available in packaged Mac builds.",
        });
        return;
      }
      try {
        native = loadNative(nativePath);
        native.start((json) => {
          try {
            const next = JSON.parse(json);
            if (!statuses.has(next.status))
              throw new Error("Unknown updater status");
            emit(next);
          } catch {
            emit({
              status: "failed",
              message: "Could not read update status.",
            });
          }
        });
      } catch (error) {
        emit({ status: "unavailable", message: error.message });
      }
    },
    activate() {
      if (
        !native ||
        ["checking", "installing", "unavailable", "requiresAdmin"].includes(
          state.status,
        )
      )
        return state;
      try {
        if (state.status === "available") {
          emit({ ...state, status: "installing" });
          native.install();
        } else {
          return check();
        }
      } catch (error) {
        emit({ status: "failed", message: error.message });
      }
      return state;
    },
  };
}
module.exports = { createUpdater };
