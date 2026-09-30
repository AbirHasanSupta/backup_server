/**
 * Local-timezone date/time formatters with explicit 12-hour AM/PM clocks.
 * Unix timestamps from the server are absolute; display always uses device local TZ.
 */

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
};

const TIME_OPTS: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
};

const DATE_TIME_OPTS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
};

function toDate(tsSecondsOrMs: number, assumeSeconds = true): Date {
  // Values under ~1e12 are treated as seconds (Unix epoch); larger as ms.
  const ms = assumeSeconds && tsSecondsOrMs < 1e12 ? tsSecondsOrMs * 1000 : tsSecondsOrMs;
  return new Date(ms);
}

/** "Aug 14, 2022" */
export function formatLocalDate(ts: number | null | undefined, assumeSeconds = true): string {
  if (ts == null || !Number.isFinite(ts)) return '';
  try {
    return toDate(ts, assumeSeconds).toLocaleDateString('en-US', DATE_OPTS);
  } catch {
    return '';
  }
}

/** "3:41 PM" */
export function formatLocalTime(ts: number | null | undefined, assumeSeconds = true): string {
  if (ts == null || !Number.isFinite(ts)) return '';
  try {
    return toDate(ts, assumeSeconds).toLocaleTimeString('en-US', TIME_OPTS);
  } catch {
    return '';
  }
}

/** "Aug 14, 2022 · 3:41 PM" */
export function formatCaptureDateTime(ts: number | null | undefined, assumeSeconds = true): string {
  if (ts == null || !Number.isFinite(ts)) return '';
  try {
    const d = toDate(ts, assumeSeconds);
    const datePart = d.toLocaleDateString('en-US', DATE_OPTS);
    const timePart = d.toLocaleTimeString('en-US', TIME_OPTS);
    return `${datePart} · ${timePart}`;
  } catch {
    return '';
  }
}

/** "Aug 14  3:41 PM" — compact for session cards */
export function formatLocalDateTime(ts: number | null | undefined, assumeSeconds = true): string {
  if (ts == null || !Number.isFinite(ts)) return '';
  try {
    const d = toDate(ts, assumeSeconds);
    return (
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      '  ' +
      d.toLocaleTimeString('en-US', TIME_OPTS)
    );
  } catch {
    return '';
  }
}

/** Full local date+time in one call (en-US, AM/PM). */
export function formatLocalDateTimeLong(ts: number | null | undefined, assumeSeconds = true): string {
  if (ts == null || !Number.isFinite(ts)) return '';
  try {
    return toDate(ts, assumeSeconds).toLocaleString('en-US', DATE_TIME_OPTS);
  } catch {
    return '';
  }
}
