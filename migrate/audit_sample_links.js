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
  { legacyRowNum: 3, voucherId: "11pZAd5tLG0HpxPza16M8yM0Row2sFdPo" },
  { legacyRowNum: 4, voucherId: "1QlqcEwCiqkXRFH_FliQREGgq2FMY4JgI" },
  { legacyRowNum: 5, voucherId: "1kuXRGf1CImB4bCT4Hq_RgGMuPPw953MI" },
];

function must(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function initFirebase() {
  if (!existsSync(CONFIG.serviceAccountPath)) {
    throw new Error(`Missing serviceAccount.json: ${CONFIG.serviceAccountPath}`);
  }

  const admin = (await import("firebase-admin")).default;
  const serviceAccount = JSON.parse(readFileSync(CONFIG.serviceAccountPath, "utf8"));

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  return { db: admin.firestore() };
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

async function auditOneSample(db, sample) {
  const steps = [];
  let txDocId = null;
  let voucherDocId = null;
  let storagePath = null;

  const txSnap = await db
    .collection(CONFIG.transactionsCollection)
    .where("_legacyRowNum", "==", sample.legacyRowNum)
    .limit(1)
    .get();

  must(!txSnap.empty, `transactions: missing _legacyRowNum=${sample.legacyRowNum}`);
  const txDoc = txSnap.docs[0];
  txDocId = txDoc.id;
  const tx = txDoc.data() || {};
  steps.push("transactions found by _legacyRowNum");

  const txVoucherIds = asStringArray(tx.voucherIds);
  must(txVoucherIds.includes(sample.voucherId), `transaction.voucherIds does not contain ${sample.voucherId}`);
  steps.push("transaction.voucherIds contains expected voucherId");

  const txVoucherRefIds = asStringArray(tx.voucherRefIds);
  must(txVoucherRefIds.length > 0, "transaction.voucherRefIds is empty");
  steps.push("transaction.voucherRefIds is populated");

  const txVoucherStoragePaths = asStringArray(tx.voucherStoragePaths);
  must(txVoucherStoragePaths.length > 0, "transaction.voucherStoragePaths is empty");
  steps.push("transaction.voucherStoragePaths is populated");

  const voucherSnap = await db
    .collection(CONFIG.vouchersCollection)
    .where("legacyDriveId", "==", sample.voucherId)
    .limit(1)
    .get();

  must(!voucherSnap.empty, `vouchers: missing legacyDriveId=${sample.voucherId}`);
  const voucherDoc = voucherSnap.docs[0];
  voucherDocId = voucherDoc.id;
  const voucher = voucherDoc.data() || {};
  steps.push("voucher found by legacyDriveId");

  storagePath = voucher.storagePath ? String(voucher.storagePath) : "";
  must(storagePath.length > 0, "voucher.storagePath is missing");
  steps.push("voucher.storagePath exists");

  const publicUrl = voucher.publicUrl ? String(voucher.publicUrl) : "";
  must(publicUrl.length > 0, "voucher.publicUrl is missing");
  steps.push("voucher.publicUrl exists");

  must(txVoucherRefIds.includes(voucherDocId), `transaction.voucherRefIds does not include voucher docId=${voucherDocId}`);
  steps.push("transaction.voucherRefIds links to voucher docId");

  must(
    txVoucherStoragePaths.includes(storagePath),
    `transaction.voucherStoragePaths does not include storagePath=${storagePath}`
  );
  steps.push("transaction.voucherStoragePaths links to voucher.storagePath");

  return {
    pass: true,
    steps,
    txDocId,
    voucherDocId,
    storagePath,
  };
}

async function main() {
  const { db } = await initFirebase();

  console.log("========== SAMPLE LINK AUDIT ==========");
  console.log(`transactionsCollection: ${CONFIG.transactionsCollection}`);
  console.log(`vouchersCollection: ${CONFIG.vouchersCollection}`);

  let passCount = 0;
  let failCount = 0;

  for (const sample of SAMPLES) {
    console.log("\n----------------------------------------");
    console.log(`Sample _legacyRowNum=${sample.legacyRowNum}, voucherId=${sample.voucherId}`);
    try {
      const result = await auditOneSample(db, sample);
      passCount++;
      console.log("Result: PASS");
      for (const step of result.steps) {
        console.log(`  [OK] ${step}`);
      }
      console.log(`  txDocId: ${result.txDocId}`);
      console.log(`  voucherDocId: ${result.voucherDocId}`);
      console.log(`  storagePath: ${result.storagePath}`);
    } catch (error) {
      failCount++;
      console.log("Result: FAIL");
      console.log(`  [FAIL] ${error.message}`);
    }
  }

  console.log("\n========================================");
  console.log(`Summary: PASS=${passCount}, FAIL=${failCount}`);
  console.log("========================================");
}

main().catch((error) => {
  console.error("audit_sample_links crashed:", error);
  process.exit(1);
});
