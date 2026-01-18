/**
 * Progress display for CLI
 *
 * Displays indexing progress to stderr for clean stdout output.
 */

import type { IndexingProgressEvent } from '../indexer/types.js';

/**
 * Progress display options
 */
export interface ProgressOptions {
  /** Suppress progress output */
  quiet?: boolean;
  /** Output in JSON format (disables progress display) */
  json?: boolean;
}

/**
 * Progress display class
 *
 * Handles progress output to stderr with in-place updates.
 */
export class ProgressDisplay {
  private quiet: boolean;
  private json: boolean;
  private lastLineLength = 0;
  private isTerminal: boolean;

  constructor(options: ProgressOptions = {}) {
    this.quiet = options.quiet === true;
    this.json = options.json === true;
    // Check if stderr is a TTY - isTTY is true when connected to a terminal
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
    this.isTerminal = process.stderr.isTTY === true;
  }

  /**
   * Clear the current progress line
   */
  private clearLine(): void {
    if (this.isTerminal) {
      process.stderr.write('\r' + ' '.repeat(this.lastLineLength) + '\r');
    }
  }

  /**
   * Write a progress line (in-place update)
   */
  private writeLine(text: string): void {
    if (this.isTerminal) {
      this.clearLine();
      process.stderr.write(text);
      this.lastLineLength = text.length;
    } else {
      // Non-interactive: write new lines
      process.stderr.write(text + '\n');
    }
  }

  /**
   * Write a permanent message (moves to new line)
   */
  private writeMessage(text: string): void {
    if (this.isTerminal) {
      this.clearLine();
    }
    process.stderr.write(text + '\n');
    this.lastLineLength = 0;
  }

  /**
   * Handle an indexing progress event
   */
  handleProgress(event: IndexingProgressEvent): void {
    // Skip output in quiet or JSON mode
    if (this.quiet || this.json) {
      return;
    }

    switch (event.type) {
      case 'started':
        this.writeMessage(`\n🚀 Starting indexing for commit ${event.commitSha.substring(0, 8)}...`);
        break;

      case 'files_listed':
        this.writeMessage(`📋 Found ${String(event.totalFiles ?? 0)} files to process`);
        break;

      case 'grammars_installing':
        if (event.missingGrammars !== undefined && event.missingGrammars.length > 0) {
          this.writeMessage(
            `📦 Installing grammars: ${event.missingGrammars.join(', ')}`
          );
        }
        break;

      case 'file_parsed': {
        const processed = event.filesProcessed ?? 0;
        const total = event.totalFiles ?? 0;
        const percent = total > 0 ? Math.round((processed / total) * 100) : 0;
        const file = event.currentFile ?? '';
        const shortFile = file.length > 40 ? '...' + file.slice(-37) : file;
        this.writeLine(`📄 [${String(percent)}%] ${String(processed)}/${String(total)} files - ${shortFile}`);
        break;
      }

      case 'chunks_embedded': {
        const chunks = event.chunksCreated ?? 0;
        const reused = event.chunksReused ?? 0;
        this.writeLine(`🧠 Embedded ${String(chunks)} chunks (${String(reused)} reused)`);
        break;
      }

      case 'chunks_stored': {
        const chunks = event.chunksCreated ?? 0;
        this.writeLine(`💾 Stored ${String(chunks)} chunks in vector database`);
        break;
      }

      case 'completed': {
        this.clearLine();
        this.writeMessage(`\n✅ Indexing completed`);
        break;
      }

      case 'failed':
        this.clearLine();
        this.writeMessage(`\n❌ Indexing failed: ${event.error ?? 'Unknown error'}`);
        break;
    }
  }

  /**
   * Create a progress callback function
   */
  createCallback(): (event: IndexingProgressEvent) => void {
    return (event: IndexingProgressEvent): void => {
      this.handleProgress(event);
    };
  }

  /**
   * Finalize progress display (ensure clean state)
   */
  finish(): void {
    if (this.isTerminal && this.lastLineLength > 0) {
      this.clearLine();
    }
  }
}

/**
 * Create a progress display with options
 */
export function createProgressDisplay(options: ProgressOptions = {}): ProgressDisplay {
  return new ProgressDisplay(options);
}
