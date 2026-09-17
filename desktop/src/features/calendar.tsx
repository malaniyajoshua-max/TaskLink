import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  CalendarDays,
  BellOff,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  X,
} from "lucide-react";
import { useCommand } from "../api";
import { Button, Empty, ErrorBox, Heading, Pagination } from "../components/ui";
import { useUI } from "../store";
import { effectiveBody, type EditTask } from "./tasks";

const monthNames = [
  "一月",
  "二月",
  "三月",
  "四月",
  "五月",
  "六月",
  "七月",
  "八月",
  "九月",
  "十月",
  "十一月",
  "十二月",
];
const weekNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function dayKey(day: Date) {
  return [
    day.getFullYear(),
    String(day.getMonth() + 1).padStart(2, "0"),
    String(day.getDate()).padStart(2, "0"),
  ].join("-");
}

function fromDayKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function Calendar({ onEdit }: { onEdit: (edit: EditTask) => void }) {
  const today = new Date();
  const [month, setMonth] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1),
  );
  const [selectedDay, setSelectedDay] = useState<string | null>(() =>
    dayKey(today),
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(String(month.getFullYear()));
  const pickerRef = useRef<HTMLDivElement>(null);
  const yearInputRef = useRef<HTMLInputElement>(null);
  const workspaceId = useUI((s) => s.workspaceId);
  const taskQuery = useCommand("tasks.list", {});
  const projectQuery = useCommand("projects.list", {});
  const tasks = taskQuery.data ?? [];
  const projects = projectQuery.data ?? [];
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const days = useMemo(() => {
    const offset = (month.getDay() + 6) % 7;
    return Array.from(
      { length: 42 },
      (_, index) =>
        new Date(month.getFullYear(), month.getMonth(), 1 - offset + index),
    );
  }, [month]);
  const byDay = useMemo(() => {
    const result = new Map<string, typeof tasks>();
    for (const task of tasks) {
      const due = effectiveBody(task, tasks).due_at;
      if (task.workspace_id !== workspaceId || !due) continue;
      const key = dayKey(new Date(due));
      const rows = result.get(key) ?? [];
      rows.push(task);
      result.set(key, rows);
    }
    for (const rows of result.values())
      rows.sort((a, b) =>
        (effectiveBody(a, tasks).due_at ?? "").localeCompare(
          effectiveBody(b, tasks).due_at ?? "",
        ),
      );
    return result;
  }, [tasks, workspaceId]);
  const selectedDate = selectedDay ? fromDayKey(selectedDay) : today;
  const selectedRows = selectedDay ? (byDay.get(selectedDay) ?? []) : [];

  function normalizedPickerYear() {
    const parsed = Number.parseInt(pickerYear, 10);
    return Math.min(
      2200,
      Math.max(1900, Number.isFinite(parsed) ? parsed : month.getFullYear()),
    );
  }

  useEffect(() => {
    if (!pickerOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node))
        setPickerOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithEscape);
    const timer = window.setTimeout(() => yearInputRef.current?.select(), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [pickerOpen]);

  function shiftMonth(offset: number) {
    const next = new Date(month.getFullYear(), month.getMonth() + offset, 1);
    setMonth(next);
    setSelectedDay(dayKey(next));
    setPickerYear(String(next.getFullYear()));
    setPickerOpen(false);
  }

  function goToday() {
    const current = new Date();
    setMonth(new Date(current.getFullYear(), current.getMonth(), 1));
    setSelectedDay(dayKey(current));
    setPickerYear(String(current.getFullYear()));
    setPickerOpen(false);
  }

  function createFor(day: Date) {
    const due = new Date(day);
    due.setHours(18, 0, 0, 0);
    onEdit({ due: due.toISOString() });
  }

  function taskStyle(projectId: string | null) {
    const color = projectId
      ? projectById.get(projectId)?.body.color
      : undefined;
    return { "--task-color": color ?? "#5966ef" } as CSSProperties;
  }

  return (
    <section className="calendar-view">
      <div className="calendar-heading">
        <div className="calendar-title-wrap" ref={pickerRef}>
          <button
            type="button"
            className="calendar-title"
            aria-expanded={pickerOpen}
            aria-controls="calendar-month-picker"
            onClick={() => {
              setPickerYear(String(month.getFullYear()));
              setPickerOpen((open) => !open);
            }}
          >
            {month.toLocaleDateString("zh-CN", {
              year: "numeric",
              month: "long",
            })}
            <ChevronDown size={18} />
          </button>
          <p>选择日期查看日程，点击任务即可编辑。</p>
          {pickerOpen && (
            <div
              id="calendar-month-picker"
              className="month-picker"
              role="dialog"
              aria-label="选择年月"
            >
              <div className="month-picker-year">
                <button
                  type="button"
                  aria-label="上一年"
                  onClick={() =>
                    setPickerYear(
                      String(Math.max(1900, normalizedPickerYear() - 1)),
                    )
                  }
                >
                  <ChevronLeft size={16} />
                </button>
                <label>
                  <span className="sr-only">年份</span>
                  <input
                    ref={yearInputRef}
                    aria-label="年份"
                    type="number"
                    min={1900}
                    max={2200}
                    value={pickerYear}
                    onChange={(event) => setPickerYear(event.target.value)}
                    onBlur={() => setPickerYear(String(normalizedPickerYear()))}
                  />
                  <span>年</span>
                </label>
                <button
                  type="button"
                  aria-label="下一年"
                  onClick={() =>
                    setPickerYear(
                      String(Math.min(2200, normalizedPickerYear() + 1)),
                    )
                  }
                >
                  <ChevronRight size={16} />
                </button>
              </div>
              <div className="month-picker-grid">
                {monthNames.map((name, index) => (
                  <button
                    type="button"
                    key={name}
                    className={
                      Number(pickerYear) === month.getFullYear() &&
                      index === month.getMonth()
                        ? "active"
                        : ""
                    }
                    onClick={() => {
                      const year = normalizedPickerYear();
                      const next = new Date(year, index, 1);
                      setPickerYear(String(year));
                      setMonth(next);
                      setSelectedDay(dayKey(next));
                      setPickerOpen(false);
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="calendar-actions">
          <Button onClick={() => createFor(selectedDate)}>
            <Plus size={17} />
            新建任务
          </Button>
          <div className="calendar-nav">
            <Button
              variant="secondary"
              aria-label="上个月"
              onClick={() => shiftMonth(-1)}
            >
              <ChevronLeft size={17} />
            </Button>
            <Button variant="secondary" onClick={goToday}>
              今天
            </Button>
            <Button
              variant="secondary"
              aria-label="下个月"
              onClick={() => shiftMonth(1)}
            >
              <ChevronRight size={17} />
            </Button>
          </div>
        </div>
      </div>
      <ErrorBox error={taskQuery.error || projectQuery.error} />
      <div
        className={
          "calendar-workspace " +
          (selectedDay ? "with-agenda" : "without-agenda")
        }
      >
        <div className="calendar-surface">
          <div className="calendar-weekdays">
            {weekNames.map((name) => (
              <span key={name}>{name}</span>
            ))}
          </div>
          <div className="calendar-grid">
            {days.map((day, index) => {
              const key = dayKey(day);
              const rows = byDay.get(key) ?? [];
              const isToday = key === dayKey(today);
              return (
                <div
                  className={[
                    "day",
                    day.getMonth() !== month.getMonth() ? "other-month" : "",
                    isToday ? "today" : "",
                    key === selectedDay ? "selected" : "",
                    index % 7 > 4 ? "weekend" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={key}
                  onClick={() => setSelectedDay(key)}
                >
                  <button
                    type="button"
                    className="calendar-day-add"
                    aria-label={`在${day.toLocaleDateString("zh-CN")}新建任务`}
                    onClick={(event) => {
                      event.stopPropagation();
                      createFor(day);
                    }}
                  >
                    <Plus size={13} />
                  </button>
                  <button
                    className="day-number"
                    aria-label={
                      day.toLocaleDateString("zh-CN") +
                      (isToday ? "，今天" : "") +
                      "，选择日期"
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedDay(key);
                    }}
                  >
                    {day.getDate()}
                  </button>
                  <div className="calendar-tasks">
                    {rows.slice(0, 3).map((task) => {
                      const body = effectiveBody(task, tasks);
                      return (
                        <button
                          key={task.id}
                          title={task.body.title}
                          style={taskStyle(task.body.project_id)}
                          className={
                            "calendar-task " +
                            (task.body.status === "done" ? "done" : "")
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            onEdit({ task });
                          }}
                        >
                          <span className="calendar-task-dot">
                            {task.body.status === "done" && <Check size={10} />}
                          </span>
                          <span>{task.body.title}</span>
                          <time>
                            {body.due_at
                              ? new Date(body.due_at).toLocaleTimeString(
                                  "zh-CN",
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    hour12: false,
                                  },
                                )
                              : ""}
                          </time>
                        </button>
                      );
                    })}
                    {rows.length > 3 && (
                      <button
                        className="calendar-overflow"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedDay(key);
                        }}
                      >
                        +{rows.length - 3} 项
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {selectedDay && (
          <aside className="calendar-agenda" aria-label="选中日期日程">
            <div className="calendar-agenda-header">
              <div>
                <strong>
                  {selectedDate.toLocaleDateString("zh-CN", {
                    month: "long",
                    day: "numeric",
                  })}
                </strong>
                <span>
                  {selectedDate.toLocaleDateString("zh-CN", {
                    weekday: "long",
                  })}
                </span>
              </div>
              <button
                type="button"
                className="icon-btn calendar-agenda-close"
                aria-label="关闭日程侧栏"
                onClick={() => setSelectedDay(null)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="calendar-agenda-count">
              当天任务 <b>{selectedRows.length}</b>
            </div>
            {!selectedRows.length ? (
              <div className="calendar-agenda-empty">
                <CalendarDays size={24} />
                <p>这一天还没有任务</p>
                <button type="button" onClick={() => createFor(selectedDate)}>
                  安排一项任务
                </button>
              </div>
            ) : (
              <div className="calendar-agenda-list">
                {selectedRows.map((task) => {
                  const body = effectiveBody(task, tasks);
                  const project = task.body.project_id
                    ? projectById.get(task.body.project_id)
                    : undefined;
                  return (
                    <button
                      key={task.id}
                      style={taskStyle(task.body.project_id)}
                      onClick={() => onEdit({ task })}
                    >
                      <span
                        className={
                          "agenda-status " +
                          (task.body.status === "done" ? "done" : "")
                        }
                      >
                        {task.body.status === "done" && <Check size={11} />}
                      </span>
                      <span className="agenda-task-copy">
                        <strong>{task.body.title}</strong>
                        <small>{project?.body.name ?? "个人任务"}</small>
                      </span>
                      <time>
                        {body.due_at
                          ? new Date(body.due_at).toLocaleTimeString("zh-CN", {
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: false,
                            })
                          : ""}
                      </time>
                    </button>
                  );
                })}
              </div>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}

export function Reminders({ onEdit }: { onEdit: (edit: EditTask) => void }) {
  const query = useCommand("tasks.list", {});
  const workspaceId = useUI((s) => s.workspaceId);
  const tasks = query.data ?? [];
  const [page, setPage] = useState(0);
  const rows = tasks
    .filter(
      (task) =>
        task.workspace_id === workspaceId &&
        task.body.status !== "done" &&
        effectiveBody(task, tasks).reminder_at,
    )
    .sort((a, b) =>
      effectiveBody(a, tasks).reminder_at!.localeCompare(
        effectiveBody(b, tasks).reminder_at!,
      ),
    );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / 100) - 1),
  );
  return (
    <section>
      <Heading
        title="提醒"
        description="到点发送系统通知；错过的提醒会在下次打开 TaskLink 时补发。"
      />
      <ErrorBox error={query.error} />
      {!rows.length ? (
        <Empty title="还没有提醒" icon={BellOff}>
          <p>打开任意任务并设置提醒时间，到点后会收到通知。</p>
          <Button variant="secondary" onClick={() => onEdit({})}>
            <Plus size={15} />
            新建带提醒的任务
          </Button>
        </Empty>
      ) : (
        <div className="task-list reminder-list">
          {rows
            .slice(currentPage * 100, (currentPage + 1) * 100)
            .map((task) => (
              <button
                key={task.id}
                className="task-row reminder-row"
                onClick={() => onEdit({ task })}
              >
                <strong>{task.body.title}</strong>
                <time>
                  {new Date(
                    effectiveBody(task, tasks).reminder_at!,
                  ).toLocaleString()}
                </time>
              </button>
            ))}
          <Pagination count={rows.length} page={page} onPage={setPage} />
        </div>
      )}
    </section>
  );
}
