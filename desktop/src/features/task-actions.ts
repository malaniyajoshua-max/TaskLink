import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invoke, message, type Task, type TaskBody } from "../api";
import { notify } from "../components/notice";

export function useTaskActions() {
  const qc = useQueryClient();
  const lock = useRef(new Set<string>());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  async function setStatus(task: Task, status: TaskBody["status"]) {
    if (lock.current.has(task.id)) return;
    lock.current.add(task.id);
    setPending(new Set(lock.current));
    setError("");
    try {
      const {
        task: current,
        previous,
        undoId,
        changedCount,
      } = await invoke("tasks.status", {
        id: task.id,
        status,
      });
      if (previous === status) return;
      await qc.invalidateQueries({ queryKey: ["tasks.list"] });
      notify(
        `已${status === "done" ? "完成" : "更新"}「${current.body.title}」${changedCount > 1 ? `，联动更新 ${changedCount - 1} 个关联任务` : ""}`,
        undoId
          ? {
              label: "撤销",
              run: async () => {
                await invoke("tasks.undoStatus", { id: undoId });
                await qc.invalidateQueries({ queryKey: ["tasks.list"] });
                notify("已恢复本次修改前的任务状态");
              },
            }
          : undefined,
      );
    } catch (reason) {
      setError(message(reason));
    } finally {
      lock.current.delete(task.id);
      setPending(new Set(lock.current));
    }
  }
  return { setStatus, pending, error };
}
