import type { UpdateState } from "@/update-state";
export {};
declare global {
  interface Window {
    donkeyDiffDesktop?: {
      platform: string;
      development?: boolean;
      getUpdateState: () => Promise<UpdateState>;
      activateUpdate: () => Promise<UpdateState>;
      onUpdateState: (callback: (state: UpdateState) => void) => () => void;
      request: <T>(
        route: string,
        method: string,
        body?: unknown,
      ) => Promise<{ ok: true; data: T } | { ok: false; error: string }>;
      chooseProject: () => Promise<string | null>;
      writeClipboardText: (text: string) => Promise<void>;
      fileAction: (
        projectId: string,
        path: string,
        action: "open" | "reveal",
      ) => Promise<void>;
      onOpenProject: (callback: () => void) => () => void;
    };
  }
}
