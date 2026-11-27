import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bug,
  Check,
  CircleDashed,
  GitCommit,
  Loader2,
  Settings as SettingsIcon,
  Square,
  Workflow,
  X,
} from "lucide-react";
import { autopilot } from "@/api-clients/autopilot";
import { ChatEntries } from "@/components/ChatEntries";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import type {
  AutopilotDeploy,
  AutopilotJob,
  AutopilotJobStatus,
  AutopilotJobSummary,
  AutopilotKind,
  AutopilotState,
} from "@/autopilot-types";
import type { Project } from "@/types";

type Props = {
  project: Project;
  connected: boolean;
  open: boolean;
  /** Set from a tray item or notification; a new nonce reopens the job. */
  focus?: { jobId?: string; nonce: number };
  onClose: () => void;
  onAttention: (count: number) => void;
};
const statusLabels: Record<AutopilotJobStatus, string> = {
  queued: "Queued",
  running: "Working",
  pushed: "Pushed",
  no_changes: "No changes",
  needs_user: "Needs you",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
  skipped: "Skipped",
};
const kindIcons: Record<AutopilotKind, typeof Bug> = {
  review: GitCommit,
  ci: Workflow,
  posthog: Bug,
};
function ago(time?: number) {
  if (!time) return "";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(time).toLocaleDateString();
}
function deployLabel({ status, conclusion }: AutopilotDeploy) {
  if (status === "queued" || status === "waiting" || status === "pending")
    return "Queued";
  if (status !== "completed") return "Deploying";
  if (conclusion === "success") return "Deployed";
  if (conclusion === "cancelled" || conclusion === "skipped")
    return conclusion === "cancelled" ? "Cancelled" : "Skipped";
  return "Failed";
}
function DeployIcon({ deploy }: { deploy: AutopilotDeploy }) {
  const label = deployLabel(deploy);
  if (label === "Deploying" || label === "Queued")
    return <Loader2 className="animate-spin running" size={13} />;
  if (label === "Deployed") return <Check className="ok" size={13} />;
  if (label === "Failed") return <X className="failed" size={13} />;
  return <CircleDashed size={13} />;
}
function StatusIcon({ status }: { status: AutopilotJobStatus }) {
  if (status === "running")
    return <Loader2 className="animate-spin" size={13} />;
  if (status === "pushed" || status === "no_changes")
    return <Check size={13} />;
  if (
    status === "needs_user" ||
    status === "failed" ||
    status === "interrupted"
  )
    return <AlertTriangle size={13} />;
  return <CircleDashed size={13} />;
}
function JobRow({
  job,
  onOpen,
}: {
  job: AutopilotJobSummary;
  onOpen: () => void;
}) {
  const Icon = kindIcons[job.kind];
  return (
    <button
      className={`autopilot-job ${!job.seen && (job.status === "needs_user" || job.status === "failed") ? "unseen" : ""}`}
      onClick={onOpen}
    >
      <Icon size={15} />
      <span className="autopilot-job-text">
        <strong>{job.title}</strong>
        <small>
          {job.trigger} · {ago(job.createdAt)}
        </small>
      </span>
      <span className={`autopilot-status ${job.status}`}>
        <StatusIcon status={job.status} />
        {statusLabels[job.status]}
        {job.commits.length > 0 && ` · ${job.commits[0].slice(0, 7)}`}
      </span>
    </button>
  );
}
function AutopilotSettings({
  project,
  state,
  onSaved,
  onError,
}: {
  project: Project;
  state: AutopilotState;
  onSaved: (state: AutopilotState) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState(() => ({
    enabled: state.config.enabled,
    branch: state.config.branch,
    dailyCap: String(state.config.dailyCap),
    model: state.config.model,
    host: state.config.posthog.host,
    projectId: state.config.posthog.projectId,
    apiKey: "",
  }));
  const [memory, setMemory] = useState(state.memory);
  const [saving, setSaving] = useState(false);
  const [loginItem, setLoginItem] = useState<boolean | null>(null);
  useEffect(() => {
    void window.donkeyDiffDesktop
      ?.loginItem()
      .then(setLoginItem)
      .catch(() => undefined);
  }, []);
  const set = (key: keyof typeof draft, value: string | boolean) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const save = async () => {
    setSaving(true);
    try {
      const next = await autopilot.config(project.id, {
        enabled: draft.enabled,
        branch: draft.branch,
        dailyCap: Number(draft.dailyCap) || 1,
        model: draft.model.trim(),
        posthog: {
          host: draft.host,
          projectId: draft.projectId,
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        },
      });
      if (memory !== state.memory) await autopilot.memory(project.id, memory);
      setDraft((d) => ({ ...d, apiKey: "" }));
      onSaved({ ...next, memory });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="autopilot-settings"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="autopilot-check">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => set("enabled", e.target.checked)}
        />
        <span>
          <strong>Run Autopilot for {project.name}</strong>
          <small>
            Reviews every push, fixes failed CI and new PostHog errors, and
            pushes fixes straight to the branch below.
          </small>
        </span>
      </label>
      <div className="autopilot-fields">
        <label>
          Branch
          <input
            value={draft.branch}
            onChange={(e) => set("branch", e.target.value)}
          />
        </label>
        <label>
          Jobs per 24 hours
          <input
            type="number"
            min={1}
            max={100}
            value={draft.dailyCap}
            onChange={(e) => set("dailyCap", e.target.value)}
          />
        </label>
      </div>
      <label>
        Claude model
        <input
          value={draft.model}
          placeholder="Your Claude Code default"
          onChange={(e) => set("model", e.target.value)}
        />
      </label>
      <h3>PostHog errors</h3>
      <label>
        Host
        <input
          value={draft.host}
          placeholder="https://us.posthog.com"
          onChange={(e) => set("host", e.target.value)}
        />
      </label>
      <div className="autopilot-fields">
        <label>
          Project ID
          <input
            value={draft.projectId}
            placeholder="12345"
            onChange={(e) => set("projectId", e.target.value)}
          />
        </label>
        <label>
          Personal API key
          <input
            type="password"
            autoComplete="off"
            value={draft.apiKey}
            placeholder={state.config.posthog.apiKeyHint || "phx_…"}
            onChange={(e) => set("apiKey", e.target.value)}
          />
        </label>
      </div>
      <p className="autopilot-hint">
        Needs the <code>query:read</code> scope. The key stays on this Mac.
      </p>
      <h3>What Autopilot remembers</h3>
      <textarea
        value={memory}
        rows={6}
        placeholder="- Don't flag missing tests in scripts/"
        onChange={(e) => setMemory(e.target.value)}
      />
      {loginItem !== null && (
        <label className="autopilot-check">
          <input
            type="checkbox"
            checked={loginItem}
            onChange={(e) => {
              const enabled = e.target.checked;
              void window
                .donkeyDiffDesktop!.loginItem(enabled)
                .then(setLoginItem)
                .catch((error) => onError((error as Error).message));
            }}
          />
          <span>
            <strong>Open at login</strong>
            <small>
              Start in the menu bar so Autopilot keeps working after a restart.
            </small>
          </span>
        </label>
      )}
      <button type="submit" className="autopilot-primary" disabled={saving}>
        {saving && <Loader2 className="animate-spin" size={13} />}
        Save
      </button>
    </form>
  );
}
export function AutopilotPanel({
  project,
  connected,
  open,
  focus,
  onClose,
  onAttention,
}: Props) {
  const [state, setState] = useState<AutopilotState | null>(null);
  const [view, setView] = useState<"jobs" | "job" | "settings">("jobs");
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<AutopilotJob | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [lesson, setLesson] = useState("");
  const attention = useRef(onAttention);
  attention.current = onAttention;
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await autopilot.state(project.id);
        if (disposed) return;
        setState(next);
        attention.current(
          next.jobs.filter(
            (j) =>
              !j.seen && (j.status === "needs_user" || j.status === "failed"),
          ).length,
        );
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
      if (!disposed) timer = setTimeout(poll, open ? 2000 : 20000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [project.id, connected, open]);
  useEffect(() => {
    if (!focus) return;
    setError("");
    if (focus.jobId) {
      setJobId(focus.jobId);
      setView("job");
    } else setView("jobs");
  }, [focus]);
  useEffect(() => {
    if (!connected || !open || view !== "job" || !jobId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setJob(null);
    void autopilot.seen(project.id, jobId).catch(() => undefined);
    const poll = async () => {
      try {
        const next = await autopilot.job(project.id, jobId);
        if (disposed) return;
        setJob(next);
        if (next.status !== "running" && next.status !== "queued") return;
      } catch (e) {
        if (!disposed) setError((e as Error).message);
        return;
      }
      if (!disposed) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [project.id, connected, open, view, jobId]);
  const act = async (key: string, task: () => Promise<string | void>) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const message = await task();
      if (message) setNotice(message);
      setState(await autopilot.state(project.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const d = state?.digest;
  return (
    <aside
      id="project-autopilot"
      className="chat-panel autopilot-panel"
      aria-label="Autopilot"
      hidden={!open}
    >
      <header className="chat-header autopilot-header">
        {view !== "jobs" ? (
          <button
            title="Back to jobs"
            aria-label="Back to jobs"
            onClick={() => setView("jobs")}
          >
            <ArrowLeft size={16} />
          </button>
        ) : (
          <h2>Autopilot</h2>
        )}
        <div>
          <button
            title="Autopilot settings"
            aria-label="Autopilot settings"
            className={view === "settings" ? "selected" : ""}
            onClick={() => setView(view === "settings" ? "jobs" : "settings")}
          >
            <SettingsIcon size={15} />
          </button>
          <button
            title="Close Autopilot"
            aria-label="Close Autopilot"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>
      {(error || notice) && (
        <div className="autopilot-messages">
          {error && (
            <div role="alert" className="chat-error">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={13} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="chat-notice">
              {notice}
            </div>
          )}
        </div>
      )}
      {!connected ? (
        <div className="autopilot-body">
          <div className="chat-notice">
            Connect your local bridge to use Autopilot.
          </div>
        </div>
      ) : !state ? (
        <div className="autopilot-body autopilot-loading">
          <Loader2 className="animate-spin" size={16} />
        </div>
      ) : view === "settings" ? (
        <div className="autopilot-body">
          <AutopilotSettings
            key={project.id}
            project={project}
            state={state}
            onError={setError}
            onSaved={(next) => {
              setState(next);
              setNotice("Settings saved");
              setView("jobs");
            }}
          />
        </div>
      ) : view === "job" ? (
        <div className="autopilot-detail">
          {!job ? (
            <div className="autopilot-body autopilot-loading">
              <Loader2 className="animate-spin" size={16} />
            </div>
          ) : (
            <>
              <div className="autopilot-job-head">
                <h3>{job.title}</h3>
                <span className={`autopilot-status ${job.status}`}>
                  <StatusIcon status={job.status} />
                  {job.status === "running"
                    ? job.activity
                    : statusLabels[job.status]}
                </span>
                <small>
                  {job.trigger} · {ago(job.createdAt)}
                </small>
                {job.summary && <p>{job.summary}</p>}
                {job.error && <p className="autopilot-error">{job.error}</p>}
                {job.commits.length > 0 && (
                  <p className="autopilot-commits">
                    Pushed{" "}
                    {job.commits.map((sha) => (
                      <code key={sha}>{sha.slice(0, 7)}</code>
                    ))}
                  </p>
                )}
                {job.meta.url && (
                  <a href={job.meta.url} target="_blank" rel="noreferrer">
                    Open the CI run
                  </a>
                )}
                {(job.status === "running" || job.status === "queued") && (
                  <button
                    className="autopilot-secondary"
                    disabled={busy === "stop"}
                    onClick={() =>
                      void act("stop", () =>
                        autopilot
                          .stop(project.id, job.id)
                          .then(() => "Stopping"),
                      )
                    }
                  >
                    <Square size={11} fill="currentColor" /> Stop
                  </button>
                )}
              </div>
              <Conversation className="chat-conversation">
                <ConversationContent className="chat-messages">
                  <ChatEntries
                    entries={job.entries}
                    animating={job.status === "running"}
                    collapseUser
                  />
                </ConversationContent>
                <ConversationScrollButton aria-label="Scroll to latest" />
              </Conversation>
              <form
                className="chat-composer autopilot-teach"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!lesson.trim()) return;
                  void act("teach", async () => {
                    await autopilot.teach(project.id, lesson, job.id);
                    setLesson("");
                    return "Autopilot will remember that for future jobs.";
                  });
                }}
              >
                <textarea
                  aria-label="Teach Autopilot"
                  value={lesson}
                  rows={2}
                  placeholder="Teach Autopilot, e.g. “That wasn’t a bug: retries are intentional there.”"
                  onChange={(e) => setLesson(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className="chat-composer-footer">
                  <small>Saved to this project’s Autopilot memory</small>
                  <button
                    type="submit"
                    className="autopilot-primary"
                    disabled={!lesson.trim() || busy === "teach"}
                  >
                    Remember
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      ) : (
        <div className="autopilot-body">
          {!state.config.enabled && (
            <div className="autopilot-off">
              <p>
                Autopilot is off for {project.name}. When it’s on, it reviews
                every push to <code>{state.config.branch}</code>, fixes failed
                CI and new PostHog errors, and pushes the fixes. It runs in the
                background with your Claude Code subscription, even when this
                window is closed.
              </p>
              <button
                className="autopilot-primary"
                disabled={busy === "enable"}
                onClick={() =>
                  void act("enable", async () => {
                    setState(
                      await autopilot.config(project.id, { enabled: true }),
                    );
                    return `Watching ${state.config.branch}. New pushes will be reviewed.`;
                  })
                }
              >
                Turn on Autopilot
              </button>
            </div>
          )}
          <ul className="autopilot-integrations">
            {(
              [
                ["GitHub Actions", Workflow, state.integrations.gh],
                ["PostHog", Bug, state.integrations.posthog],
              ] as const
            ).map(([name, Icon, integration]) => (
              <li key={name} className={integration.ok ? "ok" : ""}>
                <Icon size={13} />
                <strong>{name}</strong>
                <span>{integration.message}</span>
              </li>
            ))}
          </ul>
          {state.deploys.length > 0 && (
            <ul className="autopilot-deploys">
              {state.deploys.map((deploy) => (
                <li key={deploy.workflow}>
                  <DeployIcon deploy={deploy} />
                  <a href={deploy.url} target="_blank" rel="noreferrer">
                    {deploy.workflow}
                  </a>
                  <span>
                    {deployLabel(deploy)} · {deploy.sha.slice(0, 7)} ·{" "}
                    {ago(deploy.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {d && (
            <p className="autopilot-digest">
              Last 24 hours: {d.total} job{d.total === 1 ? "" : "s"}
              {d.pushed > 0 && ` · ${d.pushed} pushed`}
              {d.noChanges > 0 && ` · ${d.noChanges} with nothing to fix`}
              {d.needsUser > 0 && ` · ${d.needsUser} need you`}
              {d.failed > 0 && ` · ${d.failed} failed`} · {state.usedToday} of{" "}
              {state.config.dailyCap} allowed
            </p>
          )}
          <div className="autopilot-jobs">
            {state.jobs.length ? (
              state.jobs.map((item) => (
                <JobRow
                  key={item.id}
                  job={item}
                  onOpen={() => {
                    setJobId(item.id);
                    setView("job");
                  }}
                />
              ))
            ) : (
              <p className="autopilot-empty">
                No jobs yet. Push to {state.config.branch} or use Run now.
              </p>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
