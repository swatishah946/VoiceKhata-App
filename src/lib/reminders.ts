import { formatINRShort, type Paise } from './money';

/**
 * Payment reminders are sent from HIS OWN WhatsApp (share sheet / wa.me link),
 * so they cost nothing and the customer sees them from a number they know.
 */

/** UPI payment link with the amount filled in (opens GPay / PhonePe / Paytm). */
export function upiLink(opts: { upiId: string; payeeName: string; amountPaise: Paise; note?: string }): string {
  const params = [
    `pa=${encodeURIComponent(opts.upiId.trim())}`,
    `pn=${encodeURIComponent(opts.payeeName.trim())}`,
    `am=${(Math.max(0, opts.amountPaise) / 100).toFixed(2)}`,
    'cu=INR',
  ];
  if (opts.note) params.push(`tn=${encodeURIComponent(opts.note.slice(0, 50))}`);
  return `upi://pay?${params.join('&')}`;
}

export function isValidUpiId(id: string): boolean {
  return /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,64}$/.test(id.trim());
}

export function reminderMessage(opts: {
  partyName: string;
  amountPaise: Paise;
  businessName: string;
  upiId?: string | null;
  days?: number | null;
}): string {
  const lines = [
    `Namaste ${opts.partyName} ji,`,
    '',
    `Aapka ${formatINRShort(opts.amountPaise)} baaki hai${opts.days && opts.days > 30 ? ` (${opts.days} din se)` : ''}.`,
    'Kripya jaldi bhugtan karein. 🙏',
  ];
  if (opts.upiId && isValidUpiId(opts.upiId)) {
    // UPI links are not tappable in every WhatsApp version, so the UPI ID is written out too
    lines.push('', `UPI: ${opts.upiId.trim()}`, upiLink({
      upiId: opts.upiId,
      payeeName: opts.businessName,
      amountPaise: opts.amountPaise,
      note: `Payment ${opts.partyName}`,
    }));
  }
  lines.push('', `— ${opts.businessName}`);
  return lines.join('\n');
}

/** wa.me link to one customer's chat with the message ready (Indian 10-digit numbers get +91). */
export function whatsAppLink(phone: string | null | undefined, message: string): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  if (digits.length < 11 || digits.length > 15) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
