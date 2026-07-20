import { Schema } from 'effect';

const isValidIanaTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
};

const IanaTimezone = Schema.String.annotate({
  description:
    "The IANA timezone for local wall-clock semantics. Use Spike's configured timezone unless the user explicitly specifies another.",
}).pipe(Schema.check(Schema.makeFilter(isValidIanaTimezone, { title: 'IANA timezone' })));

const systemTimezone = (): string => {
  const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidIanaTimezone(timezone) ? timezone : 'UTC';
};

export { IanaTimezone, isValidIanaTimezone, systemTimezone };
