import { test, expect } from "@playwright/test";
test("local connection manager targets two identities and approves production DNS on device", async ({
  page,
}) => {
  await page.goto("/#session=fixture-launch-ticket");
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:3211/");
  await expect(
    page.getByRole("heading", { name: "person1@example.com" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "person2@example.com" }),
  ).toBeVisible();
  const first = page.locator("article").filter({
    has: page.getByRole("heading", { name: "person1@example.com" }),
  });
  await first.getByLabel("Alias").fill("production");
  await first.getByLabel("Environment").selectOption("production");
  await first
    .getByRole("button", { name: "Save account", exact: true })
    .click();
  await expect(page.getByRole("status")).toBeVisible();
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  const targets = page.getByLabel("Connection / account");
  const values = await targets
    .locator("option")
    .evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value),
    );
  await targets.selectOption(values[1]);
  await page
    .getByRole("combobox", { name: "Inventory", exact: true })
    .selectOption("list_workers");
  await page
    .getByRole("button", { name: "Read directly from Cloudflare" })
    .click();
  await expect(
    page.locator("pre").filter({ hasText: "same-resource" }),
  ).toBeVisible();
  await expect(page.locator("pre")).not.toContainText("must-not-leak");
  await page.getByLabel("Zone ID", { exact: true }).fill("d".repeat(32));
  await page
    .getByLabel("Record name", { exact: true })
    .fill("test.example.com");
  await page.getByLabel("Content", { exact: true }).fill("192.0.2.1");
  await page.getByRole("button", { name: "Create local preview" }).click();
  await expect(
    page.getByRole("heading", { name: "Changes", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve this exact change" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "production_target_confirmation_required",
  );
  const label = page.getByLabel("Production: type the exact target");
  const exact = await page.locator("label.alert code").innerText();
  await label.fill(exact);
  await page.getByRole("button", { name: "Approve this exact change" }).click();
  await expect(page.getByText(/State: approved/)).toBeVisible();
  await page.getByRole("button", { name: "Apply approved change" }).click();
  await expect(page.getByText(/State: succeeded/)).toBeVisible();
  await expect(
    page.locator("pre").filter({ hasText: '"verified": true' }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await expect(page.locator("button.operation").first()).toContainText(
    "succeeded",
  );
});
