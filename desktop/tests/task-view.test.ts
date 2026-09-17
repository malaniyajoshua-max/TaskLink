import { describe, expect, it } from "vitest";
import { taskBodySchema, type Task } from "../shared/contract";
import {
  compareTasks,
  defaultDue,
  matchesFocus,
  scopeTasks,
} from "../src/features/task-presentation";
import { dueLabel } from "../src/features/task-presentation";

const now = new Date(2026, 8, 8, 14, 30);
const at = (day: number, hour = 18) =>
  new Date(2026, 8, day, hour).toISOString();
const projectId = "00000000-0000-4000-8000-000000000001";
const parentId = "00000000-0000-4000-8000-000000000002";
function task(
  id: string,
  body: Record<string, unknown> = {},
  workspace_id: string | null = null,
): Task {
  return {
    id,
    kind: "task",
    workspace_id,
    owner_id: "owner",
    version: 1,
    deleted: false,
    updated_at: at(8, 10),
    body: taskBodySchema.parse({ title: id, ...body }),
  };
}
describe("task workspace experience", () => {
  it("creates tasks on the visible day without changing unscoped defaults", () => {
    const due = new Date(defaultDue("today", now)!);
    expect(due.toDateString()).toBe(now.toDateString());
    expect(due.getTime()).toBeGreaterThan(now.getTime());
    expect(defaultDue("upcoming", now)).toBe(defaultDue("today", now));
    expect(defaultDue("inbox", now)).toBeUndefined();
  });
  it("keeps today's completed tasks reviewable without resurrecting old completed work", () => {
    const rows = [
      task("late", { due_at: at(7) }),
      task("today", { due_at: at(8), status: "done" }),
      task("old-done", { due_at: at(7), status: "done" }),
      task("future", { due_at: at(9) }),
      task("no-date"),
    ];
    expect(
      scopeTasks(rows, null, null, "today", false, now).map((row) => row.id),
    ).toEqual(["late", "today"]);
  });
  it("uses local calendar days for the eight-day upcoming window", () => {
    const rows = [
      task("before", { due_at: at(7, 23) }),
      task("start", { due_at: at(8, 0) }),
      task("last", { due_at: at(15, 23), status: "done" }),
      task("outside", { due_at: at(16, 0) }),
    ];
    expect(
      scopeTasks(rows, null, null, "upcoming", false, now).map((row) => row.id),
    ).toEqual(["start", "last"]);
  });
  it("honors inherited deadlines and priority when filtering and sorting", () => {
    const parent = task(parentId, {
      due_at: at(8, 12),
      priority: "urgent",
      project_id: projectId,
    });
    const child = task("child", {
      parent_id: parentId,
      project_id: projectId,
      inherit_due: true,
      inherit_priority: true,
    });
    const rows = [parent, child];
    expect(scopeTasks(rows, null, null, "today", false, now)).toHaveLength(2);
    expect(scopeTasks(rows, null, null, "inbox", false, now)).toEqual([parent]);
    expect(scopeTasks(rows, null, null, "inbox", true, now)).toHaveLength(2);
    expect(
      compareTasks(child, task("low", { priority: "low" }), rows, "priority"),
    ).toBeLessThan(0);
  });
  it("never mixes workspaces or projects", () => {
    const rows = [
      task("personal", { project_id: projectId }),
      task("work", { project_id: projectId }, "team"),
      task("other"),
    ];
    expect(
      scopeTasks(rows, null, projectId, "inbox", false, now).map(
        (row) => row.id,
      ),
    ).toEqual(["personal"]);
    expect(
      scopeTasks(rows, "team", null, "inbox", false, now).map((row) => row.id),
    ).toEqual(["work"]);
  });
  it("flags a deadline earlier today as overdue and excludes completed tasks", () => {
    expect(
      matchesFocus(task("late", { due_at: at(8, 12) }).body, "overdue", now),
    ).toBe(true);
    expect(
      matchesFocus(task("later", { due_at: at(8, 16) }).body, "overdue", now),
    ).toBe(false);
    expect(
      matchesFocus(
        task("done", { due_at: at(7), status: "done" }).body,
        "overdue",
        now,
      ),
    ).toBe(false);
  });
  it("keeps completed tasks after active tasks in every ordering", () => {
    const done = task("done", {
        status: "done",
        priority: "urgent",
        due_at: at(1),
      }),
      active = task("active", { priority: "low" });
    for (const order of ["due", "priority", "updated", "title"] as const)
      expect(compareTasks(done, active, [done, active], order)).toBeGreaterThan(
        0,
      );
  });
  it("makes deadlines from different years unambiguous", () => {
    const date = new Date();
    date.setFullYear(date.getFullYear() - 1);
    expect(dueLabel(date.toISOString())).toContain(String(date.getFullYear()));
  });
});
