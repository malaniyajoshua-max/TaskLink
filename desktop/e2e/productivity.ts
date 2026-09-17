import { expect, type Page } from "@playwright/test";

export async function productivity(page: Page) {
  const quick = page.getByRole("textbox", {
    name: "快速添加任务",
    exact: true,
  });
  for (const title of ["批量任务甲", "批量任务乙"]) {
    await quick.fill(title);
    await quick.press("Enter");
    await expect(quick).toHaveValue("");
  }
  await page.getByRole("button", { name: "批量选择", exact: true }).click();
  await page.getByLabel("全选当前页任务", { exact: true }).check();
  await expect(page.getByText("已选 2 项", { exact: true })).toBeVisible();
  await page.getByLabel("批量优先级", { exact: true }).selectOption("urgent");
  await expect(
    page.locator(".task-row .priority").filter({ hasText: "紧急" }),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "批量选择", exact: true }).click();
  await page.getByLabel("选择任务 批量任务甲", { exact: true }).check();
  await page.getByLabel("批量截止日期", { exact: true }).selectOption("1");
  const tasks = await page.evaluate(() =>
    (window as any).tasklink.invoke("tasks.list", {}),
  );
  const a = tasks.find((task: any) => task.body.title === "批量任务甲");
  const b = tasks.find((task: any) => task.body.title === "批量任务乙");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  expect(new Date(a.body.due_at).toDateString()).toBe(tomorrow.toDateString());
  expect(b.body.due_at).toBeNull();
  await page
    .locator(".task-row")
    .filter({ hasText: "批量任务甲" })
    .locator(".task-copy")
    .click();
  await page.getByRole("button", { name: "复制", exact: true }).click();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
    "批量任务甲（副本）",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator(".task-row")).toHaveCount(3);
  await page.getByLabel("任务排序", { exact: true }).selectOption("priority");
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "今日", exact: true })
    .click();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "我的任务", exact: true })
    .click();
  await expect(page.locator(".board-card")).toHaveCount(3);
  await expect(page.getByLabel("任务排序", { exact: true })).toHaveValue(
    "priority",
  );

  await page.getByRole("button", { name: "专注计时", exact: true }).click();
  await page.getByRole("button", { name: "15 分钟", exact: true }).click();
  await expect(page.getByRole("timer")).toHaveAttribute(
    "aria-label",
    "剩余 15:00",
  );
  await page.getByLabel("专注关联任务", { exact: true }).selectOption(a.id);
  // A real one-minute deadline keeps full expiry/restart coverage affordable.
  await page.evaluate(
    (taskId) =>
      (window as any).tasklink.invoke("focus.command", {
        action: "configure",
        mode: "focus",
        minutes: 1,
        taskId,
      }),
    a.id,
  );
  await expect(page.getByRole("timer")).toHaveAttribute(
    "aria-label",
    "剩余 01:00",
  );
  await page.getByRole("button", { name: "开始计时", exact: true }).click();
  await expect(page.getByRole("timer")).not.toHaveAttribute(
    "aria-label",
    "剩余 01:00",
  );
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "继续专注", exact: true }),
  ).toBeVisible();
  const state = await page.evaluate(() =>
    (window as any).tasklink.invoke("focus.get", {}),
  );
  expect(state.state).toBe("paused");
  return state;
}
