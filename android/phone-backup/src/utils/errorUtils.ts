/**
 * errorUtils.ts
 *
 * Provides central error sanitization for the application.
 * Converts raw Java/Kotlin exceptions, native module rejections, and fetch network errors
 * into human-readable, production-ready user messages.
 */

export function sanitizeErrorMessage(err: any, fallbackMessage: string = 'Network error — could not reach server'): string {
  if (!err) return fallbackMessage;

  const raw = (typeof err === 'string' ? err : err?.message || String(err || '')).trim();

  if (!raw || raw === '[object Object]') {
    return fallbackMessage;
  }

  // 1. Host unreachable / Connection refused / Socket error / Offline
  if (
    /NoRouteToHostException|ConnectException|SocketException|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Host unreachable|Network request failed|NetworkError|Failed to connect|noroutohostexception|unreachable/i.test(raw)
  ) {
    return 'Server unreachable — check that the desktop app is running and your device is on the same network.';
  }

  // 2. Timeout
  if (/timeout|AbortError|timed out/i.test(raw)) {
    return 'Connection timed out — server did not respond in time.';
  }

  // 3. MIME type / content type resolution errors
  if (/guessContentTypeFromName|guessContentType|must not be null/i.test(raw)) {
    return 'File format error — unable to determine file type for upload.';
  }

  // 4. Null pointer / technical JS/Java exceptions
  if (/NullPointerException|null reference|cannot read property|undefined is not/i.test(raw)) {
    return 'File error — unable to process file details.';
  }

  // 5. ExponentFileSystem / NativeModule / Java exception class noise
  if (/ExponentFileSystem|uploadAsync|NativeModule|Invariant Violation|java\.|android\.|com\.|Exception|TypeError|ReferenceError/i.test(raw)) {
    const caused = raw.match(/(?:Caused by|caused by)[:\s]+(.+?)(?:\n|$)/i);
    if (caused && caused[1]) {
      return sanitizeErrorMessage(caused[1], fallbackMessage);
    }
    return fallbackMessage;
  }

  // 6. Clean any technical long messages or newlines
  if (raw.length > 120 || raw.includes('\n')) {
    const firstLine = raw.split('\n')[0].trim();
    if (/java\.|android\.|Exception|Error:/i.test(firstLine)) {
      return fallbackMessage;
    }
    return firstLine.substring(0, 117) + '…';
  }

  return raw;
}
