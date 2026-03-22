import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exportPath = path.join(__dirname, "export.json");

function fail(message) {
  console.error(`[validate-export] ${message}`);
  process.exitCode = 1;
}

function info(message) {
  console.log(`[validate-export] ${message}`);
}

function loadExportJson() {
  const raw = readFileSync(exportPath, "utf8");
  return JSON.parse(raw);
}

function validateTopLevel(data) {
  if (!data || typeof data !== "object") {
    fail("export.json 顶层不是对象");
    return false;
  }

  const requiredKeys = ["checksum", "transactions", "vouchers"];
  for (const key of requiredKeys) {
    if (!(key in data)) {
      fail(`缺少顶层字段: ${key}`);
    }
  }

  if (!Array.isArray(data.transactions)) {
    fail("transactions 不是数组");
  }

  if (!Array.isArray(data.vouchers)) {
    fail("vouchers 不是数组");
  }

  return true;
}

function validateCounts(data) {
  const checksum = data.checksum || {};

  if (checksum.totalRows !== data.transactions.length) {
    fail(`totalRows 不等于 transactions.length: ${checksum.totalRows} !== ${data.transactions.length}`);
  } else {
    info(`totalRows 校验通过: ${checksum.totalRows}`);
  }

  if (checksum.totalVoucherFiles !== data.vouchers.length) {
    fail(`totalVoucherFiles 不等于 vouchers.length: ${checksum.totalVoucherFiles} !== ${data.vouchers.length}`);
  } else {
    info(`totalVoucherFiles 校验通过: ${checksum.totalVoucherFiles}`);
  }
}

function validateTransactions(data) {
  data.transactions.forEach((tx, index) => {
    if (!Array.isArray(tx.voucherIds)) {
      fail(`transactions[${index}].voucherIds 不是数组`);
    }
  });
}

function validateVoucherIdsUnique(data) {
  const seen = new Set();

  data.vouchers.forEach((voucher, index) => {
    if (!voucher.legacyDriveId) {
      fail(`vouchers[${index}] 缺少 legacyDriveId`);
      return;
    }

    if (seen.has(voucher.legacyDriveId)) {
      fail(`legacyDriveId 重复: ${voucher.legacyDriveId}`);
      return;
    }

    seen.add(voucher.legacyDriveId);
  });
}

function main() {
  info(`读取文件: ${exportPath}`);

  let data;
  try {
    data = loadExportJson();
  } catch (error) {
    fail(`读取或解析 export.json 失败: ${error.message}`);
    process.exit(1);
  }

  validateTopLevel(data);
  validateCounts(data);
  validateTransactions(data);
  validateVoucherIdsUnique(data);

  if (!process.exitCode) {
    info("基础结构校验通过");
  }
}

main();
