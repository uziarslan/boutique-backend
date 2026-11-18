import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('undici', () => ({
  fetch: vi.fn(),
  ProxyAgent: class ProxyAgent {
    constructor(uri) { this.uri = uri; }
  },
}));

const transaction = {
  transactionNumber: 'TXN-20260902-001',
  createdAt: new Date('2026-09-02T06:00:00.000Z'),
  paymentMethod: 'split-bill',
  subtotal: 300,
  taxAmount: 48,
  serviceChargeAmount: 30,
  deliveryChargeAmount: 10,
  discountAmount: 30,
  pointsRedeemedValue: 10,
  totalAmount: 348,
  items: [
    { menuItem: 'item-1', name: 'Burger', qty: 1, lineTotal: 100, taxRate: 16, taxAmount: 16 },
    { menuItem: 'item-2', name: 'Pizza', qty: 2, lineTotal: 200, taxRate: 16, taxAmount: 32 },
  ],
};

afterEach(() => {
  delete process.env.PRA_SANDBOX_TOKEN;
});

describe('PRA eIMS payload', () => {
  it('preserves PRA invoice numbers larger than JavaScript safe integers', async () => {
    const { parsePraResponse } = await import('./pra.service.js');
    const parsed = parsePraResponse('{"InvoiceNumber":90000520191112000369,"Response":"Invoice received successfully","Code":"100"}');
    expect(parsed.invoiceNumber).toBe('90000520191112000369');
  });

  it('matches invoice/item totals after allocating charges and discounts', async () => {
    const { buildPraInvoicePayload } = await import('./pra.service.js');
    const payload = buildPraInvoicePayload(
      transaction,
      { mode: 'sandbox', sandboxPosId: 123456, defaultPctCode: '98010000' },
      { 'item-1': { itemCode: 'BURGER-1' } },
    );

    expect(payload).toMatchObject({
      InvoiceNumber: '',
      POSID: 123456,
      USIN: 'TXN-20260902-001',
      RefUSIN: null,
      TotalSaleValue: 340,
      TotalTaxCharged: 48,
      Discount: 40,
      TotalBillAmount: 348,
      TotalQuantity: 3,
      PaymentMode: 5,
      InvoiceType: 1,
    });
    expect(payload.Items[0]).toMatchObject({
      ItemCode: 'BURGER-1', PCTCode: '98010000', InvoiceType: 1, RefUSIN: null,
    });
    expect(payload.Items.reduce((sum, item) => sum + item.TotalAmount, 0)).toBe(348);
  });

  it('uses the fiscal classification snapshotted on the sale item', async () => {
    const { buildPraInvoicePayload } = await import('./pra.service.js');
    const payload = buildPraInvoicePayload(
      {
        ...transaction,
        items: transaction.items.map((item, index) => ({
          ...item,
          pra: { itemCode: `SAVED-${index + 1}`, pctCode: '98010001' },
        })),
      },
      { mode: 'sandbox', sandboxPosId: 123456, defaultPctCode: '98010000' },
      { 'item-1': { itemCode: 'CHANGED', pctCode: '99999999' } },
    );

    expect(payload.Items[0]).toMatchObject({ ItemCode: 'SAVED-1', PCTCode: '98010001' });
  });

  it('builds a credit invoice against the original business USIN', async () => {
    const { buildPraInvoicePayload } = await import('./pra.service.js');
    const payload = buildPraInvoicePayload(
      {
        ...transaction,
        pra: {
          usin: 'TXN-20260902-001',
          credit: { usin: 'TXN-20260902-001-CR' },
        },
      },
      { mode: 'production', productionPosId: 654321, defaultPctCode: '98010000' },
      {},
      { invoiceType: 3 },
    );

    expect(payload).toMatchObject({
      POSID: 654321,
      USIN: 'TXN-20260902-001-CR',
      RefUSIN: 'TXN-20260902-001',
      InvoiceType: 3,
    });
    expect(payload.Items.every((item) => item.InvoiceType === 3 && item.RefUSIN === payload.RefUSIN)).toBe(true);
  });

  it('keeps a credit invoice in the original sale environment', async () => {
    const { initialPraCreditState } = await import('./pra.service.js');
    const credit = initialPraCreditState(
      { transactionNumber: 'TXN-1', pra: { status: 'reported', invoiceNumber: 'PRA-1', mode: 'sandbox' } },
      { mode: 'production' },
    );
    expect(credit).toMatchObject({ status: 'pending', mode: 'sandbox', refUsin: 'TXN-1' });
  });

  it('requires a PCT code before a sale can be posted', async () => {
    const { buildPraInvoicePayload } = await import('./pra.service.js');
    expect(() => buildPraInvoicePayload(
      transaction,
      { mode: 'sandbox', sandboxPosId: 123456 },
      {},
    )).toThrow('PRA PCT code is missing');
  });
});
