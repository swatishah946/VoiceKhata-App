/** Backend URL. Set EXPO_PUBLIC_API_URL in .env.local to point at a local server. */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'https://voicekhata-yqsj.onrender.com').replace(/\/+$/, '');

/** A voice entry is a few seconds; stop automatically so a forgotten recording can't run on. */
export const MAX_RECORDING_SECONDS = 120;
