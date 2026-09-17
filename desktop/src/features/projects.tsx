import { useState, useMemo, useRef, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { invoke, message, useCommand, type Project } from "../api";
import {
  Button,
  Empty,
  ErrorBox,
  Heading,
  Loading,
  Modal,
} from "../components/ui";
import { useUI } from "../store";
import { notify } from "../components/notice";

function colorHue(hex: string) {
  const [red, green, blue] = [1, 3, 5].map(
    (offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  if (max === min) return 230;
  const delta = max - min;
  const value =
    max === red
      ? ((green - blue) / delta) % 6
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  return Math.round((value * 60 + 360) % 360);
}

function hueColor(hue: number) {
  const saturation = 0.68;
  const lightness = 0.56;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const part = hue / 60;
  const secondary = chroma * (1 - Math.abs((part % 2) - 1));
  const [red, green, blue] =
    part < 1
      ? [chroma, secondary, 0]
      : part < 2
        ? [secondary, chroma, 0]
        : part < 3
          ? [0, chroma, secondary]
          : part < 4
            ? [0, secondary, chroma]
            : part < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const match = lightness - chroma / 2;
  return (
    "#" +
    [red, green, blue]
      .map((value) =>
        Math.round((value + match) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
export function Projects() {
  const { workspaceId, setProject } = useUI();
  const query = useCommand("projects.list", {}),
    tasks = useCommand("tasks.list", {});
  const workspaces = useCommand("workspaces.list", {});
  const canEdit =
    !workspaceId ||
    !!workspaces.data?.some(
      (ws) => ws.id === workspaceId && ws.role !== "viewer",
    );
  const [editing, setEditing] = useState<Project | null | undefined>(undefined),
    [showArchived, setShowArchived] = useState(false);
  const scopedProjects = (query.data ?? []).filter(
    (project) => project.workspace_id === workspaceId,
  );
  const rows = scopedProjects.filter(
    (project) => showArchived || !project.body.archived,
  );
  const onlyArchived =
    !showArchived &&
    scopedProjects.length > 0 &&
    scopedProjects.every((project) => project.body.archived);
  const counts = useMemo(() => {
    const result = new Map<string, { total: number; done: number }>();
    for (const task of tasks.data ?? [])
      if (task.body.project_id) {
        const count = result.get(task.body.project_id) ?? { total: 0, done: 0 };
        count.total++;
        if (task.body.status === "done") count.done++;
        result.set(task.body.project_id, count);
      }
    return result;
  }, [tasks.data]);
  return (
    <section>
      <Heading
        title="项目"
        description="按目标整理任务，并查看每个项目的完成进度。"
        action={
          canEdit && (
            <Button onClick={() => setEditing(null)}>
              <Plus size={17} />
              新建项目
            </Button>
          )
        }
      />
      <label className="inline-check">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        显示归档项目
      </label>
      <ErrorBox error={query.error} />
      {query.isPending ? (
        <Loading />
      ) : !rows.length ? (
        <Empty
          title={onlyArchived ? "所有项目都已归档" : "还没有项目"}
          icon={FolderOpen}
        >
          <p>
            {onlyArchived
              ? "归档项目不会出现在当前列表中。"
              : "用项目归拢同一目标下的任务，进度会自动汇总。"}
          </p>
          {onlyArchived ? (
            <Button variant="secondary" onClick={() => setShowArchived(true)}>
              查看归档项目
            </Button>
          ) : canEdit ? (
            <Button variant="secondary" onClick={() => setEditing(null)}>
              <Plus size={15} />
              创建第一个项目
            </Button>
          ) : (
            <p>工作区管理员创建项目后，会显示在这里。</p>
          )}
        </Empty>
      ) : (
        <div className="project-grid">
          {rows.map((p) => {
            const count = counts.get(p.id) ?? { total: 0, done: 0 };
            return (
              <article key={p.id} className="project-card">
                <span
                  className="project-color"
                  style={{ background: p.body.color }}
                />
                <button
                  className="project-open"
                  onClick={() => setProject(p.id)}
                >
                  <h3>
                    {p.body.name}
                    {p.body.archived ? " · 已归档" : ""}
                  </h3>
                  <p>{p.body.description || "查看项目任务"}</p>
                </button>
                <div className="project-progress">
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-label={p.body.name + " 完成进度"}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={
                      count.total
                        ? Math.round((count.done / count.total) * 100)
                        : 0
                    }
                  >
                    <span
                      style={{
                        background: p.body.color,
                        width:
                          (count.total ? (count.done / count.total) * 100 : 0) +
                          "%",
                      }}
                    />
                  </div>
                  <small>
                    {count.done} / {count.total} 已完成
                  </small>
                </div>
                {canEdit && (
                  <button
                    className="icon-btn"
                    aria-label={"编辑项目 " + p.body.name}
                    onClick={() => setEditing(p)}
                  >
                    <Pencil size={16} />
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
      {editing !== undefined && (
        <ProjectEditor
          project={editing ?? undefined}
          onClose={() => setEditing(undefined)}
        />
      )}
    </section>
  );
}
function ProjectEditor({
  project,
  onClose,
}: {
  project?: Project;
  onClose: () => void;
}) {
  const workspaceId = useUI((s) => s.workspaceId);
  const [name, setName] = useState(project?.body.name ?? ""),
    [description, setDescription] = useState(project?.body.description ?? ""),
    [color, setColor] = useState(project?.body.color ?? "#5367df"),
    [hue, setHue] = useState(() => colorHue(project?.body.color ?? "#5367df")),
    [archived, setArchived] = useState(project?.body.archived ?? false);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState(false);
  const [discard, setDiscard] = useState(false);
  const initial = useRef(
    JSON.stringify({ name, description, color, archived }),
  );
  function requestClose() {
    if (busy) return;
    if (
      initial.current !== JSON.stringify({ name, description, color, archived })
    )
      setDiscard(true);
    else onClose();
  }
  const qc = useQueryClient();
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await invoke("projects.save", {
        id: project?.id,
        workspace_id: project ? project.workspace_id : workspaceId,
        body: { name, description, color, archived },
      });
      await qc.invalidateQueries();
      notify(project ? "项目已保存" : "项目已创建");
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await invoke("projects.delete", { id: project!.id });
      await qc.invalidateQueries();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={project ? "编辑项目" : "新建项目"} onClose={requestClose}>
      <form className="editor-form" onSubmit={save}>
        <label>
          项目名称
          <input
            autoFocus
            required
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          项目描述
          <textarea
            rows={3}
            maxLength={20000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label>
          颜色
          <span className="color-control">
            <span
              className="color-preview"
              style={{ background: color }}
              aria-hidden="true"
            />
            <input
              type="range"
              aria-label="项目颜色"
              min={0}
              max={359}
              value={hue}
              onChange={(event) => {
                const next = Number(event.target.value);
                setHue(next);
                setColor(hueColor(next));
              }}
            />
          </span>
        </label>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          归档项目
        </label>
        <ErrorBox error={error} />
        {discard && (
          <div className="discard-confirmation" role="alert">
            <p>要放弃尚未保存的项目修改吗？</p>
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
        {deleting && (
          <div className="error">
            删除项目后，其中的任务也会从你的所有设备中移除。
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              onClick={remove}
            >
              确认删除项目
            </Button>
          </div>
        )}
        <div className="dialog-actions">
          {project && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleting(!deleting)}
            >
              <Trash2 size={15} />
              删除
            </Button>
          )}
          <span />
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={requestClose}
          >
            取消
          </Button>
          <Button disabled={busy}>保存项目</Button>
        </div>
      </form>
    </Modal>
  );
}
