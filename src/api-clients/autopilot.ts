import { request } from "@/api-clients/bridge";
import type {
  AutopilotConfigPatch,
  AutopilotJob,
  AutopilotKind,
  AutopilotOverview,
  AutopilotState,
} from "@/autopilot-types";
const route = (projectId: string, rest = "") =>
  `/projects/${projectId}/autopilot${rest}`;
export const autopilot = {
  overview: () => request<AutopilotOverview>("/autopilot"),
  state: (projectId: string) => request<AutopilotState>(route(projectId)),
  job: (projectId: string, jobId: string) =>
    request<AutopilotJob>(route(projectId, `/jobs/${jobId}`)),
  seen: (projectId: string, jobId: string) =>
    request<{ ok: boolean }>(route(projectId, `/jobs/${jobId}/seen`), "POST"),
  stop: (projectId: string, jobId: string) =>
    request<{ ok: boolean }>(route(projectId, `/jobs/${jobId}/stop`), "POST"),
  config: (projectId: string, patch: AutopilotConfigPatch) =>
    request<AutopilotState>(route(projectId, "/config"), "POST", patch),
  run: (projectId: string, kind: AutopilotKind) =>
    request<{ message: string }>(route(projectId, "/run"), "POST", { kind }),
  teach: (projectId: string, text: string, jobId?: string) =>
    request<{ memory: string }>(route(projectId, "/teach"), "POST", {
      text,
      jobId,
    }),
  memory: (projectId: string, text: string) =>
    request<{ memory: string }>(route(projectId, "/memory"), "POST", { text }),
};
