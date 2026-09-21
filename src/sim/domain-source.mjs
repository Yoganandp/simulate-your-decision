import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { array, bytesHash, cents, check, integer, keys, seededOrder, stableHash, unique } from "./domain-common.mjs";
import { SOURCE_COMMIT } from "../../scripts/fetch-data.mjs";
import { employeeGroup } from "../../web/business-insights.js";

const DATA = fileURLToPath(new URL("../../data/adventureworks/", import.meta.url));
// The pinned download manifest remains authoritative; importing never repairs or replaces a source.
export const SOURCE_HASHES = {
  "DimCustomer.csv": "548dd1ffefc1419952d777c985a6c216ce32624138ffeb2743b17b9c7964b6fc",
  "FactInternetSales.csv": "0f87171a41f56a40d7f5f6261286e3dde83c88178fff5d55a36636e6150ed3be",
  "DimProduct.csv": "8e06a201098caef67bf6e38a93042738329d9fba5dac0f3dedb3dffbdac5c4f5",
  "DimEmployee.csv": "35da8bbbba32e12f878c138178921d16f71dec9381221cf9e4b535d106a21859",
  "Vendor.csv": "075c70b53fc860bf4a562b56df027b961ac4051f0fd0b75faaa106b5dae110e3",
  "DimReseller.csv": "676cb16ab4c6855da557f776ff82b0dbac19fe634b7914663c1146b53a58145a",
};
const HASHES = SOURCE_HASHES;

function readSource(file, delimiter, sources) {
  const path = join(DATA, file);
  check(existsSync(path), `Missing sample source ${file}; run npm run setup:data`);
  check(statSync(path).size <= 64 * 1024 * 1024, `${file} exceeds the 64 MiB import bound`);
  const buffer = readFileSync(path);
  const sha256 = bytesHash(buffer);
  check(sha256 === HASHES[file], `Source checksum mismatch for ${file}; run npm run setup:data to restore pinned data`);
  const lines = buffer.toString("utf8").replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n").filter(Boolean);
  array(lines, file, 100_000, 1);
  sources.push({ file, sha256, rows: lines.length, sourceCommit: SOURCE_COMMIT });
  return lines.map((line, index) => ({ row: index + 1, fields: line.split(delimiter) }));
}

export function loadSample(seed, counts, cycles) {
  const sourceFiles = [], evidence = [];
  const customerRows = readSource("DimCustomer.csv", "|", sourceFiles);
  const saleRows = readSource("FactInternetSales.csv", "|", sourceFiles);
  const productRows = readSource("DimProduct.csv", "|", sourceFiles);
  const employees = readSource("DimEmployee.csv", "|", sourceFiles);
  const vendors = readSource("Vendor.csv", "\t", sourceFiles);
  const resellers = readSource("DimReseller.csv", "|", sourceFiles);
  const addEvidence = (file, row, entityKey, field, value, unit, sourceTimestamp, transformation = "Exact source field") => {
    const evidenceId = `e-${stableHash([file, row, field, transformation]).slice(0, 24)}`;
    if (!evidence.some(item => item.evidenceId === evidenceId)) evidence.push({
      evidenceId, sourceTable: file.replace(".csv", ""), sourceFile: file, sourceFileSha256: HASHES[file],
      row, entityKey: String(entityKey), field, value, unit, sourceTimestamp, transformation,
      quality: "sample_business_data", sourceType: "AdventureWorks_sample",
    });
    return evidenceId;
  };
  const customersByKey = new Map(customerRows.map(row => [row.fields[0], row]));
  const productsByKey = new Map(productRows.map(row => [row.fields[0], row]));
  const orders = new Map(), productSales = new Map();
  let minDate = null, maxDate = null, minDateRow = null, maxDateRow = null, validLines = 0;
  for (const row of saleRows) {
    const f = row.fields;
    check(f.length >= 24, `FactInternetSales row ${row.row} has missing columns`);
    const date = f[23].slice(0, 10);
    check(/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)), `Invalid order date at row ${row.row}`);
    if (minDate === null || date < minDate) { minDate = date; minDateRow = row.row; }
    if (maxDate === null || date > maxDate) { maxDate = date; maxDateRow = row.row; }
    const quantity = Number(f[11]);
    integer(quantity, `Source order quantity row ${row.row}`, 1, 10000);
    const amount = cents(f[18], "SalesAmount");
    const line = { productId: `product-${f[0]}`, quantity, unitPriceCents: Math.round(amount / quantity),
      unitCostCents: cents(f[16], "ProductStandardCost", true), sourceRow: row.row, sourceProductKey: f[0],
      sourceOrderId: f[8], sourceLineId: f[9], sourceCustomerId: f[4], date, amount };
    const key = `${f[4]}:${f[8]}`;
    if (!orders.has(key)) orders.set(key, { id: f[8], customerKey: f[4], date, lines: [] });
    orders.get(key).lines.push(line);
    validLines++;
    const previous = productSales.get(f[0]);
    if (!previous || previous.date < date || (previous.date === date && previous.sourceRow < row.row)) productSales.set(f[0], line);
  }
  const byCustomer = new Map();
  for (const order of orders.values()) {
    if (!customersByKey.has(order.customerKey) || order.lines.length > 12
      || order.lines.some(line => line.quantity > 20 || !productsByKey.has(line.sourceProductKey))) continue;
    if (!byCustomer.has(order.customerKey)) byCustomer.set(order.customerKey, []);
    byCustomer.get(order.customerKey).push(order);
  }
  const picked = seededOrder([...byCustomer.keys()], `${seed}:customers`, key => key).slice(0, counts.customer);
  check(picked.length > 0, "No eligible sample customers with bounded historical baskets");
  const selectedOrders = [], selectedCustomers = [];
  for (const key of picked) {
    const historical = byCustomer.get(key).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const selected = seededOrder(historical, `${seed}:${key}:orders`).slice(0, cycles);
    const row = customersByKey.get(key);
    const customerEvidence = addEvidence("DimCustomer.csv", row.row, key, "CustomerKey[0]", key, "source_id", null);
    const existingEvidence = addEvidence("DimCustomer.csv", row.row, key, "DateFirstPurchase[27]", row.fields[27], "date", row.fields[27].slice(0, 10));
    const historyEvidence = historical.flatMap(order => order.lines.map(line => line.sourceRow));
    selectedCustomers.push({ id: `customer-${key}`, sourceEntityId: `DimCustomer:${key}`, profileMode: "individual",
      label: `Sample customer record ${key}`, evidenceIds: [customerEvidence, existingEvidence],
      facts: [["givenName", "FirstName", 4], ["familyName", "LastName", 6]].map(([field, sourceField, index]) => ({
        field, value: row.fields[index], unit: "text",
        evidenceIds: [addEvidence("DimCustomer.csv", row.row, key, `${sourceField}[${index}]`, row.fields[index], "text", null)],
        assumptionIds: [],
      })),
      firstPurchaseDate: row.fields[27].slice(0, 10), historicalOrderCount: historical.length,
      historicalLineCount: historyEvidence.length, orderIds: selected.map(order => `${key}:${order.id}`) });
    for (const order of selected) {
      const lines = order.lines.map(line => {
        const references = [
          addEvidence("FactInternetSales.csv", line.sourceRow, `${line.sourceOrderId}:${line.sourceLineId}`, "SalesOrderNumber[8]", line.sourceOrderId, "order_id", line.date),
          addEvidence("FactInternetSales.csv", line.sourceRow, `${line.sourceOrderId}:${line.sourceLineId}`, "ProductKey[0]", line.sourceProductKey, "source_id", line.date),
          addEvidence("FactInternetSales.csv", line.sourceRow, `${line.sourceOrderId}:${line.sourceLineId}`, "OrderQuantity[11]", line.quantity, "units", line.date),
          addEvidence("FactInternetSales.csv", line.sourceRow, `${line.sourceOrderId}:${line.sourceLineId}`, "SalesAmount[18]", line.amount, "USD_cents", line.date, "Decimal USD to cents, half-up"),
        ];
        return { productId: line.productId, quantity: line.quantity, historicalUnitPriceCents: line.unitPriceCents, evidenceIds: references };
      });
      selectedOrders.push({ id: `${key}:${order.id}`, actorId: `customer-${key}`, sourceOrderId: order.id, date: order.date, lines });
    }
  }
  const productKeys = new Set(selectedOrders.flatMap(order => order.lines.map(line => line.productId.replace("product-", ""))));
  // Low-priced actual products are extra choices, not inferred personal preferences.
  const extras = [...productSales.values()].filter(line => productsByKey.has(line.sourceProductKey))
    .sort((a, b) => a.unitPriceCents - b.unitPriceCents || a.productId.localeCompare(b.productId)).slice(0, 4);
  extras.forEach(line => productKeys.add(line.sourceProductKey));
  check(productKeys.size <= 128, "Selected product catalog exceeds 128 products; reduce panel size");
  const products = [...productKeys].sort().map(key => {
    const sale = productSales.get(key), row = productsByKey.get(key);
    const evidenceIds = [
      addEvidence("DimProduct.csv", row.row, key, "EnglishProductName[5]", row.fields[5], "text", null),
      addEvidence("FactInternetSales.csv", sale.sourceRow, `${sale.sourceOrderId}:${sale.sourceLineId}`, "SalesAmount[18]/OrderQuantity[11]", sale.unitPriceCents, "USD_cents_per_unit", sale.date, "Historical net line amount / quantity; round half-up to cents"),
    ];
    const costEvidenceIds = [addEvidence("FactInternetSales.csv", sale.sourceRow, `${sale.sourceOrderId}:${sale.sourceLineId}`, "ProductStandardCost[16]", sale.unitCostCents, "USD_cents_per_unit", sale.date, "Historical assigned cost; decimal USD to cents, half-up")];
    return { id: sale.productId, label: row.fields[5], unitPriceCents: sale.unitPriceCents, unitCostCents: sale.unitCostCents,
      evidenceIds, costEvidenceIds, assumptionIds: ["a-historical-prices", "a-historical-costs"] };
  });
  const makeRole = (role, rows, file, idIndex, fields, selected = null) => (selected ?? seededOrder(rows, `${seed}:${role}`, row => row.fields[idIndex]).slice(0, counts[role])).map(row => {
    const key = row.fields[idIndex];
    const facts = fields.map(([field, index]) => ({ field, value: row.fields[index], unit: "text",
      evidenceIds: [addEvidence(file, row.row, key, `${field}[${index}]`, row.fields[index], "text", null)], assumptionIds: [] }));
    return { id: `${role}-${key}`, role, profileMode: "individual", label: `Sample ${role} record ${key}`,
      sourceEntityId: `${file.replace(".csv", "")}:${key}`, facts };
  });
  const currentEmployees = employees.filter(row => row.fields[29] === "Current");
  const operationalEmployees = currentEmployees.filter(row => /shipping|purchasing|production|warehouse/i.test(`${row.fields[9]} ${row.fields[26]}`));
  let selectedEmployees = null;
  if (counts.employee > 4) {
    const ordered = seededOrder(currentEmployees, `${seed}:employee`, row => row.fields[0]);
    selectedEmployees = [];
    for (const [group, requested] of [['leadership', Math.max(1, Math.round(counts.employee * 0.16))],
      ['management', Math.max(1, Math.round(counts.employee * 0.32))], ['frontline', counts.employee]]) {
      selectedEmployees.push(...ordered.filter(row => employeeGroup(row.fields[9], row.fields[26]) === group)
        .slice(0, Math.min(requested, counts.employee - selectedEmployees.length)));
    }
    const selected = new Set(selectedEmployees);
    selectedEmployees.push(...ordered.filter(row => !selected.has(row)).slice(0, counts.employee - selectedEmployees.length));
  }
  const eligibleVendors = vendors.filter(row => row.fields[5] === "1");
  const eligibleResellers = resellers.filter(row => row.fields.length > 19);
  const operational = [
    ...makeRole("employee", operationalEmployees, "DimEmployee.csv", 0, [["givenName", 5], ["familyName", 6], ["jobTitle", 9], ["department", 26]], selectedEmployees),
    ...makeRole("supplier", eligibleVendors, "Vendor.csv", 0, [["sampleVendorName", 2]]),
    ...makeRole("reseller", eligibleResellers, "DimReseller.csv", 0, [["sampleResellerName", 5], ["businessType", 4]]),
  ];
  const coverageEvidenceIds = [
    addEvidence("FactInternetSales.csv", minDateRow, "coverage", "OrderDate[23]:minimum", minDate, "date", minDate, `Minimum over source rows 1..${saleRows.length}`),
    addEvidence("FactInternetSales.csv", maxDateRow, "coverage", "OrderDate[23]:maximum", maxDate, "date", maxDate, `Maximum over source rows 1..${saleRows.length}`),
    addEvidence("FactInternetSales.csv", 1, "coverage", "OrderQuantity[11]:line_count", validLines, "order_lines", maxDate, `Count of parsed source rows 1..${saleRows.length}; not order count`),
    addEvidence("FactInternetSales.csv", 1, "coverage", "CustomerKey[4]+SalesOrderNumber[8]:distinct_count", orders.size, "orders", maxDate, `Count distinct customer/order tuples over source rows 1..${saleRows.length}`),
  ];
  return { sourceType: "AdventureWorks_sample", sourceFiles, products, customers: selectedCustomers,
    historicalOrders: selectedOrders, operational, evidence, asOf: maxDate,
    coverage: { minOrderDate: minDate, maxOrderDate: maxDate, sourceOrderLines: validLines, sourceDistinctOrders: orders.size,
      population: {
        customer: { source: customerRows.length, eligible: byCustomer.size, selected: selectedCustomers.length },
        employee: { source: employees.length, eligible: counts.employee > 4 ? currentEmployees.length : operationalEmployees.length,
          selected: operational.filter(actor => actor.role === "employee").length },
        supplier: { source: vendors.length, eligible: eligibleVendors.length, selected: operational.filter(actor => actor.role === "supplier").length },
        reseller: { source: resellers.length, eligible: eligibleResellers.length, selected: operational.filter(actor => actor.role === "reseller").length },
      },
      retainedHistoricalOrders: selectedOrders.length, retainedHistoricalLines: selectedOrders.reduce((sum, order) => sum + order.lines.length, 0),
      historicalShippingPolicy: "unknown", inventory: "assumed", fulfillmentCost: "unknown",
      freightTreatment: "Historical line Freight is not assumed to be current fulfillment cost.",
      sampleDataNotRealPeople: true, behavioralValidation: "not_performed", demographicPreferenceInference: false,
      snapshotScope: "Bounded selected histories and catalog; file hashes and full sales date coverage retained.",
      evidenceIds: coverageEvidenceIds } };
}

export function syntheticSource(counts, cycles, unitCostCents = 2000, basket = [{ productId: "product-main", quantity: 1 }]) {
  if (unitCostCents !== null) integer(unitCostCents, "synthetic unitCostCents");
  const evidence = [{
    evidenceId: "e-synthetic-fixture", sourceTable: "in_memory_arithmetic_fixture", sourceFile: null,
    sourceFileSha256: null, row: null, entityKey: "fixture", field: "fixture_definition",
    value: "Synthetic arithmetic fixture only; not behavioral or historical validation", unit: "text",
    sourceTimestamp: null, transformation: "Constructed in memory", quality: "synthetic", sourceType: "synthetic_test_fixture",
  }];
  const products = [
    { id: "product-main", label: "Synthetic $60 item", unitPriceCents: 6000, unitCostCents },
    { id: "product-extra", label: "Synthetic $18 extra item", unitPriceCents: 1800, unitCostCents: unitCostCents === null ? null : 600 },
    { id: "product-substitute", label: "Synthetic $40 alternative", unitPriceCents: 4000, unitCostCents: unitCostCents === null ? null : 1000 },
  ].map(product => ({ ...product, evidenceIds: ["e-synthetic-fixture"], costEvidenceIds: ["e-synthetic-fixture"], assumptionIds: ["a-historical-prices", "a-historical-costs"] }));
  array(basket, "synthetic basket", 12, 1); unique(basket.map(item => item.productId), "synthetic basket products");
  const lines = basket.map(item => {
    keys(item, ["productId", "quantity"], "synthetic basket item");
    const product = products.find(candidate => candidate.id === item.productId);
    check(product, "Unknown synthetic basket product");
    integer(item.quantity, "synthetic basket quantity", 1, 20);
    return { productId: item.productId, quantity: item.quantity, historicalUnitPriceCents: product.unitPriceCents, evidenceIds: ["e-synthetic-fixture"] };
  });
  check(lines.reduce((sum, line) => sum + line.quantity, 0) <= 20, "Synthetic basket exceeds 20 units");
  const customers = Array.from({ length: counts.customer }, (_, index) => ({
    id: `customer-${String(index + 1).padStart(3, "0")}`, sourceEntityId: `synthetic:${index + 1}`, profileMode: "synthetic",
    label: `Synthetic arithmetic customer ${index + 1}`, evidenceIds: ["e-synthetic-fixture"],
    firstPurchaseDate: "2020-01-01", historicalOrderCount: 1, historicalLineCount: lines.length,
    orderIds: [`fixture-order-${index + 1}`],
  }));
  const historicalOrders = customers.map((customer, index) => ({ id: customer.orderIds[0], actorId: customer.id,
    sourceOrderId: customer.orderIds[0], date: "2020-01-01",
    lines: lines.map(line => ({ ...line })) }));
  const operational = ["employee", "supplier", "reseller"].flatMap(role => Array.from({ length: counts[role] }, (_, index) => ({
    id: `${role}-${index + 1}`, role, profileMode: "synthetic", label: `Synthetic arithmetic ${role} ${index + 1}`,
    sourceEntityId: `synthetic:${role}:${index + 1}`,
    facts: [{ field: "fixtureOnly", value: true, unit: "boolean", evidenceIds: ["e-synthetic-fixture"], assumptionIds: [] }],
  })));
  return { sourceType: "synthetic_test_fixture", sourceFiles: [], products, customers, historicalOrders, operational, evidence,
    asOf: "2020-01-01", coverage: { minOrderDate: "2020-01-01", maxOrderDate: "2020-01-01",
      sourceOrderLines: counts.customer * lines.length, sourceDistinctOrders: counts.customer, retainedHistoricalOrders: counts.customer,
      retainedHistoricalLines: counts.customer * lines.length, sampleDataNotRealPeople: true, behavioralValidation: "not_performed",
      demographicPreferenceInference: false, fixtureOnly: true, evidenceIds: ["e-synthetic-fixture"] } };
}
