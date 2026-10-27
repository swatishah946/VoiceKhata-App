# VoiceKhata App

Android app for [VoiceKhata](https://github.com/swatishah946/VoiceKhata). Instead of sending voice notes on WhatsApp, the user records them in the app. It uses the same backend, so entries, balances and PDFs are shared with the WhatsApp bot and the web dashboard.

I moved from WhatsApp to an app because the WhatsApp Business API now charges per message and needs business verification. The app costs nothing per message, and khata PDFs and payment reminders are still sent on WhatsApp, from the owner's own number, using the phone's share button.

## What it does

- **Record an entry:** tap the mic and speak, e.g. *"Siddhi Stone ko 5000 sqft 2x1½ bheja, rate 31.5"*.
- **Check before saving:** the app shows what was understood. Any wrong number can be fixed before saving. The total updates while editing, and the server recalculates it on save.
- **Works without internet:** recordings are saved on the phone and uploaded automatically when the network is back.
- **Khata:** every party's balance, works offline using the last downloaded copy. Share a party's khata PDF on WhatsApp.
- **Reminders:** who owes money and for how long (0–30, 31–60, 61–90, 90+ days), and a one-tap reminder message with a UPI payment link.
- Hindi by default, English in Settings.

## How it works

```
App ── record ──> saved on phone (SQLite + file)
                        │  network available
                        ▼
        POST /api/app/voice  (X-Client-Entry-Id: UUID made on the phone)
                        ▼
   Backend: BullMQ queue → Whisper → Gemini → validation → pending entry
                        ▼
App polls /api/app/voice → "check and save" → POST /api/app/entries/:id/save
```

- **No duplicate entries on retry.** Every recording gets a UUID on the phone. If an upload is retried after a network drop, the server finds the same UUID and returns the existing upload instead of creating a new one.
- **The server doesn't trust the phone.** Edited values are validated again and the bill is recalculated on the server. A total sent by the app is ignored.
- **Real accuracy data.** Every saved entry stores what the AI understood and what the user saved. `npm run accuracy` in the backend shows how often each field was right.

## Tech

Expo (React Native) with TypeScript, Expo Router, expo-audio, expo-sqlite, expo-file-system, expo-notifications, TanStack Query, Jest and React Native Testing Library.

## Running it

You need the VoiceKhata backend running (with migration `002_mobile_app.sql` applied), and a member with a PIN:

```bash
# in the backend
npm run migrate
npm run add-member -- +91XXXXXXXXXX "Papa" owner
npm run set-pin -- +91XXXXXXXXXX 4821
```

Then:

```bash
npm install
cp .env.example .env.local    # set EXPO_PUBLIC_API_URL to your backend
npx expo start
```

The app uses native modules (audio recording, SQLite), so it runs in a development build rather than Expo Go:

```bash
npx eas-cli@latest build --profile development --platform android
```

To build an APK that can be installed directly on a phone:

```bash
npx eas-cli@latest build --profile preview --platform android
```

Push notifications need an EAS project id (`npx eas-cli@latest init`). Without one, the app works the same, just without notifications.

## Tests

```bash
npm test          # Jest: sync engine, review form, money, reminders, API client
npm run typecheck
```
