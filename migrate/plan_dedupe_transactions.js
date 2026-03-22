import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  serviceAccountPath: path.join(__dirname, "serviceAccount.json"),
  outputPath: path.join(__dirname, "transactions_dedupe_plan.json"),
  transactionsCollection: process.env.TX_COLLECTION || "transactions",
};

function fatal(msg) {
  console.error(`\nFatal: ${msg}\n`);
  process.exit(1);
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function countFilledFields(data) {
  const keys = [
    "date",
    "month",
    "type",
    "category",
    "amount",
    "summary",
    "source",
    "status",
    "voucherIds",
    "voucherRefIds",
    "voucherStoragePaths",
  ];

  let score = 0;
  for (const key of keys) {
    const v = data[key];
    if (Array.isArray(v)) {
      if (v.length > 0) score++;
      continue;
    }
    if (v !== null && v !== undefined && String(v).trim() !== "") {
      score++;
    }
  }
  return score;
}

function linkCompletionScore(data) {
  const refLen = Array.isArray(data.voucherRefIds) ? data.voucherRefIds.length : 0;
  const pathLen = Array.isArray(data.voucherStoragePaths) ? data.voucherStoragePaths.length : 0;
  return refLen + pathLen;
}

function pickKeepDoc(candidates) {
  const withScores = candidates.map((doc) => {
    const data = doc.data || {};
    return {
      ...doc,
      filledScore: countFilledFields(data),
      linkScore: linkCompletionScore(data),
      updatedMs: toMillis(data.updatedAt),
      createdMs: toMillis(data.createdAt),
    };
  });

  withScores.sort((a, b) => {
    if (b.filledScore !== a.filledScore) return b.filledScore - a.filledScore;
    if (b.linkScore !== a.linkScore) return b.linkScore - a.linkScore;
    if (b.updatedMs !== a.updatedMs) return b.updatedMs - a.updatedMs;
    if (b.createdMs !== a.createdMs) return b.createdMs - a.createdMs;
    return a.docId.localeCompare(b.docId);
  });

  const keep = withScores[0];
  const deletes = withScores.slice(1);

  return {
    keep,
    deletes,
  };
}

function reasonText(keep, duplicatesCount) {
  return `keep ${keep.docId}: filledScore=${keep.filledScore}, linkScore=${keep.linkScore}, updatedMs=${keep.updatedMs}, createdMs=${keep.createdMs}, duplicates=${duplicatesCount}`;
}

async function initDb() {
  if (!existsSync(CONFIG.serviceAccountPath)) {
    fatal(`Missing serviceAccount.json: ${CONFIG.serviceAccountPath}`);
  }

  const admin = (await import("firebase-admin")).default;
  const serviceAccount = JSON.parse(readFileSync(CONFIG.serviceAccountPath, "utf8"));
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  return admin.firestore();
}

async function main() {
  const db = await initDb();
  const snap = await db.collection(CONFIG.transactionsCollection).get();

  const byLegacy = new Map();
  const skippedNoLegacy = [];

  for (const d of snap.docs) {
    const data = d.data() || {};
    const legacy = data._legacyRowNum;
    if (legacy === undefined || legacy === null) {
      skippedNoLegacy.push(d.id);
      continue;
    }
    if (!byLegacy.has(legacy)) byLegacy.set(legacy, []);
    byLegacy.get(legacy).push({
      docId: d.id,
      data,
    });
  }

  const duplicateEntries = [...byLegacy.entries()]
    .filter(([, docs]) => docs.length > 1)
    .sort((a, b) => Number(a[0]) - Number(b[0]));

  const planGroups = [];
  let totalDeleteDocs = 0;

  for (const [legacyRowNum, docs] of duplicateEntries) {
    const { keep, deletes } = pickKeepDoc(docs);
    totalDeleteDocs += deletes.length;
    planGroups.push({
      _legacyRowNum: Number(legacyRowNum),
      keepDocId: keep.docId,
      deleteDocIds: deletes.map((x) => x.docId),
      reason: reasonText(keep, docs.length),
      candidates: docs.map((d) => ({
        docId: d.docId,
        voucherIdsCount: Array.isArray(d.data.voucherIds) ? d.data.voucherIds.length : 0,
        voucherRefIdsCount: Array.isArray(d.data.voucherRefIds) ? d.data.voucherRefIds.length : 0,
        voucherStoragePathsCount: Array.isArray(d.data.voucherStoragePaths) ? d.data.voucherStoragePaths.length : 0,
        hasUpdatedAt: Boolean(d.data.updatedAt),
        hasCreatedAt: Boolean(d.data.createdAt),
      })),
    });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    collection: CONFIG.transactionsCollection,
    totals: {
      scannedDocs: snap.size,
      distinctLegacyRows: byLegacy.size,
      duplicateGroups: planGroups.length,
      deleteDocCount: totalDeleteDocs,
      noLegacyRowDocs: skippedNoLegacy.length,
    },
    skippedNoLegacyDocIds: skippedNoLegacy,
    groups: planGroups,
  };

  writeFileSync(CONFIG.outputPath, JSON.stringify(output, null, 2), "utf8");

  console.log("\n========== TRANSACTIONS DEDUPE PLAN ==========");
  console.log(`scannedDocs: ${output.totals.scannedDocs}`);
  console.log(`duplicateGroups: ${output.totals.duplicateGroups}`);
  console.log(`deleteDocCount: ${output.totals.deleteDocCount}`);
  console.log(`planFile: ${CONFIG.outputPath}`);
  console.log("==============================================\n");
}

main().catch((err) => fatal(err.message || String(err)));
