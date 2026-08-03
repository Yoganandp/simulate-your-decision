// Download the exact public AdventureWorks files used by Decision Studio.
// Sources are pinned to a Microsoft sql-server-samples commit and SHA-256 verified.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data", "adventureworks");
export const SOURCE_COMMIT = "1ab31bc560415b570d57bb5ff9896f4698891321";
const REPO_RAW = `https://raw.githubusercontent.com/microsoft/sql-server-samples/${SOURCE_COMMIT}/samples/databases/adventure-works`;

const FILES = [
  ["data-warehouse-install-script", "DimCustomer.csv", "548dd1ffefc1419952d777c985a6c216ce32624138ffeb2743b17b9c7964b6fc"],
  ["data-warehouse-install-script", "DimGeography.csv", "65dc2a96a63619a187215290941c19165b0a62541cd545428e169b805fbad685"],
  ["data-warehouse-install-script", "FactInternetSales.csv", "0f87171a41f56a40d7f5f6261286e3dde83c88178fff5d55a36636e6150ed3be"],
  ["data-warehouse-install-script", "DimProduct.csv", "8e06a201098caef67bf6e38a93042738329d9fba5dac0f3dedb3dffbdac5c4f5"],
  ["data-warehouse-install-script", "DimProductSubcategory.csv", "4496a2e75fc0279f80acb8b68a8a4e68f88b24271973f4a457e30e1a96cc1f90"],
  ["data-warehouse-install-script", "DimProductCategory.csv", "1caaa9b3d7fcc7f238b1216115a502caaad5b9ca9ca035df098db515393c069d"],
  ["data-warehouse-install-script", "DimEmployee.csv", "35da8bbbba32e12f878c138178921d16f71dec9381221cf9e4b535d106a21859"],
  ["data-warehouse-install-script", "DimReseller.csv", "676cb16ab4c6855da557f776ff82b0dbac19fe634b7914663c1146b53a58145a"],
  ["data-warehouse-install-script", "DimSalesTerritory.csv", "24945e074b1eb4d76a3c4e8eb750f12e13eccd20f504ed52951c85dd8e3c1c64"],
  ["oltp-install-script", "Vendor.csv", "075c70b53fc860bf4a562b56df027b961ac4051f0fd0b75faaa106b5dae110e3"],
  ["oltp-install-script", "PurchaseOrderHeader.csv", "fd3b6d356238c5adc938e427fd5c523ee9e405fba1343852dfba85a0a888113c"],
];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

export async function fetchData() {
  mkdirSync(DATA_DIR, { recursive: true });
  console.log(`Downloading AdventureWorks from public commit ${SOURCE_COMMIT.slice(0, 12)}...`);
  for (const [directory, file, expectedHash] of FILES) {
    const destination = join(DATA_DIR, file);
    if (existsSync(destination) && sha256(readFileSync(destination)) === expectedHash) {
      console.log(`  = ${file} (verified)`);
      continue;
    }
    const response = await fetch(`${REPO_RAW}/${directory}/${file}`);
    if (!response.ok) throw new Error(`Could not download ${file}: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const actualHash = sha256(buffer);
    if (actualHash !== expectedHash) {
      throw new Error(`Checksum mismatch for ${file}: expected ${expectedHash}, got ${actualHash}`);
    }
    writeFileSync(destination, buffer);
    console.log(`  + ${file} (${(buffer.length / 1024 / 1024).toFixed(1)} MB, verified)`);
  }
  console.log(`Dataset ready in ${DATA_DIR}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fetchData().catch((error) => { console.error(error.message); process.exit(1); });
}
