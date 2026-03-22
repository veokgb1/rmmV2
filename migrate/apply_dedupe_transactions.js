import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  serviceAccountPath: path.join(__dirname, "serviceAccount.json"),
  planPath: path.join(__dirname, "transactions_dedupe_plan.json"),
  transactionsCollection: process.env.TX_COLLECTION || "transactions",
};

function fatal(msg) {
  console.error(`\nFatal: ${msg}\n`);
  process.exit(1);
}

async function initDb() {
  if (!existsSync(CONFIG.serviceAccountPath)) {
    fatal(`Missing serviceAccount.json: ${CONFIG.serviceAccountPath}`);
  }
  if (!existsSync(CONFIG.planPath)) {
    fatal(`Missing plan file: ${CONFIG.planPath}`);
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

function loadPlan() {
  const plan = JSON.parse(readFileSync(CONFIG.planPath, "utf8"));
  if (!plan || !Array.isArray(plan.groups)) {
    fatal("Invalid plan format: groups missing");
  }
  return plan;
}

function arrayLen(v) {
  return Array.isArray(v) ? v.length : 0;
}

async function verifyPostState(db, plan) {
  const txSnap = await db.collection(CONFIG.transactionsCollection).get();
  const byLegacy = new Map();
  for (const d of txSnap.docs) {
    const data = d.data() || {};
    const legacy = data._legacyRowNum;
    if (legacy === undefined || legacy === null) continue;
    if (!byLegacy.has(legacy)) byLegacy.set(legacy, []);
    byLegacy.get(legacy).push(d.id);
  }

  const duplicateGroups = [...byLegacy.entries()].filter(([, ids]) => ids.length > 1);

  const keepChecks = [];
  for (const group of plan.groups) {
    const keepDoc = await db.collection(CONFIG.transactionsCollection).doc(group.keepDocId).get();
    const exists = keepDoc.exists;
    const data = exists ? keepDoc.data() || {} : {};
    keepChecks.push({
      legacyRowNum: group._legacyRowNum,
      keepDocId: group.keepDocId,
      exists,
      voucherRefIdsCount: arrayLen(data.voucherRefIds),
      voucherStoragePathsCount: arrayLen(data.voucherStoragePaths),
    });
  }

  return {
    transactionsTotal: txSnap.size,
    duplicateGroups,
    keepChecks,
  };
}

async function main() {
  const db = await initDb();
  const plan = loadPlan();

  let deleted = 0;
  let deleteFailed = 0;

  for (const group of plan.groups) {
    const deleteDocIds = Array.isArray(group.deleteDocIds) ? group.deleteDocIds : [];
    for (const docId of deleteDocIds) {
      try {
        await db.collection(CONFIG.transactionsCollection).doc(docId).delete();
        deleted++;
      } catch (error) {
        deleteFailed++;
        console.warn(`[warning] delete failed docId=${docId} error=${error.message}`);
      }
    }
  }

  const post = await verifyPostState(db, plan);

  console.log("\n========== APPLY DEDUPE RESULT ==========");
  console.log(`deleted: ${deleted}`);
  console.log(`deleteFailed: ${deleteFailed}`);
  console.log(`transactionsTotal: ${post.transactionsTotal}`);
  console.log(`remainingDuplicateGroups: ${post.duplicateGroups.length}`);
  for (const [legacy, ids] of post.duplicateGroups) {
    console.log(`remainingDuplicate legacyRow=${legacy} docIds=${ids.join(",")}`);
  }
  console.log("keepDocChecks:");
  for (const check of post.keepChecks) {
    console.log(
      `legacyRow=${check.legacyRowNum} keepDocId=${check.keepDocId} exists=${check.exists} voucherRefIdsCount=${check.voucherRefIdsCount} voucherStoragePathsCount=${check.voucherStoragePathsCount}`
    );
  }
  console.log("=========================================\n");
}

main().catch((error) => fatal(error.message || String(error)));
