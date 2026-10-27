import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { storage } from './storage';
import type { EntryType, FieldKey } from './types';

/** Hindi first (the people using it think in Hindi), English available in Settings. */
export type Lang = 'hi' | 'en';

const en = {
  appName: 'VoiceKhata',
  login: 'Log in',
  phone: 'Mobile number',
  pin: 'PIN',
  loginHelp: 'Ask the owner to set your PIN.',
  wrongLogin: 'Wrong mobile number or PIN',
  tooManyTries: 'Too many tries. Wait 15 minutes.',
  offline: 'No internet',
  offlineSaved: 'No internet — recording saved, it will be sent automatically.',
  serverSlow: 'Server is starting, please wait…',
  home: 'Home',
  khata: 'Khata',
  reminders: 'Reminders',
  settings: 'Settings',
  tapToSpeak: 'Tap and speak',
  tapToStop: 'Tap to stop',
  recording: 'Recording…',
  micDenied: 'Microphone permission is needed to record.',
  speakExample: 'Example: "Siddhi Stone ko 5000 sqft 2x1½ bheja, rate 31.5"',
  today: 'Today',
  dispatched: 'Dispatched',
  received: 'Received',
  marketDue: 'Total due',
  toReview: 'Check and save',
  sending: 'Waiting for internet',
  processing: 'Understanding…',
  rejected: 'Could not understand',
  failed: 'Server problem',
  saved: 'Saved',
  cancelled: 'Cancelled',
  tryAgain: 'Try again',
  dismiss: 'Remove',
  recentEntries: 'Recent recordings',
  nothingYet: 'No recordings yet. Tap the mic to add an entry.',
  review: 'Check entry',
  save: 'Save to khata',
  cancelEntry: 'Discard',
  heard: 'Heard',
  newParty: 'New party — will be created',
  priceWarning: 'Rate is {pct}% different from price list (₹{master})',
  lowConfidence: 'Not fully sure — please check every number',
  total: 'Total',
  estimate: 'Total (estimate)',
  required: 'Fill: {fields}',
  invalidNumber: 'Check the numbers: {fields}',
  savedOk: 'Saved ✅',
  alreadyDone: 'This entry was already saved or discarded.',
  searchParty: 'Search party',
  balance: 'Balance',
  due: 'Due',
  advance: 'Advance',
  sharePdf: 'Share khata PDF',
  sendReminder: 'Send reminder',
  noParties: 'No parties yet.',
  entries: 'Entries',
  lastUpdated: 'Offline copy from {time}',
  overdue: 'Overdue',
  days: '{n} days',
  noDues: 'Nobody owes money. 🎉',
  upiId: 'Your UPI ID (for payment links)',
  upiInvalid: 'UPI ID looks wrong (example: name@okaxis)',
  language: 'Language',
  logout: 'Log out',
  business: 'Business',
  you: 'You',
  version: 'App version',
  priceList: 'Share price list',
  reason_missing_fields: 'Some details were missing: {fields}. Please record again.',
  reason_not_understood: 'Could not understand the recording. Please speak again clearly.',
  reason_not_an_entry: 'This was not an entry. Use the Khata tab to see balances.',
  reason_too_long: 'Recording too long.',
  reason_server_error: 'Server problem. Tap "Try again".',
  reason_other: 'Could not make an entry. Please record again.',
};

type Dict = typeof en;

const hi: Dict = {
  appName: 'वॉइस खाता',
  login: 'लॉग इन',
  phone: 'मोबाइल नंबर',
  pin: 'पिन',
  loginHelp: 'पिन मालिक से सेट करवाएं।',
  wrongLogin: 'मोबाइल नंबर या पिन गलत है',
  tooManyTries: 'बहुत बार गलत हुआ। 15 मिनट रुकें।',
  offline: 'इंटरनेट नहीं है',
  offlineSaved: 'इंटरनेट नहीं है — रिकॉर्डिंग सेव है, नेट आते ही अपने आप जाएगी।',
  serverSlow: 'सर्वर चालू हो रहा है, रुकिए…',
  home: 'होम',
  khata: 'खाता',
  reminders: 'वसूली',
  settings: 'सेटिंग',
  tapToSpeak: 'दबाएं और बोलें',
  tapToStop: 'रोकने के लिए दबाएं',
  recording: 'रिकॉर्ड हो रहा है…',
  micDenied: 'रिकॉर्ड करने के लिए माइक की अनुमति दें।',
  speakExample: 'जैसे: "सिद्धि स्टोन को 5000 sqft 2x1½ भेजा, रेट 31.5"',
  today: 'आज',
  dispatched: 'माल गया',
  received: 'पैसे आए',
  marketDue: 'कुल बाकी',
  toReview: 'जांचें और सेव करें',
  sending: 'नेट का इंतज़ार',
  processing: 'समझ रहे हैं…',
  rejected: 'समझ नहीं आया',
  failed: 'सर्वर में दिक्कत',
  saved: 'सेव हो गया',
  cancelled: 'रद्द',
  tryAgain: 'फिर से भेजें',
  dismiss: 'हटाएं',
  recentEntries: 'हाल की रिकॉर्डिंग',
  nothingYet: 'अभी कोई रिकॉर्डिंग नहीं। एंट्री के लिए माइक दबाएं।',
  review: 'एंट्री जांचें',
  save: 'खाते में सेव करें',
  cancelEntry: 'रद्द करें',
  heard: 'सुना गया',
  newParty: 'नई पार्टी — बन जाएगी',
  priceWarning: 'रेट प्राइस लिस्ट (₹{master}) से {pct}% अलग है',
  lowConfidence: 'पूरा पक्का नहीं — हर नंबर जांच लें',
  total: 'कुल',
  estimate: 'कुल (अनुमान)',
  required: 'भरें: {fields}',
  invalidNumber: 'नंबर जांचें: {fields}',
  savedOk: 'सेव हो गया ✅',
  alreadyDone: 'यह एंट्री पहले ही सेव या रद्द हो चुकी है।',
  searchParty: 'पार्टी खोजें',
  balance: 'बाकी',
  due: 'लेना है',
  advance: 'एडवांस',
  sharePdf: 'खाता PDF भेजें',
  sendReminder: 'याद दिलाएं',
  noParties: 'अभी कोई पार्टी नहीं।',
  entries: 'एंट्री',
  lastUpdated: 'ऑफलाइन कॉपी: {time}',
  overdue: 'पुराना बाकी',
  days: '{n} दिन',
  noDues: 'किसी का पैसा बाकी नहीं। 🎉',
  upiId: 'आपकी UPI ID (पेमेंट लिंक के लिए)',
  upiInvalid: 'UPI ID गलत लग रही है (जैसे: name@okaxis)',
  language: 'भाषा',
  logout: 'लॉग आउट',
  business: 'बिज़नेस',
  you: 'आप',
  version: 'ऐप वर्ज़न',
  priceList: 'प्राइस लिस्ट भेजें',
  reason_missing_fields: 'कुछ जानकारी नहीं मिली: {fields}। फिर से बोलें।',
  reason_not_understood: 'रिकॉर्डिंग समझ नहीं आई। साफ़ बोलकर फिर से रिकॉर्ड करें।',
  reason_not_an_entry: 'यह एंट्री नहीं थी। बाकी देखने के लिए खाता टैब खोलें।',
  reason_too_long: 'रिकॉर्डिंग बहुत लंबी है।',
  reason_server_error: 'सर्वर में दिक्कत। "फिर से भेजें" दबाएं।',
  reason_other: 'एंट्री नहीं बन पाई। फिर से रिकॉर्ड करें।',
};

export type TKey = keyof Dict;
export const DICTS: Record<Lang, Dict> = { hi, en };

export const FIELD_LABELS: Record<Lang, Record<FieldKey, string>> = {
  en: {
    party_name: 'Party', worker_name: 'Worker', transporter_name: 'Transporter', stone_type: 'Stone size',
    pieces_count: 'Pieces', sqft_quantity: 'Sqft', unit_rate: 'Rate (₹/sqft)', amount: 'Amount (₹)',
    freight_charge: 'Freight (₹, minus)', loading_charge: 'Loading (₹)', packing_charge: 'Packing (₹)', tax_percentage: 'GST %',
  },
  hi: {
    party_name: 'पार्टी', worker_name: 'कारीगर', transporter_name: 'ट्रांसपोर्टर', stone_type: 'पत्थर साइज़',
    pieces_count: 'पीस', sqft_quantity: 'स्क्वायर फुट', unit_rate: 'रेट (₹/sqft)', amount: 'रकम (₹)',
    freight_charge: 'भाड़ा (₹, घटेगा)', loading_charge: 'लोडिंग (₹)', packing_charge: 'पैकिंग (₹)', tax_percentage: 'GST %',
  },
};

export const TYPE_LABELS: Record<Lang, Record<EntryType, string>> = {
  en: { dispatch: 'Dispatch', payment: 'Payment received', worker_advance: 'Worker advance', freight_payment: 'Freight paid' },
  hi: { dispatch: 'माल भेजा', payment: 'पैसे आए', worker_advance: 'कारीगर एडवांस', freight_payment: 'भाड़ा दिया' },
};

export function translate(lang: Lang, key: TKey, vars: Record<string, string | number> = {}): string {
  return DICTS[lang][key].replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

interface I18n {
  lang: Lang;
  setLang(l: Lang): void;
  t(key: TKey, vars?: Record<string, string | number>): string;
}

const Ctx = createContext<I18n>({ lang: 'hi', setLang: () => undefined, t: (k, v) => translate('hi', k, v) });
const KEY = 'vk.lang';

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('hi');
  useEffect(() => {
    storage.get(KEY).then((v) => (v === 'en' || v === 'hi') && setLangState(v));
  }, []);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    void storage.set(KEY, l);
  }, []);
  const value = useMemo(() => ({ lang, setLang, t: (k: TKey, v?: Record<string, string | number>) => translate(lang, k, v) }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
