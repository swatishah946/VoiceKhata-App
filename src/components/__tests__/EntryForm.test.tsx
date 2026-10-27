import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { EntryForm } from '../EntryForm';
import { initialForm, toEdits, type FormValues } from '@/lib/review';
import type { EntryType } from '@/lib/types';

const AI = { transaction_type: 'dispatch', party_name: 'Siddhi Stone', sqft_quantity: 5000, unit_rate: 31.5 } as const;

/** The review form as he uses it: fields for the chosen entry type, editable, only changes sent. */
function Harness({ onEdits }: { onEdits(e: Record<string, unknown>): void }) {
  const [type, setType] = useState<EntryType>('dispatch');
  const [form, setForm] = useState<FormValues>(initialForm(AI));
  onEdits(toEdits(AI, 'dispatch', type, form));
  return (
    <EntryForm
      type={type}
      form={form}
      highlight={['unit_rate']}
      onTypeChange={setType}
      onFieldChange={(f, v) => setForm((p) => ({ ...p, [f]: v }))}
    />
  );
}

describe('EntryForm', () => {
  it('shows the dispatch fields pre-filled, in Hindi by default', async () => {
    await render(<Harness onEdits={() => undefined} />);
    expect(screen.getByLabelText('पार्टी').props.value).toBe('Siddhi Stone');
    expect(screen.getByLabelText('रेट (₹/sqft)').props.value).toBe('31.5');
    expect(screen.queryByLabelText('रकम (₹)')).toBeNull(); // amount is not a dispatch field
  });

  it('editing a number produces exactly that one change', async () => {
    let edits: Record<string, unknown> = {};
    await render(<Harness onEdits={(e) => (edits = e)} />);
    await fireEvent.changeText(screen.getByLabelText('रेट (₹/sqft)'), '32');
    expect(edits).toEqual({ unit_rate: 32 });
  });

  it('switching to "payment" shows the amount field instead of sqft/rate', async () => {
    let edits: Record<string, unknown> = {};
    await render(<Harness onEdits={(e) => (edits = e)} />);
    await fireEvent.press(screen.getByTestId('type-payment'));
    expect(screen.queryByLabelText('स्क्वायर फुट')).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('रकम (₹)'), '5,000');
    expect(edits).toEqual({ transaction_type: 'payment', amount: 5000 });
  });
});
