import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { apiUrl, authHeaders } from './api';

/**
 * Download a PDF from the backend (with the login token) and open the share
 * sheet, so he can send it on his own WhatsApp — free, and from his number.
 */
export async function downloadAndSharePdf(path: string, fileName: string, title: string) {
  const safe = fileName.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'khata.pdf';
  const file = await File.downloadFileAsync(apiUrl(path), new File(Paths.cache, safe), {
    headers: authHeaders(),
    idempotent: true,
  });
  await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', dialogTitle: title, UTI: 'com.adobe.pdf' });
}
