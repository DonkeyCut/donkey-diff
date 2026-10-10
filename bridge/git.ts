import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  readFile,
  readlink,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  ChangedFile,
  Commit,
  FileContent,
  Project,
  Snapshot,
  Worktree,
} from "../src/types.js";
const exec = promisify(execFile);
export async function assertProjectDirectory(cwd: string) {
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error("Not a directory");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM")
      throw new Error(
        `Cannot access the project folder: ${cwd}. Check its permissions and try again.`,
        { cause: error },
      );
    throw new Error(
      `Project folder is no longer available: ${cwd}. It may have been moved or deleted. Open its new location or close this tab.`,
      { cause: error },
    );
  }
}
export async function git(cwd: string, args: string[], signal?: AbortSignal) {
  try {
    return (
      await exec("git", ["-c", "core.quotepath=false", ...args], {
        cwd,
        maxBuffer: 20 * 1024 * 1024,
        timeout: 60000,
        signal,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      })
    ).stdout;
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      await assertProjectDirectory(cwd);
      throw new Error(
        "Git could not be found. Install Git or reopen Donkey Diff after updating your Git installation.",
        { cause: error },
      );
    }
    throw new Error(e.stderr?.trim() || e.message, { cause: error });
  }
}
async function optional(
  cwd: string,
  args: string[],
  fallback = "",
  signal?: AbortSignal,
) {
  try {
    return await git(cwd, args, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return fallback;
  }
}
export async function validateRepo(root: string) {
  const resolved = await realpath(root);
  return (await git(resolved, ["rev-parse", "--show-toplevel"])).trim();
}
export async function isLinkedWorktree(root: string) {
  const directories = (
    await git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
    ])
  )
    .trim()
    .split("\n");
  const [gitDir, commonDir] = await Promise.all(
    directories.map((dir) => realpath(dir)),
  );
  return gitDir !== commonDir;
}
export function parseStatus(raw: string): ChangedFile[] {
  const entries = raw.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const name = entry.slice(3);
    const oldPath = /[RC]/.test(xy) ? entries[++i] : undefined;
    files.push({
      // Git reports nested untracked repositories as directory entries.
      path: name.replace(/\/$/, ""),
      ...(name.endsWith("/") ? { directory: true } : {}),
      oldPath,
      status:
        xy === "??"
          ? "A"
          : /U/.test(xy) || xy === "AA" || xy === "DD"
            ? "U"
            : xy.includes("D")
              ? "D"
              : xy.includes("A")
                ? "A"
                : xy.includes("R")
                  ? "R"
                  : "M",
      staged: ![" ", "?"].includes(xy[0]),
      unstaged: xy[1] !== " ",
      conflict: /U/.test(xy) || xy === "AA" || xy === "DD",
      additions: 0,
      deletions: 0,
    });
  }
  return files;
}
function addStats(files: ChangedFile[], stats: string) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const entries = stats.split("\0");
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    const [add, del, ...names] = entries[i].split("\t");
    // Renames leave the path empty and follow with the old and new paths.
    const name = names.join("\t") || entries[(i += 2)];
    const file = byPath.get(name);
    if (file) {
      file.additions += Number(add) || 0;
      file.deletions += Number(del) || 0;
    }
  }
}
export async function changedFiles(
  cwd: string,
  commit?: string,
  base?: string,
): Promise<ChangedFile[]> {
  if (base && !commit) throw new Error("A target commit is required");
  if (commit) {
    await validateCommit(cwd, commit);
    if (base) await validateCommit(cwd, base);
    const parent =
      base ||
      (await optional(cwd, ["rev-parse", "--verify", `${commit}^`])).trim();
    const comparison = parent
      ? ["diff", parent, commit]
      : ["diff-tree", "--root", "--no-commit-id", "-r", commit];
    const raw = await git(cwd, [
      ...comparison,
      "--no-renames",
      "--name-status",
      "-z",
      "--",
    ]);
    const parts = raw.split("\0");
    const result: ChangedFile[] = [];
    for (let i = 0; i < parts.length - 1; i += 2)
      result.push({
        path: parts[i + 1],
        status: parts[i][0],
        staged: false,
        conflict: false,
        additions: 0,
        deletions: 0,
      });
    addStats(
      result,
      await git(cwd, [...comparison, "--no-renames", "--numstat", "-z", "--"]),
    );
    return result;
  }
  const files = parseStatus(
    await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  const hasHead = await optional(cwd, ["rev-parse", "--verify", "HEAD"]);
  addStats(
    files,
    await optional(cwd, [
      "diff",
      // Match status, which counts a rename as one edited file.
      "--find-renames",
      "--numstat",
      "-z",
      ...(hasHead ? ["HEAD"] : ["--cached"]),
      "--",
    ]),
  );
  const pending = files.filter((f) => f.status === "A" && !f.staged);
  await Promise.all(
    Array.from({ length: Math.min(8, pending.length) }, async () => {
      let file: ChangedFile | undefined;
      while ((file = pending.shift())) {
        try {
          const target = await safeFile(cwd, file.path);
          const stat = await lstat(target);
          if (stat.isFile() && stat.size <= 5 * 1024 * 1024) {
            const text = await readFile(target, "utf8");
            if (!text.includes("\0"))
              file.additions = text
                ? text.split("\n").length - Number(text.endsWith("\n"))
                : 0;
          }
        } catch {
          /* Unreadable and symbolic-link entries remain listed. */
        }
      }
    }),
  );
  return files;
}
async function validateCommit(cwd: string, commit: string) {
  if (!/^[a-f0-9]{7,40}$/.test(commit)) throw new Error("Invalid commit");
  await git(cwd, ["cat-file", "-e", `${commit}^{commit}`]);
}
export async function commitHistory(
  cwd: string,
  ref: string,
): Promise<Commit[]> {
  await assertProjectDirectory(cwd);
  if (
    ref === "HEAD" &&
    !(await optional(cwd, ["rev-parse", "--verify", "HEAD"])).trim()
  )
    return [];
  const hash = (
    await git(cwd, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ])
  ).trim();
  return parseCommits(
    await git(cwd, [
      "log",
      "-150",
      "--topo-order",
      "--format=%H%x09%h%x09%P%x09%an%x09%aI%x09%D%x09%s",
      hash,
      "--",
    ]),
  );
}
function parseCommits(logs: string): Commit[] {
  return logs
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, short, parents, author, date, refs, ...subject] =
        line.split("\t");
      return {
        hash,
        short,
        parents,
        author,
        date,
        refs,
        subject: subject.join("\t"),
      };
    });
}
export async function snapshot(
  project: Project,
  navigationOnly = false,
): Promise<Snapshot> {
  const cwd = project.path;
  await assertProjectDirectory(cwd);
  const [
    files,
    branch,
    branches,
    trees,
    stashes,
    remotes,
    tags,
    logs,
    tracking,
  ] = await Promise.all([
    navigationOnly ? Promise.resolve([]) : changedFiles(cwd),
    optional(cwd, ["symbolic-ref", "--short", "HEAD"], "detached"),
    git(cwd, [
      "for-each-ref",
      "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(refname)",
      "refs/heads",
      "refs/remotes",
    ]),
    git(cwd, ["worktree", "list", "--porcelain"]),
    optional(cwd, ["stash", "list", "--format=%gd%x09%s"]),
    git(cwd, ["remote"]),
    git(cwd, ["tag", "--list"]),
    optional(cwd, [
      "log",
      "-150",
      "--topo-order",
      "--format=%H%x09%h%x09%P%x09%an%x09%aI%x09%D%x09%s",
    ]),
    optional(
      cwd,
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      "0\t0",
    ),
  ]);
  const worktrees: Worktree[] = trees
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      return {
        path: lines.find((l) => l.startsWith("worktree "))!.slice(9),
        head: lines.find((l) => l.startsWith("HEAD "))?.slice(5) || "",
        branch:
          lines
            .find((l) => l.startsWith("branch "))
            ?.slice(7)
            .replace("refs/heads/", "") || "detached",
        locked: lines.some((l) => l.startsWith("locked")),
      };
    });
  const commits = parseCommits(logs);
  const [ahead, behind] = tracking.trim().split(/\s+/).map(Number);
  return {
    project,
    files,
    branch: branch.trim(),
    branches: branches
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, current, upstream, track, ref] = line.split("\t");
        return {
          name,
          current: current === "*",
          upstream,
          track,
          ref,
          remote: ref.startsWith("refs/remotes/"),
        };
      }),
    worktrees,
    stashes: stashes
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, ...subject] = line.split("\t");
        return { ref, subject: subject.join("\t") };
      }),
    remotes: remotes.trim().split("\n").filter(Boolean),
    tags: tags.trim().split("\n").filter(Boolean),
    commits,
    ahead: ahead || 0,
    behind: behind || 0,
  };
}
export async function safeFile(cwd: string, name: string) {
  if (
    !name ||
    name.includes("\0") ||
    path.isAbsolute(name) ||
    name.split(/[\\/]/).includes("..") ||
    name.split(/[\\/]/).includes(".git")
  )
    throw new Error("Invalid file path");
  const target = path.resolve(cwd, name);
  const base = await realpath(cwd);
  // Resolve the parent so symlinked folders cannot redirect the path, but leave
  // the entry itself unresolved: Git tracks a symlink as its target text.
  try {
    const parent = await realpath(path.dirname(target));
    if (parent !== base && !parent.startsWith(base + path.sep))
      throw new Error("File is outside the repository");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}
async function isSymlink(target: string) {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}
const mediaTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
};
const mediaLimit = 20 * 1024 * 1024;
function checkMediaSize(size: number) {
  if (size > mediaLimit)
    throw new Error("Media exceeds the 20 MB preview limit");
}
function mediaUrl(bytes: Buffer, type: string) {
  return bytes.length ? `data:${type};base64,${bytes.toString("base64")}` : "";
}
async function gitMedia(
  cwd: string,
  revision: string,
  type: string,
  signal?: AbortSignal,
) {
  // Missing sides (additions, deletions, root commits) have no preview.
  const oid = (
    await optional(cwd, ["rev-parse", "--verify", revision], "", signal)
  ).trim();
  if (!oid) return "";
  checkMediaSize(Number(await git(cwd, ["cat-file", "-s", oid], signal)));
  const { stdout } = await exec("git", ["cat-file", "blob", oid], {
    cwd,
    encoding: "buffer",
    maxBuffer: mediaLimit,
    timeout: 60000,
    signal,
  });
  return mediaUrl(stdout, type);
}
export async function fileContent(
  cwd: string,
  name: string,
  commit?: string,
  base?: string,
  layer?: "staged" | "unstaged",
  signal?: AbortSignal,
): Promise<FileContent> {
  const target = await safeFile(cwd, name);
  if (base && !commit) throw new Error("A target commit is required");
  if (base) await validateCommit(cwd, base);
  const files = commit
    ? []
    : parseStatus(
        await git(
          cwd,
          [
            "--literal-pathspecs",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            ...(layer === "unstaged" ? ["--", name] : []),
          ],
          signal,
        ),
      );
  const changed = files.find((f) => f.path === name);
  if (commit) await validateCommit(cwd, commit);
  const worktreeLink =
    !commit && layer !== "staged" && (await isSymlink(target));
  if (!commit && layer !== "staged") {
    try {
      if ((await lstat(target)).isDirectory())
        return {
          path: name,
          old: "",
          current: "",
          directory: true,
          binary: true,
          conflict: changed?.conflict || false,
        };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (path.extname(name).toLowerCase() === ".bin") {
    return {
      path: name,
      old: "",
      current: "",
      binary: true,
      conflict: changed?.conflict || false,
    };
  }
  const oldName = layer === "unstaged" ? name : changed?.oldPath || name;
  const mediaType = worktreeLink
    ? undefined
    : mediaTypes[path.extname(name).toLowerCase()];
  if (mediaType) {
    const oldRevision = `${!commit && layer === "unstaged" ? "" : base || (commit ? `${commit}^` : "HEAD")}:${oldName}`;
    const currentRead = async () => {
      if (commit || layer === "staged")
        return gitMedia(cwd, `${commit || ""}:${name}`, mediaType, signal);
      try {
        checkMediaSize((await lstat(target)).size);
        const bytes = await readFile(target, { signal });
        checkMediaSize(bytes.length);
        return mediaUrl(bytes, mediaType);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return "";
      }
    };
    const [old, current] = await Promise.all([
      gitMedia(cwd, oldRevision, mediaType, signal),
      currentRead(),
    ]);
    return {
      path: name,
      old,
      current,
      mediaType,
      binary: true,
      conflict: changed?.conflict || false,
    };
  }
  const oldRead = optional(
    cwd,
    [
      "show",
      `${!commit && layer === "unstaged" ? "" : base || (commit ? `${commit}^` : "HEAD")}:${oldName}`,
    ],
    "",
    signal,
  );
  // Read both sides concurrently; every process belongs to this cancellable request.
  const currentRead = async () => {
    let current = "";
    if (commit)
      current = await optional(cwd, ["show", `${commit}:${name}`], "", signal);
    else if (layer === "staged")
      current = await optional(cwd, ["show", `:${name}`], "", signal);
    else if (worktreeLink) current = await readlink(target);
    else {
      try {
        const stat = await lstat(target);
        if (stat.size > 5 * 1024 * 1024)
          throw new Error("File exceeds the 5 MB viewing limit");
        current = await readFile(target, { encoding: "utf8", signal });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return current;
  };
  const [old, current] = await Promise.all([oldRead, currentRead()]);
  const conflict = changed?.conflict || false;
  return {
    path: name,
    ...(oldName !== name ? { oldPath: oldName } : {}),
    old,
    current,
    binary: old.includes("\0") || current.includes("\0"),
    conflict,
    ...(conflict
      ? {
          ours: await optional(cwd, ["show", `:2:${name}`], "", signal),
          theirs: await optional(cwd, ["show", `:3:${name}`], "", signal),
        }
      : {}),
  };
}
export async function sync(cwd: string) {
  const remotes = (await git(cwd, ["remote"])).trim();
  if (!remotes) return "Local repository · no remote";
  await git(cwd, ["fetch", "--all", "--prune"]);
  if ((await changedFiles(cwd)).length)
    return "Fetched · pull paused while you have local changes";
  if (
    !(await optional(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"])).trim()
  )
    return "Fetched · no upstream configured";
  const [ahead, behind] = (
    await git(cwd, [
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{upstream}",
    ])
  )
    .trim()
    .split(/\s+/)
    .map(Number);
  if (ahead && behind)
    return "Fetched · branches have diverged; use Pull to merge";
  await git(cwd, ["pull", "--ff-only"]);
  return "Up to date";
}
export async function resolveFile(cwd: string, name: string, content: string) {
  const target = await safeFile(cwd, name);
  if (await isSymlink(target))
    throw new Error("Symbolic links cannot be edited");
  const f = (await changedFiles(cwd)).find((x) => x.path === name);
  if (!f?.conflict) throw new Error("This file is no longer conflicted");
  if (/^(<{7}|={7}|>{7})( |$)/m.test(content))
    throw new Error("Remove all conflict markers before saving");
  await writeFile(target, content);
  await git(cwd, ["add", "--", name]);
}
