import { useState } from "react";
import { CalendarDays, Flag, GripVertical, Plus } from "lucide-react";
import type { Task, TaskBody, Project } from "../api";
import {
  dueLabel,
  effectiveBody,
  priorityLabel,
  statusLabel,
} from "./task-presentation";
import type { EditTask } from "./tasks";

export function TaskBoard({
  rows,
  tasks,
  projects,
  pending,
  canEdit,
  onStatus,
  onEdit,
  onCreate,
}: {
  rows: Task[];
  tasks: Task[];
  projects: Map<string, Project>;
  pending: Set<string>;
  canEdit: boolean;
  onStatus: (task: Task, status: TaskBody["status"]) => Promise<void>;
  onEdit: (edit: EditTask) => void;
  onCreate: (status: TaskBody["status"]) => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  return (
    <div className="task-board" aria-label="任务看板">
      {(Object.entries(statusLabel) as [TaskBody["status"], string][]).map(
        ([status, label]) => {
          const column = rows.filter((task) => task.body.status === status);
          return (
            <section
              key={status}
              className={"board-column " + (over === status ? "drag-over" : "")}
              aria-label={label + "任务"}
              onDragOver={(event) => {
                if (
                  canEdit &&
                  event.dataTransfer.types.includes(
                    "application/x-tasklink-task",
                  )
                ) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setOver(status);
                }
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node))
                  setOver(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                if (!canEdit) return;
                const task = rows.find(
                  (row) =>
                    row.id ===
                    event.dataTransfer.getData("application/x-tasklink-task"),
                );
                if (task) void onStatus(task, status);
              }}
            >
              <header className="board-column-heading">
                <span className={"status-dot " + status} />
                <h3>{label}</h3>
                <span>{column.length}</span>
                {canEdit && (
                  <button
                    className="icon-btn"
                    aria-label={"添加" + label + "任务"}
                    onClick={() => onCreate(status)}
                  >
                    <Plus size={16} />
                  </button>
                )}
              </header>
              <div className="board-cards">
                {column.map((task) => {
                  const body = effectiveBody(task, tasks),
                    project = projects.get(body.project_id ?? "");
                  return (
                    <article
                      key={task.id}
                      className={
                        "board-card " +
                        (body.status === "done" ? "completed" : "")
                      }
                      draggable={canEdit && !pending.has(task.id)}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(
                          "application/x-tasklink-task",
                          task.id,
                        );
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => setOver(null)}
                    >
                      <div className="board-card-top">
                        <span className={"priority " + body.priority}>
                          <Flag size={12} />
                          {priorityLabel[body.priority]}
                        </span>
                        <GripVertical size={14} aria-hidden="true" />
                      </div>
                      <button
                        className="board-task-open"
                        onClick={() => onEdit({ task })}
                      >
                        <strong>{body.title}</strong>
                        {body.description && <p>{body.description}</p>}
                      </button>
                      {project && (
                        <span className="board-project">
                          <span
                            className="color-dot"
                            style={{ background: project.body.color }}
                          />
                          {project.body.name}
                        </span>
                      )}
                      <footer>
                        {body.due_at && (
                          <time
                            className={
                              new Date(body.due_at) < new Date() &&
                              body.status !== "done"
                                ? "overdue"
                                : ""
                            }
                            dateTime={body.due_at}
                          >
                            <CalendarDays size={13} />
                            {dueLabel(body.due_at)}
                          </time>
                        )}
                        <select
                          aria-label={"任务状态 " + body.title}
                          value={body.status}
                          disabled={!canEdit || pending.has(task.id)}
                          onChange={(event) =>
                            void onStatus(
                              task,
                              event.target.value as TaskBody["status"],
                            )
                          }
                        >
                          {Object.entries(statusLabel).map(([key, text]) => (
                            <option key={key} value={key}>
                              {text}
                            </option>
                          ))}
                        </select>
                      </footer>
                    </article>
                  );
                })}
                {!column.length && (
                  <p className="board-empty">
                    {canEdit ? "拖放任务到这里，或添加任务" : "暂无任务"}
                  </p>
                )}
              </div>
            </section>
          );
        },
      )}
    </div>
  );
}
