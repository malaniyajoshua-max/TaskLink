// @vitest-environment jsdom
import React from "react";
import {
  render,
  fireEvent,
  screen,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { Auth } from "../src/features/auth";
afterEach(cleanup);
it("updates the active auth query after login without dropping its observer", async () => {
  const user = {
    id: "49e8212d-aab1-41fa-a178-97006471cc4b",
    account_id: "TL-1234-5678",
    name: "UI Test",
    email: "ui@example.com",
  };
  window.tasklink = {
    invoke: vi.fn().mockResolvedValue(user),
    subscribe: () => () => {},
    stageFiles: vi.fn().mockResolvedValue([]),
    onChatPeer: () => () => {},
    onTransfer: () => () => {},
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["auth.status", {}], null);
  render(
    <QueryClientProvider client={client}>
      <Auth />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("账号 / 邮箱"), {
    target: { value: user.email },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "test password" },
  });
  expect(screen.getByLabelText("密码").getAttribute("type")).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
  expect(screen.getByLabelText("密码").getAttribute("type")).toBe("text");
  fireEvent.click(screen.getByRole("button", { name: "隐藏密码" }));
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  await waitFor(() =>
    expect(client.getQueryData(["auth.status", {}])).toEqual(user),
  );
  expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("");
});

it("shows registration email verification and password recovery as complete flows", async () => {
  let deliverCode: (value: unknown) => void = () => {};
  const invoke = vi.fn().mockImplementation(async (command: string) => {
    if (command === "auth.registrationCode")
      return new Promise((resolve) => {
        deliverCode = resolve;
      });
    return null;
  });
  window.tasklink = {
    invoke,
    subscribe: () => () => {},
    stageFiles: vi.fn(),
    onChatPeer: () => () => {},
    onTransfer: () => () => {},
  };
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <Auth />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "注册账号" }));
  expect(screen.getByLabelText("昵称")).toBeTruthy();
  expect(screen.getByLabelText("绑定邮箱")).toBeTruthy();
  expect(screen.getByLabelText("邮箱验证码")).toBeTruthy();
  expect(screen.getByLabelText("确认密码")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("绑定邮箱"), {
    target: { value: "verified@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("auth.registrationCode", {
      email: "verified@example.com",
    }),
  );
  expect((screen.getByLabelText("绑定邮箱") as HTMLInputElement).disabled).toBe(
    true,
  );
  expect(
    (screen.getByRole("button", { name: "返回登录" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "注册账号" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => {
    deliverCode({
      request_id: "49e8212d-aab1-41fa-a178-97006471cc4b",
      expires_in: 600,
      resend_after: 60,
    });
  });
  expect((screen.getByLabelText("绑定邮箱") as HTMLInputElement).disabled).toBe(
    false,
  );
  expect(screen.getByText("60 秒后重发")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "返回登录" }));
  fireEvent.click(screen.getByRole("button", { name: "忘记密码？" }));
  expect(screen.getByRole("heading", { name: "找回密码" })).toBeTruthy();
  expect(screen.getByLabelText("绑定邮箱")).toBeTruthy();
});

it("requests, enters and resends a password recovery code", async () => {
  const invoke = vi.fn().mockResolvedValue({
    request_id: "49e8212d-aab1-41fa-a178-97006471cc4b",
    expires_in: 600,
    resend_after: 1,
  });
  window.tasklink = {
    invoke,
    subscribe: () => () => {},
    stageFiles: vi.fn(),
    onChatPeer: () => () => {},
    onTransfer: () => () => {},
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Auth />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "忘记密码？" }));
  fireEvent.change(screen.getByLabelText("绑定邮箱"), {
    target: { value: "recovery@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
  await screen.findByRole("heading", { name: "验证你的邮箱" });
  expect(screen.getByLabelText("6 位验证码")).toBeTruthy();
  await waitFor(
    () => expect(screen.getByRole("button", { name: "重新发送" })).toBeTruthy(),
    { timeout: 2500 },
  );
  fireEvent.click(screen.getByRole("button", { name: "重新发送" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "更换邮箱" }));
  expect(screen.getByRole("heading", { name: "找回密码" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "返回登录" }));
  expect(screen.getByRole("heading", { name: "欢迎回来" })).toBeTruthy();
});
