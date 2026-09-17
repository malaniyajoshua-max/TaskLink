import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  CalendarDays,
  Check,
  Circle,
  Copy,
  Flag,
  Folder,
  Plus,
  RefreshCw,
  Trash2,
  UserRound,
} from "lucide-react";
import {
  invoke,
  message,
  taskBodySchema,
  useCommand,
  type Task,
  type TaskBody,
} from "../api";
import { Button, DateTimeField, ErrorBox, Modal } from "../components/ui";
import { useUI } from "../store";
import { notify } from "../components/notice";
import {
  dateInput,
  iso,
  priorityLabel,
  statusLabel,
} from "./task-presentation";
export { TaskList } from "./task-list";
export { effectiveBody } from "./task-presentation";
export interface EditTask {
  task?: Task;
  parent?: Task;
  due?: string;
  status?: TaskBody["status"];
}

export function TaskEditor({
  edit,
  onClose,
  onEdit,
}: {
  edit: EditTask;
  onClose: () => void;
  onEdit: (edit: EditTask) => void;
}) {
  const { workspaceId, projectId } = useUI(),
    { task, parent } = edit;
  const tasks = useCommand("tasks.list", {}),
    projects = useCommand("projects.list", {});
  const scope = task
    ? task.workspace_id
    : parent
      ? parent.workspace_id
      : workspaceId;
  const workspaces = useCommand("workspaces.list", {});
  const canEdit =
    !scope ||
    !!workspaces.data?.some((ws) => ws.id === scope && ws.role !== "viewer");
  const members = useCommand(
    "workspaces.members",
    { id: scope ?? "" },
    !!scope,
  );
  const [body, setBody] = useState<TaskBody>(
    () =>
      task?.body ?? {
        ...taskBodySchema.parse({
          title: "draft",
          project_id: parent?.body.project_id ?? projectId,
          parent_id: parent?.id ?? null,
          due_at: edit.due ?? null,
          status: edit.status ?? "todo",
          inherit_due: !!parent,
          inherit_reminder: !!parent,
          inherit_priority: !!parent,
        }),
        title: "",
      },
  );
  const initial = useRef(JSON.stringify(body));
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState(false),
    [discard, setDiscard] = useState(false);
  const qc = useQueryClient();
  const change = <K extends keyof TaskBody>(key: K, value: TaskBody[K]) =>
    setBody((b) => ({ ...b, [key]: value }));
  const children = (tasks.data ?? []).filter(
    (t) => t.body.parent_id === task?.id,
  );
  const parentTask = (tasks.data ?? []).find((t) => t.id === body.parent_id);
  const latestStatus = (tasks.data ?? []).find((t) => t.id === task?.id)?.body
    .status;
  useEffect(() => {
    if (!latestStatus) return;
    const baseline = JSON.parse(initial.current) as TaskBody;
    if (latestStatus === baseline.status) return;
    // A child checkbox can complete the parent while its editor stays open.
    // Follow that update only if the user has not explicitly edited the status;
    // keep their unsaved title, description and dates intact.
    setBody((current) =>
      current.status === baseline.status
        ? { ...current, status: latestStatus }
        : current,
    );
    initial.current = JSON.stringify({ ...baseline, status: latestStatus });
  }, [latestStatus]);
  function requestClose() {
    if (busy) return;
    if (JSON.stringify(body) !== initial.current) setDiscard(true);
    else onClose();
  }
  async function persistCurrent() {
    if (
      body.start_at &&
      body.due_at &&
      new Date(body.start_at) > new Date(body.due_at)
    )
      throw new Error("截止时间不能早于开始时间");
    const saved = await invoke("tasks.save", {
      id: task?.id,
      workspace_id: scope,
      body,
    });
    initial.current = JSON.stringify(body);
    await qc.invalidateQueries();
    return saved;
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !canEdit) return;
    setBusy(true);
    setError("");
    try {
      await persistCurrent();
      notify(task ? "任务已保存" : "任务已创建");
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!task) return;
    setBusy(true);
    try {
      await invoke("tasks.delete", { id: task.id });
      await qc.invalidateQueries();
      notify("任务已删除");
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function duplicate() {
    if (!task || busy || !canEdit) return;
    setBusy(true);
    setError("");
    try {
      if (JSON.stringify(body) !== initial.current) await persistCurrent();
      const copy = await invoke("tasks.duplicate", { id: task.id });
      await qc.invalidateQueries();
      notify("已复制任务及其子任务，提醒时间已清空");
      onEdit({ task: copy });
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  async function openChild(child?: Task) {
    if (!task) return;
    setBusy(true);
    setError("");
    try {
      const saved =
        JSON.stringify(body) === initial.current
          ? task
          : await persistCurrent();
      onEdit(child ? { task: child } : { parent: saved });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function toggleChild(child: Task) {
    setBusy(true);
    setError("");
    try {
      if (JSON.stringify(body) !== initial.current) await persistCurrent();
      const result = await invoke("tasks.status", {
        id: child.id,
        status: child.body.status === "done" ? "todo" : "done",
      });
      await qc.invalidateQueries({ queryKey: ["tasks.list"] });
      const undoId = result.undoId;
      notify(
        result.changedCount > 1
          ? "子任务与父任务状态已同步更新"
          : "子任务状态已更新",
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
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        !canEdit
          ? "查看任务"
          : task
            ? "编辑任务"
            : parent
              ? "新建子任务"
              : "新建任务"
      }
      onClose={requestClose}
      className="task-drawer"
    >
      <form
        className="task-editor"
        onSubmit={save}
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key === "Enter" &&
            !event.nativeEvent.isComposing &&
            canEdit
          ) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
      >
        <div className="task-editor-scroll">
          {body.parent_id && (
            <div className="parent-context">
              <Folder size={13} />
              {parentTask?.body.title ?? "父任务"}
            </div>
          )}
          <label className="task-title-field">
            <span className="sr-only">标题</span>
            <input
              autoFocus
              readOnly={!canEdit || busy}
              placeholder="要做些什么？"
              value={body.title}
              onChange={(e) => change("title", e.target.value)}
              maxLength={240}
              required
            />
          </label>
          <label className="task-description-field">
            <span className="sr-only">描述</span>
            <textarea
              placeholder="添加描述、链接或相关信息…"
              rows={3}
              readOnly={!canEdit || busy}
              value={body.description}
              onChange={(e) => change("description", e.target.value)}
              maxLength={20000}
            />
          </label>
          {!canEdit && (
            <p className="readonly-hint">
              你可以查看此任务；修改需要工作区编辑权限。
            </p>
          )}
          <fieldset className="task-properties" disabled={!canEdit || busy}>
            <label className="property-row">
              <span>
                <RefreshCw />
                状态
              </span>
              <select
                aria-label="状态"
                value={body.status}
                onChange={(e) =>
                  change("status", e.target.value as TaskBody["status"])
                }
              >
                {Object.entries(statusLabel).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="property-row">
              <span>
                <Flag />
                优先级
              </span>
              <select
                aria-label="优先级"
                disabled={!!body.parent_id && body.inherit_priority}
                value={
                  body.inherit_priority && parentTask
                    ? parentTask.body.priority
                    : body.priority
                }
                onChange={(e) =>
                  change("priority", e.target.value as TaskBody["priority"])
                }
              >
                {Object.entries(priorityLabel).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="property-row">
              <span>
                <Folder />
                项目
              </span>
              <select
                aria-label="项目"
                disabled={!!body.parent_id}
                value={body.project_id ?? ""}
                onChange={(e) => change("project_id", e.target.value || null)}
              >
                <option value="">无项目</option>
                {(projects.data ?? [])
                  .filter(
                    (p) =>
                      p.workspace_id === scope &&
                      (!p.body.archived || p.id === body.project_id),
                  )
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.body.name}
                    </option>
                  ))}
              </select>
            </label>
            {scope && (
              <label className="property-row">
                <span>
                  <UserRound />
                  负责人
                </span>
                <select
                  aria-label="负责人"
                  value={body.assignee_id ?? ""}
                  onChange={(e) =>
                    change("assignee_id", e.target.value || null)
                  }
                >
                  <option value="">未分配</option>
                  {(members.data ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                  {body.assignee_id &&
                    !members.data?.some((m) => m.id === body.assignee_id) && (
                      <option value={body.assignee_id}>未缓存的成员</option>
                    )}
                </select>
              </label>
            )}
            <label className="property-row">
              <span>
                <CalendarDays />
                开始时间
              </span>
              <DateTimeField
                aria-label="开始时间"
                type="datetime-local"
                value={dateInput(body.start_at)}
                onChange={(e) => change("start_at", iso(e.target.value))}
              />
            </label>
            <label className="property-row">
              <span>
                <CalendarDays />
                截止时间
              </span>
              <DateTimeField
                aria-label="截止时间"
                type="datetime-local"
                disabled={!!body.parent_id && body.inherit_due}
                value={dateInput(
                  body.inherit_due && parentTask
                    ? parentTask.body.due_at
                    : body.due_at,
                )}
                onChange={(e) => change("due_at", iso(e.target.value))}
              />
            </label>
            {canEdit && !(body.parent_id && body.inherit_due) && (
              <div
                className="date-shortcuts"
                role="group"
                aria-label="快捷截止日期"
              >
                {[
                  [0, "今天"],
                  [1, "明天"],
                  [7, "一周后"],
                ].map(([days, label]) => (
                  <button
                    key={days}
                    type="button"
                    onClick={() => {
                      const date = new Date();
                      date.setDate(date.getDate() + Number(days));
                      date.setHours(
                        Number(days) === 0 ? 23 : 18,
                        Number(days) === 0 ? 59 : 0,
                        0,
                        0,
                      );
                      change("due_at", date.toISOString());
                    }}
                  >
                    {label}
                  </button>
                ))}
                {body.due_at && (
                  <button type="button" onClick={() => change("due_at", null)}>
                    清除日期
                  </button>
                )}
              </div>
            )}
            <label className="property-row">
              <span>
                <Bell />
                提醒时间
              </span>
              <DateTimeField
                aria-label="提醒时间"
                type="datetime-local"
                disabled={!!body.parent_id && body.inherit_reminder}
                value={dateInput(
                  body.inherit_reminder && parentTask
                    ? parentTask.body.reminder_at
                    : body.reminder_at,
                )}
                onChange={(e) => change("reminder_at", iso(e.target.value))}
              />
            </label>
          </fieldset>
          {body.parent_id && (
            <div className="inherit-options">
              {(
                [
                  ["inherit_due", "跟随父任务截止时间"],
                  ["inherit_reminder", "跟随父任务提醒"],
                  ["inherit_priority", "跟随父任务优先级"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={body[key]}
                    disabled={!canEdit || busy}
                    onChange={(e) => change(key, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
          )}
          <ErrorBox error={error} />
          {(body.parent_id || children.length > 0) && (
            <p className="muted">
              完成父任务会完成全部子任务；子任务全部完成时，父任务自动完成。
              恢复子任务会将已完成的父任务改为进行中；恢复父任务会将全部子任务改为待办。
            </p>
          )}
          {task && !task.body.parent_id && (
            <section className="subtasks">
              <h4>
                子任务{" "}
                {children.length > 0 && (
                  <span>
                    {children.filter((t) => t.body.status === "done").length}/
                    {children.length}
                  </span>
                )}
              </h4>
              {children.map((child) => (
                <div className="subtask-row" key={child.id}>
                  <button
                    type="button"
                    disabled={busy || !canEdit}
                    className={
                      "check " + (child.body.status === "done" ? "checked" : "")
                    }
                    aria-label={
                      (child.body.status === "done"
                        ? "恢复子任务 "
                        : "完成子任务 ") + child.body.title
                    }
                    onClick={() => toggleChild(child)}
                  >
                    {child.body.status === "done" && <Check size={12} />}
                  </button>
                  <button
                    type="button"
                    className={
                      "subtask-link " +
                      (child.body.status === "done" ? "done" : "")
                    }
                    onClick={() => openChild(child)}
                  >
                    {child.body.title}
                  </button>
                </div>
              ))}
              {canEdit && (
                <Button
                  type="button"
                  variant="text"
                  disabled={busy}
                  onClick={() => openChild()}
                >
                  <Plus size={15} />
                  添加子任务
                </Button>
              )}
            </section>
          )}
          {deleting && (
            <div className="error">
              确认删除此任务及其子任务？它会从你的所有设备中移除。
              <Button
                type="button"
                variant="danger"
                onClick={remove}
                disabled={busy}
              >
                确认删除
              </Button>
            </div>
          )}
          {discard && (
            <div className="discard-confirmation" role="alert">
              <p>要放弃尚未保存的修改吗？</p>
              <div className="button-group">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setDiscard(false)}
                >
                  继续编辑
                </Button>
                <Button type="button" variant="danger" onClick={onClose}>
                  放弃修改
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className="task-editor-footer">
          {task && canEdit && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setDeleting(!deleting)}
            >
              <Trash2 size={15} />
              删除
            </Button>
          )}
          <span className="footer-spacer" />
          {task && canEdit && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={duplicate}
              title="复制任务及其子任务；有修改时会先保存"
            >
              <Copy size={14} />
              {JSON.stringify(body) !== initial.current ? "保存并复制" : "复制"}
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={requestClose}
          >
            取消
          </Button>
          {canEdit && (
            <Button disabled={busy} title="Ctrl+Enter">
              {busy ? "正在保存…" : "保存任务"}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
