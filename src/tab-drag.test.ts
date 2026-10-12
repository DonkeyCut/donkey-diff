import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampTabOffset,
  moveItem,
  tabDropIndex,
  tabDropOffset,
  tabShift,
} from "./tab-drag.js";

// Four 100px tabs separated by 6px gaps.
const slots = [0, 106, 212, 318].map((left) => ({ left, width: 100 }));

test("drop index changes once the leading edge passes a neighbor's center", () => {
  assert.equal(tabDropIndex(slots, 1, 0), 1);
  assert.equal(tabDropIndex(slots, 1, 50), 1);
  assert.equal(tabDropIndex(slots, 1, 60), 2);
  assert.equal(tabDropIndex(slots, 1, 166), 3);
  assert.equal(tabDropIndex(slots, 1, -50), 1);
  assert.equal(tabDropIndex(slots, 1, -60), 0);
  assert.equal(tabDropIndex(slots, 0, 0), 0);
  assert.equal(tabDropIndex(slots, 3, 0), 3);
});

test("dragging is clamped to the tab strip", () => {
  assert.equal(clampTabOffset(slots, 1, -500), -106);
  assert.equal(clampTabOffset(slots, 1, 500), 212);
  assert.equal(clampTabOffset(slots, 1, 30), 30);
});

test("neighbors slide by one tab width plus gap toward the vacated slot", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((tab) => tabShift(slots, 1, 3, tab)),
    [0, 0, -106, -106],
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((tab) => tabShift(slots, 2, 0, tab)),
    [106, 106, 0, 0],
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((tab) => tabShift(slots, 2, 2, tab)),
    [0, 0, 0, 0],
  );
});

test("dropped tab settles into its target slot", () => {
  assert.equal(tabDropOffset(slots, 1, 3), 212);
  assert.equal(tabDropOffset(slots, 2, 0), -212);
  assert.equal(tabDropOffset(slots, 2, 2), 0);
});

test("moveItem reorders without mutating the input", () => {
  const items = ["a", "b", "c", "d"];
  assert.deepEqual(moveItem(items, 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(moveItem(items, 3, 1), ["a", "d", "b", "c"]);
  assert.deepEqual(items, ["a", "b", "c", "d"]);
});
