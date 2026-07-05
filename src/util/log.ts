export type LogLevel = 'info' | 'warn' | 'error';

function emit(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, ...fields, timestamp: new Date().toISOString() });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stderr.write(`${line}\n`);
}

export const log = {
  info: (message: string, fields: Record<string, unknown> = {}) => emit('info', message, fields),
  warn: (message: string, fields: Record<string, unknown> = {}) => emit('warn', message, fields),
  error: (message: string, fields: Record<string, unknown> = {}) => emit('error', message, fields),
};
