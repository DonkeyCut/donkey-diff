import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { FileTree } from "@/components/FileTree";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { ChangedFile } from "@/types";
import { writeClipboardText } from "@/api-clients/clipboard";

export type StageLayer = "unstaged" | "staged";
type Props = {
  projectId: string;
  projectPath: string;
  treeStateId: string;
  loading: boolean;
  files: ChangedFile[];
  selected: string;
  layer: StageLayer;
  filter: string;
  busy: boolean;
  onSelect: (path: string, layer: StageLayer) => void;
  onStage: (path: string, layer: StageLayer) => void;
  onError: (message: string) => void;
};
export function StagingTree(props: Props) {
  return <SavedStagingTree {...props} />;
}
function SavedStagingTree({
  projectId,
  projectPath,
  treeStateId,
  loading,
  files,
  selected,
  layer,
  filter,
  busy,
  onSelect,
  onStage,
  onError,
}: Props) {
  const stagedPanel = usePanelRef();
  const [collapsed, setCollapsed] = useState(false);
  const hasStaged = files.some((file) => file.staged);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `donkey-diff-layout-${treeStateId}-staging`,
    panelIds: ["unstaged", "staged"],
    onlySaveAfterUserInteractions: true,
  });
  const copyPath = (value: string) => {
    void writeClipboardText(value).catch((error: Error) =>
      onError(error.message),
    );
  };
  const fileAction = (path: string, action: "open" | "reveal") => {
    void window.donkeyDiffDesktop
      ?.fileAction(projectId, path, action)
      .catch((error: Error) => onError(error.message));
  };
  const section = (name: StageLayer) => {
    const changes = files.filter((file) =>
      name === "staged" ? file.staged : (file.unstaged ?? !file.staged),
    );
    const hasSelection =
      layer === name &&
      !!selected &&
      changes.some(
        (file) =>
          file.path === selected || file.path.startsWith(`${selected}/`),
      );
    const verb = name === "staged" ? "Unstage" : "Stage";
    return (
      <section className="staging-section">
        <header>
          {name === "staged" ? (
            <button
              className="staging-heading"
              aria-expanded={!collapsed}
              onClick={() => {
                if (stagedPanel.current?.isCollapsed())
                  stagedPanel.current.expand();
                else stagedPanel.current?.collapse();
              }}
            >
              {collapsed ? (
                <ChevronRight size={12} />
              ) : (
                <ChevronDown size={12} />
              )}
              Staged <small>{changes.length}</small>
            </button>
          ) : (
            <span>
              Unstaged <small>{changes.length}</small>
            </span>
          )}
          <div className="staging-actions">
            {hasSelection && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                aria-disabled={busy || loading}
                onClick={() => {
                  if (!loading) onStage(selected, name);
                }}
              >
                {verb}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !changes.length}
              aria-disabled={busy || loading || !changes.length}
              onClick={() => {
                if (!loading) onStage(".", name);
              }}
            >
              {verb} all
            </Button>
          </div>
        </header>
        {!(name === "staged" && collapsed) && (
          <div className="files-scroll">
            <FileTree
              projectId={treeStateId}
              files={changes}
              selected={layer === name ? selected : ""}
              onSelect={(path) => onSelect(path, name)}
              onDoubleClick={
                busy || loading ? undefined : (path) => onStage(path, name)
              }
              filter={filter}
              contextActions={(path) => [
                ...(window.donkeyDiffDesktop
                  ? [
                      {
                        label: "Open",
                        onSelect: () => fileAction(path, "open"),
                      },
                      {
                        label: "Show in Finder",
                        onSelect: () => fileAction(path, "reveal"),
                      },
                    ]
                  : []),
                {
                  label: verb,
                  separatorBefore: true,
                  disabled: busy || loading,
                  onSelect: () => onStage(path, name),
                },
                {
                  label: `${verb} all`,
                  disabled: busy || loading || !changes.length,
                  separatorBefore: true,
                  onSelect: () => onStage(".", name),
                },
                {
                  label: "Copy Path",
                  separatorBefore: true,
                  onSelect: () =>
                    copyPath(`${projectPath.replace(/\/+$/, "")}/${path}`),
                },
                { label: "Copy Relative Path", onSelect: () => copyPath(path) },
              ]}
            />
            {!changes.length && (
              <div className="files-empty">No unstaged changes</div>
            )}
          </div>
        )}
      </section>
    );
  };
  return (
    <div className="staging-tree" aria-busy={loading}>
      {hasStaged ? (
        <ResizablePanelGroup
          orientation="vertical"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          <ResizablePanel id="unstaged" minSize={80} defaultSize="65%">
            {section("unstaged")}
          </ResizablePanel>
          <ResizableHandle
            className="staging-divider"
            aria-label="Resize staged files"
          />
          <ResizablePanel
            id="staged"
            panelRef={stagedPanel}
            minSize={100}
            collapsedSize={38}
            collapsible
            defaultSize="35%"
            onResize={(size) => setCollapsed(size.inPixels <= 38.5)}
          >
            {section("staged")}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        section("unstaged")
      )}
    </div>
  );
}
