import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Coffee, Pause, Play, RotateCcw, Timer } from "lucide-react";
import { invoke, message, useCommand } from "../api";
import {
  initialFocus,
  remainingFocus,
  type FocusCommand,
} from "../../shared/focus";
import { Button, ErrorBox, Modal } from "../components/ui";
import { notify } from "../components/notice";
import { useUI } from "../store";

export function FocusTimer() {
  const query = useCommand("focus.get", {}),
    tasks = useCommand("tasks.list", {});
  const workspaceId = useUI((state) => state.workspaceId);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [now, setNow] = useState(Date.now),
    [confirmReset, setConfirmReset] = useState(false);
  const lock = useRef(false),
    settled = useRef<number | null>(null);
  const state = query.data ?? initialFocus();
  const remaining = remainingFocus(state, now);
  const display = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
  const task = tasks.data?.find((row) => row.id === state.taskId);
  const active = state.state === "running" || state.state === "paused";
  useEffect(() => {
    if (state.state !== "running") return;
    // This interval only repaints the display. The worker owns the persisted
    // deadline and completion record; missed frames cannot extend a session.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.state]);
  useEffect(() => {
    if (
      state.state !== "running" ||
      remaining > 0 ||
      settled.current === state.endsAt
    )
      return;
    settled.current = state.endsAt;
    void invoke("focus.get", {})
      .then((result) => {
        qc.setQueryData(["focus.get", {}], result);
        notify(
          result.mode === "focus"
            ? "这一段专注完成了，休息一下吧。"
            : "休息结束，可以开始下一段专注。",
        );
      })
      .catch((reason) => {
        setError(message(reason));
        settled.current = null;
      });
  }, [remaining, state.state, state.endsAt, qc]);
  async function act(command: FocusCommand) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await invoke("focus.command", command);
      qc.setQueryData(["focus.get", {}], result);
      setNow(Date.now());
      setConfirmReset(false);
      settled.current = null;
    } catch (reason) {
      setError(message(reason));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function configure(
    patch: Partial<{
      mode: "focus" | "break";
      minutes: number;
      taskId: string | null;
    }>,
  ) {
    return act({
      action: "configure",
      mode: state.mode,
      minutes: state.duration / 60,
      taskId: state.taskId,
      ...patch,
    });
  }
  return (
    <>
      <button
        className={"nav-btn focus-nav " + (active ? "is-timing" : "")}
        aria-label="专注计时"
        onClick={() => setOpen(true)}
      >
        <Timer size={17} />
        <span>专注计时</span>
        {active && <time>{display}</time>}
      </button>
      {open && (
        <Modal
          title="专注计时"
          onClose={() => setOpen(false)}
          className="focus-dialog"
        >
          <div className="focus-mode" role="group" aria-label="计时模式">
            <button
              aria-pressed={state.mode === "focus"}
              disabled={busy || active}
              onClick={() => void configure({ mode: "focus", minutes: 25 })}
            >
              <Timer size={16} />
              专注
            </button>
            <button
              aria-pressed={state.mode === "break"}
              disabled={busy || active}
              onClick={() =>
                void configure({ mode: "break", minutes: 5, taskId: null })
              }
            >
              <Coffee size={16} />
              短休息
            </button>
          </div>
          <p className="focus-context">
            {state.state === "completed"
              ? "本次计时已完成"
              : state.state === "paused"
                ? "计时已暂停，准备好后继续"
                : state.mode === "break"
                  ? "休息一下，再开始下一项任务"
                  : "为当前任务留出一段专注时间"}
          </p>
          <div
            className={
              "timer-dial " + (state.state === "running" ? "running" : "")
            }
            role="timer"
            aria-label={"剩余 " + display}
          >
            <svg viewBox="0 0 240 240" aria-hidden="true">
              <circle cx="120" cy="120" r="108" />
              <circle
                className="timer-progress"
                cx="120"
                cy="120"
                r="108"
                pathLength="100"
                strokeDasharray="100"
                strokeDashoffset={100 - (remaining / state.duration) * 100}
              />
            </svg>
            <strong>{display}</strong>
            <small>
              {state.state === "running"
                ? "正在" + (state.mode === "focus" ? "专注" : "休息")
                : state.state === "paused"
                  ? "已暂停"
                  : state.state === "completed"
                    ? "已完成"
                    : "准备开始"}
            </small>
          </div>
          <div className="focus-duration" role="group" aria-label="计时时长">
            {(state.mode === "focus" ? [15, 25, 45, 60] : [5, 10, 15]).map(
              (minutes) => (
                <button
                  key={minutes}
                  aria-pressed={state.duration === minutes * 60}
                  disabled={active || busy}
                  onClick={() => void configure({ minutes })}
                >
                  {minutes} 分钟
                </button>
              ),
            )}
          </div>
          {state.mode === "focus" && (
            <label className="focus-task-label">
              关联任务
              <select
                aria-label="专注关联任务"
                disabled={active || busy}
                value={state.taskId ?? ""}
                onChange={(event) =>
                  void configure({ taskId: event.target.value || null })
                }
              >
                <option value="">自由专注</option>
                {(tasks.data ?? [])
                  .filter(
                    (row) =>
                      row.workspace_id === workspaceId &&
                      row.body.status !== "done",
                  )
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.body.title}
                    </option>
                  ))}
                {state.taskId &&
                  !(tasks.data ?? []).some(
                    (row) =>
                      row.id === state.taskId &&
                      row.workspace_id === workspaceId &&
                      row.body.status !== "done",
                  ) && (
                    <option value={state.taskId}>
                      {task?.body.title ?? "原任务已不可用"}
                    </option>
                  )}
              </select>
            </label>
          )}
          <ErrorBox error={error || query.error} />
          {confirmReset ? (
            <div className="focus-reset-confirm">
              <p>结束本次计时？未完成的这一段不会计入专注记录。</p>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setConfirmReset(false)}
              >
                继续计时
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => void act({ action: "reset" })}
              >
                结束本次
              </Button>
            </div>
          ) : (
            <div className="focus-controls">
              {state.state === "running" ? (
                <Button
                  disabled={busy}
                  onClick={() => void act({ action: "pause" })}
                >
                  <Pause size={17} />
                  暂停
                </Button>
              ) : (
                <Button
                  disabled={busy || query.isPending}
                  onClick={() => void act({ action: "start" })}
                >
                  <Play size={17} />
                  {state.state === "paused"
                    ? "继续专注"
                    : state.state === "completed"
                      ? "再来一轮"
                      : "开始计时"}
                </Button>
              )}
              {active && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setConfirmReset(true)}
                >
                  <RotateCcw size={16} />
                  结束
                </Button>
              )}
            </div>
          )}
          <div className="focus-record">
            <span>
              已完成 <b>{state.sessions}</b> 段专注
            </span>
            <span>
              累计 <b>{Math.floor(state.focusedSeconds / 60)}</b> 分钟
            </span>
          </div>
          <p className="focus-footnote">
            本机记录 · 收起窗口后继续计时 · 专注结束不会自动完成任务
          </p>
        </Modal>
      )}
    </>
  );
}
