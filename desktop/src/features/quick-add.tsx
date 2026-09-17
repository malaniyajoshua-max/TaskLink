import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Plus } from "lucide-react";
import { invoke, message, taskBodySchema } from "../api";
import { notify } from "../components/notice";
import { ErrorBox } from "../components/ui";
import type { View } from "../store";
import { defaultDue } from "./task-presentation";

export function QuickAdd({
  workspaceId,
  projectId,
  view,
  onCreated,
}: {
  workspaceId: string | null;
  projectId: string | null;
  view: View;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null),
    saving = useRef(false);
  const restoreFocus = useRef(false);
  // Wait for React to re-enable the input before focusing it; focusing while
  // disabled is ignored by Chromium and breaks consecutive keyboard entry.
  useEffect(() => {
    if (!busy && restoreFocus.current) {
      input.current?.focus();
      restoreFocus.current = false;
    }
  }, [busy]);
  const qc = useQueryClient();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await invoke("tasks.save", {
        workspace_id: workspaceId,
        body: taskBodySchema.parse({
          title: title.trim(),
          project_id: projectId,
          due_at: defaultDue(view) ?? null,
        }),
      });
      setTitle("");
      onCreated();
      await qc.invalidateQueries({ queryKey: ["tasks.list"] });
      notify("任务已创建");
    } catch (reason) {
      setError(message(reason));
    } finally {
      saving.current = false;
      restoreFocus.current = true;
      setBusy(false);
    }
  }
  return (
    <div className="quick-add-wrap">
      <form className="quick-add" onSubmit={submit}>
        <Plus size={18} aria-hidden="true" />
        <input
          ref={input}
          aria-label="快速添加任务"
          placeholder="快速添加任务，按 Enter 创建"
          value={title}
          maxLength={240}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.nativeEvent.isComposing)
              event.preventDefault();
          }}
        />
        {title ? (
          <button
            aria-label="创建快速任务"
            disabled={busy || !title.trim()}
            type="submit"
          >
            <ArrowUp size={17} />
          </button>
        ) : (
          <kbd>Enter 创建</kbd>
        )}
      </form>
      <ErrorBox error={error} />
    </div>
  );
}
