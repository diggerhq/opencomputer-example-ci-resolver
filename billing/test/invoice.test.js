import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceTotal, lineTotal } from "../src/invoice.js";

test("lineTotal multiplies price by quantity", () => {
  assert.equal(lineTotal({ unitPrice: 2.5, quantity: 4 }), 10);
});

test("invoiceTotal sums lines without tax", () => {
  const invoice = {
    lines: [
      { unitPrice: 2.5, quantity: 4 },
      { unitPrice: 10, quantity: 1 },
    ],
  };
  assert.equal(invoiceTotal(invoice), 20);
});

test("invoiceTotal applies a 20% tax rate", () => {
  const invoice = { lines: [{ unitPrice: 100, quantity: 1 }] };
  assert.equal(invoiceTotal(invoice, { taxRate: 0.2 }), 120);
});

test("invoiceTotal rounds tax half-up (8.20 at 7.5% is 8.82)", () => {
  const invoice = { lines: [{ unitPrice: 8.2, quantity: 1 }] };
  assert.equal(invoiceTotal(invoice, { taxRate: 0.075 }), 8.82);
});
