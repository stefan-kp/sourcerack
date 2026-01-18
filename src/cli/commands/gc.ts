/**
 * CLI command: gc
 *
 * Clean up orphaned data and expired index entries.
 */

import { Command } from 'commander';
import { withContext } from '../context.js';
import { formatGCResult, type GCResult } from '../output.js';
import { handleError } from '../errors.js';

/**
 * GC command options
 */
interface GCOptions {
  dryRun?: boolean;
  json?: boolean;
}

/**
 * Execute the gc command
 */
async function executeGC(options: GCOptions): Promise<void> {
  const isJson = options.json === true;
  const isDryRun = options.dryRun === true;

  try {
    const result = await withContext(async (context) => {
      // Get commits eligible for GC
      const eligibleCommits = context.metadata.getEligibleForGC();

      if (eligibleCommits.length === 0 && !isDryRun) {
        // Also check for orphaned chunks
        // Note: getOrphanedChunkIds might return empty for proper implementation
        // For now, just report no work to do
      }

      // Collect commit IDs for chunk lookup
      const commitIds = eligibleCommits.map((c) => c.commit_id);

      // Get chunks that are only used by these commits
      const chunksToDelete =
        commitIds.length > 0
          ? context.metadata.getChunksOnlyInCommits(commitIds)
          : [];

      const gcResult: GCResult = {
        dryRun: isDryRun,
        chunksDeleted: 0,
        commitsDeleted: 0,
      };

      if (isDryRun) {
        // Just report what would be done
        gcResult.commitsDeleted = eligibleCommits.length;
        gcResult.chunksDeleted = chunksToDelete.length;
        return gcResult;
      }

      // Actually perform the cleanup
      if (chunksToDelete.length > 0) {
        // Delete chunks from vector storage
        await context.vectors.deleteChunks(chunksToDelete);
        gcResult.chunksDeleted = chunksToDelete.length;
      }

      // Delete commit records and their references
      for (const candidate of eligibleCommits) {
        // Delete chunk references for this commit
        context.metadata.deleteChunkRefsForCommit(candidate.commit_id);

        // Delete the indexed commit record
        context.metadata.deleteIndexedCommit(candidate.commit_id);

        gcResult.commitsDeleted++;
      }

      // Remove the GC candidates that we processed
      for (const candidate of eligibleCommits) {
        context.metadata.removeFromGCCandidates(candidate.commit_id);
      }

      return gcResult;
    });

    // Format and output result
    formatGCResult(result, { json: isJson });
  } catch (error) {
    handleError(error, isJson);
  }
}

/**
 * Register the gc command with the program
 */
export function registerGCCommand(program: Command): void {
  program
    .command('gc')
    .description('Clean up orphaned data and expired index entries')
    .option('-n, --dry-run', 'Show what would be deleted without actually deleting')
    .option('--json', 'Output in JSON format')
    .action(async (options: GCOptions) => {
      await executeGC(options);
    });
}
