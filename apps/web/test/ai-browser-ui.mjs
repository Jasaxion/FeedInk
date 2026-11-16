// UI lifecycle setup shared by the hosted AI readers and saved-result regressions.
export async function openAiSettings(page, expect) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: 'AI 模型', exact: true }).click();
  await expect(page.getByRole('form', { name: 'AI 模型设置' })).toBeVisible();
}

export async function closeAiSettings(page, expect) {
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

export async function signInToAiReader(page, expect, owner) {
  await page.getByLabel('邮箱', { exact: true }).fill(`${owner}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  // Login activates owned storage and then navigates home asynchronously. A click
  // or the HTTP reply alone is not readiness to select an article in the new epoch.
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('region', { name: '文章列表', exact: true }).locator('[data-article-id="one"]').click();
  await expect(page.getByTestId('reader-content')).toHaveAttribute('data-annotation-context', 'a'.repeat(64));
}
