/** One line per event, so a demo is readable in a terminal. */
function line(level: string, message: string, extra?: unknown): void {
  const stamp = new Date().toISOString();
  const tail = extra === undefined ? "" : ` ${format(extra)}`;
  console.log(`${stamp} ${level} ${message}${tail}`);
}

function format(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  info: (message: string, extra?: unknown) => line("INFO ", message, extra),
  warn: (message: string, extra?: unknown) => line("WARN ", message, extra),
  error: (message: string, extra?: unknown) => line("ERROR", message, extra),
};
