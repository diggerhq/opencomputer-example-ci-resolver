// Billing helpers. Amounts are numbers in major currency units.

export function round2(value) {
  // Compensate for binary floating point before rounding half-up, so that
  // values such as 0.615 do not land just below the boundary.
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
