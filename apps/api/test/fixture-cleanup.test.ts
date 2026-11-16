import test from "node:test";
import assert from "node:assert/strict";
import { cleanupFixture } from "./fixture-cleanup.js";

test("fixture cleanup attempts every resource and preserves one failure unchanged", async () => {
  const failure = new Error("synthetic deletion failure"), attempted: string[] = [];
  await assert.rejects(cleanupFixture([
    ["users", () => { attempted.push("users"); throw failure; }],
    ["database", () => { attempted.push("database"); }],
    ["server", () => { attempted.push("server"); }],
    ["directory", () => { attempted.push("directory"); }],
  ]), error => error === failure);
  assert.deepEqual(attempted, ["users", "database", "server", "directory"]);
});

test("fixture cleanup retains primary and multiple cleanup causes with operation names", async () => {
  const primary = new Error("synthetic test failure"), deletion = new Error("synthetic deletion failure"), removal = new Error("synthetic removal failure"), attempted: string[] = [];
  await assert.rejects(cleanupFixture([
    ["users", () => { attempted.push("users"); throw deletion; }],
    ["database", () => { attempted.push("database"); }],
    ["server", () => { attempted.push("server"); }],
    ["directory", () => { attempted.push("directory"); throw removal; }],
  ], { error: primary }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(item => item.message), ["test body", "users", "directory"]);
    assert.deepEqual(error.errors.map(item => item.cause), [primary, deletion, removal]);
    return true;
  });
  assert.deepEqual(attempted, ["users", "database", "server", "directory"]);
});
