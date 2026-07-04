/**
 * Logger types and implementations for call-sdk.
 *
 * Mirrors chat-sdk's `Logger`/`ConsoleLogger` shape (see
 * `../chat/packages/chat/src/logger.ts`), adapted for call-sdk's need to
 * attach structured context (`stage`, `sessionId`) to every log line coming
 * out of a pipeline stage or session — hence structured `fields` on every
 * call instead of chat-sdk's `...args: unknown[]`, and a standalone
 * `childLogger()` helper (rather than a `.child()` method) that works over
 * any `Logger` implementation, not just `ConsoleLogger`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
}

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error", "silent"];

/** Default console-backed logger implementation, with level filtering. */
export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;
  private readonly prefix: string;

  constructor(level: LogLevel = "info", prefix = "call-sdk") {
    this.level = level;
    this.prefix = prefix;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVELS.indexOf(level) >= LEVELS.indexOf(this.level);
  }

  private write(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: LogFields
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }
    const line = `[${this.prefix}] ${message}`;
    const write = console[level];
    if (fields && Object.keys(fields).length > 0) {
      write(line, fields);
    } else {
      write(line);
    }
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }
}

/**
 * Normalizes the many ways a logger can be configured (nothing, a level, or
 * an already-constructed `Logger`) into a `Logger` instance.
 */
export function createLogger(levelOrLogger?: LogLevel | Logger): Logger {
  if (levelOrLogger && typeof levelOrLogger === "object") {
    return levelOrLogger;
  }
  return new ConsoleLogger(levelOrLogger ?? "info");
}

export interface ChildLoggerBindings {
  sessionId?: string;
  stage?: string;
  [key: string]: unknown;
}

/**
 * Wraps any `Logger` with bound context (typically `stage` and/or
 * `sessionId`): the bindings are merged into every call's `fields` and
 * surfaced as a `[binding:binding] message` prefix, so log lines from a
 * given stage/session are identifiable even when the underlying transport
 * doesn't render structured fields.
 */
export function childLogger(
  parent: Logger,
  bindings: ChildLoggerBindings
): Logger {
  const bindingEntries = Object.entries(bindings).filter(
    ([, v]) => v !== undefined
  );
  const prefix = [bindings.stage, bindings.sessionId]
    .filter((v): v is string => Boolean(v))
    .join(":");

  const withPrefix = (message: string): string =>
    prefix.length > 0 ? `[${prefix}] ${message}` : message;

  const withBindings = (fields?: LogFields): LogFields | undefined => {
    if (bindingEntries.length === 0) {
      return fields;
    }
    return { ...Object.fromEntries(bindingEntries), ...fields };
  };

  return {
    debug: (message, fields) =>
      parent.debug(withPrefix(message), withBindings(fields)),
    info: (message, fields) =>
      parent.info(withPrefix(message), withBindings(fields)),
    warn: (message, fields) =>
      parent.warn(withPrefix(message), withBindings(fields)),
    error: (message, fields) =>
      parent.error(withPrefix(message), withBindings(fields)),
  };
}
