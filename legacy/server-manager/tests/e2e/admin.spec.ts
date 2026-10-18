import { test, expect } from "@playwright/test";
test("login page and authenticated navigation expose explicit targets", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Continue with Google" }),
  ).toBeVisible();
  await context.addCookies([
    {
      name: "gem-session",
      value: "e2e-session",
      url: "http://localhost:8787",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByText("Account " + "a".repeat(32))).toBeVisible();
  await expect(
    page.getByText("Connection " + "22222222-2222-4222-8222-222222222222"),
  ).toBeVisible();
});
test("production approval requires exact target and persists server-side", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: "gem-session",
      value: "e2e-session",
      url: "http://localhost:8787",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Approvals & Operations", exact: true })
    .click();
  await page
    .getByRole("button")
    .filter({ hasText: "33333333-3333-4333-8333-333333333333" })
    .click();
  await expect(
    page.getByRole("heading", { name: "After", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve this change" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "production_target_confirmation_required" }),
  ).toBeVisible();
  await page
    .getByLabel("Production: type the exact target to approve")
    .fill(
      "22222222-2222-4222-8222-222222222222/" +
        "a".repeat(32) +
        "/" +
        "b".repeat(32),
    );
  await page.getByRole("button", { name: "Approve this change" }).click();
  await expect(page.getByText(/State: approved/)).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Approvals & Operations", exact: true })
    .click();
  await expect(
    page
      .getByRole("button")
      .filter({ hasText: "33333333-3333-4333-8333-333333333333" }),
  ).toContainText("approved");
});
