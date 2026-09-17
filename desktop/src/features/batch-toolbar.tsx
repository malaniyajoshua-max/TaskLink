import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Check, Flag, X } from "lucide-react";
import { invoke, message, type Inputs } from "../api";
import { Button, ErrorBox } from "../components/ui";
import { notify } from "../components/notice";

export function BatchToolbar({
  ids,
  onClear,
}: {
  ids: string[];
  onClear: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const qc = useQueryClient();
  async function apply(patch: Inputs["tasks.batch"]["patch"]) {
    if (busy || !ids.length) return;
    setBusy(true);
    setError("");
    try {
      await invoke("tasks.batch", { ids, patch });
      await qc.invalidateQueries({ queryKey: ["tasks.list"] });
      notify(`已更新 ${ids.length} 项任务`);
      onClear();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="batch-toolbar">
      <div className="batch-controls">
        <strong>已选 {ids.length} 项</strong>
        <Button
          variant="secondary"
          disabled={busy || !ids.length}
          onClick={() => void apply({ status: "done" })}
        >
          <Check size={14} />
          完成
        </Button>
        <label>
          <Flag size={14} />
          <select
            aria-label="批量优先级"
            value=""
            disabled={busy || !ids.length}
            onChange={(event) =>
              void apply({
                priority: event.target.value as
                  "low" | "medium" | "high" | "urgent",
              })
            }
          >
            <option value="" disabled>
              优先级
            </option>
            <option value="urgent">紧急</option>
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </select>
        </label>
        <label>
          <CalendarDays size={14} />
          <select
            aria-label="批量截止日期"
            value=""
            disabled={busy || !ids.length}
            onChange={(event) => {
              const days = event.target.value;
              if (days === "clear") void apply({ due_at: null });
              else {
                const due = new Date();
                due.setDate(due.getDate() + Number(days));
                due.setHours(23, 59, 0, 0);
                void apply({ due_at: due.toISOString() });
              }
            }}
          >
            <option value="" disabled>
              安排日期
            </option>
            <option value="0">今天</option>
            <option value="1">明天</option>
            <option value="7">一周后</option>
            <option value="clear">清除日期</option>
          </select>
        </label>
        <button
          className="icon-btn"
          aria-label="取消批量选择"
          disabled={busy}
          onClick={onClear}
        >
          <X size={16} />
        </button>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}
