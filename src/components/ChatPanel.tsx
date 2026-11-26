import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Code2,
  Plus,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { ChatModelPicker } from "@/components/ChatModelPicker";
import { chat } from "@/api-clients/chat";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { ChatEntries } from "@/components/ChatEntries";
import type {
  ChatProvider,
  ChatProviderInfo,
  ChatSession,
  ChatSkill,
  ChatState,
} from "@/chat-types";
import type { Project } from "@/types";

type Props = {
  project: Project;
  connected: boolean;
  open: boolean;
  onClose: () => void;
  onComplete: (projectId: string) => void;
  onRunning: (running: boolean) => void;
};
const emptyState: ChatState = { sessions: [], skills: [] };
const normalize = (value: string) => value.toLowerCase().replace(/[-_]+/g, " ");
function Elapsed({ session }: { session: ChatSession }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (session.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session.status]);
  const seconds = Math.max(
    0,
    Math.floor(
      ((session.status === "running" ? now : session.updatedAt) -
        (session.startedAt || session.updatedAt)) /
        1000,
    ),
  );
  return (
    <span>
      {session.status === "running"
        ? "Working for"
        : session.status === "stopped"
          ? "Stopped after"
          : "Worked for"}{" "}
      {seconds >= 60 ? `${Math.floor(seconds / 60)}m ` : ""}
      {seconds % 60}s
    </span>
  );
}
export function ChatPanel({
  project,
  connected,
  open,
  onClose,
  onComplete,
  onRunning,
}: Props) {
  const [state, setState] = useState<ChatState>(emptyState);
  const [providers, setProviders] = useState<ChatProviderInfo[]>([]);
  const [provider, setProvider] = useState<ChatProvider | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(() =>
    localStorage.getItem(`donkey-chat-active-${project.id}`),
  );
  const [draft, setDraft] = useState(
    () => localStorage.getItem(`donkey-chat-draft-${project.id}`) || "",
  );
  const [skill, setSkill] = useState<ChatSkill | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(connected);
  const [providerLoading, setProviderLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [skillIndex, setSkillIndex] = useState(0);
  const [dismissedSlash, setDismissedSlash] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const callbacks = useRef({ onComplete, onRunning });
  callbacks.current = { onComplete, onRunning };
  const seenRunning = useRef(false);
  const selected = state.sessions.find((s) => s.id === activeId);
  const running = state.sessions.find((s) => s.status === "running");
  const activeProvider = provider ?? selected?.provider ?? "codex";
  const info = providers.find((p) => p.id === activeProvider);
  const chosenModel =
    (model ?? selected?.model) ||
    info?.defaultModel ||
    info?.models[0]?.id ||
    "";
  const chosenEffort = effort ?? selected?.effort ?? "";
  const canSend =
    connected &&
    !loading &&
    !submitting &&
    !running &&
    (!!draft.trim() || !!skill) &&
    info?.available;
  const slashMatch = /(?:^|\s)\/([^/\n]*)$/.exec(draft);
  const slash = !skill && !dismissedSlash && !!slashMatch;
  const matches = slash
    ? state.skills
        .filter((s) =>
          normalize(`${s.name} ${s.description}`).includes(
            normalize(slashMatch![1].trim()),
          ),
        )
        .slice(0, 8)
    : [];
  const selectedSkillIndex = Math.min(
    skillIndex,
    Math.max(0, matches.length - 1),
  );
  const loadProviders = async (refresh = false) => {
    setProviderLoading(true);
    try {
      setProviders(await chat.providers(project.id, refresh));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProviderLoading(false);
    }
  };
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await chat.state(project.id);
        if (disposed) return;
        const busy = next.sessions.some((s) => s.status === "running");
        callbacks.current.onRunning(busy);
        if (seenRunning.current && !busy)
          callbacks.current.onComplete(project.id);
        seenRunning.current = busy;
        setState(next);
        setLoading(false);
        setActiveId((id) => (id === null ? next.sessions[0]?.id || "" : id));
      } catch (e) {
        if (!disposed) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
      if (!disposed) timer = setTimeout(poll, 650);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [project.id, connected]);
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    setProviderLoading(true);
    chat
      .providers(project.id)
      .then((next) => {
        if (!disposed) setProviders(next);
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      })
      .finally(() => {
        if (!disposed) setProviderLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [project.id, connected]);
  useEffect(() => {
    try {
      localStorage.setItem(`donkey-chat-draft-${project.id}`, draft);
      if (activeId !== null)
        localStorage.setItem(`donkey-chat-active-${project.id}`, activeId);
    } catch {
      /* Chat still works with browser storage disabled. */
    }
  }, [project.id, draft, activeId]);
  useEffect(() => {
    if (open) textarea.current?.focus();
  }, [open]);
  const chooseSkill = (value: ChatSkill) => {
    setSkill(value);
    setDraft(draft.slice(0, draft.lastIndexOf("/")).trimEnd());
    setDismissedSlash(false);
    textarea.current?.focus();
  };
  const send = async () => {
    if (!canSend) return;
    setSubmitting(true);
    setError("");
    try {
      const result = await chat.send(project.id, {
        sessionId: selected?.id,
        provider: activeProvider,
        model: chosenModel,
        effort: chosenEffort,
        text: skill
          ? `/${skill.name}${draft.trim() ? ` ${draft}` : ""}`
          : draft,
        skillId: skill?.id,
      });
      setActiveId(result.sessionId);
      setDraft("");
      setSkill(null);
      seenRunning.current = true;
      callbacks.current.onRunning(true);
      setState(await chat.state(project.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  const stop = async () => {
    if (!running) return;
    setSubmitting(true);
    try {
      await chat.stop(project.id, running.id);
      setState(await chat.state(project.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  const newChat = () => {
    setProvider(activeProvider);
    setActiveId("");
    setModel(null);
    setEffort(null);
    setSkill(null);
    setError("");
    textarea.current?.focus();
  };
  return (
    <aside
      id="project-chat"
      className="chat-panel"
      aria-label="Project chat"
      hidden={!open}
    >
      <header className="chat-header">
        <div>
          <button title="New chat" aria-label="New chat" onClick={newChat}>
            <Plus size={17} />
          </button>
          <button title="Close chat" aria-label="Close chat" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>
      <Conversation className="chat-conversation" key={activeId || "new"}>
        <ConversationContent className="chat-messages">
          {selected && (
            <ChatEntries
              entries={selected.entries}
              animating={selected.status === "running"}
            />
          )}
          {selected?.startedAt && (
            <div className="chat-progress" role="status">
              {selected.status === "running" ? (
                <>
                  <span className="chat-thinking-dot" />
                  <span>{selected.activity || "Thinking"}</span>
                  <Elapsed session={selected} />
                </>
              ) : (
                <>
                  <Check size={13} />
                  <Elapsed session={selected} />
                </>
              )}
            </div>
          )}
          {selected?.error && (
            <div role="alert" className="chat-error">
              {selected.error}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton aria-label="Scroll to latest message" />
      </Conversation>
      <div className="chat-bottom">
        {error && (
          <div role="alert" className="chat-error">
            <span>{error}</span>
            <button
              aria-label="Dismiss chat error"
              onClick={() => setError("")}
            >
              <X size={13} />
            </button>
          </div>
        )}
        {!connected && (
          <div className="chat-notice">
            Connect your local bridge to chat with this project.
          </div>
        )}
        {connected && !providerLoading && info && !info.available && (
          <div className="chat-notice">
            {info.error}
            <button onClick={() => void loadProviders(true)}>
              <RotateCcw size={12} />
              Retry connection
            </button>
          </div>
        )}
        {running && running.id !== activeId && (
          <button
            className="chat-notice"
            onClick={() => setActiveId(running.id)}
          >
            Another chat is working on this project. Open it →
          </button>
        )}
        {!selected?.entries.length && (
          <div className="chat-suggestions">
            {[
              ["Review changes", "Review my uncommitted changes"],
              ["Explain project", "Explain this project"],
              ["Prepare commit", "Help me prepare a commit"],
            ].map(([label, text]) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  setDraft(text);
                  textarea.current?.focus();
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <form
          className="chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {slash && (
            <div
              className="chat-skills"
              role="listbox"
              id="chat-skills"
              aria-label="Repository skills"
            >
              <div className="chat-popover-title">Repository skills</div>
              {matches.length ? (
                matches.map((item, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === selectedSkillIndex}
                    id={`chat-skill-${index}`}
                    className={index === selectedSkillIndex ? "selected" : ""}
                    key={item.id}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chooseSkill(item)}
                  >
                    <Code2 size={16} />
                    <span>
                      <strong>{item.name.replace(/-/g, " ")}</strong>
                      <small>{item.description}</small>
                    </span>
                  </button>
                ))
              ) : (
                <div className="chat-skill-empty">
                  {state.skills.length ? (
                    "No matching skills"
                  ) : (
                    <>
                      Add <code>.agents/skills/name/SKILL.md</code> to this
                      repository.
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          {skill && (
            <div className="chat-selected-skill">
              <Code2 size={12} />
              {skill.name}
              <button
                type="button"
                aria-label="Remove skill"
                onClick={() => setSkill(null)}
              >
                <X size={12} />
              </button>
            </div>
          )}
          <textarea
            ref={textarea}
            aria-label="Message your project agent"
            value={draft}
            placeholder="Ask anything"
            rows={3}
            aria-controls={slash ? "chat-skills" : undefined}
            aria-activedescendant={
              matches.length ? `chat-skill-${selectedSkillIndex}` : undefined
            }
            onChange={(e) => {
              setDraft(e.target.value);
              setSkillIndex(0);
              setDismissedSlash(false);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (
                slash &&
                matches.length &&
                ["ArrowDown", "ArrowUp", "Tab", "Enter"].includes(e.key) &&
                !e.shiftKey
              ) {
                e.preventDefault();
                if (e.key === "ArrowDown")
                  setSkillIndex((selectedSkillIndex + 1) % matches.length);
                else if (e.key === "ArrowUp")
                  setSkillIndex(
                    (selectedSkillIndex - 1 + matches.length) % matches.length,
                  );
                else chooseSkill(matches[selectedSkillIndex]);
              } else if (e.key === "Escape") {
                setDismissedSlash(true);
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="chat-composer-footer">
            <ChatModelPicker
              providers={providers}
              provider={activeProvider}
              model={chosenModel}
              effort={chosenEffort}
              loading={providerLoading}
              disabled={!!running || submitting}
              onSelect={(nextProvider, nextModel) => {
                setProvider(nextProvider);
                setModel(nextModel);
                setEffort("");
              }}
              onEffort={setEffort}
            />
            {running ? (
              <button
                type="button"
                className="chat-send"
                aria-label="Stop response"
                disabled={submitting}
                onClick={() => void stop()}
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                className="chat-send"
                aria-label="Send message"
                disabled={!canSend}
              >
                <ArrowUp size={19} />
              </button>
            )}
          </div>
        </form>
      </div>
    </aside>
  );
}
