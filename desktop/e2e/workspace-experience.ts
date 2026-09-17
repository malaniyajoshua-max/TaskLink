import { expect, type ElectronApplication, type Page } from "@playwright/test";

export async function workspaceExperience(
  app: ElectronApplication,
  page: Page,
) {
  const nav = page.locator(".sidebar");
  await nav.getByRole("button", { name: "今日", exact: true }).click();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  expect(
    await page.getByLabel("截止时间", { exact: true }).inputValue(),
  ).toMatch(/T23:59$/);
  await page.getByLabel("标题", { exact: true }).fill("今天完成的体验任务");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "完成任务 今天完成的体验任务",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "完成任务 今天完成的体验任务", exact: true })
    .click();
  await page.getByRole("tab", { name: /已完成/ }).click();
  await expect(page.locator(".task-row")).toHaveCount(1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".task-row")).toHaveCount(0);
  await page.getByRole("tab", { name: /全部/ }).click();
  await expect(
    page.getByRole("button", {
      name: "完成任务 今天完成的体验任务",
      exact: true,
    }),
  ).toBeVisible();
  await nav.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("体验工作区");
  await page.keyboard.press("Escape");
  await expect(page.getByText("要放弃尚未保存的项目修改吗？")).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await nav
    .getByRole("button", { name: "打开项目 体验工作区", exact: true })
    .click();
  const quick = page.getByRole("textbox", {
    name: "快速添加任务",
    exact: true,
  });
  await quick.fill("中文输入不会误提交");
  await quick.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    bubbles: true,
  });
  await expect(page.locator(".task-row")).toHaveCount(0);
  await quick.press("Enter");
  await expect(page.locator(".task-row")).toHaveCount(1);
  await expect(quick).toBeFocused();
  await expect(quick).toHaveValue("");
  await quick.fill("第二项离线任务");
  await quick.press("Enter");
  await expect(page.locator(".task-row")).toHaveCount(2);
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await page
    .getByLabel("任务状态 中文输入不会误提交", { exact: true })
    .selectOption("in_progress");
  await expect(
    page
      .getByRole("region", { name: "进行中任务" })
      .getByText("中文输入不会误提交", { exact: true }),
  ).toBeVisible();
  const card = page
    .locator(".board-card")
    .filter({ hasText: "第二项离线任务" });
  await card.dragTo(
    page
      .getByRole("region", { name: "已完成任务" })
      .locator(".board-column-heading"),
  );
  await expect(
    page.getByLabel("任务状态 第二项离线任务", { exact: true }),
  ).toHaveValue("done");
  // Simulate an arriving independent edit through the actual desktop repository.
  await page.evaluate(async () => {
    const api = (window as any).tasklink;
    const task = (await api.invoke("tasks.list", {})).find(
      (row: any) => row.body.title === "第二项离线任务",
    );
    await api.invoke("tasks.save", {
      id: task.id,
      workspace_id: task.workspace_id,
      body: { ...task.body, description: "撤销期间到达的新描述" },
    });
  });
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(
    page.getByLabel("任务状态 第二项离线任务", { exact: true }),
  ).toHaveValue("todo");
  await expect(
    page.getByText("撤销期间到达的新描述", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+k");
  const command = page.getByRole("combobox", { name: "搜索任务、项目或页面" });
  await expect(command).toBeFocused();
  await command.fill("中文输入");
  await expect(
    page.getByRole("option", { name: /中文输入不会误提交/ }),
  ).toBeVisible();
  await command.press("Enter");
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
    "中文输入不会误提交",
  );
  await expect(page.getByLabel("状态", { exact: true })).toHaveValue(
    "in_progress",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "列表", exact: true }).click();
  await page.getByLabel("搜索任务", { exact: true }).fill("找不到的关键词");
  await expect(page.locator(".task-row")).toHaveCount(0);
  await nav.getByRole("button", { name: "今日", exact: true }).click();
  await expect(page.getByLabel("搜索任务", { exact: true })).toHaveValue("");
  await nav
    .getByRole("button", { name: "打开项目 体验工作区", exact: true })
    .click();
  await expect(page.locator(".task-row")).toHaveCount(2);
  await page.keyboard.press("Control+f");
  await expect(page.getByLabel("搜索任务", { exact: true })).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "体验工作区", exact: true }),
  ).toBeVisible();
  await page.getByLabel("任务排序", { exact: true }).selectOption("title");
  await nav.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("界面主题", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await nav.getByRole("button", { name: "我的任务", exact: true }).click();
  // Narrow rendering remains usable, though shipped native windows enforce 980px.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 980, height: 720 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 820),
  );
}
