import { create } from "zustand";
import { useState } from "react";
import { CheckCircle2, X } from "lucide-react";
import { message } from "../api";

type Notice = {
  id: number;
  text: string;
  action?: { label: string; run: () => Promise<void> };
};
const useNotice = create<{
  notice: Notice | null;
  set: (notice: Notice | null) => void;
}>((set) => ({ notice: null, set: (notice) => set({ notice }) }));
let nextId = 0;
export function notify(text: string, action?: Notice["action"]) {
  useNotice.getState().set({ id: ++nextId, text, action });
}
export function clearNotice() {
  useNotice.getState().set(null);
}

function NoticeContent({ notice }: { notice: Notice }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className={"notice-toast " + (error ? "has-error" : "")}>
      <CheckCircle2 size={18} aria-hidden="true" />
      <span role={error ? "alert" : "status"}>{error || notice.text}</span>
      {notice.action && (
        <button
          disabled={busy}
          className="notice-action"
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await notice.action!.run();
              if (useNotice.getState().notice?.id === notice.id) clearNotice();
            } catch (reason) {
              setError(message(reason));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "处理中…" : notice.action.label}
        </button>
      )}
      <button
        className="icon-btn"
        aria-label="关闭操作提示"
        disabled={busy}
        onClick={clearNotice}
      >
        <X size={16} />
      </button>
    </div>
  );
}
export function NoticeToast() {
  const notice = useNotice((state) => state.notice);
  return notice ? <NoticeContent key={notice.id} notice={notice} /> : null;
}
