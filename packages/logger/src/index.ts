// Structured JSON-lines logger shared by the web app, the worker, and the
// engine. One line per event on stdout/stderr so Railway (or any log drain)
// can index fields without a parser. Secrets never reach the output: any
// field whose key looks like a credential is replaced before serialising.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line it writes. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Component name, written as `logger` on every line. */
  name: string;
  /** Lines below this level are dropped. Defaults to LOG_LEVEL or 'info'. */
  level?: LogLevel;
  /** Output sink, for tests. Defaults to console (stderr for warn/error). */
  sink?: (level: LogLevel, line: string) => void;
  /** Clock, for tests. */
  now?: () => Date;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTED = '[redacted]';

// Keys whose values are credentials. Matched case-insensitively against the
// whole key so `accessToken`, `refresh_token`, `clientSecret` and
// `authorization` are all caught, while `tokenCount`-style names are not.
const SECRET_KEY =
  /^(.*[_-]?(token|secret|password|authorization|cookie|signature|apikey|api_key))$/i;

function isLogLevel(value: string | undefined): value is LogLevel {
  return (
    value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error'
  );
}

function defaultLevel(): LogLevel {
  const fromEnv =
    typeof process === 'undefined' ? undefined : process.env.LOG_LEVEL;
  return isLogLevel(fromEnv) ? fromEnv : 'info';
}

function defaultSink(level: LogLevel, line: string): void {
  if (level === 'warn' || level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

// Turns arbitrary field values into JSON-safe data: errors keep their name,
// message and stack; secret-looking keys are redacted at any depth; cycles
// are cut instead of throwing.
function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause === undefined
        ? {}
        : { cause: sanitize(value.cause, seen) }),
    };
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return value.toString();
    return value;
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, seen));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : sanitize(v, seen);
  }
  return out;
}

/** Creates a logger that writes one JSON object per line. */
export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_RANK[options.level ?? defaultLevel()];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());

  function make(bound: LogFields): Logger {
    function write(level: LogLevel, message: string, fields?: LogFields) {
      if (LEVEL_RANK[level] < threshold) return;
      const merged = sanitize({ ...bound, ...fields }, new WeakSet()) as Record<
        string,
        unknown
      >;
      const line = JSON.stringify({
        time: now().toISOString(),
        level,
        logger: options.name,
        msg: message,
        ...merged,
      });
      sink(level, line);
    }
    return {
      debug: (m, f) => write('debug', m, f),
      info: (m, f) => write('info', m, f),
      warn: (m, f) => write('warn', m, f),
      error: (m, f) => write('error', m, f),
      child: (fields) => make({ ...bound, ...fields }),
    };
  }

  return make({});
}

/** A logger that drops everything, for tests and optional dependencies. */
export const silentLogger: Logger = createLogger({
  name: 'silent',
  sink: () => {},
});
