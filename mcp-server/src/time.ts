const TIME_ZONE = process.env.CANVAS_TIME_ZONE || 'Asia/Shanghai';

export function calendarDay(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function formatDeadline(iso: string | null | undefined): string {
  if (!iso) return '无';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
  return `${calendarDay(date)} ${time} (${TIME_ZONE})`;
}
