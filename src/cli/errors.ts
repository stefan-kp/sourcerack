/**
 * CLI error types and handlers
 *
 * Defines CLI-specific errors with exit codes for proper process termination.
 * Includes agent-friendly error formatting so AI agents know how to recover.
 */

/**
 * Agent-friendly error structure
 * Provides actionable information for both humans and AI agents
 */
export interface AgentError {
  error: string;
  action_required: string;
  command?: string;
  hint?: string;
}

/**
 * CLI exit codes
 */
export enum ExitCode {
  /** Success */
  SUCCESS = 0,
  /** General error */
  GENERAL_ERROR = 1,
  /** Invalid arguments */
  INVALID_ARGS = 2,
  /** Repository or commit not found */
  NOT_FOUND = 3,
  /** Commit not indexed */
  NOT_INDEXED = 4,
  /** Connection error (Qdrant) */
  CONNECTION_ERROR = 5,
}

/**
 * Base CLI error class with agent-friendly error support
 */
export class CLIError extends Error {
  public readonly agentError: AgentError | undefined;

  constructor(
    message: string,
    public readonly exitCode: ExitCode = ExitCode.GENERAL_ERROR,
    public readonly cause?: Error,
    agentError?: AgentError
  ) {
    super(message);
    this.name = 'CLIError';
    this.agentError = agentError ?? undefined;
  }

  /**
   * Create a CLIError with agent-friendly information
   */
  static withAgentInfo(
    agentError: AgentError,
    exitCode: ExitCode = ExitCode.GENERAL_ERROR,
    cause?: Error
  ): CLIError {
    return new CLIError(agentError.error, exitCode, cause, agentError);
  }
}

/**
 * Error for invalid command arguments
 */
export class InvalidArgumentError extends CLIError {
  constructor(message: string, cause?: Error) {
    super(message, ExitCode.INVALID_ARGS, cause);
    this.name = 'InvalidArgumentError';
  }
}

/**
 * Error when repository or commit is not found
 */
export class NotFoundError extends CLIError {
  constructor(message: string, cause?: Error) {
    super(message, ExitCode.NOT_FOUND, cause);
    this.name = 'NotFoundError';
  }
}

/**
 * Error when commit is not indexed
 */
export class NotIndexedError extends CLIError {
  constructor(message: string, cause?: Error) {
    super(message, ExitCode.NOT_INDEXED, cause);
    this.name = 'NotIndexedError';
  }
}

/**
 * Error for connection failures (Qdrant, etc.)
 */
export class ConnectionError extends CLIError {
  constructor(message: string, cause?: Error) {
    super(message, ExitCode.CONNECTION_ERROR, cause);
    this.name = 'ConnectionError';
  }
}

/**
 * Common agent-friendly errors with pre-defined messages
 */
export const AgentErrors = {
  repoNotIndexed: (repoPath: string): AgentError => ({
    error: 'Repository not indexed',
    action_required: 'Index the repository before searching',
    command: `sourcerack index ${repoPath}`,
  }),

  repoNotFound: (repoPath: string): AgentError => ({
    error: 'Repository not found',
    action_required: 'Verify the path exists and is a git repository',
    hint: `Path: ${repoPath}`,
  }),

  notAGitRepo: (path: string): AgentError => ({
    error: 'Not a git repository',
    action_required: 'Navigate to a git repository or initialize one',
    command: `cd ${path} && git init`,
  }),

  qdrantConnectionFailed: (url: string): AgentError => ({
    error: 'Qdrant connection failed',
    action_required: 'Start Qdrant or disable embeddings in config',
    command: 'docker run -d -p 6333:6333 qdrant/qdrant',
    hint: `Tried to connect to: ${url}`,
  }),

  noResults: (query: string): AgentError => ({
    error: 'No results found',
    action_required: 'Try a different search query or verify the repository is indexed',
    command: 'sourcerack status',
    hint: `Query was: "${query}"`,
  }),

  embeddingsDisabled: (): AgentError => ({
    error: 'Semantic search unavailable - embeddings are disabled',
    action_required: 'Enable embeddings in config or use SQI commands (find-def, find-usages)',
    hint: 'Edit ~/.sourcerack/config.json and set embedding.enabled to true',
  }),

  symbolNotFound: (symbol: string, file?: string): AgentError => ({
    error: `Symbol not found: ${symbol}`,
    action_required: 'Verify the symbol name and file path are correct',
    hint: file ? `Searched in: ${file}` : 'Try using find-def with a broader search',
  }),

  databaseError: (details: string): AgentError => ({
    error: 'Database error',
    action_required: 'Check database integrity or re-index the repository',
    hint: details,
  }),

  configInvalid: (details: string): AgentError => ({
    error: 'Invalid configuration',
    action_required: 'Fix the configuration file or run setup again',
    command: 'sourcerack setup',
    hint: details,
  }),
} as const;

/**
 * Format an agent-friendly error for output
 */
export function formatAgentError(error: AgentError, json = false): string {
  if (json || process.env.SOURCERACK_OUTPUT === 'json') {
    return JSON.stringify(error, null, 2);
  }

  const lines: string[] = [
    `Error: ${error.error}`,
    '',
    `Action required: ${error.action_required}`,
  ];

  if (error.command) {
    lines.push('', `Run: ${error.command}`);
  }

  if (error.hint) {
    lines.push('', `Hint: ${error.hint}`);
  }

  return lines.join('\n');
}

/**
 * Handle an error and exit the process with appropriate code
 *
 * Outputs agent-friendly error format when available, falling back to simple messages.
 *
 * @param error - Error to handle
 * @param json - Whether to output in JSON format
 */
export function handleError(error: unknown, json = false): never {
  let exitCode = ExitCode.GENERAL_ERROR;
  let message: string;
  let agentError: AgentError | undefined;

  if (error instanceof CLIError) {
    exitCode = error.exitCode;
    message = error.message;
    agentError = error.agentError;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }

  // If we have agent-friendly error info, use that format
  if (agentError) {
    console.error(formatAgentError(agentError, json));
  } else if (json) {
    console.error(JSON.stringify({ error: { code: exitCode, message } }));
  } else {
    console.error(`Error: ${message}`);
  }

  process.exit(exitCode);
}

/**
 * Exit with an agent-friendly error
 */
export function exitWithAgentError(
  agentError: AgentError,
  exitCode: ExitCode = ExitCode.GENERAL_ERROR,
  json = false
): never {
  console.error(formatAgentError(agentError, json));
  process.exit(exitCode);
}

/**
 * Wrap an async function to handle errors
 *
 * @param fn - Async function to wrap
 * @param json - Whether to output in JSON format
 * @returns Wrapped function that handles errors
 */
export function withErrorHandler<T extends unknown[]>(
  fn: (...args: T) => Promise<void>,
  json = false
): (...args: T) => Promise<void> {
  return async (...args: T): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      handleError(error, json);
    }
  };
}
