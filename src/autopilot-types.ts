import type { ChatEntry } from "./chat-types.js";

export type AutopilotKind = "review" | "ci" | "posthog";
export type AutopilotJobStatus =
  | "queued"
  | "running"
  | "pushed"
  | "no_changes"
  | "needs_user"
  | "failed"
  | "stopped"
  | "interrupted"
  | "skipped";
export type AutopilotConfig = {
  enabled: boolean;
  branch: string;
  dailyCap: number;
  model: string;
  posthog: { host: string; projectId: string; apiKey: string };
};
/** Config as the UI sees it: the PostHog key is never sent back in full. */
export type AutopilotPublicConfig = Omit<AutopilotConfig, "posthog"> & {
  posthog: { host: string; projectId: string; apiKeyHint: string };
};
export type AutopilotConfigPatch = Partial<Omit<AutopilotConfig, "posthog">> & {
  posthog?: Partial<AutopilotConfig["posthog"]>;
};
export type AutopilotJob = {
  id: string;
  projectId: string;
  kind: AutopilotKind;
  title: string;
  trigger: string;
  status: AutopilotJobStatus;
  activity: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
  commits: string[];
  seen: boolean;
  meta: {
    from?: string;
    to?: string;
    shas?: string[];
    runId?: number;
    workflow?: string;
    headSha?: string;
    url?: string;
    ciKey?: string;
    issue?: string;
    details?: string;
  };
  entries: ChatEntry[];
};
export type AutopilotJobSummary = Omit<AutopilotJob, "entries">;
export type AutopilotDigest = {
  since: number;
  total: number;
  pushed: number;
  noChanges: number;
  needsUser: number;
  failed: number;
  commits: number;
};
export type AutopilotIntegration = { ok: boolean; message: string };
/** The newest run of a deploy or release workflow on the watched branch. */
export type AutopilotDeploy = {
  workflow: string;
  /** GitHub's run status: queued, in_progress, completed, … */
  status: string;
  /** Set once completed: success, failure, cancelled, … */
  conclusion: string;
  url: string;
  sha: string;
  at: number;
};
export type AutopilotState = {
  config: AutopilotPublicConfig;
  jobs: AutopilotJobSummary[];
  memory: string;
  digest: AutopilotDigest;
  usedToday: number;
  integrations: { gh: AutopilotIntegration; posthog: AutopilotIntegration };
  deploys: AutopilotDeploy[];
  checkedAt?: number;
};
export type AutopilotOverview = {
  running: number;
  attention: number;
  recent: {
    projectId: string;
    projectName: string;
    jobId: string;
    title: string;
    status: AutopilotJobStatus;
  }[];
};
