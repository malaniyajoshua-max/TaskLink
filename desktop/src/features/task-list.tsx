import { useMemo, useState, useEffect, useDeferredValue } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Flag,
  ListChecks,
  ListTodo,
  MoreHorizontal,
  Plus,
  Search,
  SearchX,
  List,
  Columns3,
  CheckSquare2,
  X,
} from "lucide-react";
import {
  invoke,
  message,
  useCommand,
  type Task,
  type Preferences,
} from "../api";
import {
  Button,
  Empty,
  ErrorBox,
  Heading,
  Loading,
  Pagination,
} from "../components/ui";
import { useUI, type View } from "../store";
import {
  dueLabel,
  effectiveBody,
  compareTasks,
  defaultDue,
  matchesFocus,
  priorityLabel,
  scopeTasks,
  statusLabel,
  type FocusFilter,
  type TaskSort,
} from "./task-presentation";
import { useTaskActions } from "./task-actions";
import { TaskBoard } from "./task-board";
import { QuickAdd } from "./quick-add";
import type { EditTask } from "./tasks";
import { BatchToolbar } from "./batch-toolbar";

const EMPTY_TASKS: Task[] = [];
export function TaskList({
  view,
  onEdit,
}: {
  view: View;
  onEdit: (edit: EditTask) => void;
}) {
  const { workspaceId, projectId, setProject } = useUI();
  const query = useCommand("tasks.list", {}),
    projects = useCommand("projects.list", {}),
    workspaces = useCommand("workspaces.list", {}),
    preferences = useCommand("settings.get", {});
  const [search, setSearch] = useState(""),
    [status, setStatus] = useState("all"),
    [priority, setPriority] = useState("all");
  const [focus, setFocus] = useState<FocusFilter>(null),
    [page, setPage] = useState(0);
  const sort = preferences.data?.taskSort ?? "due",
    layout = preferences.data?.taskLayout ?? "list";
  const [preferenceError, setPreferenceError] = useState("");
  const qc = useQueryClient();
  const [bulk, setBulk] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set());
  async function setPreference(patch: Partial<Preferences>) {
    try {
      const result = await invoke("settings.patch", patch);
      qc.setQueryData(["settings.get", {}], result);
      setPreferenceError("");
    } catch (reason) {
      setPreferenceError(message(reason));
    }
  }
  function setLayout(next: "list" | "board") {
    setBulk(false);
    setSelected(new Set());
    void setPreference({ taskLayout: next });
  }
  function setSort(next: TaskSort) {
    void setPreference({ taskSort: next });
  }
  const [now, setNow] = useState(() => new Date());
  const actions = useTaskActions();
  const tasks = query.data ?? EMPTY_TASKS;
  const canEdit =
    !workspaceId ||
    !!workspaces.data?.some(
      (ws) => ws.id === workspaceId && ws.role !== "viewer",
    );
  const deferredSearch = useDeferredValue(search.trim());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => setPage(0), [deferredSearch, status, priority, focus, sort]);
  const childrenByParent = useMemo(() => {
    const result = new Map<string, Task[]>();
    for (const task of tasks)
      if (task.body.parent_id) {
        const siblings = result.get(task.body.parent_id) ?? [];
        siblings.push(task);
        result.set(task.body.parent_id, siblings);
      }
    return result;
  }, [tasks]);
  const projectMap = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p])),
    [projects.data],
  );
  const scoped = useMemo(
    () =>
      scopeTasks(tasks, workspaceId, projectId, view, !!deferredSearch, now),
    [tasks, workspaceId, projectId, view, deferredSearch, now],
  );
  const matching = useMemo(
    () =>
      scoped.filter((task) => {
        const body = effectiveBody(task, tasks);
        return (
          (priority === "all" || body.priority === priority) &&
          matchesFocus(body, focus, now) &&
          (body.title + " " + body.description)
            .toLocaleLowerCase()
            .includes(deferredSearch.toLocaleLowerCase())
        );
      }),
    [scoped, tasks, priority, focus, now, deferredSearch],
  );
  const visible = useMemo(
    () =>
      matching
        .filter((task) => status === "all" || task.body.status === status)
        .sort((a, b) => compareTasks(a, b, tasks, sort)),
    [matching, status, tasks, sort],
  );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(visible.length / 100) - 1),
  );
  const rows = visible.slice(currentPage * 100, (currentPage + 1) * 100);
  const selectedIds = rows
    .filter((task) => selected.has(task.id))
    .map((task) => task.id);
  function clearBulk() {
    setBulk(false);
    setSelected(new Set());
  }
  function create() {
    onEdit({ due: defaultDue(view) });
  }
  function clearFilters() {
    setSearch("");
    setStatus("all");
    setPriority("all");
    setFocus(null);
  }
  const title = projectId
    ? (projectMap.get(projectId)?.body.name ?? "项目任务")
    : view === "today"
      ? "今日与逾期"
      : view === "upcoming"
        ? "即将到期"
        : "我的任务";
  const description = projectId
    ? projectMap.get(projectId)?.body.description ||
      "把目标拆成行动，一步步完成。"
    : view === "today"
      ? "专注今天的安排，也给逾期事项一个新的开始。"
      : view === "upcoming"
        ? "今天及之后七天内的安排，提前为重要的事留出时间。"
        : "记录待办，安排优先级和截止时间。";
  const hasFilters =
    !!search || status !== "all" || priority !== "all" || !!focus;
  const emptyTitle = hasFilters
    ? "没有找到符合条件的任务"
    : view === "today"
      ? "今天没有待办事项"
      : view === "upcoming"
        ? "未来七天还没有安排"
        : projectId
          ? "这个项目还没有任务"
          : "从第一项任务开始";
  return (
    <section className="tasks-view">
      <Heading
        title={title}
        description={description}
        action={
          canEdit && (
            <Button onClick={create} title="Ctrl+N">
              <Plus size={16} />
              新建任务
            </Button>
          )
        }
      />
      {!query.isPending && scoped.length > 0 && (
        <div className="focus-summary" aria-label="任务概览">
          {(
            [
              ["today", "今天到期"],
              ["overdue", "已经逾期"],
              ["priority", "高优先级"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={
                "focus-item focus-" + key + (focus === key ? " active" : "")
              }
              aria-pressed={focus === key}
              onClick={() => {
                setFocus(focus === key ? null : key);
                setStatus("all");
                setPriority("all");
                setSearch("");
              }}
            >
              <span>{label}</span>
              <strong>
                {
                  scoped.filter((task) =>
                    matchesFocus(effectiveBody(task, tasks), key, now),
                  ).length
                }
              </strong>
            </button>
          ))}
        </div>
      )}
      <div className="task-view-bar">
        <div className="status-tabs" role="tablist" aria-label="状态筛选">
          {[["all", "全部"], ...Object.entries(statusLabel)].map(
            ([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                value={key}
                tabIndex={status === key ? 0 : -1}
                aria-selected={status === key}
                className={status === key ? "selected" : ""}
                onClick={() => setStatus(key)}
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const tabs = Array.from(
                    event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                      '[role="tab"]',
                    ),
                  );
                  const index = tabs.indexOf(event.currentTarget);
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : (index +
                            (event.key === "ArrowRight" ? 1 : -1) +
                            tabs.length) %
                          tabs.length;
                  setStatus(tabs[next].value);
                  tabs[next].focus();
                }}
              >
                {label}
                <span>
                  {key === "all"
                    ? matching.length
                    : matching.filter((task) => task.body.status === key)
                        .length}
                </span>
              </button>
            ),
          )}
        </div>
        <div className="view-switch" role="group" aria-label="任务显示方式">
          <button
            aria-pressed={layout === "list"}
            onClick={() => setLayout("list")}
          >
            <List size={16} />
            列表
          </button>
          <button
            aria-pressed={layout === "board"}
            onClick={() => setLayout("board")}
          >
            <Columns3 size={16} />
            看板
          </button>
        </div>
      </div>
      <div className="task-surface">
        <div className="toolbar">
          <div className="search">
            <Search size={16} />
            <input
              aria-label="搜索任务"
              placeholder="搜索标题或描述"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search ? (
              <button
                className="icon-btn"
                aria-label="清空搜索"
                onClick={() => setSearch("")}
              >
                <X size={14} />
              </button>
            ) : (
              <kbd>Ctrl F</kbd>
            )}
          </div>
          <select
            aria-label="优先级筛选"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            <option value="all">所有优先级</option>
            {Object.entries(priorityLabel).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="任务排序"
            value={sort}
            onChange={(e) => setSort(e.target.value as TaskSort)}
          >
            <option value="due">截止时间</option>
            <option value="priority">优先级</option>
            <option value="updated">最近更新</option>
            <option value="title">任务名称</option>
          </select>
        </div>
        {hasFilters && (
          <div className="active-filters">
            <span>
              {focus
                ? {
                    today: "今天到期",
                    overdue: "已经逾期",
                    priority: "高优先级",
                  }[focus] + " · "
                : ""}
              找到 {visible.length} 项任务
            </span>
            <button onClick={clearFilters}>
              <X size={12} />
              清除筛选
            </button>
          </div>
        )}
        {!canEdit && (
          <p className="readonly-hint">你在此工作区拥有查看权限。</p>
        )}
        {canEdit && layout === "list" && rows.length > 0 && (
          <div className="batch-entry">
            {bulk ? (
              <label>
                <input
                  type="checkbox"
                  aria-label="全选当前页任务"
                  checked={selectedIds.length === rows.length}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? new Set(rows.map((task) => task.id))
                        : new Set(),
                    )
                  }
                />
                全选当前页
              </label>
            ) : (
              <button onClick={() => setBulk(true)}>
                <CheckSquare2 size={14} />
                批量选择
              </button>
            )}
          </div>
        )}
        {bulk && canEdit && (
          <BatchToolbar ids={selectedIds} onClear={clearBulk} />
        )}
        <ErrorBox error={actions.error || preferenceError || query.error} />
        {query.isPending ? (
          <Loading />
        ) : !visible.length ? (
          <Empty title={emptyTitle} icon={hasFilters ? SearchX : ListChecks}>
            <p>
              {hasFilters
                ? "换一个关键词，或清除筛选条件后再试。"
                : view === "today"
                  ? "新建一项今天到期的任务，或去“我的任务”查看全部内容。"
                  : view === "upcoming"
                    ? "为任务设置截止时间后，会在这里显示。"
                    : "写下需要完成的事，再安排优先级和时间。"}
            </p>
            {hasFilters ? (
              <Button variant="secondary" onClick={clearFilters}>
                重置条件
              </Button>
            ) : (
              canEdit && (
                <Button variant="secondary" onClick={create}>
                  <Plus size={15} />
                  {projectId
                    ? "添加项目任务"
                    : view === "today" || view === "upcoming"
                      ? "安排任务"
                      : "添加第一项任务"}
                </Button>
              )
            )}
          </Empty>
        ) : layout === "board" ? (
          <TaskBoard
            rows={rows}
            tasks={tasks}
            projects={projectMap}
            pending={actions.pending}
            canEdit={canEdit}
            onStatus={actions.setStatus}
            onEdit={onEdit}
            onCreate={(next) => onEdit({ due: defaultDue(view), status: next })}
          />
        ) : (
          <div className="task-table">
            <div className="task-columns" aria-hidden="true">
              <span>任务</span>
              <span>项目</span>
              <span>优先级</span>
              <span>截止时间</span>
              <span />
            </div>
            <div className="task-list">
              {rows.map((task) => {
                const body = effectiveBody(task, tasks),
                  children = childrenByParent.get(task.id) ?? [],
                  project = projectMap.get(body.project_id ?? "");
                return (
                  <div
                    className={
                      "task-row " + (body.status === "done" ? "completed" : "")
                    }
                    key={task.id}
                  >
                    {bulk ? (
                      <input
                        type="checkbox"
                        className="batch-checkbox"
                        aria-label={"选择任务 " + body.title}
                        checked={selected.has(task.id)}
                        onChange={(event) =>
                          setSelected((previous) => {
                            const next = new Set(previous);
                            if (event.target.checked) next.add(task.id);
                            else next.delete(task.id);
                            return next;
                          })
                        }
                      />
                    ) : (
                      <button
                        className={
                          "check " +
                          (body.status === "done"
                            ? "checked"
                            : body.status === "in_progress"
                              ? "in-progress"
                              : "")
                        }
                        aria-label={
                          (body.status === "done" ? "恢复任务 " : "完成任务 ") +
                          body.title
                        }
                        aria-pressed={body.status === "done"}
                        disabled={!canEdit || actions.pending.has(task.id)}
                        onClick={() =>
                          void actions.setStatus(
                            task,
                            body.status === "done" ? "todo" : "done",
                          )
                        }
                      >
                        {body.status === "done" && (
                          <Check size={13} strokeWidth={2.4} />
                        )}
                      </button>
                    )}
                    <button
                      className="task-copy task-open"
                      onClick={() => onEdit({ task })}
                    >
                      <strong>{body.title}</strong>
                      <small>
                        <span className={"status-dot " + body.status} />
                        <span className="task-description">
                          {body.parent_id ? "子任务 · " : ""}
                          {body.description || statusLabel[body.status]}
                        </span>
                        {children.length > 0 && (
                          <span className="subtask-count">
                            <ListTodo size={12} />
                            {
                              children.filter(
                                (child) => child.body.status === "done",
                              ).length
                            }
                            /{children.length}
                          </span>
                        )}
                      </small>
                    </button>
                    <div className="task-project">
                      {project ? (
                        <button
                          onClick={() => setProject(project.id)}
                          title={project.body.name}
                        >
                          <span
                            className="color-dot"
                            style={{ background: project.body.color }}
                          />
                          {project.body.name}
                        </button>
                      ) : (
                        <span className="metadata-empty">—</span>
                      )}
                    </div>
                    <span className={"priority " + body.priority}>
                      <Flag size={13} />
                      {priorityLabel[body.priority]}
                    </span>
                    <time
                      className={
                        body.due_at &&
                        new Date(body.due_at) < now &&
                        body.status !== "done"
                          ? "overdue"
                          : ""
                      }
                      dateTime={body.due_at ?? undefined}
                      title={
                        body.due_at
                          ? new Date(body.due_at).toLocaleString()
                          : undefined
                      }
                    >
                      {body.due_at ? (
                        dueLabel(body.due_at)
                      ) : (
                        <span className="metadata-empty">未设置</span>
                      )}
                    </time>
                    <button
                      className="icon-btn row-more"
                      aria-label={"编辑任务 " + body.title}
                      onClick={() => onEdit({ task })}
                    >
                      <MoreHorizontal size={17} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {canEdit && !query.isPending && (
          <QuickAdd
            workspaceId={workspaceId}
            projectId={projectId}
            view={view}
            onCreated={clearFilters}
          />
        )}
        <div className="task-list-footer">
          <span>
            {visible.length} 项任务
            {layout === "board" && visible.length > 100
              ? " · 看板显示当前页"
              : ""}
          </span>
          {layout === "board" && canEdit && (
            <span>拖动卡片调整状态，也可使用卡片内的状态菜单</span>
          )}
        </div>
        <Pagination
          count={visible.length}
          page={currentPage}
          onPage={setPage}
        />
      </div>
    </section>
  );
}
