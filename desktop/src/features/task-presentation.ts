import type { Task, TaskBody } from "../api";
import type { View } from "../store";

export const priorityLabel = {
  low: "低",
  medium: "中",
  high: "高",
  urgent: "紧急",
};
export const statusLabel = {
  todo: "待办",
  in_progress: "进行中",
  done: "已完成",
};

const indexes = new WeakMap<Task[], Map<string, Task>>();
export function taskIndex(tasks: Task[]) {
  let index = indexes.get(tasks);
  if (!index) {
    index = new Map(tasks.map((task) => [task.id, task]));
    indexes.set(tasks, index);
  }
  return index;
}
export function effectiveBody(task: Task, tasks: Task[]): TaskBody {
  const parent = taskIndex(tasks).get(task.body.parent_id ?? "");
  const body = { ...task.body };
  if (parent) {
    if (body.inherit_due) body.due_at = parent.body.due_at;
    if (body.inherit_priority) body.priority = parent.body.priority;
    if (body.inherit_reminder) body.reminder_at = parent.body.reminder_at;
  }
  return body;
}

export function dueLabel(value: string) {
  const date = new Date(value),
    today = new Date(),
    tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const time = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (date.toDateString() === today.toDateString()) return "今天 " + time;
  if (date.toDateString() === tomorrow.toDateString()) return "明天 " + time;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天 " + time;
  return date.toLocaleDateString("zh-CN", {
    year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
    month: "short",
    day: "numeric",
  });
}

export const dateInput = (value: string | null | undefined) =>
  value
    ? new Date(
        new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16)
    : "";
export const iso = (value: string) =>
  value ? new Date(value).toISOString() : null;

export type FocusFilter = "today" | "overdue" | "priority" | null;
export type TaskSort = "due" | "priority" | "updated" | "title";
const priorityRank = { urgent: 0, high: 1, medium: 2, low: 3 };

export function dayBounds(now: Date) {
  // Calendar boundaries use local dates so daylight-saving changes remain correct.
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const week = new Date(start);
  week.setDate(week.getDate() + 8);
  return { start, end, week };
}

export function defaultDue(view: View, now = new Date()) {
  if (view !== "today" && view !== "upcoming") return undefined;
  const due = new Date(now);
  due.setHours(23, 59, 0, 0);
  return due.toISOString();
}

export function matchesFocus(body: TaskBody, focus: FocusFilter, now: Date) {
  if (!focus) return true;
  if (body.status === "done") return false;
  if (focus === "priority") return priorityRank[body.priority] <= 1;
  if (!body.due_at) return false;
  const due = new Date(body.due_at);
  const { start, end } = dayBounds(now);
  return focus === "overdue" ? due < now : due >= start && due < end;
}

export function scopeTasks(
  tasks: Task[],
  workspaceId: string | null,
  projectId: string | null,
  view: View,
  includeChildren: boolean,
  now: Date,
) {
  const { start, end, week } = dayBounds(now);
  return tasks.filter((task) => {
    const body = effectiveBody(task, tasks);
    if (
      task.workspace_id !== workspaceId ||
      (projectId && body.project_id !== projectId)
    )
      return false;
    if (view === "inbox" && body.parent_id && !includeChildren) return false;
    const due = body.due_at ? new Date(body.due_at) : null;
    if (view === "today")
      return !!due && due < end && (body.status !== "done" || due >= start);
    if (view === "upcoming") return !!due && due >= start && due < week;
    return true;
  });
}

export function compareTasks(a: Task, b: Task, tasks: Task[], sort: TaskSort) {
  const left = effectiveBody(a, tasks);
  const right = effectiveBody(b, tasks);
  const completed =
    Number(left.status === "done") - Number(right.status === "done");
  if (completed) return completed;
  const due = (left.due_at ?? "9999").localeCompare(right.due_at ?? "9999");
  const priority = priorityRank[left.priority] - priorityRank[right.priority];
  const changed = b.updated_at.localeCompare(a.updated_at);
  if (sort === "priority")
    return priority || due || changed || a.id.localeCompare(b.id);
  if (sort === "updated") return changed || a.id.localeCompare(b.id);
  if (sort === "title")
    return (
      left.title.localeCompare(right.title, "zh-CN") || a.id.localeCompare(b.id)
    );
  return due || priority || changed || a.id.localeCompare(b.id);
}
