import { ChevronRight, Loader2, Terminal, X } from "lucide-react";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import type { ChatEntry } from "@/chat-types";

function Activity({ entry }: { entry: ChatEntry }) {
  return (
    <details className="chat-activity">
      <summary>
        {entry.status === "running" ? (
          <Loader2 className="animate-spin" size={14} />
        ) : entry.status === "error" ? (
          <X size={14} />
        ) : (
          <Terminal size={14} />
        )}
        <span>{entry.text}</span>
        <ChevronRight size={12} />
      </summary>
      {entry.detail && <pre>{entry.detail}</pre>}
    </details>
  );
}
/** Renders a chat or Autopilot transcript. */
export function ChatEntries({
  entries,
  animating,
  collapseUser = false,
}: {
  entries: ChatEntry[];
  animating: boolean;
  /** Long generated prompts read better folded, like tool output. */
  collapseUser?: boolean;
}) {
  return entries.map((entry) =>
    entry.kind === "activity" ? (
      <Activity key={entry.id} entry={entry} />
    ) : entry.kind === "user" && collapseUser ? (
      <Activity
        key={entry.id}
        entry={{ ...entry, text: "Instructions", detail: entry.text }}
      />
    ) : (
      <Message key={entry.id} from={entry.kind}>
        <MessageContent
          className={
            entry.kind === "user"
              ? "chat-user-message"
              : "chat-assistant-message"
          }
        >
          {entry.kind === "user" ? (
            entry.text
          ) : (
            <MessageResponse isAnimating={animating}>
              {entry.text}
            </MessageResponse>
          )}
        </MessageContent>
      </Message>
    ),
  );
}
