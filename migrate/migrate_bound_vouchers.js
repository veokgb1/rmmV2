import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  serviceAccountPath: path.join(__dirname, "serviceAccount.json"),
  exportJsonPath: path.join(__dirname, "export.json"),
  bucket: process.env.FIREBASE_STORAGE_BUCKET ?? "",
  vouchersCollection: process.env.VOUCHER_COLLECTION || "vouchers",
};

function fatal(msg) {
  console.error(`\nFatal: ${msg}\n`);
  process.exit(1);
}

function preflight() {
  if (!existsSync(CONFIG.serviceAccountPath)) fatal(`Missing serviceAccount.json: ${CONFIG.serviceAccountPath}`);
  if (!existsSync(CONFIG.exportJsonPath)) fatal(`Missing export.json: ${CONFIG.exportJsonPath}`);
  if (!CONFIG.bucket) fatal("Missing FIREBASE_STORAGE_BUCKET");
}

function loadExportVoucherIds() {
  const data = JSON.parse(readFileSync(CONFIG.exportJsonPath, "utf8"));
  const txs = Array.isArray(data.transactions) ? data.transactions : [];
  const all = txs.flatMap((tx) => (Array.isArray(tx.voucherIds) ? tx.voucherIds : []));
  return [...new Set(all.map((x) => String(x).trim()).filter(Boolean))];
}

async function initFirebaseAndDrive() {
  const admin = (await import("firebase-admin")).default;
  const { google } = await import("googleapis");
  const serviceAccount = JSON.parse(readFileSync(CONFIG.serviceAccountPath, "utf8"));

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: CONFIG.bucket,
    });
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: CONFIG.serviceAccountPath,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  return {
    admin,
    db: admin.firestore(),
    storage: admin.storage().bucket(),
    drive: google.drive({ version: "v3", auth }),
  };
}

async function findVoucherDocByLegacyId(db, legacyDriveId) {
  const snap = await db
    .collection(CONFIG.vouchersCollection)
    .where("legacyDriveId", "==", legacyDriveId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
}

function isAlreadyMigrated(vData) {
  if (!vData) return false;
  const status = vData.migration?.status || vData.migrateStatus || "";
  const hasPath = Boolean(vData.storagePath);
  const hasUrl = Boolean(vData.publicUrl);
  return (status === "done" || status === "ok") && hasPath && hasUrl;
}

async function migrateOne({ admin, db, storage, drive }, legacyDriveId) {
  const existingDoc = await findVoucherDocByLegacyId(db, legacyDriveId);
  const existingData = existingDoc ? existingDoc.data() || {} : null;

  if (isAlreadyMigrated(existingData)) {
    return { action: "skipped" };
  }

  const metaResp = await drive.files.get({
    fileId: legacyDriveId,
    fields: "id,name,mimeType,size",
  });

  const mimeType = metaResp.data.mimeType ?? "image/jpeg";
  const ext = mimeType.split("/")[1]?.split(";")[0] ?? "jpg";
  const storagePath = `vouchers/${legacyDriveId}.${ext}`;
  const storageFile = storage.file(storagePath);

  const [alreadyExists] = await storageFile.exists();
  if (!alreadyExists) {
    const dlResp = await drive.files.get(
      { fileId: legacyDriveId, alt: "media" },
      { responseType: "stream", timeout: 15000 }
    );

    await new Promise((resolve, reject) => {
      const writeStream = storageFile.createWriteStream({
        metadata: {
          contentType: mimeType,
          metadata: { legacyDriveId },
        },
        resumable: false,
      });
      dlResp.data.on("error", reject);
      writeStream.on("error", reject);
      writeStream.on("finish", resolve);
      dlResp.data.pipe(writeStream);
    });
  }

  await storageFile.makePublic();
  const [metadata] = await storageFile.getMetadata();
  const publicUrl = `https://storage.googleapis.com/${CONFIG.bucket}/${storagePath}`;

  const docRef = existingDoc
    ? existingDoc.ref
    : db.collection(CONFIG.vouchersCollection).doc(legacyDriveId);

  await docRef.set(
    {
      legacyDriveId,
      storagePath,
      publicUrl,
      thumbnailUrl: publicUrl,
      mimeType,
      sizeBytes: Number(metadata.size ?? 0),
      migration: {
        status: "done",
        lastError: null,
        retryCount: 0,
        consecutiveFailCount: 0,
      },
      migrateStatus: "ok",
      migrateError: null,
      uploadedAt: admin.firestore.Timestamp.now(),
      migratedFrom: "v1-drive",
      updatedAt: admin.firestore.Timestamp.now(),
    },
    { merge: true }
  );

  return { action: alreadyExists ? "repaired" : "migrated" };
}

async function main() {
  preflight();
  const ids = loadExportVoucherIds();
  const runtime = await initFirebaseAndDrive();

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  console.log(`Bound voucherIds from export.transactions: ${ids.length}`);

  for (const legacyDriveId of ids) {
    try {
      const result = await migrateOne(runtime, legacyDriveId);
      if (result.action === "skipped") skipped++;
      else migrated++;
    } catch (error) {
      failed++;
      console.warn(`[warning] migrate failed legacyDriveId=${legacyDriveId} error=${error.message}`);
      const doc = await findVoucherDocByLegacyId(runtime.db, legacyDriveId);
      const ref = doc ? doc.ref : runtime.db.collection(CONFIG.vouchersCollection).doc(legacyDriveId);
      await ref.set(
        {
          legacyDriveId,
          migration: {
            status: "failed",
            lastError: error.message,
          },
          migrateStatus: "failed",
          migrateError: error.message,
          updatedAt: runtime.admin.firestore.Timestamp.now(),
        },
        { merge: true }
      );
    }
  }

  console.log("\n========== MIGRATE BOUND VOUCHERS RESULT ==========");
  console.log(`newlyMigrated: ${migrated}`);
  console.log(`skippedExisting: ${skipped}`);
  console.log(`failed: ${failed}`);
  console.log("===================================================\n");
}

main().catch((error) => {
  console.error("migrate_bound_vouchers crashed:", error);
  process.exit(1);
});
