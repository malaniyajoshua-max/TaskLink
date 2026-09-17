import { useDeferredValue, useEffect, useId, useState } from "react";
import {
  ArrowUpRight,
  CalendarDays,
  CheckSquare2,
  Clock3,
  Folder,
  Plus,
  Search,
  Settings,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { useCommand } from "../api";
import { useUI, type View } from "../store";
import { Modal } from "./ui";
import type { EditTask } from "../features/tasks";
import { defaultDue } from "../features/task-presentation";

export function CommandPalette({
  onClose,
  onEdit,
  onNavigate,
}: {
  onClose: () => void;
  onEdit: (edit: EditTask) => void;
  onNavigate: (view: View) => void;
}) {
  const { workspaceId, view, setProject } = useUI();
  const tasks = useCommand("tasks.list", {}),
    projects = useCommand("projects.list", {}),
    workspaces = useCommand("workspaces.list", {});
  const [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  const search = useDeferredValue(query.trim().toLocaleLowerCase());
  const canEdit =
    !workspaceId ||
    !!workspaces.data?.some(
      (space) => space.id === workspaceId && space.role !== "viewer",
    );
  const listId = useId();
  type Result = {
    id: string;
    label: string;
    detail: string;
    icon: LucideIcon;
    run: () => void;
  };
  const commands: Result[] = [
    ...(canEdit
      ? [
          {
            id: "new",
            label: "新建任务",
            detail: "Ctrl N",
            icon: Plus,
            run: () => onEdit({ due: defaultDue(view) }),
          },
        ]
      : []),
    ...(
      [
        { view: "inbox", label: "我的任务", icon: CheckSquare2 },
        { view: "today", label: "今日", icon: Sun },
        { view: "upcoming", label: "即将到期", icon: Clock3 },
        { view: "projects", label: "项目", icon: Folder },
        { view: "calendar", label: "日历", icon: CalendarDays },
        { view: "settings", label: "设置", icon: Settings },
      ] as { view: View; label: string; icon: LucideIcon }[]
    ).map((item) => ({
      id: item.view,
      label: item.label,
      detail: "跳转",
      icon: item.icon,
      run: () => onNavigate(item.view),
    })),
  ];
  const results: Result[] = [
    ...commands.filter((command) => !search || command.label.includes(search)),
    ...(projects.data ?? [])
      .filter(
        (project) =>
          project.workspace_id === workspaceId &&
          !project.body.archived &&
          (!search || project.body.name.toLocaleLowerCase().includes(search)),
      )
      .slice(0, 6)
      .map((project) => ({
        id: project.id,
        label: project.body.name,
        detail: "项目",
        icon: Folder,
        run: () => {
          onNavigate("inbox");
          setProject(project.id);
        },
      })),
    ...(search
      ? (tasks.data ?? [])
          .filter(
            (task) =>
              task.workspace_id === workspaceId &&
              (task.body.title + " " + task.body.description)
                .toLocaleLowerCase()
                .includes(search),
          )
          .slice(0, 20)
          .map((task) => ({
            id: task.id,
            label: task.body.title,
            detail: task.body.status === "done" ? "已完成任务" : "任务",
            icon: CheckSquare2,
            run: () => onEdit({ task }),
          }))
      : []),
  ];
  const selected = Math.min(active, Math.max(0, results.length - 1));
  useEffect(() => setActive(0), [search]);
  useEffect(() => {
    document
      .getElementById(`${listId}-${selected}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [listId, selected]);
  function choose(result: Result) {
    onClose();
    result.run();
  }
  return (
    <Modal title="搜索与跳转" onClose={onClose} className="command-dialog">
      <div className="command-search">
        <Search size={21} />
        <input
          autoFocus
          role="combobox"
          aria-label="搜索任务、项目或页面"
          aria-controls={listId}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={
            results.length ? `${listId}-${selected}` : undefined
          }
          placeholder="搜索任务、项目，或跳转到…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) =>
                results.length
                  ? (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      results.length) %
                    results.length
                  : 0,
              );
            }
            if (event.key === "Enter" && results[selected]) {
              event.preventDefault();
              choose(results[selected]);
            }
          }}
        />
        <kbd>Esc</kbd>
      </div>
      <p className="command-scope">
        {workspaceId ? "当前工作区" : "个人空间"} ·{" "}
        {search ? "搜索结果" : "快捷操作与项目"}
      </p>
      <div
        className="command-results"
        role="listbox"
        id={listId}
        aria-label="搜索结果"
      >
        {results.map((result, index) => (
          <button
            key={result.id}
            id={`${listId}-${index}`}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={selected === index}
            onMouseMove={() => setActive(index)}
            onClick={() => choose(result)}
          >
            <result.icon size={18} />
            <span>{result.label}</span>
            <small>{result.detail}</small>
            <ArrowUpRight size={14} />
          </button>
        ))}
        {!results.length && (
          <div className="command-empty">
            没有找到匹配内容，试试其他关键词。
          </div>
        )}
      </div>
      <footer className="command-footer">
        <span>
          <kbd>↑ ↓</kbd> 选择
        </span>
        <span>
          <kbd>Enter</kbd> 打开
        </span>
        <span>仅搜索当前空间</span>
      </footer>
    </Modal>
  );
}
