/**
 * Output formatting for CLI
 *
 * Provides human-readable and JSON output formatters for CLI commands.
 */

import type { IndexingResult } from '../indexer/types.js';

/**
 * Output options for formatting
 */
export interface OutputOptions {
  /** Output in JSON format */
  json?: boolean;
  /** Suppress non-essential output */
  quiet?: boolean;
}

/**
 * Repository info for display
 */
export interface RepoDisplayInfo {
  id: string;
  name: string;
  path: string;
  indexedCommitCount: number;
  /** Number of commits with embeddings */
  embeddingsCompleteCount: number;
  /** Number of commits without embeddings (SQI only) */
  embeddingsNoneCount: number;
}

/**
 * Indexed commit info for display
 */
export interface CommitDisplayInfo {
  commitSha: string;
  status: 'complete' | 'in_progress' | 'failed';
  indexedAt?: string;
  chunkCount?: number;
  branch?: string;
}

/**
 * Query result for display
 */
export interface QueryResultDisplay {
  id: string;
  score: number;
  path: string;
  symbol: string;
  symbolType: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  /** Repository name (populated in cross-repo queries) */
  repoName?: string;
  /** Repository path (populated in cross-repo queries) */
  repoPath?: string;
}

/**
 * Query output for display
 */
export interface QueryOutputDisplay {
  success: boolean;
  indexed: boolean;
  results: QueryResultDisplay[];
  totalCount: number;
  error?: string;
}

/**
 * Status output for display
 */
export interface StatusOutputDisplay {
  status: 'not_indexed' | 'in_progress' | 'complete' | 'failed';
  repoId?: string;
  commitSha: string;
  indexedAt?: string;
  chunkCount?: number;
}

/**
 * Format indexing result for output
 */
export function formatIndexResult(result: IndexingResult, options: OutputOptions): void {
  if (options.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.success) {
    // Check if incremental indexing was used
    const isIncremental = result.baseCommitSha !== undefined;

    if (isIncremental) {
      console.log(`\n✨ Incremental indexing complete:`);
      console.log(`  Base commit: ${result.baseCommitSha?.substring(0, 8)}`);
      console.log(`  New commit: ${result.commitSha.substring(0, 8)}`);
      console.log(`  Changed files: ${String(result.changedFiles ?? 0)}`);
      console.log(`  Unchanged files: ${String(result.unchangedFiles ?? 0)} (reused)`);
      console.log(`  Files processed: ${String(result.filesProcessed)}`);
      console.log(`  Chunks created: ${String(result.chunksCreated)}`);
      console.log(`  Chunks reused: ${String(result.chunksReused)}`);
      console.log(`  Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
    } else {
      console.log(`\nIndexing complete:`);
      console.log(`  Repository: ${result.repoId}`);
      console.log(`  Commit: ${result.commitSha.substring(0, 8)}`);
      console.log(`  Files processed: ${String(result.filesProcessed)}`);
      console.log(`  Chunks created: ${String(result.chunksCreated)}`);
      console.log(`  Chunks reused: ${String(result.chunksReused)}`);
      console.log(`  Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
    }

    // Show file coverage summary
    if (result.fileCoverage) {
      const coverage = result.fileCoverage;
      console.log(`\n📊 Language Coverage:`);

      // Show supported languages
      const supported = coverage.byLanguage.filter((l) => l.sqiSupported);
      if (supported.length > 0) {
        console.log(`  ✅ Symbol extraction supported (${coverage.sqiSupportedFiles} files):`);
        for (const lang of supported) {
          console.log(`     ${lang.language}: ${lang.fileCount} files`);
        }
      }

      // Show unsupported languages with warning
      const unsupported = coverage.byLanguage.filter((l) => !l.sqiSupported);
      if (unsupported.length > 0) {
        console.log(`  ⚠️  No symbol extraction (${coverage.unsupportedFiles} files):`);
        for (const lang of unsupported) {
          console.log(`     ${lang.language}: ${lang.fileCount} files (embeddings only)`);
        }
        console.log(`\n  💡 Tip: Run 'sourcerack query' for semantic search on these files.`);
        console.log(`     Symbol commands (find-def, find-usages) only work with supported languages.`);
      }
    }
  } else {
    console.error(`\nIndexing failed:`);
    console.error(`  Commit: ${result.commitSha.substring(0, 8)}`);
    console.error(`  Error: ${result.error ?? 'Unknown error'}`);
  }
}

/**
 * Extended output options for query
 */
export interface QueryOutputOptions extends OutputOptions {
  /** Whether this is a cross-repo search */
  allRepos?: boolean;
}

/**
 * Format query results for output
 */
export function formatQueryResults(output: QueryOutputDisplay, options: QueryOutputOptions): void {
  if (options.json === true) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (!output.success) {
    console.error(`Query failed: ${output.error ?? 'Unknown error'}`);
    return;
  }

  if (!output.indexed) {
    console.error('Commit is not indexed. Run `sourcerack index` first.');
    return;
  }

  if (output.results.length === 0) {
    console.log('No results found.');
    return;
  }

  const reposNote = options.allRepos ? ' (across all repos)' : '';
  console.log(`Found ${String(output.totalCount)} result(s)${reposNote}:\n`);

  for (const result of output.results) {
    const scorePercent = (result.score * 100).toFixed(1);
    const repoPrefix = options.allRepos && result.repoName ? `[${result.repoName}] ` : '';
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📄 ${repoPrefix}${result.path}:${String(result.startLine)}-${String(result.endLine)}`);
    console.log(`   ${result.symbolType}: ${result.symbol} (${result.language}) [${scorePercent}%]`);
    console.log('');
    // Indent content
    const lines = result.content.split('\n');
    for (const line of lines.slice(0, 15)) {
      console.log(`   ${line}`);
    }
    if (lines.length > 15) {
      console.log(`   ... (${String(lines.length - 15)} more lines)`);
    }
    console.log('');
  }
}

/**
 * Format status output
 */
export function formatStatus(output: StatusOutputDisplay, options: OutputOptions): void {
  if (options.json === true) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const statusEmoji: Record<string, string> = {
    complete: '✅',
    in_progress: '🔄',
    failed: '❌',
    not_indexed: '⚪',
  };

  const emoji = statusEmoji[output.status] ?? '❓';
  console.log(`${emoji} Commit ${output.commitSha.substring(0, 8)}: ${output.status}`);

  if (output.repoId !== undefined) {
    console.log(`   Repository ID: ${output.repoId}`);
  }

  if (output.status === 'complete') {
    if (output.indexedAt !== undefined) {
      console.log(`   Indexed at: ${output.indexedAt}`);
    }
    if (output.chunkCount !== undefined) {
      console.log(`   Chunks: ${String(output.chunkCount)}`);
    }
  }
}

/**
 * Format list of commits for status --all
 */
export function formatCommitList(
  repoName: string,
  commits: CommitDisplayInfo[],
  options: OutputOptions
): void {
  if (options.json === true) {
    console.log(JSON.stringify({ repository: repoName, commits }, null, 2));
    return;
  }

  console.log(`\nRepository: ${repoName}`);
  console.log('━'.repeat(50));

  if (commits.length === 0) {
    console.log('  No indexed commits.');
    return;
  }

  for (const commit of commits) {
    const statusEmoji: Record<string, string> = {
      complete: '✅',
      in_progress: '🔄',
      failed: '❌',
    };

    const emoji = statusEmoji[commit.status] ?? '❓';
    const sha = commit.commitSha.substring(0, 8);
    const branch = commit.branch !== undefined ? ` (${commit.branch})` : '';
    const chunks =
      commit.chunkCount !== undefined ? ` - ${String(commit.chunkCount)} chunks` : '';
    const date = commit.indexedAt !== undefined ? ` - ${commit.indexedAt}` : '';

    console.log(`  ${emoji} ${sha}${branch}${chunks}${date}`);
  }
}

/**
 * Format repositories list
 */
export function formatRepositories(repos: RepoDisplayInfo[], options: OutputOptions): void {
  if (options.json === true) {
    console.log(JSON.stringify({ repositories: repos }, null, 2));
    return;
  }

  if (repos.length === 0) {
    console.log('No registered repositories.');
    return;
  }

  console.log(`\nRegistered repositories (${String(repos.length)}):\n`);

  for (const repo of repos) {
    console.log(`📁 ${repo.name}`);
    console.log(`   Path: ${repo.path}`);
    console.log(`   ID: ${repo.id}`);
    console.log(`   Indexed commits: ${String(repo.indexedCommitCount)}`);

    // Show index type breakdown
    if (repo.indexedCommitCount > 0) {
      const parts: string[] = [];
      if (repo.embeddingsNoneCount > 0) {
        parts.push(`${String(repo.embeddingsNoneCount)} SQI only`);
      }
      if (repo.embeddingsCompleteCount > 0) {
        parts.push(`${String(repo.embeddingsCompleteCount)} with embeddings`);
      }
      if (parts.length > 0) {
        console.log(`   Index types: ${parts.join(', ')}`);
      }
    }
    console.log('');
  }
}

/**
 * Format GC result
 */
export interface GCResult {
  dryRun: boolean;
  chunksDeleted: number;
  commitsDeleted: number;
  bytesFreed?: number;
}

export function formatGCResult(result: GCResult, options: OutputOptions): void {
  if (options.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.dryRun) {
    console.log('\n[Dry run - no changes made]');
    console.log(`  Would delete ${String(result.commitsDeleted)} commit(s)`);
    console.log(`  Would delete ${String(result.chunksDeleted)} orphaned chunk(s)`);
  } else {
    console.log('\nGarbage collection complete:');
    console.log(`  Commits deleted: ${String(result.commitsDeleted)}`);
    console.log(`  Chunks deleted: ${String(result.chunksDeleted)}`);
  }
}
