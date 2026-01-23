/**
 * Repository filtering utilities for CLI commands
 *
 * Provides functionality to resolve repository names/paths to IDs
 * and filter repositories for --repos, --all-repos, and --group options.
 */

import type { MetadataStorage } from '../storage/metadata.js';
import type { RepositoryRecord } from '../storage/types.js';
import { getGroup, getDefaultGroup } from '../config/groups.js';
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

/**
 * Resolve repositories from a group name
 *
 * @param metadata - Metadata storage instance
 * @param groupName - Name of the group
 * @returns Resolved repositories
 * @throws InvalidArgumentError if group not found
 */
export function resolveGroupRepos(
  metadata: MetadataStorage,
  groupName: string
): ResolvedRepos {
  const group = getGroup(groupName);

  if (!group) {
    throw new InvalidArgumentError(
      `Group not found: "${groupName}"\n\nRun 'sourcerack group list' to see available groups.`
    );
  }

  return resolveRepoIdentifiers(metadata, group.repos);
}

/**
 * Options for resolving repository filters
 */
export interface RepoFilterOptions {
  /** Specific repos to filter by (names or paths) */
  repos?: string | string[];
  /** Whether to include all repos */
  allRepos?: boolean;
  /** Group name to use */
  group?: string;
  /** Whether to use default group if no filter specified */
  useDefaultGroup?: boolean;
}

/**
 * Resolve repositories based on filter options
 *
 * Priority:
 * 1. --repos (explicit list)
 * 2. --group (named group)
 * 3. --all-repos (all indexed repos)
 * 4. Default group (if useDefaultGroup is true)
 * 5. Current directory repo only
 *
 * @param metadata - Metadata storage instance
 * @param options - Filter options
 * @param currentRepoId - ID of current directory repo (optional)
 * @returns Resolved repositories
 */
export function resolveRepoFilters(
  metadata: MetadataStorage,
  options: RepoFilterOptions,
  currentRepoId?: string
): ResolvedRepos {
  // Priority 1: Explicit --repos
  const reposList = parseReposOption(options.repos);
  if (reposList.length > 0) {
    return resolveRepoIdentifiers(metadata, reposList);
  }

  // Priority 2: --group
  if (options.group) {
    return resolveGroupRepos(metadata, options.group);
  }

  // Priority 3: --all-repos
  if (options.allRepos) {
    return getAllRepos(metadata);
  }

  // Priority 4: Default group (if enabled and set)
  if (options.useDefaultGroup !== false) {
    const defaultGroup = getDefaultGroup();
    if (defaultGroup) {
      try {
        return resolveGroupRepos(metadata, defaultGroup);
      } catch {
        // Default group might reference non-existent repos, fall through
      }
    }
  }

  // Priority 5: Current repo only
  if (currentRepoId) {
    const allRepos = metadata.listRepositories();
    const currentRepo = allRepos.find((r) => r.id === currentRepoId);
    if (currentRepo) {
      return {
        repoIds: [currentRepoId],
        repos: [currentRepo],
      };
    }
  }

  // No filters, return empty
  return {
    repoIds: [],
    repos: [],
  };
}
