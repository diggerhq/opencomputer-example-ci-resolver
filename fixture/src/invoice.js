// A small billing module. Amounts are numbers in major currency units.
// The test suite fails on purpose on the fixture-ci branch; that failure is
// what the resolver fixes. Do not fix it on main.

export function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function lineTotal({ unitPrice, quantity }) {
  return round2(unitPrice * quantity);
}

export function invoiceTotal(invoice, { taxRate = 0 } = {}) {
  const subtotal = invoice.lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const tax = round2(subtotal * taxRate);
  return round2(subtotal + tax);
}
