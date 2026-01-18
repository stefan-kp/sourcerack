/**
 * Structured JSON logger for SourceRack (FR-011)
 *
 * Provides configurable logging with:
 * - JSON output format
 * - Configurable log levels (debug/info/warn/error)
 * - Optional file output
 * - Timestamps and context metadata
 */

import pino, { Logger, LoggerOptions, DestinationStream } from 'pino';
import { createWriteStream } from 'node:fs';
import { LoggingConfig } from '../config/schema.js';

/**
 * Log level type
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Context metadata for log entries
 */
export interface LogContext {
  /** Repository ID for scoped operations */
  repoId?: string;
  /** Commit SHA for scoped operations */
  commit?: string;
  /** Operation name */
  operation?: string;
  /** Additional metadata */
  [key: string]: unknown;
}

/**
 * Logger instance type
 */
export type SourceRackLogger = Logger;

/**
 * Create a destination stream for logging
 */
function createDestination(config: LoggingConfig): DestinationStream | undefined {
  if (config.file !== undefined && config.file !== '') {
    return createWriteStream(config.file, { flags: 'a' });
  }
  return undefined;
}

/**
 * Create logger options from configuration
 */
function createLoggerOptions(config: LoggingConfig): LoggerOptions {
  const options: LoggerOptions = {
    level: config.level,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      service: 'sourcerack',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  // Enable pretty printing for development
  if (config.pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
  }

  return options;
}

/**
 * Create a configured logger instance
 *
 * @param config - Logging configuration
 * @returns Configured pino logger
 */
export function createLogger(config: LoggingConfig): SourceRackLogger {
  const options = createLoggerOptions(config);
  const destination = createDestination(config);

  if (destination !== undefined) {
    return pino(options, destination);
  }

  return pino(options);
}

/**
 * Create a child logger with additional context
 *
 * @param logger - Parent logger instance
 * @param context - Context metadata to include in all logs
 * @returns Child logger with context
 */
export function createChildLogger(
  logger: SourceRackLogger,
  context: LogContext
): SourceRackLogger {
  return logger.child(context);
}

/**
 * Default logger instance (info level, stdout, JSON format)
 * Should be replaced with createLogger() using actual config in application
 */
let defaultLogger: SourceRackLogger | null = null;

/**
 * Get or create the default logger instance
 */
export function getLogger(): SourceRackLogger {
  defaultLogger ??= createLogger({
    level: 'info',
    pretty: false,
  });
  return defaultLogger;
}

/**
 * Set the default logger instance
 * Useful for initializing with application configuration
 */
export function setDefaultLogger(logger: SourceRackLogger): void {
  defaultLogger = logger;
}

/**
 * Utility function to log operation start
 */
export function logOperationStart(
  logger: SourceRackLogger,
  operation: string,
  context?: LogContext
): void {
  logger.info({ operation, ...context }, `Starting ${operation}`);
}

/**
 * Utility function to log operation completion
 */
export function logOperationComplete(
  logger: SourceRackLogger,
  operation: string,
  durationMs: number,
  context?: LogContext
): void {
  logger.info(
    { operation, durationMs, ...context },
    `Completed ${operation} in ${durationMs}ms`
  );
}

/**
 * Utility function to log operation failure
 */
export function logOperationError(
  logger: SourceRackLogger,
  operation: string,
  error: Error,
  context?: LogContext
): void {
  logger.error(
    {
      operation,
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack,
      },
      ...context,
    },
    `Failed ${operation}: ${error.message}`
  );
}

/**
 * Create a timed operation wrapper that logs start, completion, and errors
 */
export function withLogging<T>(
  logger: SourceRackLogger,
  operation: string,
  fn: () => T,
  context?: LogContext
): T {
  const start = Date.now();
  logOperationStart(logger, operation, context);

  try {
    const result = fn();

    // Handle promises
    if (result instanceof Promise) {
      return result
        .then((value) => {
          logOperationComplete(logger, operation, Date.now() - start, context);
          return value;
        })
        .catch((error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          logOperationError(logger, operation, err, context);
          throw error;
        }) as T;
    }

    logOperationComplete(logger, operation, Date.now() - start, context);
    return result;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logOperationError(logger, operation, err, context);
    throw error;
  }
}
