const voucher_no_updatedAt = {
  id: "voucher_no_updatedAt",
  storagePath: "vouchers/mock/no-updated-at.jpg",
  amount: 15,
  date: "2026-03-05",
  summary: "no updatedAt fixture",
  merchant: "qa-merchant",
  updatedAt: null,
  lastReviewedAt: "2026-03-05T06:00:00.000Z",
  latestAt: "2026-03-05T06:00:00.000Z",
  createdAt: "2026-03-05T06:00:00.000Z",
};

async function pendingCursorMissingUpdatedAtFixtureStep({
  step,
  openGlobalCenterFresh,
  readLoadMoreMeta,
  getGlobalEntryOrder,
  page,
  screenshot,
  closeGlobalCenter,
}) {
  await step("pending cursor missing-updatedAt fixture", async () => {
    await openGlobalCenterFresh("openVoucherCorrelation");
    for (let guard = 0; guard < 10; guard += 1) {
      const meta = await readLoadMoreMeta("pending");
      if (meta.loadState === "no_more") break;
      await page.locator('[data-global-load-more="pending"]').first().click({ force: true });
      await page.waitForTimeout(130);
    }

    const finalOrder = await getGlobalEntryOrder();
    const uniqueIds = [...new Set(finalOrder.filter(Boolean))];
    if (!finalOrder.includes("pending:voucher_no_updatedAt")) {
      throw new Error(`missing-updatedAt fixture absent: ${finalOrder.join(",")}`);
    }
    if (uniqueIds.length !== finalOrder.length) {
      throw new Error(`missing-updatedAt duplicated ids: raw=${finalOrder.join(",")} unique=${uniqueIds.join(",")}`);
    }
    await screenshot("03d-pending-cursor-no-updatedAt");
    await closeGlobalCenter();
    return { finalOrder, uniqueIds };
  });
}

async function fallbackStepSessionRestoreSubcheck({
  readGlobalScope,
  getGlobalEntryCount,
  getGlobalEntryOrder,
  page,
  closeGlobalCenter,
  openGlobalCenter,
  readLoadMoreMeta,
  screenshot,
  afterScope,
  afterCount,
}) {
  const afterOrder = await getGlobalEntryOrder();
  await closeGlobalCenter();
  await page.evaluate(() => {
    window.__ENV__ = { ...(window.__ENV__ || {}), GLOBAL_CENTER_FORCE_PENDING_FALLBACK_STEP: false };
  });
  await openGlobalCenter("openVoucherCorrelation");

  const restoreScope = await readGlobalScope();
  const restoreCount = await getGlobalEntryCount();
  const restoreOrder = await getGlobalEntryOrder();
  const restoreBtn = await readLoadMoreMeta("pending");
  if (!restoreScope.pendingLink || restoreScope.pendingLink.mode !== "fallback-step") {
    throw new Error(`fallback-step session restore lost mode: ${restoreScope.text}`);
  }
  if (restoreScope.pendingLink.requested !== afterScope.pendingLink.requested) {
    throw new Error(`fallback-step session restore scope mismatch: before=${afterScope.text} after=${restoreScope.text}`);
  }
  if (restoreCount !== afterCount || restoreOrder.join("|") !== afterOrder.join("|")) {
    throw new Error("fallback-step session restore list/count changed");
  }
  if (restoreBtn.loadState !== "no_more" || !restoreBtn.disabled) {
    throw new Error(`fallback-step session restore no_more lost: ${JSON.stringify(restoreBtn)}`);
  }
  await screenshot("03b-global-pending-fallback-step-session-restore");
  await closeGlobalCenter();
  return { afterOrder, restoreScope, restoreCount, restoreBtn };
}

module.exports = {
  voucher_no_updatedAt,
  pendingCursorMissingUpdatedAtFixtureStep,
  fallbackStepSessionRestoreSubcheck,
};
