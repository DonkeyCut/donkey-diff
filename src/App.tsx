import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  FileDiff,
  Folder,
  FolderOpen,
  GitBranch,
  GitCompare,
  GitCommitHorizontal,
  History,
  Link2,
  Loader2,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Tag,
  X,
  Github,
  ExternalLink,
} from "lucide-react";
import * as Switch from "@radix-ui/react-switch";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Dropdown } from "@/components/ui/dropdown-menu";
import { CommitHistory } from "@/components/CommitHistory";
import { BranchTree } from "@/components/BranchTree";
import { Sidebar } from "@/components/Sidebar";
import { FileTree } from "@/components/FileTree";
import { StagingTree, type StageLayer } from "@/components/StagingTree";
import { CommitForm } from "@/components/CommitForm";
import { WorkspaceLayout } from "@/components/WorkspaceLayout";
import { ChatPanel } from "@/components/ChatPanel";
import { UpdateButton } from "@/components/UpdateButton";
import { DiffPane } from "@/components/DiffPane";
import {
  bridge,
  getToken,
  setToken,
  capturePairingToken,
} from "@/api-clients/bridge";
import { usePersistentBoolean } from "@/use-persistent-boolean";
import { ProjectCache } from "@/project-cache";
import { worktreeNavigation } from "@/sidebar-state";
import { tabShortcutIndex } from "@/tab-shortcuts";
import { useTabDrag } from "@/use-tab-drag";
import { demo, demoContent } from "@/demo";
import type {
  Action,
  ChangedFile,
  Commit,
  FileContent,
  Project,
  Snapshot,
} from "@/types";
type Modal = {
  kind: "connect" | "open" | "action";
  title: string;
  description: string;
  action?: Action;
  fields?: {
    key: string;
    label: string;
    placeholder?: string;
    value?: string;
  }[];
  input?: Record<string, string>;
  danger?: boolean;
};
const initials = (name: string) =>
  name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("");
function Section({
  projectId,
  title,
  icon,
  children,
  action,
  filtering = false,
  hidden = false,
}: {
  projectId: string;
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  filtering?: boolean;
  hidden?: boolean;
}) {
  const [savedOpen, setOpen] = usePersistentBoolean(
    projectId,
    "sections",
    title,
  );
  const open = filtering || savedOpen;
  if (hidden) return null;
  return (
    <section className="nav-section">
      <div className="section-header">
        <button
          aria-expanded={open}
          onClick={() => !filtering && setOpen(!open)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {icon}
          <span>{title}</span>
        </button>
        {action}
      </div>
      {open && children}
    </section>
  );
}
export function App() {
  const [chatOpen, setChatOpen] = useState(false);
  const [chatStarted, setChatStarted] = useState(false);
  const [chatRunning, setChatRunning] = useState(false);
  const [chatWidth, setChatWidth] = useState(
    () => Number(localStorage.getItem("donkey-chat-width")) || 420,
  );
  const [projects, setProjects] = useState<Project[]>([]);
  const [changeCounts, setChangeCounts] = useState<Record<string, number>>({});
  const [active, setActive] = useState(
    () => localStorage.getItem("donkey-diff-active") || "",
  );
  const [loadingProject, setLoadingProject] = useState("");
  const [projectError, setProjectError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const snapshots = useRef(new ProjectCache<Snapshot>());
  const refreshVersions = useRef(new Map<string, number>());
  const selectedFiles = useRef(new Map<string, string>());
  const [openIds, setOpenIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("donkey-diff-tabs") || "[]");
    } catch {
      return [];
    }
  });
  const [selectedTab, setSelectedTab] = useState(
    () =>
      localStorage.getItem("donkey-diff-selected-tab") ||
      localStorage.getItem("donkey-diff-active") ||
      "",
  );
  const [tabWorktrees, setTabWorktrees] = useState<Record<string, string>>(
    () => {
      try {
        return JSON.parse(
          localStorage.getItem("donkey-diff-tab-worktrees") || "{}",
        );
      } catch {
        return {};
      }
    },
  );
  const activeTab = selectedTab || active;
  const projectForTab = (id: string) => {
    const worktree = tabWorktrees[id];
    return projects.some((project) => project.id === worktree) ? worktree : id;
  };
  const [state, setState] = useState<Snapshot>(demo);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sidebarId = state.worktrees[0]?.path || state.project.id || "preview";
  const [connected, setConnected] = useState(false);
  const [busyByTab, setBusyByTab] = useState<Record<string, Action>>({});
  const busy = busyByTab[activeTab];
  const [modalSubmitting, setModalSubmitting] = useState(false);
  const [syncText, setSyncText] = useState("Example workspace");
  const [selectedCommits, setSelectedCommits] = useState<string[]>([]);
  const [historyRef, setHistoryRef] = useState("");
  const [historyData, setHistoryData] = useState<{
    id: string;
    ref: string;
    commits: Commit[];
  } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyRequest = useRef(0);
  const worktreeRequest = useRef(0);
  const commitFiles = useRef(new ProjectCache<ChangedFile[]>(64));
  const commitContents = useRef(new ProjectCache<FileContent>(64));
  const commitTrees = useRef(new ProjectCache<string[]>(32));
  const historyCache = useRef(new ProjectCache<Commit[]>(24));
  const visibleCommits = historyData?.commits ?? state.commits;
  const changingHistoryProject = historyLoading && historyData?.id !== active;
  const historySelection = visibleCommits.filter((c) =>
    selectedCommits.includes(c.hash),
  );
  const commit = historySelection[0]?.hash;
  const comparisonBase =
    historySelection.length === 2 ? historySelection[1].hash : undefined;
  const manyCommits = historySelection.length > 2;
  const [files, setFiles] = useState<ChangedFile[]>(demo.files);
  const [loadedFilesContext, setLoadedFilesContext] = useState("");
  const filesContext = `${active}:${commit || ""}:${comparisonBase || ""}`;
  const [selected, setSelected] = useState("src/workspace.tsx");
  const [content, setContent] = useState<FileContent | null>(demoContent);
  const [fileLoading, setFileLoading] = useState(false);
  const lastFileRequest = useRef("");
  const workingContents = useRef(new Map<string, FileContent>());
  const selectedIsFolder = files.some((file) =>
    file.path.startsWith(`${selected}/`),
  );
  const [full, setFull] = useState(false);
  const [split, setSplit] = useState(false);
  const [stageLayer, setStageLayer] = useState<StageLayer>("unstaged");
  const [filter, setFilter] = useState("");
  const [navFilter, setNavFilter] = useState("");
  const navQuery = navFilter.trim().toLowerCase();
  const matchingProjects = projects.filter((p) =>
    `${p.name} ${p.path}`.toLowerCase().includes(navQuery),
  );
  const worktrees = [
    ...new Map(state.worktrees.map((w) => [w.path, w])).values(),
  ];
  const worktreeLabel = (w: Snapshot["worktrees"][number]) => {
    const name = w.path.split("/").pop() || w.path;
    return worktrees.filter((other) => other.path.split("/").pop() === name)
      .length > 1
      ? `${name} · ${w.branch}`
      : name;
  };
  const projectLabel = (p: Project) => {
    if (
      projects.filter(
        (other) => openIds.includes(other.id) && other.name === p.name,
      ).length < 2
    )
      return p.name;
    const tree = worktrees.find((w) => w.path === p.path);
    return `${p.name} · ${tree?.branch || p.path.split("/").at(-2)}`;
  };
  const matchingWorktrees = worktrees.filter((w) =>
    `${w.path} ${w.branch}`.toLowerCase().includes(navQuery),
  );
  const matchingBranches = state.branches.filter(
    (b) => !b.remote && b.name.toLowerCase().includes(navQuery),
  );
  const matchingRemotes = state.remotes.filter(
    (name) =>
      name.toLowerCase().includes(navQuery) ||
      state.branches.some(
        (b) =>
          b.remote &&
          b.name.startsWith(`${name}/`) &&
          b.name.toLowerCase().includes(navQuery),
      ),
  );
  const matchingTags = state.tags.filter((name) =>
    name.toLowerCase().includes(navQuery),
  );
  const matchingStashes = state.stashes.filter((stash) =>
    `${stash.ref} ${stash.subject}`.toLowerCase().includes(navQuery),
  );
  const [mode, setMode] = useState<"changes" | "tree" | "commit">("changes");
  const [view, setView] = useState<"changes" | "history">("changes");
  const tabViews = useRef(new Map<string, "changes" | "history">());
  useEffect(() => {
    if (state.project.id === active && !loadingProject)
      tabViews.current.set(active, view);
  }, [active, view, loadingProject, state.project.id]);
  const localChanges = view === "changes" && !commit;
  const loadingLocalProject =
    localChanges && loadingProject === active && !snapshots.current.get(active);
  useEffect(() => {
    if (!localChanges) return;
    const file = files.find((file) => file.path === selected);
    if (!file) return;
    if (stageLayer === "staged" && !file.staged) setStageLayer("unstaged");
    else if (
      stageLayer === "unstaged" &&
      !(file.unstaged ?? !file.staged) &&
      file.staged
    )
      setStageLayer("staged");
  }, [files, selected, stageLayer, localChanges]);
  const [autoSync, setAutoSync] = useState(
    () => localStorage.getItem("donkey-diff-auto-sync") !== "false",
  );
  const [mobileNav, setMobileNav] = useState(false);
  const [showHistory, setShowHistory] = usePersistentBoolean(
    activeTab || "preview",
    "panels",
    "history",
  );
  const [modal, setModal] = useState<Modal | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [modalError, setModalError] = useState("");
  const [actionError, setActionError] = useState("");
  const [fileError, setFileError] = useState<{
    context: string;
    message: string;
  } | null>(null);
  const fileErrorContext = JSON.stringify([
    active,
    selected,
    commit,
    comparisonBase,
    view,
    stageLayer,
  ]);
  const visibleFileError =
    fileError?.context === fileErrorContext ? fileError.message : "";
  useEffect(() => {
    setFileError(null);
  }, [fileErrorContext]);
  const [revision, setRevision] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const syncBusy = useRef(new Set<string>());
  const showModal = (value: Modal) => {
    setValues(
      Object.fromEntries(
        (value.fields || []).map((f) => [f.key, f.value || ""]),
      ),
    );
    setModalError("");
    setModal(value);
  };
  const connect = useCallback(async () => {
    setSyncText("Connecting to local bridge…");
    const list = await bridge.projects();
    setProjects(list);
    setConnected(true);
    setSelectedTab((previous) =>
      list.some((p) => p.id === previous) ? previous : list[0]?.id || "",
    );
    setOpenIds((previous) => {
      const valid = previous.filter((id) => list.some((p) => p.id === id));
      return valid.length ? valid : list.slice(0, 3).map((p) => p.id);
    });
    setActive((previous) =>
      list.some((p) => p.id === previous) ? previous : list[0]?.id || "",
    );
    setSyncText(
      window.donkeyDiffDesktop ? "Ready" : "Connected to local bridge",
    );
    if (!list.length) {
      setState({
        ...demo,
        project: { id: "", name: "No project", path: "" },
        files: [],
        commits: [],
        branches: [],
        worktrees: [],
        stashes: [],
        remotes: [],
        tags: [],
      });
      setFiles([]);
      setContent(null);
      setSelected("");
    }
    setModal(null);
  }, []);
  useEffect(() => {
    const pair = () => {
      capturePairingToken();
      if (getToken())
        connect().catch((error) => {
          setSyncText(error.message);
          setActionError(error.message);
        });
    };
    pair();
    window.addEventListener("hashchange", pair);
    window.addEventListener("pageshow", pair);
    return () => {
      window.removeEventListener("hashchange", pair);
      window.removeEventListener("pageshow", pair);
    };
  }, [connect]);
  useEffect(() => {
    localStorage.setItem("donkey-diff-selected-tab", selectedTab);
    localStorage.setItem(
      "donkey-diff-tab-worktrees",
      JSON.stringify(tabWorktrees),
    );
  }, [selectedTab, tabWorktrees]);
  useEffect(
    () => localStorage.setItem("donkey-diff-tabs", JSON.stringify(openIds)),
    [openIds],
  );
  useEffect(
    () => localStorage.setItem("donkey-diff-auto-sync", String(autoSync)),
    [autoSync],
  );
  useEffect(() => {
    if (connected && !active) {
      setState({
        ...demo,
        project: { id: "", name: "Open a repository", path: "" },
        branch: "—",
        files: [],
        branches: [],
        worktrees: [],
        commits: [],
        stashes: [],
        tags: [],
        remotes: [],
      });
      setSelectedCommits([]);
      setFiles([]);
      setSelected("");
      setContent(null);
    }
  }, [active, connected]);
  const refresh = useCallback(async (id: string) => {
    const version = (refreshVersions.current.get(id) || 0) + 1;
    refreshVersions.current.set(id, version);
    try {
      const next = await snapshots.current.load(id, () => bridge.snapshot(id));
      if (
        activeRef.current === id &&
        refreshVersions.current.get(id) === version
      ) {
        setChangeCounts((previous) => ({
          ...previous,
          [id]: next.files.length,
        }));
        setProjectError(null);
        setState(next);
        setRevision((n) => n + 1);
      }
    } catch (error) {
      if (
        activeRef.current === id &&
        refreshVersions.current.get(id) === version
      ) {
        if (snapshots.current.get(id))
          setActionError(`Refresh failed: ${(error as Error).message}`);
        else setProjectError({ id, message: (error as Error).message });
      }
      throw error;
    }
  }, []);
  const inactiveTabIds = [...new Set(openIds.map(projectForTab))]
    .filter(
      (id) => id !== active && projects.some((project) => project.id === id),
    )
    .join(",");
  useEffect(() => {
    if (!connected || !inactiveTabIds) return;
    let cancelled = false;
    const pending = new Set<string>();
    const updateCounts = () => {
      if (document.visibilityState !== "visible") return;
      for (const id of inactiveTabIds.split(",")) {
        if (pending.has(id)) continue;
        pending.add(id);
        void bridge
          .files(id)
          .then((changedFiles) => {
            if (cancelled) return;
            setChangeCounts((previous) =>
              previous[id] === changedFiles.length
                ? previous
                : { ...previous, [id]: changedFiles.length },
            );
          })
          .catch(() => undefined)
          .finally(() => pending.delete(id));
      }
    };
    updateCounts();
    window.addEventListener("focus", updateCounts);
    document.addEventListener("visibilitychange", updateCounts);
    const timer = setInterval(updateCounts, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", updateCounts);
      document.removeEventListener("visibilitychange", updateCounts);
    };
  }, [connected, inactiveTabIds]);
  const doSync = useCallback(
    async (id: string) => {
      if (syncBusy.current.has(id)) return;
      syncBusy.current.add(id);
      try {
        const result = await bridge.action(id, "sync");
        if (activeRef.current === id) {
          setSyncText(result.message);
          await refresh(id);
        }
      } catch (error) {
        if (activeRef.current === id) setSyncText((error as Error).message);
      } finally {
        syncBusy.current.delete(id);
      }
    },
    [refresh],
  );
  useEffect(() => {
    if (!connected || !active) return;
    setProjectError(null);
    setActionError("");
    historyRequest.current++;
    const request = historyRequest.current;
    setHistoryLoading(false);
    setHistoryRef("");
    localStorage.setItem("donkey-diff-active", active);
    const cached = snapshots.current.get(active);
    const nextView = tabViews.current.get(active) || "changes";
    if (nextView === "history") {
      if (cached) {
        setHistoryData({ id: active, ref: "HEAD", commits: cached.commits });
        setSelectedCommits(cached.commits[0] ? [cached.commits[0].hash] : []);
      } else {
        setHistoryData(
          (previous) =>
            previous ?? {
              id: stateRef.current.project.id,
              ref: "HEAD",
              commits: stateRef.current.commits,
            },
        );
      }
    } else {
      setHistoryData(null);
      setSelectedCommits([]);
      setMode("changes");
    }
    setView(nextView);
    setFilter("");
    if (nextView === "changes") {
      if (cached) {
        setSelected(
          selectedFiles.current.get(active) || cached.files[0]?.path || "",
        );
        setFiles(cached.files);
      } else if (stateRef.current.project.id === "demo") {
        setContent(null);
        setSelected("");
        setFiles([]);
      }
    }
    if (cached) setState(cached);
    else {
      const project = projects.find((p) => p.id === active);
      const navigation =
        project && worktreeNavigation(stateRef.current, project);
      setState(
        navigation || {
          ...demo,
          project: project || { id: active, name: "Loading…", path: "" },
          files: [],
          commits: [],
          branches: [],
          worktrees: [],
          stashes: [],
          remotes: [],
          tags: [],
          ahead: 0,
          behind: 0,
        },
      );
    }
    setLoadingProject(active);
    let cancelled = false;
    if (!cached)
      void bridge
        .navigation(active)
        .then((navigation) => {
          if (
            !cancelled &&
            activeRef.current === active &&
            !snapshots.current.get(active)
          )
            setState(navigation);
        })
        .catch(() => undefined);
    if (nextView === "history") {
      setHistoryLoading(!cached?.commits.length);
      void historyCache.current
        .load(`${active}:HEAD`, () => bridge.history(active, "HEAD"))
        .then((commits) => {
          if (cancelled || historyRequest.current !== request) return;
          setHistoryData({ id: active, ref: "HEAD", commits });
          setSelectedCommits(commits[0] ? [commits[0].hash] : []);
          if (!commits.length) {
            setFiles([]);
            setSelected("");
            setContent(null);
          }
        })
        .catch((error) => {
          if (!cancelled && historyRequest.current === request)
            setActionError((error as Error).message);
        })
        .finally(() => {
          if (!cancelled && historyRequest.current === request)
            setHistoryLoading(false);
        });
    }
    refresh(active)
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) return;
        setLoadingProject((id) => (id === active ? "" : id));
      });
    return () => {
      cancelled = true;
    };
    // Project metadata changes must not reset the current tab's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, connected, refresh]);
  useEffect(() => {
    if (connected && active && autoSync && !chatRunning) void doSync(active);
  }, [active, connected, autoSync, chatRunning, doSync]);
  useEffect(() => {
    if (!connected || !active) return;
    const onFocus = () => {
      if (document.visibilityState === "visible") {
        void refresh(active).catch(() => setSyncText("Local bridge offline"));
        if (autoSync && !chatRunning) void doSync(active);
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        void refresh(active).catch(() => setSyncText("Local bridge offline"));
    }, 10000);
    const syncTimer = setInterval(() => {
      if (autoSync && !chatRunning && document.visibilityState === "visible")
        void doSync(active);
    }, 60000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      clearInterval(timer);
      clearInterval(syncTimer);
    };
  }, [connected, active, autoSync, chatRunning, refresh, doSync]);
  useEffect(() => {
    if (
      !connected ||
      !active ||
      state.project.id !== active ||
      projectError?.id === active ||
      manyCommits ||
      loadingLocalProject ||
      (view === "history" && (!commit || changingHistoryProject))
    )
      return;
    let ignore = false;
    async function load() {
      const key = `${active}:${commit}:${comparisonBase || ""}`;
      const changed = commit
        ? (commitFiles.current.get(key) ??
          (await commitFiles.current.load(key, () =>
            bridge.files(active, commit, comparisonBase),
          )))
        : state.files;
      const list =
        mode === "tree"
          ? (commit
              ? (commitTrees.current.get(`${active}:${commit}`) ??
                (await commitTrees.current.load(`${active}:${commit}`, () =>
                  bridge.tree(active, commit),
                )))
              : await bridge.tree(active, commit)
            ).map(
              (path) =>
                changed.find((f) => f.path === path) || {
                  path,
                  status: "",
                  staged: false,
                  conflict: false,
                  additions: 0,
                  deletions: 0,
                },
            )
          : changed;
      if (ignore) return;
      setFiles(list);
      setLoadedFilesContext(filesContext);
      setSelected((previous) =>
        list.some(
          (f) => f.path === previous || f.path.startsWith(`${previous}/`),
        )
          ? previous
          : list[0]?.path || "",
      );
    }
    load().catch((e) => {
      if (!ignore && activeRef.current === active) setActionError(e.message);
    });
    return () => {
      ignore = true;
    };
  }, [
    connected,
    active,
    state,
    commit,
    comparisonBase,
    manyCommits,
    mode,
    projectError,
    view,
    filesContext,
    changingHistoryProject,
    loadingLocalProject,
  ]);
  useEffect(() => {
    if (
      !connected ||
      !active ||
      state.project.id !== active ||
      projectError?.id === active ||
      (view === "history" && (!commit || changingHistoryProject)) ||
      loadedFilesContext !== filesContext
    )
      return;
    let ignore = false;
    if (!selected || manyCommits || selectedIsFolder) {
      setFileLoading(false);
      setContent(null);
      return;
    }
    const controller = new AbortController();
    const key = `${active}:${commit}:${comparisonBase || ""}:${selected}`;
    const requestKey = `${key}:${localChanges ? stageLayer : ""}`;
    const cached = commit
      ? commitContents.current.get(key)
      : workingContents.current.get(requestKey);
    if (cached) {
      setContent(cached);
      setFileLoading(false);
    } else if (lastFileRequest.current !== requestKey) setFileLoading(true);
    lastFileRequest.current = requestKey;
    if (commit && cached) return;
    // Coalesce held-arrow repeats before spawning Git reads. The final selection
    // always wins; superseded reads are cancelled through the HTTP/desktop bridge.
    const timer = setTimeout(() => {
      const read = () =>
        bridge.file(
          active,
          selected,
          commit,
          comparisonBase,
          localChanges ? stageLayer : undefined,
          controller.signal,
        );
      // Commit cache is immutable. Working files are displayed from cache while
      // revalidating so revisiting a file also reuses its prepared diff.
      read()
        .then((next) => {
          if (ignore) return;
          const previous = cached;
          const same =
            previous &&
            previous.path === next.path &&
            previous.old === next.old &&
            previous.current === next.current &&
            previous.directory === next.directory &&
            previous.binary === next.binary &&
            previous.mediaType === next.mediaType &&
            previous.conflict === next.conflict &&
            previous.ours === next.ours &&
            previous.theirs === next.theirs;
          const value = same ? previous : next;
          // Large media data URLs should not accumulate in the commit cache.
          if (
            commit &&
            (!value.mediaType ||
              value.old.length + value.current.length < 500000)
          )
            void commitContents.current.load(key, () => Promise.resolve(value));
          else if (
            !commit &&
            value.old.length + value.current.length < 500000
          ) {
            workingContents.current.delete(requestKey);
            workingContents.current.set(requestKey, value);
            if (workingContents.current.size > 24)
              workingContents.current.delete(
                workingContents.current.keys().next().value!,
              );
          }
          setContent(value);
          setFileError(null);
        })
        .catch((error) => {
          if (
            !ignore &&
            !controller.signal.aborted &&
            activeRef.current === active
          ) {
            setContent(null);
            setFileError({ context: fileErrorContext, message: error.message });
          }
        })
        .finally(() => {
          if (!ignore) setFileLoading(false);
        });
    }, 35);
    return () => {
      ignore = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    connected,
    active,
    selected,
    selectedIsFolder,
    loadedFilesContext,
    changingHistoryProject,
    filesContext,
    view,
    stageLayer,
    localChanges,
    commit,
    comparisonBase,
    manyCommits,
    revision,
    state.project.id,
    projectError,
    fileErrorContext,
  ]);
  useEffect(() => {
    if (
      connected &&
      active === state.project.id &&
      selected &&
      view === "changes"
    )
      selectedFiles.current.set(active, selected);
  }, [connected, active, state.project.id, selected, view]);
  const requireConnection = () => {
    if (connected) return true;
    showModal({
      kind: "connect",
      title: "Connect your local repositories",
      description:
        "Your code stays on your computer. A small local bridge lets this browser use Git.",
    });
    return false;
  };
  const action = async (type: Action, input: Record<string, string> = {}) => {
    if (!requireConnection() || !active || busy) return;
    const id = active;
    const tab = activeTab;
    setBusyByTab((previous) => ({ ...previous, [tab]: type }));
    setActionError("");
    try {
      const result = await bridge.action(id, type, input);
      const list = await bridge.projects();
      setProjects(list);
      if (type === "worktree-move" || type === "worktree-remove") {
        for (const project of projects.filter(
          (p) => p.id === id || p.path === input.from,
        )) {
          snapshots.current.invalidate(project.id);
          refreshVersions.current.set(
            project.id,
            (refreshVersions.current.get(project.id) || 0) + 1,
          );
        }
        setOpenIds((previous) =>
          previous.filter((openId) => list.some((p) => p.id === openId)),
        );
      }
      setSyncText(type === "sync" ? result.message : "Updated just now");
      if (!list.some((p) => p.id === id)) {
        if (activeRef.current === id) {
          const nextTab =
            list.find((p) => p.id === activeTab)?.id ||
            list.find((p) => openIds.includes(p.id))?.id ||
            list[0]?.id ||
            "";
          const next =
            tabWorktrees[nextTab] !== id &&
            list.some((p) => p.id === tabWorktrees[nextTab])
              ? tabWorktrees[nextTab]
              : nextTab;
          setSelectedTab(nextTab);
          setTabWorktrees((previous) =>
            Object.fromEntries(
              Object.entries(previous).filter(
                ([tab, tree]) => tab !== id && tree !== id,
              ),
            ),
          );
          activeRef.current = next;
          setActive(next);
          setContent(null);
          setFiles([]);
          setSelected("");
          setSelectedCommits([]);
          if (nextTab)
            setOpenIds((previous) =>
              previous.includes(nextTab) ? previous : [...previous, nextTab],
            );
        }
        return;
      }
      await refresh(id);
    } catch (error) {
      if (activeRef.current === id) setActionError((error as Error).message);
      throw error;
    } finally {
      setBusyByTab((previous) => {
        const next = { ...previous };
        delete next[tab];
        return next;
      });
    }
  };
  const run = (type: Action, input: Record<string, string> = {}) =>
    void action(type, input).catch(() => undefined);
  const actionModal = (
    title: string,
    actionType: Action,
    fields: Modal["fields"] = [],
    input: Record<string, string> = {},
    description = "",
    danger = false,
  ) => {
    if (requireConnection())
      showModal({
        kind: "action",
        title,
        action: actionType,
        fields,
        input,
        description,
        danger,
      });
  };
  const openProject = (id: string) => {
    worktreeRequest.current++;
    setActionError("");
    setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setSelectedTab(id);
    const projectId = projectForTab(id);
    if (projectId !== active) {
      activeRef.current = projectId;
      setActive(projectId);
    }
    setMobileNav(false);
  };
  const openTabs = openIds.flatMap((id) => {
    const project = projects.find((p) => p.id === id);
    return project ? [project] : [];
  });
  const tabDrag = useTabDrag(
    openTabs.map((p) => p.id),
    openProject,
    (order) =>
      setOpenIds((previous) => [
        ...order,
        ...previous.filter((id) => !order.includes(id)),
      ]),
  );
  const tabShortcutRef = useRef<(event: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    tabShortcutRef.current = (event) => {
      if (!connected || event.defaultPrevented) return;
      const isMac = window.donkeyDiffDesktop
        ? window.donkeyDiffDesktop.platform === "darwin"
        : /Mac|iPhone|iPad/.test(navigator.platform);
      const index = tabShortcutIndex(
        event,
        isMac,
        openTabs.findIndex((project) => project.id === activeTab),
        openTabs.length,
      );
      if (index === undefined) return;
      event.preventDefault();
      openProject(openTabs[index].id);
    };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => tabShortcutRef.current(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const closeProjectTab = (id: string) => {
    const remaining = openIds.filter((tab) => tab !== id);
    setOpenIds(remaining);
    if (activeTab !== id) return;
    worktreeRequest.current++;
    const nextTab = remaining[0] || "";
    const nextProject = nextTab ? projectForTab(nextTab) : "";
    setSelectedTab(nextTab);
    activeRef.current = nextProject;
    setActive(nextProject);
    if (!nextProject) {
      setFiles([]);
      setContent(null);
    }
  };
  const openWorktree = async (path: string) => {
    if (!requireConnection()) return;
    const request = ++worktreeRequest.current;
    const source = active;
    try {
      const project =
        projects.find((p) => p.path === path) || (await bridge.add(path));
      if (activeRef.current !== source || worktreeRequest.current !== request)
        return;
      setProjects((previous) =>
        previous.some((p) => p.id === project.id)
          ? previous
          : [...previous, project],
      );
      tabViews.current.set(project.id, view);
      setTabWorktrees((previous) => ({ ...previous, [activeTab]: project.id }));
      setActionError("");
      activeRef.current = project.id;
      setActive(project.id);
      setMobileNav(false);
      if (project.id === active && view === "history") void browseRef("HEAD");
    } catch (error) {
      if (activeRef.current === source && worktreeRequest.current === request)
        setActionError((error as Error).message);
    }
  };
  const browseRef = async (ref: string) => {
    if (!requireConnection()) return;
    worktreeRequest.current++;
    const id = active;
    const request = ++historyRequest.current;
    const cacheKey = `${id}:${ref}`;
    const cached = historyCache.current.get(cacheKey);
    setActionError("");
    setView("history");
    if (view !== "history") {
      setShowHistory(true);
      setMode("changes");
    }
    setHistoryLoading(!cached);
    setHistoryRef(ref);
    if (cached) {
      setHistoryData({ id, ref, commits: cached });
      setSelectedCommits(cached[0] ? [cached[0].hash] : []);
    }
    try {
      const commits = await historyCache.current.load(cacheKey, () =>
        bridge.history(id, ref),
      );
      if (activeRef.current !== id || historyRequest.current !== request)
        return;
      setHistoryData({ id, ref, commits });
      if (!commits.length) {
        setFiles([]);
        setSelected("");
        setContent(null);
      }
      setSelectedCommits(commits[0] ? [commits[0].hash] : []);
    } catch (error) {
      if (activeRef.current === id && historyRequest.current === request)
        setActionError((error as Error).message);
    } finally {
      if (activeRef.current === id && historyRequest.current === request)
        setHistoryLoading(false);
    }
  };
  const selectCommits = (ids: string[]) => {
    historyRequest.current++;
    setHistoryLoading(false);
    setSelectedCommits(ids);
    if (!connected && !ids.length) setFiles(demo.files);
    if (!connected && !ids.length) {
      setSelected(demoContent.path);
      setContent(demoContent);
    }
  };
  const selectCommit = (hash?: string) => selectCommits(hash ? [hash] : []);
  const selectFile = (path: string) => {
    if (files.some((file) => file.path.startsWith(`${path}/`))) {
      setSelected(path);
      setContent(null);
      return;
    }
    if (!connected) {
      setSelected(path);
      setContent(
        path === demoContent.path
          ? demoContent
          : {
              path,
              old: "// Before\n",
              current:
                "// Connect your local repositories to view this file.\n",
              binary: false,
              conflict: false,
            },
      );
    } else setSelected(path);
  };
  const submitModal = async () => {
    if (modalSubmitting) return;
    setModalSubmitting(true);
    setModalError("");
    try {
      if (modal?.kind === "connect") {
        if (values.token) {
          setToken(values.token.trim());
          await connect();
        } else {
          window.location.href = `http://127.0.0.1:43127/pair?origin=${encodeURIComponent(location.origin)}`;
          return;
        }
      } else if (modal?.kind === "open") {
        const project = await bridge.add(values.path);
        setProjects(await bridge.projects());
        openProject(project.id);
      } else if (modal?.action) {
        await action(modal.action, { ...modal.input, ...values });
      }
      setModal(null);
    } catch (error) {
      setModalError((error as Error).message);
    } finally {
      setModalSubmitting(false);
    }
  };
  const currentCommit =
    historySelection.length === 1 ? historySelection[0] : undefined;
  const changedCount = loadingLocalProject ? files.length : state.files.length;
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const openDialog = () => {
    if (window.donkeyDiffDesktop) {
      void window.donkeyDiffDesktop
        .chooseProject()
        .then(async (path) => {
          if (!path) return;
          const project = await bridge.add(path);
          setProjects(await bridge.projects());
          openProject(project.id);
        })
        .catch((error) => setActionError(error.message));
      return;
    }
    if (requireConnection())
      showModal({
        kind: "open",
        title: "Open a local repository",
        description:
          "Enter the absolute path to a Git repository on this computer.",
        fields: [
          {
            key: "path",
            label: "Repository path",
            placeholder: "/Users/you/projects/my-project",
          },
        ],
      });
  };
  const openProjectMenuRef = useRef(openDialog);
  useEffect(() => {
    openProjectMenuRef.current = openDialog;
  });
  useEffect(
    () =>
      window.donkeyDiffDesktop?.onOpenProject?.(() =>
        openProjectMenuRef.current(),
      ),
    [],
  );
  const autoSyncControl = (
    <label className="auto-sync" title={syncText}>
      <Switch.Root
        checked={autoSync}
        onCheckedChange={setAutoSync}
        className="switch"
        aria-label="Auto sync"
      >
        <Switch.Thumb className="switch-thumb" />
      </Switch.Root>
      Auto sync
    </label>
  );
  const noProject = !active && (connected || !!window.donkeyDiffDesktop);
  return (
    <div className="app-shell">
      <div className="window-titlebar">
        <div
          className={`project-tabs ${window.donkeyDiffDesktop?.platform === "darwin" ? "native-tabs" : ""} ${tabDrag.dragging ? "tab-dragging" : ""}`}
        >
          {noProject && (
            <div className="project-tab active empty-project-tab">
              <div className="tab-select" aria-label="New project tab">
                <GitCompare size={14} />
                <span className="tab-label">New Project</span>
              </div>
            </div>
          )}
          {(noProject ? [] : connected ? openTabs : [demo.project]).map(
            (p, index) => {
              const label = projectLabel(p);
              const suffixLength = label.length > 20 ? 8 : 0;
              const count = connected
                ? changeCounts[projectForTab(p.id)]
                : demo.files.length;
              return (
                <div
                  key={p.id}
                  className={`project-tab ${p.id === activeTab || !connected ? "active" : ""}`}
                  {...(connected ? tabDrag.tabProps(index) : {})}
                >
                  <button
                    className="tab-select"
                    aria-pressed={p.id === activeTab || !connected}
                    aria-label={label}
                    aria-describedby={
                      count !== undefined && count > 0
                        ? `tab-count-${p.id}`
                        : undefined
                    }
                    title={p.path}
                    onClick={() => openProject(p.id)}
                  >
                    <Folder size={13} />
                    <span className="tab-label">
                      <span className="tab-label-start">
                        {suffixLength ? label.slice(0, -suffixLength) : label}
                      </span>
                      {suffixLength > 0 && (
                        <span className="tab-label-end">
                          {label.slice(-suffixLength)}
                        </span>
                      )}
                    </span>
                    {count !== undefined && count > 0 && (
                      <span
                        id={`tab-count-${p.id}`}
                        className="tab-count"
                        aria-label={`${count} changed file${count === 1 ? "" : "s"}`}
                        title={`${count} changed file${count === 1 ? "" : "s"}`}
                      >
                        ({count})
                      </span>
                    )}
                  </button>
                  <button
                    className="tab-close"
                    aria-label={`Close ${p.name} tab`}
                    onClick={() => closeProjectTab(p.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            },
          )}
          {!noProject && (
            <Dropdown
              trigger={
                <button className="add-tab" aria-label="Open project tab">
                  <Plus size={17} />
                </button>
              }
              items={[
                ...projects
                  .filter((p) => p.isWorktree === false)
                  .map((p) => ({
                    label: p.name,
                    icon: <Folder size={16} />,
                    onSelect: () => openProject(p.id),
                  })),
                {
                  label: "Open repository…",
                  icon: <FolderOpen size={16} />,
                  separatorBefore: true,
                  onSelect: openDialog,
                },
              ]}
            />
          )}
        </div>
        {window.donkeyDiffDesktop?.development && (
          <span className="dev-indicator" title="Donkey Diff Dev">
            <GitCompare size={15} aria-hidden="true" />
            Dev
          </span>
        )}
        <UpdateButton
          busy={modalSubmitting || Object.keys(busyByTab).length > 0}
        />
      </div>
      <div className="project-workspace">
        {noProject ? (
          <WorkspaceLayout
            projectId="empty"
            kind="repository"
            leading={
              <Sidebar className="empty-sidebar">
                <div className="project-heading">
                  <GitCompare size={18} />
                  <span>Donkey Diff</span>
                </div>
                <div className="sidebar-scroll">
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      className="nav-row"
                      title={project.path}
                      onClick={() => openProject(project.id)}
                    >
                      <Folder size={15} />
                      <span>{project.name}</span>
                    </button>
                  ))}
                </div>
              </Sidebar>
            }
          >
            <main className="add-project-empty">
              <button className="add-project-button" onClick={openDialog}>
                <Plus size={20} />
                Add Project
              </button>
            </main>
          </WorkspaceLayout>
        ) : (
          <WorkspaceLayout
            projectId={active || "preview"}
            kind="repository"
            leading={
              <Sidebar className={mobileNav ? "mobile-open" : ""}>
                <div className="project-heading">
                  <span>
                    {projects.find((project) => project.id === activeTab)
                      ?.name || state.project.name}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="mobile-close"
                    onClick={() => setMobileNav(false)}
                    aria-label="Close navigation"
                  >
                    <X size={16} />
                  </Button>
                </div>
                <nav className="primary-nav">
                  <button
                    className={view === "changes" ? "active" : ""}
                    onClick={() => {
                      historyRequest.current++;
                      worktreeRequest.current++;
                      setHistoryLoading(false);
                      setHistoryRef("");
                      setHistoryData(null);
                      setActionError("");
                      setView("changes");
                      setMode("changes");
                      selectCommit();
                    }}
                  >
                    <FileDiff size={16} />
                    <span>Local Changes</span>
                    <span className="count">{changedCount}</span>
                  </button>
                  <button
                    className={view === "history" ? "active" : ""}
                    onClick={() => {
                      void browseRef("HEAD");
                    }}
                  >
                    <History size={16} />
                    <span>All Commits</span>
                  </button>
                </nav>
                <div className="sidebar-filter">
                  <Search size={13} />
                  <input
                    aria-label="Search sidebar"
                    placeholder="Search"
                    value={navFilter}
                    onChange={(e) => setNavFilter(e.target.value)}
                  />
                </div>
                <div className="sidebar-scroll">
                  {navQuery && matchingProjects.length > 0 && (
                    <Section projectId={sidebarId} title="Projects" filtering>
                      {matchingProjects.map((project) => (
                        <button
                          key={project.id}
                          className="nav-row"
                          title={project.path}
                          onClick={() => {
                            openProject(project.id);
                            setNavFilter("");
                          }}
                        >
                          <Folder size={14} />
                          <span>{project.name}</span>
                          {project.id === active && (
                            <span className="current-dot" />
                          )}
                        </button>
                      ))}
                    </Section>
                  )}
                  {loadingProject === active && !state.worktrees.length && (
                    <div className="nav-empty" role="status">
                      Loading repository…
                    </div>
                  )}
                  {navQuery &&
                    !matchingProjects.length &&
                    !matchingWorktrees.length &&
                    !matchingBranches.length &&
                    !matchingRemotes.length &&
                    !matchingTags.length &&
                    !matchingStashes.length && (
                      <div className="nav-empty" role="status">
                        No matches found
                      </div>
                    )}
                  <Section
                    projectId={sidebarId}
                    title="Worktrees"
                    filtering={!!navQuery}
                    hidden={!!navQuery && !matchingWorktrees.length}
                    action={
                      <button
                        className="section-add"
                        aria-label="Create worktree"
                        onClick={() =>
                          actionModal(
                            "Create worktree",
                            "worktree-create",
                            [
                              {
                                key: "name",
                                label: "New branch",
                                placeholder: "feat/my-feature",
                              },
                              {
                                key: "path",
                                label: "New directory",
                                placeholder: "/Users/you/projects/my-feature",
                              },
                            ],
                            {},
                            "Create a separate checkout on a new branch.",
                          )
                        }
                      >
                        <Plus size={13} />
                      </button>
                    }
                  >
                    {matchingWorktrees.map((w) => (
                      <div className="nav-row-group" key={w.path}>
                        <button
                          className="nav-row"
                          title={w.path}
                          data-browse-worktree
                          onClick={() => void openWorktree(w.path)}
                        >
                          <Folder size={14} />
                          <span>{worktreeLabel(w)}</span>
                          {w.path === state.project.path && (
                            <span className="current-dot" />
                          )}
                        </button>
                        <Dropdown
                          trigger={
                            <button
                              className="row-menu"
                              aria-label={`Manage worktree ${worktreeLabel(w)}`}
                            >
                              <MoreHorizontal size={13} />
                            </button>
                          }
                          items={[
                            {
                              label: "Move worktree…",
                              onSelect: () =>
                                actionModal(
                                  "Move worktree",
                                  "worktree-move",
                                  [{ key: "path", label: "New path" }],
                                  { from: w.path },
                                  "The worktree will be moved to the new directory.",
                                ),
                            },
                            {
                              label: "Remove worktree…",
                              danger: true,
                              onSelect: () =>
                                actionModal(
                                  "Remove worktree?",
                                  "worktree-remove",
                                  [],
                                  { from: w.path },
                                  "Remove this checkout. Git will refuse if it contains unsaved changes.",
                                  true,
                                ),
                            },
                          ]}
                        />
                      </div>
                    ))}
                  </Section>
                  <Section
                    projectId={sidebarId}
                    title="Branches"
                    filtering={!!navQuery}
                    hidden={!!navQuery && !matchingBranches.length}
                    action={
                      <button
                        className="section-add"
                        aria-label="Create branch"
                        onClick={() =>
                          actionModal(
                            "Create branch",
                            "branch-create",
                            [
                              {
                                key: "name",
                                label: "Branch name",
                                placeholder: "feat/my-feature",
                              },
                            ],
                            {},
                            "Create and switch to a branch from the current HEAD.",
                          )
                        }
                      >
                        <Plus size={13} />
                      </button>
                    }
                  >
                    <BranchTree
                      projectId={sidebarId}
                      filtering={!!navQuery}
                      branches={matchingBranches}
                      renderBranch={(b) => (
                        <div className="nav-row-group" key={b.name}>
                          <button
                            className={`nav-row ${b.current ? "current" : ""} ${historyRef === (b.ref || `refs/heads/${b.name}`) && view === "history" ? "selected" : ""}`}
                            data-browse-ref
                            onClick={() =>
                              void browseRef(b.ref || `refs/heads/${b.name}`)
                            }
                          >
                            {b.current ? (
                              <Check size={14} />
                            ) : (
                              <GitBranch size={14} />
                            )}
                            <span title={b.name}>
                              {b.name.split("/").pop()}
                            </span>
                            {b.current &&
                              (state.ahead > 0 || state.behind > 0) && (
                                <small className="branch-sync-counts">
                                  {state.behind > 0 && (
                                    <span
                                      aria-label={`${state.behind} incoming commits`}
                                    >
                                      {state.behind}↓
                                    </span>
                                  )}
                                  {state.ahead > 0 && (
                                    <span
                                      aria-label={`${state.ahead} outgoing commits`}
                                    >
                                      {state.ahead}↑
                                    </span>
                                  )}
                                </small>
                              )}
                          </button>
                          <Dropdown
                            trigger={
                              <button
                                className="row-menu"
                                aria-label={`Manage branch ${b.name}`}
                              >
                                <MoreHorizontal size={13} />
                              </button>
                            }
                            items={[
                              {
                                label: "Checkout branch",
                                disabled: b.current,
                                onSelect: () => {
                                  const tree = worktrees.find(
                                    (w) => w.branch === b.name,
                                  );
                                  if (tree) void openWorktree(tree.path);
                                  else run("branch-switch", { name: b.name });
                                },
                              },
                              {
                                label: "Rename…",
                                onSelect: () =>
                                  actionModal(
                                    "Rename branch",
                                    "branch-rename",
                                    [
                                      {
                                        key: "name",
                                        label: "New name",
                                        value: b.name,
                                      },
                                    ],
                                    { from: b.name },
                                  ),
                              },
                              {
                                label: "Delete branch…",
                                danger: true,
                                disabled: b.current,
                                onSelect: () =>
                                  actionModal(
                                    "Delete branch?",
                                    "branch-delete",
                                    [],
                                    { name: b.name },
                                    `Delete ${b.name}. Unmerged branches are protected.`,
                                    true,
                                  ),
                              },
                            ]}
                          />
                        </div>
                      )}
                    />
                  </Section>
                  <Section
                    projectId={sidebarId}
                    title="Remotes"
                    filtering={!!navQuery}
                    hidden={!!navQuery && !matchingRemotes.length}
                  >
                    {matchingRemotes.map((r) => (
                      <Section
                        key={r}
                        projectId={sidebarId}
                        title={r}
                        icon={<Github size={14} />}
                        filtering={!!navQuery}
                      >
                        <BranchTree
                          projectId={sidebarId}
                          filtering={!!navQuery}
                          prefix={`${r}/`}
                          branches={state.branches.filter(
                            (b) =>
                              b.remote &&
                              b.name.startsWith(`${r}/`) &&
                              !b.name.endsWith("/HEAD") &&
                              (r.toLowerCase().includes(navQuery) ||
                                b.name.toLowerCase().includes(navQuery)),
                          )}
                          renderBranch={(b) => (
                            <button
                              key={b.name}
                              data-browse-ref
                              className={`nav-row ${historyRef === b.ref && view === "history" ? "selected" : ""}`}
                              title={b.name}
                              onClick={() =>
                                void browseRef(
                                  b.ref || `refs/remotes/${b.name}`,
                                )
                              }
                            >
                              <GitBranch size={14} />
                              <span>{b.name.split("/").pop()}</span>
                            </button>
                          )}
                        />
                      </Section>
                    ))}
                    {!state.remotes.length && (
                      <div className="nav-empty">No remotes configured</div>
                    )}
                  </Section>
                  <Section
                    projectId={sidebarId}
                    title="Tags"
                    filtering={!!navQuery}
                    hidden={!!navQuery && !matchingTags.length}
                  >
                    {matchingTags.length ? (
                      matchingTags.map((t) => (
                        <button
                          data-browse-ref
                          className={`nav-row ${historyRef === `refs/tags/${t}` && view === "history" ? "selected" : ""}`}
                          key={t}
                          title={t}
                          onClick={() => void browseRef(`refs/tags/${t}`)}
                        >
                          <Tag size={13} />
                          <span className="tag-name">
                            <span>
                              {t.includes("-")
                                ? t.slice(0, t.lastIndexOf("-") + 1)
                                : ""}
                            </span>
                            <span>{t.slice(t.lastIndexOf("-") + 1)}</span>
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className="nav-empty">No tags yet</div>
                    )}
                  </Section>
                  <Section
                    projectId={sidebarId}
                    title="Stashes"
                    filtering={!!navQuery}
                    hidden={!!navQuery && !matchingStashes.length}
                    action={
                      <button
                        className="section-add"
                        aria-label="Create stash"
                        onClick={() =>
                          actionModal(
                            "Stash local changes",
                            "stash-create",
                            [
                              {
                                key: "name",
                                label: "Message",
                                placeholder: "Work in progress",
                              },
                            ],
                            {},
                            "Save tracked and untracked changes, then clean the working tree.",
                          )
                        }
                      >
                        <Plus size={13} />
                      </button>
                    }
                  >
                    {matchingStashes.length ? (
                      matchingStashes.map((stash) => (
                        <div className="nav-row-group" key={stash.ref}>
                          <button
                            className="nav-row"
                            title={stash.subject}
                            data-browse-ref
                            onClick={() => void browseRef(stash.ref)}
                          >
                            <Archive size={13} />
                            <span>{stash.subject}</span>
                          </button>
                          <Dropdown
                            trigger={
                              <button
                                className="row-menu"
                                aria-label={`Manage ${stash.ref}`}
                              >
                                <MoreHorizontal size={14} />
                              </button>
                            }
                            items={[
                              {
                                label: "Apply (keep stash)",
                                onSelect: () =>
                                  run("stash-apply", { name: stash.ref }),
                              },
                              {
                                label: "Pop (apply & remove)",
                                onSelect: () =>
                                  run("stash-pop", { name: stash.ref }),
                              },
                              {
                                label: "Delete stash…",
                                danger: true,
                                onSelect: () =>
                                  actionModal(
                                    "Delete stash?",
                                    "stash-drop",
                                    [],
                                    { name: stash.ref },
                                    "This permanently removes the saved stash.",
                                    true,
                                  ),
                              },
                            ]}
                          />
                        </div>
                      ))
                    ) : (
                      <div className="nav-empty">No stashed changes</div>
                    )}
                  </Section>
                </div>
              </Sidebar>
            }
          >
            <main className="main">
              <header className="toolbar">
                <Button
                  variant="ghost"
                  size="icon"
                  className="mobile-menu"
                  onClick={() => setMobileNav(true)}
                  aria-label="Open navigation"
                >
                  <Menu size={18} />
                </Button>
                <div className="toolbar-actions">
                  {!window.donkeyDiffDesktop && (
                    <Dropdown
                      trigger={<button className="tool">File</button>}
                      items={[{ label: "Open project…", onSelect: openDialog }]}
                    />
                  )}
                  <Tool
                    icon={<RefreshCw />}
                    label="Fetch"
                    loading={busy === "fetch"}
                    onClick={() => run("fetch")}
                    disabled={!!busy}
                  />
                  <Tool
                    icon={<ArrowDown />}
                    label="Pull"
                    loading={busy === "pull"}
                    badge={state.behind}
                    onClick={() => run("pull")}
                    disabled={!!busy}
                  />
                  <Tool
                    icon={<ArrowUp />}
                    label="Push"
                    loading={busy === "push"}
                    badge={state.ahead}
                    onClick={() => run("push")}
                    disabled={!!busy}
                  />
                  <Tool
                    icon={<Archive />}
                    label="Stash"
                    loading={busy === "stash-create"}
                    onClick={() =>
                      actionModal(
                        "Stash local changes",
                        "stash-create",
                        [
                          {
                            key: "name",
                            label: "Message",
                            placeholder: "Work in progress",
                          },
                        ],
                        {},
                        "Includes untracked files. Your changes can be restored from the sidebar.",
                      )
                    }
                    disabled={!!busy}
                  />
                </div>
                <div className="toolbar-right">
                  <Tool
                    icon={<GitBranch />}
                    label="Branch"
                    onClick={() =>
                      actionModal("Create branch", "branch-create", [
                        {
                          key: "name",
                          label: "Branch name",
                          placeholder: "feat/my-feature",
                        },
                      ])
                    }
                  />
                  <span className="chat-toolbar-divider" aria-hidden="true" />
                  <button
                    className={`tool chat-toggle ${chatOpen ? "selected" : ""}`}
                    aria-label="Chat"
                    aria-expanded={chatOpen}
                    aria-controls="project-chat"
                    onClick={() => {
                      setChatStarted(true);
                      setChatOpen(!chatOpen);
                    }}
                  >
                    <MessageSquare size={15} />
                    <small>Chat</small>
                  </button>
                </div>
              </header>
              <div
                className="workspace-with-chat"
                style={
                  { "--chat-width": `${chatWidth}px` } as React.CSSProperties
                }
              >
                <div className="chat-workspace">
                  {!connected && (
                    <div className="demo-banner">
                      <div>
                        <span className="example-dot" />
                        Preview workspace{" "}
                        <span className="demo-description">
                          Connect your computer to start reviewing local code.
                        </span>
                      </div>
                      <button onClick={() => requireConnection()}>
                        Connect local bridge{" "}
                        <ArrowUp size={12} className="rotate-45" />
                      </button>
                    </div>
                  )}
                  {(actionError || visibleFileError) && (
                    <div className="action-error" role="alert">
                      <span>{actionError || visibleFileError}</span>
                      <button
                        aria-label="Dismiss error"
                        onClick={() => {
                          setActionError("");
                          setFileError(null);
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  {projectError?.id === active ? (
                    <div className="welcome-project" role="alert">
                      <FolderOpen size={32} />
                      <h2>Project unavailable</h2>
                      <p className="project-error-message">
                        {projectError.message}
                      </p>
                      <div className="project-error-actions">
                        <Button onClick={openDialog}>Open folder…</Button>
                        <Button
                          variant="outline"
                          onClick={() =>
                            void refresh(active).catch(() => undefined)
                          }
                        >
                          Try again
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => closeProjectTab(activeTab)}
                        >
                          Close tab
                        </Button>
                      </div>
                    </div>
                  ) : !historyLoading &&
                    view === "changes" &&
                    loadingProject === active &&
                    !snapshots.current.get(active) &&
                    !files.length &&
                    !content ? (
                    <div className="workspace-loading" role="status">
                      <Loader2 size={18} className="animate-spin" />
                      {historyLoading
                        ? "Loading history…"
                        : "Loading local changes…"}
                    </div>
                  ) : localChanges &&
                    !state.files.length &&
                    !loadingLocalProject ? (
                    <div
                      className="empty-workspace"
                      aria-label="No local changes"
                    />
                  ) : (
                    <WorkspaceLayout
                      projectId={active || "preview"}
                      kind="history"
                      leading={
                        showHistory && view === "history" ? (
                          <section className="history">
                            <div className="history-heading">
                              <span>
                                <GitCommitHorizontal size={14} />
                                {historyData?.ref && historyData.ref !== "HEAD"
                                  ? historyData.ref.replace(
                                      /^refs\/(heads|remotes|tags)\//,
                                      "",
                                    )
                                  : "Commit history"}{" "}
                                <span className="muted">
                                  {visibleCommits.length}
                                  {visibleCommits.length === 150 ? "+" : ""}
                                </span>
                              </span>
                              <button
                                aria-label="Collapse commit history"
                                onClick={() => setShowHistory(false)}
                              >
                                <ChevronDown size={14} />
                              </button>
                            </div>
                            <CommitHistory
                              branch={state.branch}
                              commits={visibleCommits}
                              selected={selectedCommits}
                              onSelect={selectCommits}
                            />
                          </section>
                        ) : null
                      }
                    >
                      {historyLoading && (
                        <div
                          className="history-loading-indicator"
                          role="status"
                        >
                          <Loader2 size={12} className="animate-spin" />
                          Loading history…
                        </div>
                      )}
                      {view === "history" && (
                        <div className="workspace-tabs">
                          <div>
                            {(["commit", "changes", "tree"] as const).map(
                              (tab) => (
                                <button
                                  key={tab}
                                  className={mode === tab ? "selected" : ""}
                                  onClick={() => setMode(tab)}
                                >
                                  {tab === "commit"
                                    ? "Commit"
                                    : tab === "changes"
                                      ? "Changes"
                                      : "File Tree"}
                                  {tab === "changes" && (
                                    <span>{files.length}</span>
                                  )}
                                </button>
                              ),
                            )}
                          </div>
                          <div className="workspace-options">
                            {!showHistory && view === "history" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setShowHistory(true)}
                              >
                                <History size={14} />
                                History
                              </Button>
                            )}
                            <span className="diff-stat add">+{additions}</span>
                            <span className="diff-stat remove">
                              −{deletions}
                            </span>
                            <span className="separator" />
                            {autoSyncControl}
                          </div>
                        </div>
                      )}
                      <div className="change-summary">
                        {historySelection.length > 1 ? (
                          <>
                            <GitCommitHorizontal size={16} />
                            <strong>
                              {historySelection.length} commits selected
                            </strong>
                            <span className="summary-message">
                              {comparisonBase
                                ? `${comparisonBase.slice(0, 7)} → ${commit?.slice(0, 7)}`
                                : "Select two commits to compare"}
                            </span>
                          </>
                        ) : currentCommit ? (
                          <>
                            <span className="avatar">
                              {initials(currentCommit.author)}
                            </span>
                            <strong>{currentCommit.author}</strong>
                            <code>{currentCommit.short}</code>
                            <span className="summary-message">
                              {currentCommit.subject}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="working-dot" />
                            <strong>
                              {active
                                ? "Working directory"
                                : "Choose a project to get started"}
                            </strong>
                            <span className="summary-message">
                              {changedCount
                                ? `${changedCount} changed file${changedCount !== 1 ? "s" : ""}`
                                : "No uncommitted changes"}
                            </span>
                          </>
                        )}
                        {view === "changes" ? (
                          <div className="local-change-options">
                            <span className="diff-stat add">+{additions}</span>
                            <span className="diff-stat remove">
                              −{deletions}
                            </span>
                            {autoSyncControl}
                          </div>
                        ) : (
                          <span className="summary-right">
                            Committed changes
                          </span>
                        )}
                      </div>
                      {manyCommits || (!connected && !!commit) ? (
                        <div className="commit-selection-empty">
                          <GitCommitHorizontal size={40} />
                          <h2>
                            {historySelection.length}{" "}
                            {historySelection.length === 1
                              ? "commit"
                              : "commits"}{" "}
                            selected
                          </h2>
                          <p>
                            {connected
                              ? "Select two commits to see the difference between them."
                              : "Connect a project to compare real commits."}
                          </p>
                          <p className="selection-hint">
                            Shift-click for a range · ⌘ / Ctrl-click to add or
                            remove
                          </p>
                        </div>
                      ) : mode === "commit" && comparisonBase ? (
                        <div className="commit-selection-empty">
                          <h2>Comparing two commits</h2>
                          <p>
                            {comparisonBase.slice(0, 7)} → {commit?.slice(0, 7)}
                          </p>
                          <Button
                            variant="outline"
                            onClick={() => setMode("changes")}
                          >
                            View changed files
                          </Button>
                        </div>
                      ) : mode === "commit" ? (
                        <div className="commit-details">
                          <GitCommitHorizontal size={32} />
                          <h2>
                            {currentCommit?.subject || "Commit your changes"}
                          </h2>
                          {currentCommit ? (
                            <>
                              <p>
                                {currentCommit.author} ·{" "}
                                {new Date(currentCommit.date).toLocaleString()}
                              </p>
                              <code>{currentCommit.hash}</code>
                              <Button
                                variant="outline"
                                onClick={() => setMode("changes")}
                              >
                                View changed files
                              </Button>
                            </>
                          ) : (
                            <>
                              <p>
                                Commit staged changes on{" "}
                                <strong>{state.branch}</strong>.
                              </p>
                              <Button
                                disabled={
                                  !files.some((file) => file.staged) || !!busy
                                }
                                onClick={() =>
                                  actionModal(
                                    "Commit staged changes",
                                    "commit",
                                    [
                                      {
                                        key: "name",
                                        label: "Commit message",
                                        placeholder: "Describe your changes",
                                      },
                                    ],
                                    {},
                                    "Only staged changes will be included in this commit.",
                                  )
                                }
                              >
                                Commit changes…
                              </Button>
                            </>
                          )}
                        </div>
                      ) : (
                        <WorkspaceLayout
                          projectId={active || "preview"}
                          kind="files"
                          leading={
                            <aside className="files-pane">
                              <div className="file-filter">
                                <Search size={13} />
                                <input
                                  placeholder="Filter files…"
                                  aria-label="Filter files"
                                  value={filter}
                                  onChange={(e) => setFilter(e.target.value)}
                                />
                                <span>{files.length}</span>
                              </div>
                              {localChanges ? (
                                <StagingTree
                                  projectId={active || "preview"}
                                  projectPath={state.project.path}
                                  onError={setActionError}
                                  files={files}
                                  selected={selected}
                                  layer={stageLayer}
                                  filter={filter}
                                  busy={!!busy || !connected}
                                  loading={
                                    loadingLocalProject ||
                                    loadedFilesContext !== filesContext
                                  }
                                  treeStateId={sidebarId}
                                  onSelect={(path, layer) => {
                                    setStageLayer(layer);
                                    selectFile(path);
                                  }}
                                  onStage={(path, layer) =>
                                    run(
                                      layer === "staged" ? "unstage" : "stage",
                                      {
                                        path,
                                      },
                                    )
                                  }
                                />
                              ) : (
                                <div className="files-scroll">
                                  <FileTree
                                    projectId={sidebarId}
                                    files={files}
                                    selected={selected}
                                    onSelect={selectFile}
                                    filter={filter}
                                  />
                                  {!files.length && (
                                    <div className="files-empty">
                                      {connected
                                        ? "No changed files"
                                        : "Connect a repository"}
                                    </div>
                                  )}
                                </div>
                              )}
                              <div className="files-footer">
                                <Folder size={12} />
                                {mode === "tree"
                                  ? "All files"
                                  : "Changed files"}
                                <span>
                                  {files.filter((f) => f.staged).length} staged
                                </span>
                              </div>
                            </aside>
                          }
                        >
                          {connected && !active ? (
                            <div className="welcome-project">
                              <FolderOpen size={32} />
                              <h2>Open a project</h2>
                              <p>
                                Choose a folder on your Mac to review its
                                changes.
                              </p>
                              <Button onClick={openDialog}>
                                Choose folder
                              </Button>
                            </div>
                          ) : (
                            <div className="diff-workspace">
                              <DiffPane
                                content={content}
                                loading={
                                  fileLoading ||
                                  historyLoading ||
                                  loadedFilesContext !== filesContext
                                }
                                full={full}
                                setFull={setFull}
                                split={split}
                                setSplit={setSplit}
                                fileMode={mode === "tree"}
                                onResolve={(value) =>
                                  actionModal(
                                    "Save conflict resolution",
                                    "resolve",
                                    [],
                                    { path: selected, content: value },
                                    "Write your resolution to disk and stage this file.",
                                  )
                                }
                              />
                              {localChanges && (
                                <CommitForm
                                  projectId={active}
                                  loading={
                                    loadingLocalProject ||
                                    loadedFilesContext !== filesContext
                                  }
                                  count={
                                    files.filter((file) => file.staged).length
                                  }
                                  busy={!!busy || !connected}
                                  onCommit={(message) =>
                                    action("commit", { name: message })
                                  }
                                />
                              )}
                            </div>
                          )}
                        </WorkspaceLayout>
                      )}
                    </WorkspaceLayout>
                  )}
                </div>
                {chatOpen && (
                  <div
                    className="chat-resizer"
                    role="separator"
                    aria-label="Resize chat panel"
                    aria-orientation="vertical"
                    aria-valuenow={chatWidth}
                    aria-valuemin={320}
                    aria-valuemax={800}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight")
                        return;
                      e.preventDefault();
                      const width = Math.max(
                        320,
                        Math.min(
                          800,
                          chatWidth + (e.key === "ArrowLeft" ? 20 : -20),
                        ),
                      );
                      setChatWidth(width);
                      localStorage.setItem("donkey-chat-width", String(width));
                    }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={(e) => {
                      if (!e.currentTarget.hasPointerCapture(e.pointerId))
                        return;
                      const right =
                        e.currentTarget.parentElement!.getBoundingClientRect()
                          .right;
                      const width = Math.round(
                        Math.max(320, Math.min(800, right - e.clientX)),
                      );
                      setChatWidth(width);
                      localStorage.setItem("donkey-chat-width", String(width));
                    }}
                    onPointerUp={(e) =>
                      e.currentTarget.releasePointerCapture(e.pointerId)
                    }
                  />
                )}
                {chatStarted && (
                  <ChatPanel
                    key={active || "preview"}
                    project={
                      projects.find((p) => p.id === active) || state.project
                    }
                    connected={connected && !!active}
                    open={chatOpen}
                    onClose={() => setChatOpen(false)}
                    onComplete={(id) => {
                      void refresh(id).catch(() => undefined);
                    }}
                    onRunning={setChatRunning}
                  />
                )}
              </div>
            </main>
          </WorkspaceLayout>
        )}
      </div>
      <Dialog
        open={!!modal}
        onOpenChange={(open) => {
          if (!open) setModal(null);
        }}
        title={modal?.title || ""}
        description={modal?.description}
      >
        {modal?.kind === "connect" ? (
          <div className="connect-content">
            <a
              className="desktop-download"
              href="https://github.com/DonkeyCut/donkey-diff/releases/latest"
              target="_blank"
              rel="noreferrer"
            >
              <strong>Get the Mac app</strong>
              <span>Open the app, choose a folder, and start reviewing.</span>
            </a>
            <details className="advanced-setup">
              <summary>Advanced: use this browser with a local service</summary>
              <div className="connect-step">
                <span>1</span>
                <div>
                  <strong>Start the local bridge</strong>
                  <p>In the project folder, run:</p>
                  <code>
                    npm install
                    <br />
                    npm run bridge -- /path/to/repository
                  </code>
                  <a
                    href="https://github.com/DonkeyCut/donkey-diff#local-bridge"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Installation & source <ExternalLink size={12} />
                  </a>
                </div>
              </div>
              <div className="connect-step">
                <span>2</span>
                <div>
                  <strong>Pair this browser</strong>
                  <p>
                    Use the button below. Allow local network access if your
                    browser asks.
                  </p>
                </div>
              </div>
              <details>
                <summary>Pair with a key instead</summary>
                <label htmlFor="pair-key">Key from ~/.donkey-diff/token</label>
                <input
                  id="pair-key"
                  type="password"
                  placeholder="Paste your local pairing key"
                  value={values.token || ""}
                  onChange={(e) => setValues({ token: e.target.value })}
                />
              </details>
              <Button className="w-full" onClick={() => void submitModal()}>
                <Link2 size={15} />
                {values.token ? "Connect with key" : "Pair with local bridge"}
              </Button>
            </details>
            {connected && (
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setToken("");
                  setConnected(false);
                  setState(demo);
                  setFiles(demo.files);
                  setContent(demoContent);
                  setSelected(demoContent.path);
                  setActive("");
                  setModal(null);
                  setSyncText("Disconnected");
                }}
              >
                Disconnect this browser
              </Button>
            )}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitModal();
            }}
            className="modal-form"
          >
            {modal?.fields?.map((field) => (
              <label key={field.key}>
                {field.label}
                <input
                  required
                  value={values[field.key] || ""}
                  placeholder={field.placeholder}
                  onChange={(e) =>
                    setValues((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                />
              </label>
            ))}
            <div className="modal-buttons">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setModal(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  modalSubmitting || (modal?.kind === "action" && !!busy)
                }
                variant={modal?.danger ? "destructive" : "default"}
              >
                {modalSubmitting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : null}
                {modal?.danger
                  ? "Confirm deletion"
                  : modal?.kind === "open"
                    ? "Open repository"
                    : "Continue"}
              </Button>
            </div>
          </form>
        )}
        {modalError && (
          <p className="modal-error" role="alert">
            {modalError}
          </p>
        )}
      </Dialog>
    </div>
  );
}
function Tool({
  icon,
  label,
  onClick,
  badge,
  disabled,
  loading = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  badge?: number;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      className="tool"
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading}
      title={label}
    >
      <span className="tool-icon" aria-hidden="true">
        {loading ? <Loader2 className="animate-spin" /> : icon}
      </span>
      <small>{label}</small>
      {!!badge && <i className="tool-badge">{badge}</i>}
    </button>
  );
}
