import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import PDFKitDocument from 'pdfkit';
import { PDFDocument as PDFLibDocument } from 'pdf-lib';

const COLORS = {
  ink: '#111111',
  muted: '#667085',
  line: '#DDE1E8',
  panel: '#F7F8FA',
  brand: '#2563EB',
  brandSoft: '#EFF6FF',
  amber: '#F5A800',
  success: '#15803D',
  danger: '#BE123C',
  white: '#FFFFFF',
};

const PAGE = { width: 595.276, height: 841.89, left: 46, right: 520 };
const LETTERHEAD_PATH = fileURLToPath(
  new URL('../../../assets/Cenciss-Letterhead.pdf', import.meta.url),
);

const dateText = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.BILLING_TIMEZONE || 'Asia/Karachi',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
};

const money = (value, currency = 'PKR') => `${currency} ${Number(value || 0).toLocaleString('en-PK', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;

const createOverlayBuffer = (build) => new Promise((resolve, reject) => {
  const doc = new PDFKitDocument({ size: 'A4', margin: 0, info: { Creator: 'Cenciss Billing' } });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
  build(doc);
  doc.end();
});

const loadLetterhead = async () => {
  try {
    return await fs.readFile(LETTERHEAD_PATH);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Bundled Cenciss letterhead is missing from backend/assets.');
    }
    throw error;
  }
};

const mergeWithLetterhead = async (overlayBytes, title) => {
  const [letterheadBytes] = await Promise.all([loadLetterhead()]);
  const [letterhead, output] = await Promise.all([
    PDFLibDocument.load(letterheadBytes),
    PDFLibDocument.create(),
  ]);
  if (letterhead.getPageCount() < 1) throw new Error('Cenciss letterhead PDF has no pages.');

  const [page] = await output.copyPages(letterhead, [0]);
  output.addPage(page);
  const [overlay] = await output.embedPdf(overlayBytes, [0]);
  page.drawPage(overlay, { x: 0, y: 0, width: PAGE.width, height: PAGE.height });
  output.setTitle(title);
  output.setAuthor('Cenciss');
  output.setCreator('Cenciss Billing');
  output.setProducer('Cenciss Billing');
  return Buffer.from(await output.save());
};

const horizontalRule = (doc, y) => {
  doc.save().moveTo(PAGE.left, y).lineTo(PAGE.right, y).lineWidth(0.8).strokeColor(COLORS.line).stroke().restore();
};

const statusBadge = (doc, status, y = 218) => {
  const label = String(status || 'issued').toUpperCase();
  const color = label === 'PAID' ? COLORS.success : label === 'OVERDUE' || label === 'VOID' ? COLORS.danger : COLORS.brand;
  doc.roundedRect(442, y, 78, 23, 11.5).fill(color);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(8).text(label, 442, y + 7.5, { width: 78, align: 'center', lineBreak: false });
};

const labelValue = (doc, label, value, x, y, width = 150, align = 'left') => {
  doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7).text(label.toUpperCase(), x, y, { width, align, lineBreak: false });
  doc.fillColor(COLORS.ink).font('Helvetica').fontSize(9).text(value || '-', x, y + 12, { width, align, lineBreak: false, ellipsis: true });
};

const drawTitle = (doc, title, number, status) => {
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(22).text(title, PAGE.left, 214, { width: 330, lineBreak: false });
  doc.fillColor(COLORS.brand).font('Helvetica-Bold').fontSize(8.5).text(number || '-', PAGE.left, 242, { width: 330, lineBreak: false });
  statusBadge(doc, status);
  horizontalRule(doc, 263);
};

const drawBankDetails = (doc, bank, x, y, width, height) => {
  doc.roundedRect(x, y, width, height, 9).fill(COLORS.panel);
  doc.fillColor(COLORS.brand).font('Helvetica-Bold').fontSize(8).text('BANK DETAILS', x + 12, y + 12, { width: width - 24 });
  if (bank?.active !== true) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8).text('Banking information is available from Cenciss support.', x + 12, y + 31, { width: width - 24 });
    return;
  }
  const rows = [
    ['Bank', bank.bankName],
    ['Account title', bank.accountTitle],
    ['Account number', bank.accountNumber],
    ['IBAN', bank.iban],
    ['Branch', [bank.branchName, bank.branchCode].filter(Boolean).join(' - ')],
    ['SWIFT/BIC', bank.swiftCode],
  ].filter(([, value]) => value);
  let rowY = y + 30;
  for (const [label, value] of rows) {
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(6.6).text(`${label}:`, x + 12, rowY, { width: 70, lineBreak: false });
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7.5).text(value, x + 82, rowY, { width: width - 94, lineBreak: false, ellipsis: true });
    rowY += 14;
  }
};

const drawInvoiceOverlay = (doc, invoice) => {
  drawTitle(doc, 'Subscription Invoice', invoice.invoiceNumber, invoice.status);

  doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7).text('BILL TO', PAGE.left, 279);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(11).text(invoice.restaurantName, PAGE.left, 294, { width: 250, lineBreak: false, ellipsis: true });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8.5).text(invoice.ownerName || '', PAGE.left, 311, { width: 250, lineBreak: false, ellipsis: true });
  doc.text(invoice.billingEmail || invoice.ownerEmail, PAGE.left, 325, { width: 250, lineBreak: false, ellipsis: true });

  labelValue(doc, 'Issue date', dateText(invoice.issueDate), 319, 279, 93, 'right');
  labelValue(doc, 'Due date', dateText(invoice.dueDate), 427, 279, 93, 'right');
  labelValue(doc, 'Current access ends', dateText(invoice.accessUntilBefore), 319, 315, 93, 'right');
  labelValue(doc, 'Projected access', dateText(invoice.projectedAccessUntil), 427, 315, 93, 'right');

  const tableY = 360;
  doc.roundedRect(PAGE.left, tableY, PAGE.right - PAGE.left, 27, 6).fill(COLORS.ink);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(7.2)
    .text('DESCRIPTION', 57, tableY + 9.5, { width: 235, lineBreak: false })
    .text('QTY', 304, tableY + 9.5, { width: 34, align: 'right', lineBreak: false })
    .text('UNIT PRICE', 350, tableY + 9.5, { width: 75, align: 'right', lineBreak: false })
    .text('AMOUNT', 437, tableY + 9.5, { width: 72, align: 'right', lineBreak: false });

  let rowY = tableY + 39;
  for (const item of (invoice.lineItems || []).slice(0, 3)) {
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(8.3).text(item.description, 57, rowY, { width: 235, lineBreak: false, ellipsis: true });
    doc.text(String(item.quantity || 0), 304, rowY, { width: 34, align: 'right', lineBreak: false });
    doc.text(money(item.unitPrice, invoice.currency), 344, rowY, { width: 81, align: 'right', lineBreak: false });
    doc.font('Helvetica-Bold').text(money(item.amount, invoice.currency), 430, rowY, { width: 79, align: 'right', lineBreak: false });
    rowY += 25;
    horizontalRule(doc, rowY - 7);
  }

  const totalsY = Math.max(443, rowY + 5);
  const totalLine = (label, value, y, bold = false) => {
    doc.fillColor(COLORS.muted).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 9 : 8).text(label, 349, y, { width: 72, lineBreak: false });
    doc.fillColor(COLORS.ink).font(bold ? 'Helvetica-Bold' : 'Helvetica').text(value, 421, y, { width: 99, align: 'right', lineBreak: false });
  };
  totalLine('Subtotal', money(invoice.subtotal, invoice.currency), totalsY);
  totalLine('Discount', money(invoice.discountAmount, invoice.currency), totalsY + 17);
  totalLine(`Tax (${Number(invoice.taxRate || 0).toFixed(2)}%)`, money(invoice.taxAmount, invoice.currency), totalsY + 34);
  doc.roundedRect(349, totalsY + 54, 171, 32, 7).fill(COLORS.brandSoft);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(9.5).text('Total', 359, totalsY + 65, { width: 52, lineBreak: false });
  doc.fillColor(COLORS.brand).text(money(invoice.total, invoice.currency), 411, totalsY + 65, { width: 99, align: 'right', lineBreak: false });

  const detailY = Math.max(546, totalsY + 104);
  drawBankDetails(doc, invoice.bankDetails, PAGE.left, detailY, 295, 126);
  doc.roundedRect(351, detailY, 169, 126, 9).fill(COLORS.panel);
  doc.fillColor(COLORS.amber).font('Helvetica-Bold').fontSize(8).text('PAYMENT NOTES', 363, detailY + 12, { width: 145 });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.6).text(
    invoice.paymentInstructions || invoice.bankDetails?.paymentNotes || 'Please use the invoice number as your payment reference.',
    363,
    detailY + 31,
    { width: 145, height: 76, ellipsis: true },
  );
  if (invoice.status === 'paid') {
    doc.fillColor(COLORS.success).font('Helvetica-Bold').fontSize(7.5).text(`Paid ${dateText(invoice.paidAt)}`, 363, detailY + 103, { width: 145, align: 'right', lineBreak: false });
  }
};

const drawReceiptOverlay = (doc, invoice) => {
  drawTitle(doc, 'Payment Receipt', invoice.receiptNumber || '-', 'paid');

  doc.roundedRect(PAGE.left, 282, PAGE.right - PAGE.left, 72, 11).fill(COLORS.brandSoft);
  doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7.5).text('PAYMENT RECEIVED', 61, 299, { width: 220, lineBreak: false });
  doc.fillColor(COLORS.brand).font('Helvetica-Bold').fontSize(23).text(money(invoice.amountPaid, invoice.currency), 61, 316, { width: 260, lineBreak: false });
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(9.5).text(invoice.restaurantName, 330, 301, { width: 175, align: 'right', lineBreak: false, ellipsis: true });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5).text(invoice.billingEmail || invoice.ownerEmail, 330, 320, { width: 175, align: 'right', lineBreak: false, ellipsis: true });

  labelValue(doc, 'Receipt number', invoice.receiptNumber, 61, 384, 200);
  labelValue(doc, 'Invoice number', invoice.invoiceNumber, 320, 384, 200);
  labelValue(doc, 'Payment date', dateText(invoice.paidAt), 61, 430, 200);
  labelValue(doc, 'Payment method', invoice.paymentMethod || 'Manual payment', 320, 430, 200);
  labelValue(doc, 'Payment reference', invoice.paymentReference || '-', 61, 476, 200);
  labelValue(doc, 'Access extended until', dateText(invoice.accessGrantedUntil), 320, 476, 200);

  horizontalRule(doc, 525);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(9).text('Payment allocation', PAGE.left, 546, { width: 200, lineBreak: false });
  doc.roundedRect(PAGE.left, 567, PAGE.right - PAGE.left, 48, 8).fill(COLORS.panel);
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8.5).text(`Invoice ${invoice.invoiceNumber}`, 59, 584, { width: 230, lineBreak: false });
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').text(money(invoice.amountPaid, invoice.currency), 335, 584, { width: 170, align: 'right', lineBreak: false });

  doc.roundedRect(320, 636, 200, 38, 8).fill('#ECFDF3');
  doc.fillColor(COLORS.success).font('Helvetica-Bold').fontSize(8.5).text('Balance remaining', 332, 650, { width: 95, lineBreak: false });
  doc.text(money(invoice.balance, invoice.currency), 425, 650, { width: 83, align: 'right', lineBreak: false });
  if (invoice.paymentNotes) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5).text(`Notes: ${invoice.paymentNotes}`, PAGE.left, 645, { width: 255, height: 35, ellipsis: true });
  }
};

export const generateInvoicePdf = async (invoice) => {
  const overlay = await createOverlayBuffer((doc) => drawInvoiceOverlay(doc, invoice));
  return mergeWithLetterhead(overlay, `${invoice.invoiceNumber} - Subscription Invoice`);
};

export const generateReceiptPdf = async (invoice) => {
  const overlay = await createOverlayBuffer((doc) => drawReceiptOverlay(doc, invoice));
  return mergeWithLetterhead(overlay, `${invoice.receiptNumber || 'Receipt'} - Payment Receipt`);
};

export default { generateInvoicePdf, generateReceiptPdf };
