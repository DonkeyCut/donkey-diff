import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLineup } from "./model-lineup.js";

const models = (...names: string[]) =>
  names.map((name) => ({ id: name, name, efforts: [] }));
const names = (list: { name: string }[]) => list.map((m) => m.name);

test("older versions of a family move out of the main list", () => {
  const { current, older } = modelLineup(
    models(
      "Claude Opus 5.5",
      "Claude Fable 5.1",
      "Claude Sonnet 5.5",
      "Claude Haiku 5.5",
      "Claude Haiku 4.5",
      "Claude Sonnet 5",
      "Claude Opus 5",
      "Claude Fable 5",
      "Claude Opus 4.8",
      "Claude Opus 4.10",
    ),
  );
  assert.deepEqual(names(current), [
    "Claude Opus 5.5",
    "Claude Fable 5.1",
    "Claude Sonnet 5.5",
    "Claude Haiku 5.5",
  ]);
  assert.deepEqual(names(older), [
    "Claude Haiku 4.5",
    "Claude Sonnet 5",
    "Claude Opus 5",
    "Claude Fable 5",
    "Claude Opus 4.8",
    "Claude Opus 4.10",
  ]);
});

test("codex families keep their newest version", () => {
  const { current, older } = modelLineup(
    models("gpt-6.1-sol", "GPT-6-Luna", "GPT-5.6-Terra", "GPT-5.6-Luna"),
  );
  assert.deepEqual(names(current), [
    "gpt-6.1-sol",
    "GPT-6-Luna",
    "GPT-5.6-Terra",
  ]);
  assert.deepEqual(names(older), ["GPT-5.6-Luna"]);
});

test("unversioned models and version ties stay current", () => {
  const { current, older } = modelLineup(
    models("Local Model", "Claude Sonnet", "Opus 4.10", "Opus 4.10"),
  );
  assert.equal(current.length, 4);
  assert.equal(older.length, 0);
});
