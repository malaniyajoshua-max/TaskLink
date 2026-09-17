import { useEffect, useMemo, useState } from "react";
import { useTheme } from "./use-theme";
import { useQueryClient } from "@tanstack/react-query";
import {
  BadgeCheck,
  Bell,
  CalendarDays,
  CheckSquare2,
  ChevronRight,
  Clock3,
  Copy,
  Folder,
  LogOut,
  MessageCircle,
  Plus,
  Search,
  RefreshCw,
  Settings as SettingsIcon,
  Sun,
  UserRound,
  Users,
} from "lucide-react";
import { invoke, message, useCommand, type User } from "./api";
import { Avatar, Brand, Button, ErrorBox, Modal } from "./components/ui";
import { Auth } from "./features/auth";
import {
  TaskEditor,
  TaskList,
  effectiveBody,
  type EditTask,
} from "./features/tasks";
import { Projects } from "./features/projects";
import { Calendar, Reminders } from "./features/calendar";
import { Collaboration, Notifications } from "./features/collaboration";
import { Conflicts, Settings } from "./features/settings";
import { useUI, type View } from "./store";
import { CommandPalette } from "./components/command-palette";
import { NoticeToast, clearNotice } from "./components/notice";
import { defaultDue } from "./features/task-presentation";
import { FocusTimer } from "./features/focus-timer";

const navigation = [
  { view: "inbox", label: "我的任务", icon: CheckSquare2 },
  { view: "today", label: "今日", icon: Sun },
  { view: "upcoming", label: "即将到期", icon: Clock3 },
  { view: "projects", label: "项目", icon: Folder },
  { view: "calendar", label: "日历", icon: CalendarDays },
  { view: "reminders", label: "提醒", icon: Bell },
  { view: "collaboration", label: "协作", icon: Users },
  { view: "notifications", label: "通知中心", icon: MessageCircle },
] satisfies { view: View; label: string; icon: typeof Bell }[];

export function AppShell({ user }: { user: User }) {
  const {
    view,
    workspaceId,
    projectId,
    newAccountId,
    setView,
    setWorkspace,
    setNewAccountId,
    setProject,
  } = useUI();
  const workspaces = useCommand("workspaces.list", {}),
    sync = useCommand("sync.status", {}),
    preferences = useCommand("settings.get", {});
  const notes = useCommand("notifications.list", {}),
    tasks = useCommand("tasks.list", {}),
    projects = useCommand("projects.list", {});
  const [edit, setEdit] = useState<EditTask | null>(null),
    [error, setError] = useState("");
  const [conflicts, setConflicts] = useState(false),
    [logout, setLogout] = useState(false),
    [reauth, setReauth] = useState(false);
  const [accountCopied, setAccountCopied] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);
  const qc = useQueryClient();
  const space =
    workspaces.data?.find((w) => w.id === workspaceId)?.name ?? "个人空间";
  const canEdit =
    !workspaceId ||
    !!workspaces.data?.some(
      (ws) => ws.id === workspaceId && ws.role !== "viewer",
    );
  const sidebarProjects = (projects.data ?? [])
    .filter(
      (project) =>
        project.workspace_id === workspaceId && !project.body.archived,
    )
    .slice(0, 6);
  const counts = useMemo(() => {
    const all = tasks.data ?? [],
      scoped = all.filter((t) => t.workspace_id === workspaceId);
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const week = new Date(start);
    week.setDate(week.getDate() + 8);
    return {
      inbox: scoped.filter((t) => !t.body.parent_id && t.body.status !== "done")
        .length,
      today: scoped.filter((t) => {
        const b = effectiveBody(t, all);
        return b.status !== "done" && b.due_at && new Date(b.due_at) < end;
      }).length,
      upcoming: scoped.filter((t) => {
        const b = effectiveBody(t, all);
        return (
          b.status !== "done" &&
          b.due_at &&
          new Date(b.due_at) >= start &&
          new Date(b.due_at) < week
        );
      }).length,
      notifications: (notes.data ?? []).filter((n) => !n.read).length,
    } as Partial<Record<View, number>>;
  }, [tasks.data, notes.data, workspaceId, now]);
  const title = conflicts
    ? "同步冲突"
    : view === "settings"
      ? "设置"
      : projectId
        ? (projects.data?.find((p) => p.id === projectId)?.body.name ??
          "项目任务")
        : navigation.find((n) => n.view === view)?.label;
  function navigate(next: View) {
    setView(next);
    setConflicts(false);
  }
  useEffect(() => () => clearNotice(), [user.id]);
  useTheme(preferences.data?.theme);
  useEffect(() => {
    const timer = setInterval(() => {
      void qc.invalidateQueries({ queryKey: ["sync.status"] });
    }, 3000);
    return () => clearInterval(timer);
  }, [qc]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        document.querySelector("dialog[open]")
      )
        return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key.toLowerCase() === "n" && canEdit) {
        event.preventDefault();
        setEdit({ due: defaultDue(view) });
      }
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (!["inbox", "today", "upcoming"].includes(view)) setView("inbox");
        setConflicts(false);
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLInputElement>('[aria-label="搜索任务"]')
            ?.focus(),
        );
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [setView, view, canEdit]);
  async function signOut() {
    try {
      await invoke("auth.logout", {});
      setWorkspace(null);
      setView("inbox");
      setLogout(false);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth.status" });
      qc.setQueryData(["auth.status", {}], null);
    } catch (e) {
      setError(message(e));
    }
  }
  async function synchronize() {
    try {
      setError("");
      await invoke("sync.run", {});
      await qc.invalidateQueries();
    } catch (e) {
      setError(message(e));
    }
  }
  const syncText =
    sync.data?.state === "syncing"
      ? "同步中"
      : sync.data?.conflicts
        ? "有冲突待处理"
        : sync.data?.state === "auth_required"
          ? "需重新登录"
          : sync.data?.paused
            ? "离线模式"
            : sync.data?.state === "offline"
              ? "网络不可用"
              : sync.data?.state === "error"
                ? "同步异常"
                : sync.data?.pending
                  ? sync.data.pending + " 项待同步"
                  : sync.data?.lastSynced
                    ? "已同步"
                    : "等待首次同步";
  return (
    <div className="app">
      <aside className="sidebar" aria-label="应用导航">
        <Brand className="side-brand" />
        <label className="workspace-picker">
          <UserRound size={16} />
          <select
            aria-label="切换工作区"
            value={workspaceId ?? ""}
            onChange={(e) => {
              setWorkspace(e.target.value || null);
              setConflicts(false);
              clearNotice();
              setError("");
            }}
          >
            <option value="">个人空间</option>
            {(workspaces.data ?? []).map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </select>
        </label>
        {canEdit && (
          <Button
            className="sidebar-create"
            aria-label="快速新建任务"
            title="Ctrl+N"
            onClick={() => setEdit({ due: defaultDue(view) })}
          >
            <Plus size={17} />
            新建任务<kbd>Ctrl N</kbd>
          </Button>
        )}
        <nav>
          <div className="nav-group-label">工作台</div>
          {navigation.map(({ view: key, label, icon: Icon }, index) => (
            <div key={key}>
              {index === 6 && (
                <>
                  <div className="nav-group-label project-nav-heading">
                    <span>我的项目</span>
                    <button
                      className="icon-btn"
                      aria-label="管理项目"
                      onClick={() => navigate("projects")}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  {sidebarProjects.map((project) => (
                    <button
                      key={project.id}
                      className={
                        "nav-btn project-nav-btn " +
                        (projectId === project.id && !conflicts ? "active" : "")
                      }
                      aria-label={"打开项目 " + project.body.name}
                      aria-current={
                        projectId === project.id && !conflicts
                          ? "page"
                          : undefined
                      }
                      onClick={() => {
                        setConflicts(false);
                        setProject(project.id);
                      }}
                    >
                      <span
                        className="color-dot"
                        style={{ background: project.body.color }}
                      />
                      <span>{project.body.name}</span>
                    </button>
                  ))}
                  {!sidebarProjects.length && (
                    <button
                      className="sidebar-empty-project"
                      onClick={() => navigate("projects")}
                    >
                      创建项目，归拢同一目标
                    </button>
                  )}
                  <div className="nav-group-label collaboration-label">
                    协作
                  </div>
                </>
              )}
              <button
                aria-label={label}
                aria-current={
                  view === key && !conflicts && !projectId ? "page" : undefined
                }
                className={
                  "nav-btn " +
                  (view === key && !conflicts && !projectId ? "active" : "")
                }
                onClick={() => navigate(key)}
              >
                <Icon size={18} strokeWidth={1.65} />
                <span>{label}</span>
                {!!counts[key] && (
                  <small className="nav-count">{counts[key]}</small>
                )}
              </button>
            </div>
          ))}
          <button
            className="nav-btn"
            aria-label="聊天"
            onClick={() =>
              invoke("chat.open", {}).catch((e) => setError(message(e)))
            }
          >
            <MessageCircle size={18} strokeWidth={1.65} />
            <span>聊天</span>
          </button>
        </nav>
        <div className="side-bottom">
          <FocusTimer />
          <button
            className={
              "sync-indicator " +
              (sync.data?.paused || sync.data?.state === "offline"
                ? "is-offline"
                : "")
            }
            onClick={() =>
              sync.data?.state === "auth_required"
                ? setReauth(true)
                : sync.data?.conflicts
                  ? setConflicts(true)
                  : navigate("settings")
            }
            aria-label={syncText + "，查看同步设置"}
          >
            <span
              className={"sync-dot " + (sync.data?.conflicts ? "is-error" : "")}
            />
            <span>{syncText}</span>
          </button>
          <button
            className={
              "nav-btn " + (view === "settings" && !conflicts ? "active" : "")
            }
            onClick={() => navigate("settings")}
          >
            <SettingsIcon size={18} strokeWidth={1.65} />
            设置
          </button>
          <div className="profile">
            <button
              className="profile-settings"
              aria-label="账号与偏好设置"
              onClick={() => navigate("settings")}
            >
              <Avatar user={user} size={34} />
              <span className="profile-copy">
                <b>{user.name}</b>
                <small title={user.account_id + " · " + user.email}>
                  {user.account_id}
                </small>
              </span>
            </button>
            <button
              className="icon-btn"
              aria-label="退出登录"
              onClick={() => setLogout(true)}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <section className="content">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>{space}</span>
            <ChevronRight size={14} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className="command-trigger"
              aria-label="搜索与跳转"
              onClick={() => setCommandOpen(true)}
            >
              <Search size={16} />
              <span>搜索与跳转</span>
              <kbd>Ctrl K</kbd>
            </button>
            <button
              className="sync-button"
              aria-label="立即同步"
              disabled={sync.data?.state === "syncing"}
              onClick={synchronize}
            >
              <RefreshCw
                size={16}
                className={sync.data?.state === "syncing" ? "spin" : ""}
              />
              同步
            </button>
          </div>
        </header>
        <main
          className={
            "page " +
            (view === "collaboration"
              ? "collaboration-page"
              : view === "calendar"
                ? "calendar-page"
                : "")
          }
        >
          <ErrorBox error={error} />
          {sync.data?.error && (
            <div className="sync-banner" role="status">
              {sync.data.error}
              {sync.data.state === "auth_required" && (
                <Button variant="secondary" onClick={() => setReauth(true)}>
                  重新登录
                </Button>
              )}
            </div>
          )}
          {conflicts ? (
            <Conflicts />
          ) : view === "projects" ? (
            <Projects />
          ) : view === "calendar" ? (
            <Calendar onEdit={setEdit} />
          ) : view === "reminders" ? (
            <Reminders onEdit={setEdit} />
          ) : view === "collaboration" ? (
            <Collaboration />
          ) : view === "notifications" ? (
            <Notifications />
          ) : view === "settings" ? (
            <Settings />
          ) : (
            <TaskList
              key={`${workspaceId}:${projectId}:${view}`}
              view={view}
              onEdit={setEdit}
            />
          )}
        </main>
      </section>
      {commandOpen && (
        <CommandPalette
          onClose={() => setCommandOpen(false)}
          onEdit={setEdit}
          onNavigate={navigate}
        />
      )}
      <NoticeToast />
      {edit && (
        <TaskEditor
          key={
            edit.task
              ? "task:" + edit.task.id
              : edit.parent
                ? "child:" + edit.parent.id
                : "new:" + (edit.due ?? "")
          }
          edit={edit}
          onClose={() => setEdit(null)}
          onEdit={setEdit}
        />
      )}
      {logout && (
        <Modal title="退出登录" onClose={() => setLogout(false)}>
          <p className="dialog-description">
            退出后，这台电脑上仍会保留你的个人数据。下次使用同一账号登录即可继续。
          </p>
          <div className="dialog-actions">
            <Button variant="secondary" onClick={() => setLogout(false)}>
              取消
            </Button>
            <Button onClick={signOut}>确认退出登录</Button>
          </div>
        </Modal>
      )}
      {newAccountId && (
        <Modal
          title="账号创建成功"
          onClose={() => setNewAccountId(null)}
          className="account-welcome"
        >
          <div className="welcome-mark" aria-hidden="true">
            <BadgeCheck size={28} />
          </div>
          <p className="dialog-description">
            这是你的专属 TaskLink 账号。以后可以使用它或绑定邮箱登录。
          </p>
          <div className="account-id-card">
            <span>TaskLink 账号</span>
            <strong>{newAccountId}</strong>
          </div>
          <div className="dialog-actions">
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await invoke("system.copyText", { text: newAccountId });
                  setAccountCopied(true);
                } catch (reason) {
                  setError(message(reason));
                }
              }}
            >
              <Copy size={16} />
              {accountCopied ? "已复制" : "复制账号"}
            </Button>
            <Button onClick={() => setNewAccountId(null)}>开始使用</Button>
          </div>
        </Modal>
      )}
      {reauth && (
        <Modal title="重新登录" onClose={() => setReauth(false)}>
          <Auth reauth onDone={() => setReauth(false)} />
        </Modal>
      )}
    </div>
  );
}
