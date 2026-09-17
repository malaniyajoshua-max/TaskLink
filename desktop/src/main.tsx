import React, { Component, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { useCommand } from "./api";
import { Button, ErrorBox, Loading } from "./components/ui";
import { Auth } from "./features/auth";
import { AppShell } from "./app-shell";
import { ChatWindow } from "./features/chat";
import "@fontsource-variable/noto-sans-sc";
import "./styles.css";
import "./workspace.css";
import "./themes.css";
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10000, retry: false, refetchOnWindowFocus: false },
  },
});
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <main className="fatal">
        <h1>页面遇到错误</h1>
        <p>
          已保存的内容仍在本地。请重新打开
          TaskLink，尚未保存的表单内容可能需要重新填写。
        </p>
      </main>
    ) : (
      this.props.children
    );
  }
}
function Root() {
  const query = useCommand("auth.status", {}),
    qc = useQueryClient();
  useEffect(
    () =>
      window.tasklink?.subscribe((dataChanged) => {
        void qc.invalidateQueries(
          dataChanged
            ? {
                predicate: (q) =>
                  !["attachments.preview"].includes(String(q.queryKey[0])),
              }
            : { queryKey: ["sync.status"] },
        );
      }),
    [qc],
  );
  if (!window.tasklink)
    return (
      <main className="fatal">
        <h1>TaskLink 桌面应用</h1>
        <p>请从已安装的 TaskLink 桌面应用启动。</p>
      </main>
    );
  if (query.isPending)
    return (
      <main className="fatal">
        <Loading />
      </main>
    );
  if (query.error)
    return (
      <main className="fatal">
        <ErrorBox error={query.error} />
        <Button onClick={() => query.refetch()}>重试</Button>
      </main>
    );
  return query.data ? (
    location.hash === "#chat" ? (
      <ChatWindow user={query.data} />
    ) : (
      <AppShell user={query.data} />
    )
  ) : (
    <Auth />
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Root />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
