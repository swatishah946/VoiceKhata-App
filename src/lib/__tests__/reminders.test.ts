import { isValidUpiId, reminderMessage, upiLink, whatsAppLink } from '../reminders';

describe('payment reminders', () => {
  it('builds a UPI link with the amount filled in', () => {
    expect(upiLink({ upiId: 'papa@okaxis', payeeName: 'Shah Stones', amountPaise: 4_500_050, note: 'Payment Ramesh' })).toBe(
      'upi://pay?pa=papa%40okaxis&pn=Shah%20Stones&am=45000.50&cu=INR&tn=Payment%20Ramesh'
    );
  });

  it('validates UPI IDs', () => {
    expect(isValidUpiId('papa@okaxis')).toBe(true);
    expect(isValidUpiId('9876543210@ybl')).toBe(true);
    expect(isValidUpiId('papa')).toBe(false);
    expect(isValidUpiId('papa@')).toBe(false);
    expect(isValidUpiId('a b@okaxis')).toBe(false);
  });

  it('writes a polite Hinglish reminder, with the UPI ID spelled out and the link', () => {
    const m = reminderMessage({ partyName: 'Ramesh', amountPaise: 4_500_000, businessName: 'Shah Stones', upiId: 'papa@okaxis', days: 75 });
    expect(m).toContain('Namaste Ramesh ji');
    expect(m).toContain('₹45,000 baaki hai (75 din se)');
    expect(m).toContain('UPI: papa@okaxis');
    expect(m).toContain('upi://pay?pa=papa%40okaxis');
    expect(m.trim().endsWith('— Shah Stones')).toBe(true);
  });

  it('leaves out the payment part when no valid UPI ID is set, and the age when it is recent', () => {
    const m = reminderMessage({ partyName: 'Ramesh', amountPaise: 100_000, businessName: 'Shah Stones', upiId: 'oops', days: 10 });
    expect(m).not.toContain('UPI');
    expect(m).not.toContain('din se');
  });

  it('opens the customer’s WhatsApp chat when we have their number', () => {
    expect(whatsAppLink('98765 43210', 'hi there')).toBe('https://wa.me/919876543210?text=hi%20there');
    expect(whatsAppLink('+91 98765-43210', 'x')).toBe('https://wa.me/919876543210?text=x');
    expect(whatsAppLink(null, 'x')).toBeNull();
    expect(whatsAppLink('12345', 'x')).toBeNull();
  });
});
