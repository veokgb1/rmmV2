import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  serviceAccountPath: path.join(__dirname, "serviceAccount.json"),
  transactionsCollection: process.env.TX_COLLECTION || "transactions",
  vouchersCollection: process.env.VOUCHER_COLLECTION || "vouchers",
};

const SAMPLES = [
  {
    legacyRowNum: 19,
    voucherIds: [
      "1aL5uE6QmZkJts-xuo14-rDXHJ4sb2G9A",
      "17N4jKv__l3bf6qUs82GBujKeBTqGmGcb",
    ],
  },
  {
    legacyRowNum: 20,
    voucherIds: [
      "1fcD9SDQbl3luOSKr4LoXy1-pVDuVlpZU",
      "1qe0ZT2A2s5RQrFxhBSJ4nkQmsgJa1wCa",
    ],
  },
];

function must(ok, msg) {
  if (!ok) throw new Error(msg);
}

async function initDb() {
  if (!existsSync(CONFIG.serviceAccountPath)) {
    throw new Error(`Missing serviceAccount.json: ${CONFIG.serviceAccountPath}`);
  }
  const admin = (await import("firebase-admin")).default;
  const serviceAccount = JSON.parse(readFileSync(CONFIG.serviceAccountPath, "utf8"));
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin.firestore();
}

function asArray(v) {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

async function auditOne(db, sample) {
  const steps = [];

  const txSnap = await db
    .collection(CONFIG.transactionsCollection)
    .where("_legacyRowNum", "==", sample.legacyRowNum)
    .limit(1)
    .get();
  must(!txSnap.empty, `transaction missing _legacyRowNum=${sample.legacyRowNum}`);
  const txDoc = txSnap.docs[0];
  const tx = txDoc.data() || {};
  steps.push("transaction exists");

  const txVoucherIds = asArray(tx.voucherIds);
  for (const vid of sample.voucherIds) {
    must(txVoucherIds.includes(vid), `transaction.voucherIds missing ${vid}`);
  }
  steps.push("transaction.voucherIds contains both voucherIds");

  const txRefIds = asArray(tx.voucherRefIds);
  must(txRefIds.length >= 2, "transaction.voucherRefIds not fully populated (need >=2)");
  steps.push("transaction.voucherRefIds populated");

  const txPaths = asArray(tx.voucherStoragePaths);
  must(txPaths.length >= 2, "transaction.voucherStoragePaths not fully populated (need >=2)");
  steps.push("transaction.voucherStoragePaths populated");

  const voucherDetails = [];

  for (const vid of sample.voucherIds) {
    const vSnap = await db
      .collection(CONFIG.vouchersCollection)
      .where("legacyDriveId", "==", vid)
      .limit(1)
      .get();
    must(!vSnap.empty, `voucher missing legacyDriveId=${vid}`);
    const vDoc = vSnap.docs[0];
    const v = vDoc.data() || {};
    const storagePath = v.storagePath ? String(v.storagePath) : "";
    const publicUrl = v.publicUrl ? String(v.publicUrl) : "";
    must(storagePath.length > 0, `voucher.storagePath missing for ${vid}`);
    must(publicUrl.length > 0, `voucher.publicUrl missing for ${vid}`);
    must(txRefIds.includes(vDoc.id), `transaction.voucherRefIds missing voucherDocId=${vDoc.id}`);
    must(txPaths.includes(storagePath), `transaction.voucherStoragePaths missing ${storagePath}`);
    voucherDetails.push({
      legacyDriveId: vid,
      voucherDocId: vDoc.id,
      storagePath,
    });
  }
  steps.push("voucher docs/storage/publicUrl all valid and linked back to transaction");

  return {
    pass: true,
    txDocId: txDoc.id,
    steps,
    voucherDetails,
  };
}

async function main() {
  const db = await initDb();
  let pass = 0;
  let fail = 0;

  console.log("========== ONE-TO-MANY AUDIT (19/20) ==========");

  for (const sample of SAMPLES) {
    console.log("\n-----------------------------------------------");
    console.log(`Sample _legacyRowNum=${sample.legacyRowNum}`);
    try {
      const result = await auditOne(db, sample);
      pass++;
      console.log("Result: PASS");
      for (const step of result.steps) console.log(`  [OK] ${step}`);
      console.log(`  txDocId: ${result.txDocId}`);
      for (const item of result.voucherDetails) {
        console.log(
          `  voucher legacyDriveId=${item.legacyDriveId} voucherDocId=${item.voucherDocId} storagePath=${item.storagePath}`
        );
      }
    } catch (error) {
      fail++;
      console.log("Result: FAIL");
      console.log(`  [FAIL] ${error.message}`);
    }
  }

  console.log("\n===============================================");
  console.log(`Summary: PASS=${pass}, FAIL=${fail}`);
  console.log("===============================================");
}

main().catch((error) => {
  console.error("audit_onetomany_19_20 crashed:", error);
  process.exit(1);
});
