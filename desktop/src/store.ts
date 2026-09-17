import { create } from "zustand";
export type View =
  | "inbox"
  | "today"
  | "upcoming"
  | "projects"
  | "calendar"
  | "reminders"
  | "collaboration"
  | "notifications"
  | "settings";
interface UIState {
  view: View;
  workspaceId: string | null;
  projectId: string | null;
  newAccountId: string | null;
  setView: (v: View) => void;
  setWorkspace: (id: string | null) => void;
  setProject: (id: string | null) => void;
  setNewAccountId: (id: string | null) => void;
}
export const useUI = create<UIState>((set) => ({
  view: "inbox",
  workspaceId: null,
  projectId: null,
  newAccountId: null,
  setView: (view) => set({ view, projectId: null }),
  setWorkspace: (workspaceId) => set({ workspaceId, projectId: null }),
  setProject: (projectId) => set({ projectId, view: "inbox" }),
  setNewAccountId: (newAccountId) => set({ newAccountId }),
}));
