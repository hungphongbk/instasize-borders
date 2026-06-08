const { test, expect } = require("@playwright/test");
test("comparison page smoke", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Comparison" }).click();

  const uploadButtons = page.getByRole("button", { name: "Tải ảnh" });
  await expect(uploadButtons).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Phóng to" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Thu nhỏ" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Xuất PNG" })).toBeVisible();
});
