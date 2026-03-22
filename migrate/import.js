import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  serviceAccountPath: path.join(__dirname, "serviceAccount.json"),
  exportJsonPath: path.join(__dirname, "export.json"),
  reportPath: path.join(__dirname, "migration-report.json"),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? "",
  dryRun: process.env.DRY_RUN === "1",
  preflightOnly: process.env.PREFLIGHT_ONLY === "1",
  singleTx: process.env.SINGLE_TX === "1",
  singleTxLegacyRowNum: 3,
  concurrency: 5,
  driveTimeoutMs: 15_000,
  retryMax: 3,
};

function preflight() {
  if (!existsSync(CONFIG.exportJsonPath)) {
    fatal(`Missing export.json: ${CONFIG.exportJsonPath}`);
  }

  const exportData = loadExportJson();
  const issues = validateExportStructure(exportData);
  if (issues.length > 0) {
    fatal(`export.json structure check failed:\n- ${issues.join("\n- ")}`);
  }

  if (CONFIG.dryRun) {
    return { exportData, mode: "dry-run" };
  }

  if (!existsSync(CONFIG.serviceAccountPath)) {
    fatal(`Missing serviceAccount.json: ${CONFIG.serviceAccountPath}`);
  }

  if (!CONFIG.storageBucket) {
    fatal("Missing FIREBASE_STORAGE_BUCKET");
  }

  return { exportData, mode: "live-ready" };
}

async function initFirebase() {
  const admin = (await import("firebase-admin")).default;
  const serviceAccount = JSON.parse(readFileSync(CONFIG.serviceAccountPath, "utf8"));

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: CONFIG.storageBucket,
    });
  }

  return {
    admin,
    db: admin.firestore(),
    storage: admin.storage().bucket(),
  };
}

async function initDrive() {
  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({
    keyFile: CONFIG.serviceAccountPath,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version: "v3", auth });
}

async function main() {
  const preflightResult = preflight();

  log("DUKA V2 import runner");
  log(`  mode: ${CONFIG.dryRun ? "DRY_RUN" : "LIVE"}`);
  log(`  preflightOnly: ${CONFIG.preflightOnly ? "yes" : "no"}`);
  log(`  singleTx: ${CONFIG.singleTx ? "yes" : "no"}`);
  log(`  storageBucket: ${CONFIG.storageBucket || "(not set)"}`);

  const exportData = preflightResult.exportData;
  const transactions = Array.isArray(exportData.transactions) ? exportData.transactions : [];
  const uniqueVoucherIds = collectAllDriveIds(transactions);
  const checksum = buildNormalizedChecksum(exportData.checksum || {}, transactions, uniqueVoucherIds);
  const risks = assessExportRisks(exportData, transactions);

  printPreflightSummary({
    checksum,
    exportData,
    transactions,
    uniqueVoucherIds,
    mode: preflightResult.mode,
  });

  if (CONFIG.preflightOnly) {
    log("Preflight passed. PREFLIGHT_ONLY=1 so import flow stops here.");
    return;
  }

  if (CONFIG.singleTx) {
    await runSingleTxMode(transactions);
    return;
  }

  let runtime = {
    admin: null,
    db: null,
    storage: null,
    drive: null,
  };

  if (!CONFIG.dryRun) {
    runtime = await initFirebase();
    runtime.drive = await initDrive();
  }

  const voucherMap = await migrateImages(uniqueVoucherIds, runtime.drive, runtime.storage);
  const { txIdMap, importedCount, importedAmount, transactionPlans } = await importTransactions(
    transactions,
    voucherMap,
    runtime.db,
    runtime.admin
  );
  const { plannedCount: voucherPlanCount, voucherPlans } = await importVouchers(
    uniqueVoucherIds,
    voucherMap,
    txIdMap,
    transactions,
    runtime.db,
    runtime.admin
  );

  const report = generateReport({
    checksum,
    importedCount,
    importedAmount,
    voucherTotal: uniqueVoucherIds.length,
    voucherSuccess: [...voucherMap.values()].filter((item) => item.ok).length,
    voucherFailed: [...voucherMap.values()].filter((item) => !item.ok),
  });

  if (CONFIG.dryRun) {
    printDryRunSummary({
      checksum,
      transactions,
      uniqueVoucherIds,
      transactionPlans,
      txIdMap,
      voucherPlanCount,
      voucherPlans,
      risks,
    });
  } else {
    writeFileSync(CONFIG.reportPath, JSON.stringify(report, null, 2), "utf8");
    log(`Saved report to ${CONFIG.reportPath}`);
  }

  printReport(report);

  if (!report.passed) {
    process.exit(1);
  }
}

async function runSingleTxMode(transactions) {
  const tx = transactions.find((item) => item._legacyRowNum === CONFIG.singleTxLegacyRowNum);
  if (!tx) {
    fatal(`SINGLE_TX target not found: _legacyRowNum=${CONFIG.singleTxLegacyRowNum}`);
  }

  const collectionName = "transactions_test";
  const docId = `tx_${tx._legacyRowNum}`;
  const transactionDoc = buildSingleTxDocument(tx);

  console.log("\n========== SINGLE_TX ==========");
  console.log(`collection: ${collectionName}`);
  console.log(`docId: ${docId}`);
  console.log("document:");
  console.log(JSON.stringify(transactionDoc, null, 2));
  console.log("idempotent: yes (same docId + upsert)");

  if (CONFIG.dryRun) {
    console.log("writeResult: skipped because DRY_RUN=1");
    console.log("================================\n");
    return;
  }

  const { admin, db } = await initFirebase();
  await db.collection(collectionName).doc(docId).set(
    {
      ...transactionDoc,
      _migratedAt: admin.firestore.Timestamp.now(),
      createdAt: admin.firestore.Timestamp.now(),
      updatedAt: admin.firestore.Timestamp.now(),
    },
    { merge: true }
  );

  console.log("writeResult: success");
  console.log("================================\n");
}

async function migrateImages(driveIds, drive, storage) {
  if (CONFIG.dryRun) {
    const results = new Map();
    driveIds.forEach((driveId) => {
      results.set(driveId, {
        ok: true,
        storagePath: `vouchers/${driveId}.jpg`,
        publicUrl: CONFIG.storageBucket
          ? `https://storage.googleapis.com/${CONFIG.storageBucket}/vouchers/${driveId}.jpg`
          : null,
        thumbnailUrl: CONFIG.storageBucket
          ? `https://storage.googleapis.com/${CONFIG.storageBucket}/vouchers/${driveId}.jpg`
          : null,
        mimeType: "image/jpeg",
        sizeBytes: 0,
        dryRun: true,
      });
    });
    return results;
  }

  const results = new Map();
  const queue = [...driveIds];
  let done = 0;

  log(`[images] concurrency=${CONFIG.concurrency}, total=${driveIds.length}`);

  async function worker() {
    while (queue.length > 0) {
      const fileId = queue.shift();
      if (!fileId) continue;

      for (let attempt = 1; attempt <= CONFIG.retryMax; attempt++) {
        try {
          const result = await migrateOneImage(fileId, drive, storage);
          results.set(fileId, result);
          break;
        } catch (error) {
          if (attempt === CONFIG.retryMax) {
            results.set(fileId, { ok: false, driveId: fileId, error: error.message });
          } else {
            await sleep(500 * attempt);
          }
        }
      }

      done++;
      if (done % 5 === 0 || done === driveIds.length) {
        process.stdout.write(`\r  image progress: ${done} / ${driveIds.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONFIG.concurrency }, () => worker()));
  process.stdout.write("\n");

  return results;
}

async function migrateOneImage(driveFileId, drive, storage) {
  const metaResp = await drive.files.get({
    fileId: driveFileId,
    fields: "id,name,mimeType,size",
  });

  const mimeType = metaResp.data.mimeType ?? "image/jpeg";
  const ext = mimeType.split("/")[1]?.split(";")[0] ?? "jpg";
  const storagePath = `vouchers/${driveFileId}.${ext}`;

  const dlResp = await drive.files.get(
    { fileId: driveFileId, alt: "media" },
    { responseType: "stream", timeout: CONFIG.driveTimeoutMs }
  );

  const storageFile = storage.file(storagePath);
  await new Promise((resolve, reject) => {
    const writeStream = storageFile.createWriteStream({
      metadata: {
        contentType: mimeType,
        metadata: {
          legacyDriveId: driveFileId,
        },
      },
      resumable: false,
    });
    dlResp.data.on("error", reject);
    writeStream.on("error", reject);
    writeStream.on("finish", resolve);
    dlResp.data.pipe(writeStream);
  });

  await storageFile.makePublic();
  const [metadata] = await storageFile.getMetadata();
  const publicUrl = `https://storage.googleapis.com/${CONFIG.storageBucket}/${storagePath}`;

  return {
    ok: true,
    storagePath,
    publicUrl,
    thumbnailUrl: publicUrl,
    mimeType,
    sizeBytes: Number(metadata.size ?? 0),
  };
}

async function importTransactions(transactions, voucherMap, db, admin) {
  log(`[transactions] total=${transactions.length}`);

  const BATCH_SIZE = 400;
  const txIdMap = new Map();
  const transactionPlans = [];
  let importedCount = 0;
  let importedAmount = 0;

  for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
    const chunk = transactions.slice(i, i + BATCH_SIZE);
    const batch = CONFIG.dryRun ? null : db.batch();

    for (const tx of chunk) {
      const docId = CONFIG.dryRun ? `dryrun-tx-${tx._legacyRowNum}` : db.collection("transactions").doc().id;
      txIdMap.set(tx._legacyRowNum, docId);

      const voucherStoragePaths = (tx.voucherIds ?? [])
        .map((driveId) => voucherMap.get(driveId)?.storagePath ?? null)
        .filter(Boolean);

      const transactionPlan = {
        _legacyRowNum: tx._legacyRowNum,
        date: tx.date ?? null,
        month: tx.month ?? "",
        type: tx.type ?? "支出",
        category: tx.category ?? "未分类",
        amount: tx.amount ?? 0,
        summary: tx.summary ?? "",
        source: tx.source ?? "",
        status: tx.status ?? "未关联",
        voucherIds: tx.voucherIds ?? [],
        voucherRefIds: [],
        voucherStoragePaths,
      };
      transactionPlans.push(transactionPlan);

      if (!CONFIG.dryRun) {
        const docRef = db.collection("transactions").doc(docId);
        batch.set(docRef, {
          _legacyRowNum: tx._legacyRowNum,
          _migratedAt: admin.firestore.Timestamp.now(),
          date: tx.date ? admin.firestore.Timestamp.fromDate(new Date(tx.date)) : null,
          month: tx.month ?? "",
          type: tx.type ?? "支出",
          category: tx.category ?? "未分类",
          amount: tx.amount ?? 0,
          summary: tx.summary ?? "",
          source: tx.source ?? "",
          status: tx.status ?? "未关联",
          voucherIds: tx.voucherIds ?? [],
          voucherRefIds: [],
          voucherStoragePaths,
          createdAt: admin.firestore.Timestamp.now(),
          updatedAt: admin.firestore.Timestamp.now(),
        });
      }

      importedCount++;
      importedAmount += Number(tx.amount) || 0;
    }

    if (!CONFIG.dryRun) {
      await batch.commit();
    }
  }

  return { txIdMap, importedCount, importedAmount, transactionPlans };
}

async function importVouchers(driveIds, voucherMap, txIdMap, transactions, db, admin) {
  log(`[vouchers] total=${driveIds.length}`);

  const BATCH_SIZE = 400;
  const voucherPlans = [];
  let plannedCount = 0;

  for (let i = 0; i < driveIds.length; i += BATCH_SIZE) {
    const chunk = driveIds.slice(i, i + BATCH_SIZE);
    const batch = CONFIG.dryRun ? null : db.batch();

    for (const driveId of chunk) {
      const migResult = voucherMap.get(driveId);
      const linkedTransactions = transactions.filter((tx) => (tx.voucherIds ?? []).includes(driveId));
      const linkedTransactionIds = linkedTransactions
        .map((tx) => txIdMap.get(tx._legacyRowNum))
        .filter(Boolean);
      const linkedTransactionKeys = linkedTransactions
        .map((tx) => tx._legacyRowNum)
        .filter((value) => value !== undefined && value !== null);

      const voucherPlan = {
        legacyDriveId: driveId,
        linkedTransactionIds,
        linkedTransactionKeys,
        storagePath: migResult?.storagePath ?? null,
        publicUrl: migResult?.publicUrl ?? null,
        thumbnailUrl: migResult?.thumbnailUrl ?? null,
        mimeType: migResult?.mimeType ?? null,
        sizeBytes: migResult?.sizeBytes ?? null,
        migration: {
          status: migResult?.ok ? "done" : "failed",
          lastError: migResult?.error ?? null,
          retryCount: 0,
          consecutiveFailCount: migResult?.ok ? 0 : 1,
        },
      };
      voucherPlans.push(voucherPlan);

      if (!CONFIG.dryRun) {
        const docRef = db.collection("vouchers").doc(driveId);
        batch.set(docRef, {
          legacyDriveId: driveId,
          linkedTransactionIds,
          linkedTransactionKeys,
          storagePath: migResult?.storagePath ?? null,
          publicUrl: migResult?.publicUrl ?? null,
          thumbnailUrl: migResult?.thumbnailUrl ?? null,
          mimeType: migResult?.mimeType ?? null,
          sizeBytes: migResult?.sizeBytes ?? null,
          migration: {
            status: migResult?.ok ? "done" : "failed",
            lastError: migResult?.error ?? null,
            retryCount: 0,
            consecutiveFailCount: migResult?.ok ? 0 : 1,
          },
          uploadedAt: admin.firestore.Timestamp.now(),
          migratedFrom: "v1-drive",
        });
      }

      plannedCount++;
    }

    if (!CONFIG.dryRun) {
      await batch.commit();
    }
  }

  return { plannedCount, voucherPlans };
}

function collectAllDriveIds(transactions) {
  return [...new Set(transactions.flatMap((tx) => tx.voucherIds ?? []))];
}

function buildSingleTxDocument(tx) {
  return {
    _legacyRowNum: tx._legacyRowNum,
    date: tx.date ?? null,
    month: tx.month ?? "",
    type: tx.type ?? "支出",
    category: tx.category ?? "未分类",
    amount: Number(tx.amount) || 0,
    summary: tx.summary ?? "",
    source: tx.source ?? "",
    status: tx.status ?? "未关联",
    voucherIds: Array.isArray(tx.voucherIds) ? tx.voucherIds : [],
    voucherRefIds: [],
    voucherStoragePaths: [],
  };
}

function loadExportJson() {
  try {
    return JSON.parse(readFileSync(CONFIG.exportJsonPath, "utf8"));
  } catch (error) {
    fatal(`Failed to read export.json: ${error.message}`);
  }
}

function validateExportStructure(exportData) {
  const issues = [];

  if (!exportData || typeof exportData !== "object" || Array.isArray(exportData)) {
    issues.push("top-level value must be an object");
    return issues;
  }

  if (!exportData.checksum || typeof exportData.checksum !== "object" || Array.isArray(exportData.checksum)) {
    issues.push("checksum must exist and be an object");
  }

  if (!Array.isArray(exportData.transactions)) {
    issues.push("transactions must exist and be an array");
  }

  if (!Array.isArray(exportData.vouchers)) {
    issues.push("vouchers must exist and be an array");
  }

  if (Array.isArray(exportData.transactions)) {
    exportData.transactions.forEach((tx, index) => {
      const label = `transactions[${index}]`;
      if (tx._legacyRowNum === undefined || tx._legacyRowNum === null) {
        issues.push(`${label} is missing _legacyRowNum`);
      }
      if (!Array.isArray(tx.voucherIds)) {
        issues.push(`${label}.voucherIds must be an array`);
      }
    });
  }

  if (Array.isArray(exportData.vouchers)) {
    const seen = new Set();
    exportData.vouchers.forEach((voucher, index) => {
      const label = `vouchers[${index}]`;
      if (!voucher || typeof voucher !== "object" || Array.isArray(voucher)) {
        issues.push(`${label} must be an object`);
        return;
      }
      if (!voucher.legacyDriveId) {
        issues.push(`${label} is missing legacyDriveId`);
        return;
      }
      if (seen.has(voucher.legacyDriveId)) {
        issues.push(`${label}.legacyDriveId is duplicated: ${voucher.legacyDriveId}`);
        return;
      }
      seen.add(voucher.legacyDriveId);
    });
  }

  return issues;
}

function buildNormalizedChecksum(checksum, transactions, uniqueVoucherIds) {
  const totalAmount = checksum.totalAmount ?? transactions.reduce(
    (sum, tx) => sum + (Number(tx.amount) || 0),
    0
  );

  return {
    totalRows: checksum.totalRows ?? transactions.length,
    totalVoucherFiles: checksum.totalVoucherFiles ?? uniqueVoucherIds.length,
    rowsWithVouchers: checksum.rowsWithVouchers ?? transactions.filter(
      (tx) => Array.isArray(tx.voucherIds) && tx.voucherIds.length > 0
    ).length,
    totalAmount: Math.round(totalAmount * 100) / 100,
    allVoucherIds: checksum.allVoucherIds ?? uniqueVoucherIds,
  };
}

function assessExportRisks(exportData, transactions) {
  const risks = [];

  if (!exportData || typeof exportData !== "object") {
    risks.push("export.json top-level value is not an object");
    return risks;
  }

  if (!Array.isArray(exportData.transactions)) {
    risks.push("transactions is not an array");
  }

  if (!Array.isArray(exportData.vouchers)) {
    risks.push("vouchers is not an array");
  }

  transactions.forEach((tx, index) => {
    const label = `transactions[${index}]`;
    if (tx._legacyRowNum === undefined || tx._legacyRowNum === null) {
      risks.push(`${label} is missing _legacyRowNum`);
    }
    if (!Array.isArray(tx.voucherIds)) {
      risks.push(`${label}.voucherIds is not an array`);
    }
    if (tx.amount === undefined || tx.amount === null || Number.isNaN(Number(tx.amount))) {
      risks.push(`${label}.amount is not a valid number`);
    }
    if (!tx.date) {
      risks.push(`${label} is missing date`);
    }
    if (!tx.month) {
      risks.push(`${label} is missing month`);
    }
  });

  return risks;
}

function generateReport({
  checksum,
  importedCount,
  importedAmount,
  voucherTotal,
  voucherSuccess,
  voucherFailed,
}) {
  const amtDiff = Math.abs(importedAmount - checksum.totalAmount);
  const rowMatch = importedCount === checksum.totalRows;
  const amtMatch = amtDiff < 0.01;
  const imgRate = voucherTotal > 0 ? Math.round((voucherSuccess / voucherTotal) * 100) : 100;

  return {
    generatedAt: new Date().toISOString(),
    dryRun: CONFIG.dryRun,
    passed: rowMatch && amtMatch && imgRate === 100,
    checks: {
      rowCount: {
        expected: checksum.totalRows,
        actual: importedCount,
        ok: rowMatch,
      },
      totalAmount: {
        expected: checksum.totalAmount,
        actual: Math.round(importedAmount * 100) / 100,
        diff: amtDiff,
        ok: amtMatch,
      },
      imagesMigrated: {
        total: voucherTotal,
        success: voucherSuccess,
        rate: `${imgRate}%`,
        ok: imgRate === 100,
      },
    },
    failedVouchers: voucherFailed,
  };
}

function printDryRunSummary({
  checksum,
  transactions,
  uniqueVoucherIds,
  transactionPlans,
  txIdMap,
  voucherPlanCount,
  voucherPlans,
  risks,
}) {
  console.log("\n========== DRY RUN SUMMARY ==========");
  console.log(`transactions read: ${transactions.length}`);
  console.log(`unique voucherIds: ${uniqueVoucherIds.length}`);
  console.log(`planned transaction objects: ${txIdMap.size}`);
  console.log(`planned voucher objects: ${voucherPlanCount}`);
  console.log(`totalAmount: ${checksum.totalAmount}`);
  if (transactionPlans.length > 0) {
    console.log(`transaction plan fields: ${Object.keys(transactionPlans[0]).join(", ")}`);
  }
  if (voucherPlans.length > 0) {
    console.log(`voucher plan fields: ${Object.keys(voucherPlans[0]).join(", ")}`);
  }
  if (risks.length) {
    console.log("risks:");
    risks.forEach((risk) => console.log(`- ${risk}`));
  } else {
    console.log("risks: none");
  }
  console.log("=====================================\n");
}

function printPreflightSummary({
  checksum,
  exportData,
  transactions,
  uniqueVoucherIds,
  mode,
}) {
  console.log("\n========== PREFLIGHT SUMMARY ==========");
  console.log(`mode: ${mode}`);
  console.log(`export.json: ${CONFIG.exportJsonPath}`);
  console.log(`checksum present: ${exportData.checksum ? "yes" : "no"}`);
  console.log(`transactions count: ${transactions.length}`);
  console.log(`vouchers count: ${Array.isArray(exportData.vouchers) ? exportData.vouchers.length : 0}`);
  console.log(`unique voucherIds: ${uniqueVoucherIds.length}`);
  console.log(`totalRows: ${checksum.totalRows}`);
  console.log(`totalVoucherFiles: ${checksum.totalVoucherFiles}`);
  console.log(`rowsWithVouchers: ${checksum.rowsWithVouchers}`);
  console.log(`totalAmount: ${checksum.totalAmount}`);
  console.log(`serviceAccount exists: ${existsSync(CONFIG.serviceAccountPath) ? "yes" : "no"}`);
  console.log(`bucket configured: ${CONFIG.storageBucket ? "yes" : "no"}`);
  console.log("=======================================\n");
}

function printReport(report) {
  const checks = report.checks;
  console.log("\n========== IMPORT REPORT ==========");
  console.log(`rowCount: expected=${checks.rowCount.expected}, actual=${checks.rowCount.actual}, ok=${checks.rowCount.ok}`);
  console.log(`totalAmount: expected=${checks.totalAmount.expected}, actual=${checks.totalAmount.actual}, diff=${checks.totalAmount.diff.toFixed(4)}, ok=${checks.totalAmount.ok}`);
  console.log(`images: success=${checks.imagesMigrated.success}/${checks.imagesMigrated.total}, rate=${checks.imagesMigrated.rate}, ok=${checks.imagesMigrated.ok}`);
  if (report.failedVouchers?.length) {
    console.log("failed vouchers:");
    report.failedVouchers.forEach((item) => {
      console.log(`- ${item.driveId ?? JSON.stringify(item)}: ${item.error ?? "unknown"}`);
    });
  }
  console.log(`passed: ${report.passed}`);
  console.log("===================================\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(...args) {
  console.log(...args);
}

function fatal(message) {
  console.error(`\nFatal: ${message}\n`);
  process.exit(1);
}

main().catch((error) => {
  console.error("Import script crashed:", error);
  process.exit(1);
});
