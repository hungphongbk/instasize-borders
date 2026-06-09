const { test, expect } = require("@playwright/test");

test("nas sync page shows connection wizard", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "NAS Sync" }).click();

  await expect(
    page.getByRole("heading", { name: "Connection Wizard" }),
  ).toBeVisible();
  await expect(page.getByLabel("Host/IP")).toBeVisible();
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
});
