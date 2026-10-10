import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  symlink,
  readFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  git,
  parseStatus,
  changedFiles,
  fileContent,
  snapshot,
  commitHistory,
  sync,
  safeFile,
  resolveFile,
} from "./git.js";
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "donkey-diff-test-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "tests@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await writeFile(path.join(dir, "hello.ts"), 'const hello = "world";\n');
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "Initial"]);
  return dir;
}
test("sidebar history browses occupied branches, tags and remotes without checkout", async () => {
  const dir = await fixture();
  const linked = `${dir}-linked`;
  try {
    const original = await git(dir, ["rev-parse", "HEAD"]);
    await git(dir, ["worktree", "add", "-b", "feature", linked]);
    await writeFile(path.join(linked, "hello.ts"), "feature\n");
    await git(linked, ["commit", "-am", "Feature change"]);
    const tip = (await git(linked, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["tag", "v1", tip]);
    await git(dir, ["update-ref", "refs/remotes/origin/feature", tip]);
    for (const ref of [
      "refs/heads/feature",
      "refs/tags/v1",
      "refs/remotes/origin/feature",
    ]) {
      assert.equal((await commitHistory(dir, ref))[0].hash, tip);
    }
    assert.equal(await git(dir, ["rev-parse", "HEAD"]), original);
    assert.equal((await git(dir, ["branch", "--show-current"])).trim(), "main");
    assert.equal(
      await readFile(path.join(dir, "hello.ts"), "utf8"),
      'const hello = "world";\n',
    );
    const navigation = await snapshot(
      { id: "test", name: "test", path: dir },
      true,
    );
    assert.ok(
      navigation.branches.some(
        (b) => b.remote && b.ref === "refs/remotes/origin/feature",
      ),
    );
    assert.equal(navigation.worktrees.length, 2);
    await assert.rejects(commitHistory(dir, "--all"));
    await assert.rejects(commitHistory(dir, "missing"));
  } finally {
    await rm(linked, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
test("porcelain parser handles spaces, staged renames and conflicts", () => {
  const files = parseStatus(
    " M src/a file.ts\0R  new.ts\0old.ts\0?? fresh.ts\0UU conflict.ts\0",
  );
  assert.equal(files[0].path, "src/a file.ts");
  assert.equal(files[1].oldPath, "old.ts");
  assert.equal(files[1].staged, true);
  assert.equal(files[2].status, "A");
  assert.equal(files[3].conflict, true);
});
test("nested repositories have named rows and directory previews", async () => {
  const dir = await fixture();
  try {
    const nested = path.join(dir, "maplewood");
    await mkdir(nested);
    await git(nested, ["init", "-b", "main"]);
    await writeFile(path.join(nested, "game.ts"), "export {};\n");
    await writeFile(path.join(dir, "preview.png"), Buffer.from([0, 1, 2]));
    const files = await changedFiles(dir);
    assert.deepEqual(files.map((file) => file.path).sort(), [
      "maplewood",
      "preview.png",
    ]);
    assert.equal(
      files.find((file) => file.path === "maplewood")?.directory,
      true,
    );
    assert.equal(
      files.find((file) => file.path === "preview.png")?.directory,
      undefined,
    );
    for (const name of ["maplewood", "maplewood/"]) {
      const content = await fileContent(
        dir,
        name,
        undefined,
        undefined,
        "unstaged",
      );
      assert.equal(content.directory, true);
      assert.equal(content.binary, true);
      assert.equal(content.old, "");
      assert.equal(content.current, "");
    }
    assert.equal(
      (await fileContent(dir, "preview.png")).mediaType,
      "image/png",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("directory previews preserve staged and historical file contents", async () => {
  const dir = await fixture();
  try {
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await rm(path.join(dir, "hello.ts"));
    await mkdir(path.join(dir, "hello.ts"));
    await mkdir(path.join(dir, "folder.png"));
    assert.equal((await fileContent(dir, "hello.ts")).directory, true);
    const mediaFolder = await fileContent(dir, "folder.png");
    assert.equal(mediaFolder.directory, true);
    assert.equal(mediaFolder.mediaType, undefined);
    for (const [commit, layer] of [
      [head, undefined],
      [undefined, "staged"],
    ] as const) {
      const content = await fileContent(
        dir,
        "hello.ts",
        commit,
        undefined,
        layer,
      );
      assert.equal(content.directory, undefined);
      assert.equal(content.current, 'const hello = "world";\n');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("history and snapshots expose complete merge ancestry in topological order", async () => {
  const dir = await fixture();
  try {
    const root = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["switch", "-c", "feature"]);
    await writeFile(path.join(dir, "feature.ts"), "feature\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "Feature"]);
    const side = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["switch", "main"]);
    await writeFile(path.join(dir, "hello.ts"), "main\n");
    await git(dir, ["commit", "-am", "Main"]);
    const main = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["merge", "--no-ff", "feature", "-m", "Merge feature"]);
    const merge = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const state = await snapshot({ id: "test", name: "test", path: dir });
    for (const commits of [state.commits, await commitHistory(dir, "HEAD")]) {
      assert.equal(commits[0].hash, merge);
      assert.equal(commits[0].parents, `${main} ${side}`);
      assert.equal(commits.length, 4);
      assert.equal(commits.at(-1)?.hash, root);
      for (const [index, entry] of commits.entries()) {
        for (const parent of entry.parents.split(" ").filter(Boolean)) {
          assert.equal(parent.length, 40);
          assert.ok(commits.findIndex((c) => c.hash === parent) > index);
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("working changes compare HEAD to disk and root commits are viewable", async () => {
  const dir = await fixture();
  try {
    await writeFile(path.join(dir, "hello.ts"), 'const hello = "changed";\n');
    await writeFile(path.join(dir, "new file.ts"), "export {};\n");
    const files = await changedFiles(dir);
    assert.equal(files.length, 2);
    const content = await fileContent(dir, "hello.ts");
    assert.match(content.old, /world/);
    assert.match(content.current, /changed/);
    const state = await snapshot({ id: "test", name: "test", path: dir });
    assert.equal(state.commits.length, 1);
    assert.equal(state.branch, "main");
    const historical = await fileContent(
      dir,
      "hello.ts",
      state.commits[0].hash,
    );
    assert.equal(historical.old, "");
    assert.match(historical.current, /world/);
    const historicalFiles = await changedFiles(dir, state.commits[0].hash);
    assert.equal(historicalFiles[0].path, "hello.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("file paths cannot escape a repository or access Git internals", async () => {
  const dir = await fixture();
  try {
    await assert.rejects(safeFile(dir, "../private"));
    await assert.rejects(safeFile(dir, ".git/config"));
    await symlink("/etc", path.join(dir, "outside"));
    await assert.rejects(
      safeFile(dir, "outside/passwd"),
      /outside the repository/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("symbolic links show their target without being followed", async () => {
  const dir = await fixture();
  try {
    await symlink("/etc/passwd", path.join(dir, "link"));
    assert.equal(await safeFile(dir, "link"), path.join(dir, "link"));
    const content = await fileContent(dir, "link");
    assert.equal(content.current, "/etc/passwd");
    assert.equal(content.binary, false);
    await assert.rejects(resolveFile(dir, "link", "x"), /cannot be edited/);
    await git(dir, ["add", "--", "link"]);
    assert.equal(
      (await fileContent(dir, "link", undefined, undefined, "staged")).current,
      "/etc/passwd",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("conflict versions and resolution preserve intended content", async () => {
  const dir = await fixture();
  try {
    await git(dir, ["switch", "-c", "feature"]);
    await writeFile(path.join(dir, "hello.ts"), 'const hello = "incoming";\n');
    await git(dir, ["commit", "-am", "Incoming"]);
    await git(dir, ["switch", "main"]);
    await writeFile(path.join(dir, "hello.ts"), 'const hello = "current";\n');
    await git(dir, ["commit", "-am", "Current"]);
    await assert.rejects(git(dir, ["merge", "feature"]));
    const content = await fileContent(dir, "hello.ts");
    assert.equal(content.conflict, true);
    assert.match(content.ours!, /current/);
    assert.match(content.theirs!, /incoming/);
    await assert.rejects(resolveFile(dir, "hello.ts", content.current));
    await resolveFile(dir, "hello.ts", 'const hello = "resolved";\n');
    assert.equal((await changedFiles(dir))[0].conflict, false);
    assert.match(
      await readFile(path.join(dir, "hello.ts"), "utf8"),
      /resolved/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("sync fetches but never changes a dirty worktree", async () => {
  const dir = await fixture();
  const remote = await mkdtemp(path.join(os.tmpdir(), "donkey-diff-remote-"));
  try {
    await git(remote, ["init", "--bare"]);
    await git(dir, ["remote", "add", "origin", remote]);
    await git(dir, ["push", "-u", "origin", "main"]);
    await writeFile(path.join(dir, "hello.ts"), "local work\n");
    assert.match(await sync(dir), /paused/);
    assert.equal(
      await readFile(path.join(dir, "hello.ts"), "utf8"),
      "local work\n",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

test("two selected commits compare exact endpoints, including non-adjacent changes", async () => {
  const dir = await fixture();
  try {
    const base = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(dir, "hello.ts"), "middle\n");
    await writeFile(path.join(dir, "added.ts"), "added\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "Middle"]);
    await writeFile(path.join(dir, "hello.ts"), "latest\n");
    await git(dir, ["commit", "-am", "Latest"]);
    const target = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const changes = await changedFiles(dir, target, base);
    assert.deepEqual(changes.map((f) => f.path).sort(), [
      "added.ts",
      "hello.ts",
    ]);
    const file = await fileContent(dir, "hello.ts", target, base);
    assert.match(file.old, /world/);
    assert.equal(file.current, "latest\n");
    assert.equal((await fileContent(dir, "added.ts", target, base)).old, "");
    const reverse = await changedFiles(dir, base, target);
    assert.equal(reverse.find((f) => f.path === "added.ts")?.status, "D");
    assert.deepEqual(await changedFiles(dir, target, target), []);
    await assert.rejects(changedFiles(dir, target, "--help"), /Invalid commit/);
    await assert.rejects(changedFiles(dir, undefined, base), /target commit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleted project directories report recovery instructions and do not break other projects", async () => {
  const removed = await fixture();
  const healthy = await fixture();
  await rm(removed, { recursive: true });
  try {
    const missing = { id: "removed", name: "removed", path: removed };
    await assert.rejects(
      snapshot(missing),
      /Project folder is no longer available.*Open its new location/,
    );
    await assert.rejects(
      git(removed, ["status"]),
      /Project folder is no longer available/,
    );
    const state = await snapshot({
      id: "healthy",
      name: "healthy",
      path: healthy,
    });
    assert.equal(state.branch, "main");
    assert.equal(state.commits.length, 1);
  } finally {
    await rm(healthy, { recursive: true, force: true });
  }
});

test("cancellable file reads preserve staged renames and unstaged index comparisons", async () => {
  const dir = await fixture();
  try {
    await git(dir, ["mv", "hello.ts", "renamed.ts"]);
    const staged = await fileContent(
      dir,
      "renamed.ts",
      undefined,
      undefined,
      "staged",
    );
    assert.equal(staged.old, staged.current);
    assert.equal(staged.oldPath, "hello.ts");
    assert.match(staged.old, /world/);
    const [renamed] = await changedFiles(dir);
    assert.equal(renamed.status, "R");
    assert.equal(renamed.additions, 0);
    assert.equal(renamed.deletions, 0);
    await writeFile(
      path.join(dir, "renamed.ts"),
      'const hello = "world";\nconst more = 1;\n',
    );
    const [edited] = await changedFiles(dir);
    assert.equal(edited.additions, 1);
    assert.equal(edited.deletions, 0);
    await writeFile(path.join(dir, "renamed.ts"), "changed\n");
    const unstaged = await fileContent(
      dir,
      "renamed.ts",
      undefined,
      undefined,
      "unstaged",
    );
    assert.equal(unstaged.old, staged.current);
    assert.equal(unstaged.oldPath, undefined);
    assert.equal(unstaged.current, "changed\n");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      fileContent(
        dir,
        "renamed.ts",
        undefined,
        undefined,
        "unstaged",
        controller.signal,
      ),
      /abort/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
