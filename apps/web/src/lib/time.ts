import { locale, t } from '../i18n';
import { timeZonePreference } from './preferences';

const parse = (value?: string | null) => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};
const zone = () => timeZonePreference() === 'utc' ? 'UTC' : undefined;

/** Minutes east of UTC used to group activity by the displayed calendar day. */
export const displayOffsetMinutes = () => timeZonePreference() === 'utc' ? 0 : -new Date().getTimezoneOffset();

/** Short date and time; the year appears only outside the current year. */
export function formatDateTime(value?: string | null, options: { seconds?: boolean } = {}) {
  const date = parse(value);
  if (!date) return '—';
  const timeZone = zone();
  const year = new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone }).format(date) !== new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone }).format(new Date());
  const text = new Intl.DateTimeFormat(locale, {
    ...(year ? { year: 'numeric' } : {}), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(options.seconds ? { second: '2-digit' } : {}), hourCycle: 'h23', timeZone,
  }).format(date);
  return timeZone ? text + ' UTC' : text;
}

/** Full timestamp for tooltips and detail views. */
export function formatFullDateTime(value?: string | null) {
  const date = parse(value);
  if (!date) return '—';
  const timeZone = zone();
  const text = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone, timeZoneName: 'short' }).format(date);
  return text;
}

export function formatRelative(value?: string | null, now = Date.now()) {
  const date = parse(value);
  if (!date) return '—';
  const seconds = Math.round((date.getTime() - now) / 1000);
  if (Math.abs(seconds) < 45) return t('time.justNow');
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['minute', 60], ['hour', 3600], ['day', 86400], ['month', 2592000], ['year', 31536000]];
  let unit = units[0];
  for (const candidate of units) if (Math.abs(seconds) >= candidate[1]) unit = candidate;
  return format.format(Math.round(seconds / unit[1]), unit[0]);
}

export function formatDuration(from?: string | null, to?: string | null) {
  const start = parse(from), end = parse(to) ?? (from ? new Date() : undefined);
  if (!start || !end) return '—';
  let seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  if (seconds < 60) return t('time.seconds', { n: seconds });
  const hours = Math.floor(seconds / 3600); seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60); seconds -= minutes * 60;
  return hours ? t('time.hoursMinutes', { h: hours, m: minutes }) : t('time.minutesSeconds', { m: minutes, s: seconds });
}

/** Calendar label for an activity bucket `YYYY-MM-DD`. */
export function formatDay(day: string) {
  const [, month, date] = day.split('-').map(Number);
  return t('time.monthDay', { month, day: date });
}

/** ISO instant → `datetime-local` value in the display time zone. */
export function toDateTimeInput(value?: string | null) {
  const date = parse(value);
  if (!date) return '';
  const shifted = new Date(date.getTime() + displayOffsetMinutes() * 60_000);
  return shifted.toISOString().slice(0, 19);
}

/** `datetime-local` value in the display time zone → ISO instant. */
export function fromDateTimeInput(value: string) {
  if (!value) return '';
  const utc = Date.parse(value + 'Z');
  if (!Number.isFinite(utc)) return '';
  if (timeZonePreference() === 'utc') return new Date(utc).toISOString();
  const local = new Date(value);
  return Number.isNaN(local.getTime()) ? '' : local.toISOString();
}

/** Axis label for a chart time: clock time for short ranges, date for long ones. */
export function formatAxisTime(value: string, long: boolean) {
  const date = parse(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(locale, long ? { month: 'numeric', day: 'numeric', timeZone: zone() } : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone() }).format(date);
}

export function formatUptime(totalSeconds?: number | null) {
  if (totalSeconds === undefined || totalSeconds === null) return '—';
  const days = Math.floor(totalSeconds / 86400), hours = Math.floor(totalSeconds % 86400 / 3600), minutes = Math.floor(totalSeconds % 3600 / 60);
  return days ? t('time.daysHours', { d: days, h: hours }) : hours ? t('time.hoursMinutes', { h: hours, m: minutes }) : t('time.minutes', { m: minutes });
}
