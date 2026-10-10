export type Project = {
  id: string;
  name: string;
  path: string;
  /** Undefined when the checkout could not be inspected. */
  isWorktree?: boolean;
};
export type ChangedFile = {
  path: string;
  directory?: boolean;
  oldPath?: string;
  status: string;
  staged: boolean;
  unstaged?: boolean;
  conflict: boolean;
  additions: number;
  deletions: number;
};
export type Commit = {
  hash: string;
  short: string;
  parents: string;
  author: string;
  date: string;
  subject: string;
  refs: string;
};
export type Branch = {
  ref?: string;
  remote?: boolean;
  name: string;
  current: boolean;
  upstream: string;
  track: string;
};
export type Worktree = {
  path: string;
  branch: string;
  head: string;
  locked: boolean;
};
export type Stash = { ref: string; subject: string };
export type Snapshot = {
  project: Project;
  branch: string;
  files: ChangedFile[];
  branches: Branch[];
  worktrees: Worktree[];
  stashes: Stash[];
  remotes: string[];
  tags: string[];
  commits: Commit[];
  ahead: number;
  behind: number;
  sync?: string;
};
export type FileContent = {
  path: string;
  /** Set when the old side was read from a renamed path. */
  oldPath?: string;
  old: string;
  current: string;
  /** Directory entries have no file contents to preview. */
  directory?: boolean;
  /** Media sides contain data URLs instead of decoded text. */
  mediaType?: string;
  binary: boolean;
  conflict: boolean;
  ours?: string;
  theirs?: string;
};
export type Action =
  | "fetch"
  | "pull"
  | "push"
  | "sync"
  | "branch-create"
  | "branch-switch"
  | "branch-rename"
  | "branch-delete"
  | "worktree-create"
  | "worktree-move"
  | "worktree-remove"
  | "stash-create"
  | "stash-apply"
  | "stash-pop"
  | "stash-drop"
  | "resolve"
  | "stage"
  | "unstage"
  | "commit";
