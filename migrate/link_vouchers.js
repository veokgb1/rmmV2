import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  serviceAccountPath: path.join(__dirname, "serviceAccount.json"),
  transactionsCollection: process.env.TX_COLLECTION || "transactions",
  vouchersCollection: process.env.VOUCHER_COLLECTION || "vouchers",
};

function preflight() {
  if (!existsSync(CONFIG.serviceAccountPath)) {
    fatal(`Missing serviceAccount.json: ${CONFIG.serviceAccountPath}`);
  }
}

async function initFirebase() {
  const admin = (await import("firebase-admin")).default;
  const serviceAccount = JSON.parse(readFileSync(CONFIG.serviceAccountPath, "utf8"));

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  return { admin, db: admin.firestore() };
}

function uniquePreserveOrder(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function arrayEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function main() {
  preflight();
  const { admin, db } = await initFirebase();

  const txSnap = await db.collection(CONFIG.transactionsCollection).get();

  let processed = 0;
  let boundSuccess = 0;
  let failed = 0;
  let unchanged = 0;
  let warnings = 0;

  for (const txDoc of txSnap.docs) {
    processed++;
    const tx = txDoc.data() || {};
    const voucherIdsRaw = Array.isArray(tx.voucherIds) ? tx.voucherIds : [];
    const voucherIds = uniquePreserveOrder(voucherIdsRaw.filter(Boolean).map(String));

    if (voucherIds.length === 0) {
      unchanged++;
      continue;
    }

    const nextVoucherRefIds = [];
    const nextVoucherStoragePaths = [];
    let hasMissing = false;

    for (const voucherId of voucherIds) {
      const vSnap = await db
        .collection(CONFIG.vouchersCollection)
        .where("legacyDriveId", "==", voucherId)
        .limit(1)
        .get();

      if (vSnap.empty) {
        warnings++;
        hasMissing = true;
        console.warn(
          `[warning] tx=${txDoc.id} legacyRow=${tx._legacyRowNum ?? "unknown"} missing voucher legacyDriveId=${voucherId}`
        );
        continue;
      }

      const vDoc = vSnap.docs[0];
      const vData = vDoc.data() || {};
      nextVoucherRefIds.push(vDoc.id);

      if (vData.storagePath) {
        nextVoucherStoragePaths.push(String(vData.storagePath));
      } else {
        warnings++;
        console.warn(
          `[warning] tx=${txDoc.id} voucherDoc=${vDoc.id} legacyDriveId=${voucherId} missing storagePath`
        );
      }
    }

    const orderedVoucherRefIds = uniquePreserveOrder(nextVoucherRefIds);
    const orderedVoucherStoragePaths = uniquePreserveOrder(nextVoucherStoragePaths);

    const currentVoucherRefIds = Array.isArray(tx.voucherRefIds) ? tx.voucherRefIds.map(String) : [];
    const currentVoucherStoragePaths = Array.isArray(tx.voucherStoragePaths)
      ? tx.voucherStoragePaths.map(String)
      : [];

    const refSame = arrayEqual(currentVoucherRefIds, orderedVoucherRefIds);
    const pathSame = arrayEqual(currentVoucherStoragePaths, orderedVoucherStoragePaths);

    if (refSame && pathSame) {
      unchanged++;
    } else {
      await txDoc.ref.set(
        {
          voucherRefIds: orderedVoucherRefIds,
          voucherStoragePaths: orderedVoucherStoragePaths,
          updatedAt: admin.firestore.Timestamp.now(),
        },
        { merge: true }
      );
    }

    if (hasMissing || orderedVoucherRefIds.length === 0) {
      failed++;
    } else {
      boundSuccess++;
    }
  }

  console.log("\n========== LINK_VOUCHERS RESULT ==========");
  console.log(`transactionsCollection: ${CONFIG.transactionsCollection}`);
  console.log(`vouchersCollection: ${CONFIG.vouchersCollection}`);
  console.log(`processed: ${processed}`);
  console.log(`successBound: ${boundSuccess}`);
  console.log(`failed: ${failed}`);
  console.log(`unchanged: ${unchanged}`);
  console.log(`warnings: ${warnings}`);
  console.log("=========================================\n");
}

function fatal(message) {
  console.error(`\nFatal: ${message}\n`);
  process.exit(1);
}

main().catch((error) => {
  console.error("link_vouchers crashed:", error);
  process.exit(1);
});
