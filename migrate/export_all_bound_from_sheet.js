import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  serviceAccountPath: path.join(__dirname, "serviceAccount.json"),
  exportPath: path.join(__dirname, "export.json"),
  spreadsheetId: "1moQy0qsxBTSQ3VvLRVD9onoZuvycsbe5tMqGyhAiVdc",
  sheetName: "① 流水明细",
  startRow: 3,
  endCol: "K",
};

const COL = {
  DATE: 0,
  MONTH: 1,
  TYPE: 2,
  CATEGORY: 3,
  AMOUNT: 4,
  SUMMARY: 5,
  SOURCE: 6,
  VOUCHER: 7,
  STATUS: 8,
  VOUCHER_V2: 10,
};

function fatal(msg) {
  console.error(`\nFatal: ${msg}\n`);
  process.exit(1);
}

function formatMonth(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{4}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const y = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${mm}`;
  }
  return s;
}

function parseVoucherIds(v2, voucherText) {
  const ids = [];
  const v2Raw = String(v2 ?? "").trim();
  if (v2Raw) {
    const payload = v2Raw.startsWith("v:") ? v2Raw.slice(2) : v2Raw;
    payload.split("|").forEach((x) => ids.push(String(x).trim()));
  }
  const vt = String(voucherText ?? "");
  const matches = vt.match(/[-\w]{25,}/g) || [];
  matches.forEach((x) => ids.push(x));

  const seen = new Set();
  return ids.filter((x) => x && /^[-\w]{25,}$/.test(x) && !seen.has(x) && seen.add(x));
}

async function main() {
  if (!existsSync(CONFIG.serviceAccountPath)) {
    fatal(`Missing serviceAccount.json: ${CONFIG.serviceAccountPath}`);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: CONFIG.serviceAccountPath,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: "v3", auth });

  // Avoid Sheets API dependency by exporting spreadsheet via Drive API as TSV.
  const exportResp = await drive.files.export(
    {
      fileId: CONFIG.spreadsheetId,
      mimeType: "text/tab-separated-values",
    },
    { responseType: "arraybuffer" }
  );

  const text = Buffer.from(exportResp.data).toString("utf8");
  const allLines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (allLines.length < 3) {
    fatal("Exported sheet has fewer than 3 rows; cannot build full bound export.");
  }

  // Row 1-2 are non-ledger headers; start from row 3.
  const dataLines = allLines.slice(2);
  const rows = dataLines.map((line) => line.split("\t"));
  const transactions = [];
  const voucherMap = {};
  let totalAmount = 0;

  for (let i = 0; i < rows.length; i++) {
    const rowNum = CONFIG.startRow + i;
    const row = rows[i];
    const voucherIds = parseVoucherIds(row[COL.VOUCHER_V2], row[COL.VOUCHER]);
    if (voucherIds.length === 0) continue;

    const amount = Number(row[COL.AMOUNT] ?? 0) || 0;
    totalAmount += amount;

    transactions.push({
      _legacyRowNum: rowNum,
      date: String(row[COL.DATE] ?? "").trim(),
      month: formatMonth(row[COL.MONTH]),
      type: String(row[COL.TYPE] ?? "").trim(),
      category: String(row[COL.CATEGORY] ?? "").trim(),
      amount,
      summary: String(row[COL.SUMMARY] ?? "").trim(),
      source: String(row[COL.SOURCE] ?? "").trim(),
      status: String(row[COL.STATUS] ?? "").trim(),
      voucherIds,
    });

    voucherIds.forEach((id) => {
      if (!voucherMap[id]) voucherMap[id] = { legacyDriveId: id };
    });
  }

  const vouchers = Object.keys(voucherMap).map((id) => voucherMap[id]);
  const exportData = {
    checksum: {
      totalRows: transactions.length,
      totalVoucherFiles: vouchers.length,
      rowsWithVouchers: transactions.length,
      totalAmount: Math.round(totalAmount * 100) / 100,
    },
    transactions,
    vouchers,
  };

  writeFileSync(CONFIG.exportPath, JSON.stringify(exportData, null, 2), "utf8");

  console.log("\n========== EXPORT ALL BOUND RESULT ==========");
  console.log(`rowsRead: ${rows.length}`);
  console.log(`transactionsExported: ${transactions.length}`);
  console.log(`vouchersExported: ${vouchers.length}`);
  console.log(`totalAmount: ${exportData.checksum.totalAmount}`);
  console.log(`exportPath: ${CONFIG.exportPath}`);
  console.log("============================================\n");
}

main().catch((e) => {
  fatal(e.message || String(e));
});
