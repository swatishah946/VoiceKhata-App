# VoiceKhata App

An Android app for small traders to keep their khata (ledger) by voice. You speak an entry in Hindi or Hinglish, check what the app understood, and save it.

I built it for my father's stone trading business in Kota. It is the mobile app for [VoiceKhata](https://github.com/swatishah946/VoiceKhata), which started as a WhatsApp bot. I added the app because the WhatsApp Business API now charges per message and needs business verification. The app has no per-message cost, and khata PDFs and payment reminders are still sent on WhatsApp, from the owner's own number.

## Screenshots

The app is in Hindi by default and can be switched to English in Settings.

| Home | Check entry | Reminders |
| --- | --- | --- |
| <img src="docs/screenshots/hi-home.png" width="220"/> | <img src="docs/screenshots/hi-review.png" width="220"/> | <img src="docs/screenshots/hi-reminders.png" width="220"/> |

| Home | Check entry (after fixing the rate) | Party khata | Khata |
| --- | --- | --- | --- |
| <img src="docs/screenshots/en-home.png" width="200"/> | <img src="docs/screenshots/en-review.png" width="200"/> | <img src="docs/screenshots/en-party.png" width="200"/> | <img src="docs/screenshots/en-khata.png" width="200"/> |

## Features

- **Voice entries.** Tap the mic and speak, e.g. *"Siddhi Stone ko 5000 sqft 2x1½ bheja, rate 31.5"*. The audio is transcribed (Groq Whisper) and turned into an entry (Gemini).
- **Check before saving.** The app shows what it heard and lets you fix any field. The total updates while you edit. It warns when the rate is far from the price list (13.5 heard instead of 31.5 is a common mistake) and when a party name is new.
- **Works without internet.** Recordings are saved on the phone and uploaded on their own when the network comes back.
- **Khata.** Balance for every party, the full entry history, and a button to share the khata PDF on WhatsApp. The last downloaded copy is shown when offline.
- **Payment reminders.** Who owes money and for how long (0–30, 31–60, 61–90, 90+ days). One tap opens WhatsApp with a reminder message that includes a UPI payment link.
- **Notifications.** A notification when an entry is ready to check, and a weekly summary of overdue payments.

## How it works

```
App ── record ──> saved on phone (SQLite + file)
                        │  when online
                        ▼
        POST /api/app/voice   (X-Client-Entry-Id: UUID made on the phone)
                        ▼
   Backend: BullMQ queue → Whisper → Gemini → validation → pending entry
                        ▼
App checks status ──> "Check and save" ──> POST /api/app/entries/:id/save
```

Some decisions:

- **Retries don't create duplicates.** Each recording gets a UUID on the phone. If the network drops after the server has saved an upload, the retry carries the same UUID and the server returns the existing upload.
- **The server recalculates everything.** Edited values are validated again on the server, and the bill is calculated there in integer paise. Totals sent by the app are ignored.
- **Measuring accuracy.** For every saved entry, the backend stores what the AI understood and what the user finally saved. `npm run accuracy` in the backend reports how often each field was right.
- **Offline storage.** Recordings are kept in SQLite with a status (waiting, processing, ready, saved…). A sync step runs when the app opens, when the network comes back, and every few seconds while the server is still working on an entry.

## Tech

React Native (Expo) and TypeScript, Expo Router, expo-audio, expo-sqlite, expo-file-system, expo-notifications, TanStack Query. Tests use Jest and React Native Testing Library.

## Running it

The app needs the VoiceKhata backend, with migrations applied and a user with a PIN:

```bash
# in the backend folder
npm run migrate
npm run add-member -- +91XXXXXXXXXX "Papa" owner
npm run set-pin -- +91XXXXXXXXXX 4821
```

Then, in this folder:

```bash
npm install
cp .env.example .env.local    # set EXPO_PUBLIC_API_URL to your backend
npm run web                   # quick preview in the browser
```

Voice recording and SQLite need a real build on the phone (not Expo Go):

```bash
npx eas-cli@latest build --profile development --platform android   # development build
npx eas-cli@latest build --profile preview --platform android       # installable APK
```

Push notifications need an EAS project (`npx eas-cli@latest init`). Without one, the app works the same but doesn't send notifications.

## Tests

```bash
npm test           # sync logic, review form, money calculations, reminders, API client
npm run typecheck
```
