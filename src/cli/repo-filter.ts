/**
 * Repository filtering utilities for CLI commands
 *
 * Provides functionality to resolve repository names/paths to IDs
 * and filter repositories for --repos and --all-repos options.
 */

import type { MetadataStorage } from '../storage/metadata.js';
import type { RepositoryRecord } from '../storage/types.js';
import { InvalidArgumentError } from './errors.js';

/**
 * Result of resolving repository filters
 */
export interface ResolvedRepos {
  /** Repository IDs to query */
  repoIds: string[];
  /** Repository records for display purposes */
  repos: RepositoryRecord[];
}

/**
 * Resolve a single repo identifier (name or path) to a repository record
 *
 * @param metadata - Metadata storage instance
 * @param identifier - Repository name or path
 * @returns Repository record
 * @throws InvalidArgumentError if not found or ambiguous
 */
export function resolveRepoIdentifier(
  metadata: MetadataStorage,
  identifier: string
): RepositoryRecord {
  // Try exact path match first
  const byPath = metadata.getRepositoryByPath(identifier);
  if (byPath !== null) {
    return byPath;
  }

  // Try by name
  const allRepos = metadata.listRepositories();
  const byName = allRepos.filter((r) => r.name === identifier);

  if (byName.length === 1) {
    return byName[0]!;
  }

  if (byName.length > 1) {
    // Ambiguous name - list all matching repos
    const paths = byName.map((r) => `  - ${r.path}`).join('\n');
    throw new InvalidArgumentError(
      `Ambiguous repository name "${identifier}". Multiple repositories found:\n${paths}\n\nUse the full path to specify which one.`
    );
  }

  // Not found - provide helpful error
  const availableNames = allRepos.map((r) => r.name).join(', ');
  throw new InvalidArgumentError(
    `Repository not found: "${identifier}"\n\nAvailable repositories: ${availableNames || '(none indexed)'}\n\nRun 'sourcerack repos' to see all indexed repositories.`
  );
}

/**
 * Resolve multiple repo identifiers to repository records
 *
 * @param metadata - Metadata storage instance
 * @param identifiers - Array of repository names or paths
 * @returns Resolved repositories
 */
export function resolveRepoIdentifiers(
  metadata: MetadataStorage,
  identifiers: string[]
): ResolvedRepos {
  const repos: RepositoryRecord[] = [];
  const seenIds = new Set<string>();

  for (const identifier of identifiers) {
    const repo = resolveRepoIdentifier(metadata, identifier);
    if (!seenIds.has(repo.id)) {
      repos.push(repo);
      seenIds.add(repo.id);
    }
  }

  return {
    repoIds: repos.map((r) => r.id),
    repos,
  };
}

/**
 * Get all indexed repositories
 *
 * @param metadata - Metadata storage instance
 * @returns All repositories
 */
export function getAllRepos(metadata: MetadataStorage): ResolvedRepos {
  const repos = metadata.listRepositories();
  return {
    repoIds: repos.map((r) => r.id),
    repos,
  };
}

/**
 * Parse --repos option value
 *
 * Handles comma-separated values and multiple --repos flags
 *
 * @param reposOption - Value from commander (string or string[])
 * @returns Array of repo identifiers
 */
export function parseReposOption(reposOption: string | string[] | undefined): string[] {
  if (reposOption === undefined) {
    return [];
  }

  // Commander with .option('--repos <names...>') gives us string[]
  // But with .option('--repos <names>') (no ...) gives us string
  const values = Array.isArray(reposOption) ? reposOption : [reposOption];

  // Also handle comma-separated values within each entry
  const result: string[] = [];
  for (const value of values) {
    const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
    result.push(...parts);
  }

  return result;
}
