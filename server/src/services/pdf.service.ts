import PDFDocument from 'pdfkit';
import path from 'path';
import pool from '../db';
import { formatINR, toPaise } from '../lib/money';
import { formatDateIST, formatDateTimeIST } from '../lib/time';

/**
 * PDF generation (price list + khata statement).
 *
 *  - built in memory and returned as a Buffer (nothing written to disk);
 *  - embeds DejaVu Sans, because PDFKit's built-in Helvetica cannot draw "₹";
 *  - dates are shown in IST;
 *  - the khata shows a running balance and stone/sqft details, and long
 *    ledgers continue on new pages.
 */

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const REGULAR = path.join(FONT_DIR, 'DejaVuSans.ttf');
const BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

function newDoc() {
  const doc = new PDFDocument({ margin: 50, size: 'A4', info: { Title: 'VoiceKhata', Producer: 'VoiceKhata' } });
  doc.registerFont('regular', REGULAR);
  doc.registerFont('bold', BOLD);
  doc.font('regular');
  return doc;
}

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

async function businessName(orgId: string): Promise<string> {
  const r = await pool.query(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
  const name: string | undefined = r.rows[0]?.name;
  return !name || name === 'VoiceKhata Admin' ? 'VoiceKhata Stone Traders' : name;
}

function header(doc: PDFKit.PDFDocument, title: string, subtitle: string) {
  doc.font('bold').fontSize(22).fillColor('#0f172a').text(title, { align: 'center' });
  doc.moveDown(0.3);
  doc.font('regular').fontSize(12).fillColor('#475569').text(subtitle, { align: 'center' });
  doc.fontSize(9).text(`Generated: ${formatDateTimeIST(new Date())} IST`, { align: 'center' });
  doc.moveDown(1.5);
  doc.fillColor('black');
}

/** Draws one table row; adds a page (and repeats the header row) when needed. */
function row(
  doc: PDFKit.PDFDocument,
  cols: Array<{ x: number; w: number; text: string; align?: 'left' | 'right' }>,
  opts: { bold?: boolean; shade?: boolean; repeatHeader?: () => void } = {}
) {
  const bottom = doc.page.height - doc.page.margins.bottom - 30;
  if (doc.y > bottom) {
    doc.addPage();
    opts.repeatHeader?.();
  }
  const y = doc.y;
  if (opts.shade) doc.rect(45, y - 4, 505, 18).fill('#f1f5f9').fillColor('black');
  doc.font(opts.bold ? 'bold' : 'regular').fontSize(opts.bold ? 10 : 9.5);
  for (const c of cols) doc.text(c.text, c.x, y, { width: c.w, align: c.align || 'left', lineBreak: false });
  doc.x = 50;
  doc.y = y + 18;
}

export async function generatePricingPdf(orgId: string): Promise<Buffer> {
  const { rows } = await pool.query(
    `SELECT size_format, finish, current_price FROM stone_types
      WHERE organization_id = $1 AND is_active = TRUE ORDER BY size_format ASC`,
    [orgId]
  );
  const doc = newDoc();
  header(doc, await businessName(orgId), 'Official Price List (per sq.ft.)');

  const cols = (a: string, b: string, c: string) => [
    { x: 55, w: 220, text: a },
    { x: 280, w: 120, text: b },
    { x: 400, w: 140, text: c, align: 'right' as const },
  ];
  const head = () => row(doc, cols('Stone Size', 'Finish', 'Rate / sq.ft.'), { bold: true });
  head();
  rows.forEach((r, i) =>
    row(doc, cols(r.size_format, r.finish || '-', formatINR(toPaise(r.current_price))), { shade: i % 2 === 0, repeatHeader: head })
  );
  if (!rows.length) doc.text('No prices set yet.', 55);

  doc.moveDown(2).fontSize(9).fillColor('#64748b').text('Rates are subject to change. Thank you for your business.', 50, doc.y, {
    align: 'center',
    width: 495,
  });
  return toBuffer(doc);
}

export async function generateKhataPdf(
  orgId: string,
  person: { id: string; type: 'party' | 'worker'; name: string }
): Promise<Buffer> {
  const column = person.type === 'party' ? 'party_id' : 'worker_id';
  const { rows } = await pool.query(
    `SELECT created_at, confirmed_at, transaction_type, stone_type_text, sqft_quantity, unit_rate,
            total_amount, advance_paid, outstanding_balance, ref_code
       FROM transactions
      WHERE organization_id = $1 AND ${column} = $2 AND status = 'confirmed'
      ORDER BY COALESCE(confirmed_at, created_at) ASC`,
    [orgId, person.id]
  );

  const doc = newDoc();
  header(doc, await businessName(orgId), `Khata Statement — ${person.name}`);

  const cols = (d: string, desc: string, debit: string, credit: string, bal: string) => [
    { x: 50, w: 70, text: d },
    { x: 122, w: 190, text: desc },
    { x: 312, w: 75, text: debit, align: 'right' as const },
    { x: 390, w: 75, text: credit, align: 'right' as const },
    { x: 468, w: 80, text: bal, align: 'right' as const },
  ];
  const head = () => row(doc, cols('Date', 'Details', 'Bill', 'Paid / Adv', 'Balance'), { bold: true });
  head();

  let running = 0;
  rows.forEach((t, i) => {
    const bill = Math.max(toPaise(t.total_amount), 0);
    const paid = toPaise(t.advance_paid);
    // Worker ledger: an advance increases what the worker owes us
    running += person.type === 'party' ? toPaise(t.outstanding_balance) : paid;
    const desc =
      t.transaction_type === 'dispatch'
        ? `Dispatch ${t.stone_type_text || ''}${t.sqft_quantity ? ` · ${Number(t.sqft_quantity)} sqft @ ₹${Number(t.unit_rate)}` : ''}`
        : t.transaction_type === 'payment'
          ? 'Payment received'
          : t.transaction_type === 'worker_advance'
            ? 'Advance given'
            : t.transaction_type.replace('_', ' ');
    row(
      doc,
      cols(
        formatDateIST(t.confirmed_at || t.created_at),
        desc.trim(),
        bill ? formatINR(bill) : '',
        paid ? formatINR(paid) : '',
        formatINR(running)
      ),
      { shade: i % 2 === 0, repeatHeader: head }
    );
  });
  if (!rows.length) doc.text('No confirmed entries yet.', 55);

  doc.moveDown(1.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#94a3b8');
  doc.moveDown(0.8);
  const label = person.type === 'party' ? 'Outstanding (customer owes us):' : 'Advance outstanding (worker owes us):';
  doc.font('bold').fontSize(13).fillColor(running > 0 ? '#b91c1c' : '#15803d');
  doc.text(`${label}  ${formatINR(running)}`, 50, doc.y, { width: 495, align: 'right' });
  return toBuffer(doc);
}
