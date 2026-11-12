// Display helpers. Pure functions.

const pad2 = (n) => String(n).padStart(2, '0');

/** Seconds to "m:ss" (or "h:mm:ss" from one hour). */
export function formatDuration(totalSec) {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

/** Milliseconds to a countdown clock. Counts remaining time UP to the next whole second, so it never shows 0:00 early. */
export const formatCountdown = (ms) => formatDuration(Math.ceil(Math.max(0, ms) / 1000));

/** Milliseconds to an elapsed clock. Counts DOWN to the whole second. */
export const formatElapsed = (ms) => formatDuration(Math.floor(Math.max(0, ms) / 1000));

export const mphText = (mph) => `${mph.toFixed(1)} mph`;

export const describeInterval = (iv) => `${iv.category} · ${formatDuration(iv.durationSec)} · ${mphText(iv.speedMph)} · incline ${iv.inclineLevel}`;

/** "1:55" -> 115. Returns null if it is not a valid m:ss (or h:mm:ss) time. */
export function parseDuration(text) {
  const m = /^(?:(\d+):)?(\d{1,3}):([0-5]\d)$/.exec(String(text).trim());
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
}
