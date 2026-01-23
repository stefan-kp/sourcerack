/**
 * Repository group management utilities
 *
 * Provides functions to manage repository groups in the configuration.
 * Groups allow organizing repositories into logical collections for
 * easier multi-repo operations.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getGlobalConfigPath } from './config.js';
import type { RepoGroup } from './schema.js';

/**
 * Group information with name
 */
export interface GroupInfo {
  name: string;
  repos: string[];
  description: string | undefined;
}

/**
 * Load raw config file content
 */
function loadRawConfig(): Record<string, unknown> {
  const configPath = getGlobalConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Save raw config to file
 */
function saveRawConfig(config: Record<string, unknown>): void {
  const configPath = getGlobalConfigPath();
  const dir = dirname(configPath);

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * List all repository groups
 */
export function listGroups(): GroupInfo[] {
  const config = loadRawConfig();
  const groups = (config.groups ?? {}) as Record<string, RepoGroup>;

  return Object.entries(groups).map(([name, group]) => ({
    name,
    repos: group.repos,
    description: group.description,
  }));
}

/**
 * Get a specific group by name
 */
export function getGroup(name: string): GroupInfo | null {
  const config = loadRawConfig();
  const groups = (config.groups ?? {}) as Record<string, RepoGroup>;
  const group = groups[name];

  if (!group) {
    return null;
  }

  return {
    name,
    repos: group.repos,
    description: group.description,
  };
}

/**
 * Add or update a repository group
 */
export function addGroup(
  name: string,
  repos: string[],
  description?: string
): void {
  const config = loadRawConfig();

  if (!config.groups) {
    config.groups = {};
  }

  const groups = config.groups as Record<string, RepoGroup>;
  const groupData: RepoGroup = { repos };
  if (description) {
    groupData.description = description;
  }

  groups[name] = groupData;
  saveRawConfig(config);
}

/**
 * Remove a repository group
 */
export function removeGroup(name: string): boolean {
  const config = loadRawConfig();
  const groups = (config.groups ?? {}) as Record<string, RepoGroup>;

  if (!groups[name]) {
    return false;
  }

  delete groups[name];

  // Also clear defaultGroup if it was this group
  if (config.defaultGroup === name) {
    delete config.defaultGroup;
  }

  saveRawConfig(config);
  return true;
}

/**
 * Add repositories to an existing group
 */
export function addReposToGroup(name: string, repos: string[]): boolean {
  const config = loadRawConfig();
  const groups = (config.groups ?? {}) as Record<string, RepoGroup>;
  const group = groups[name];

  if (!group) {
    return false;
  }

  // Add new repos, avoiding duplicates
  const existingSet = new Set(group.repos);
  for (const repo of repos) {
    existingSet.add(repo);
  }
  group.repos = Array.from(existingSet);

  saveRawConfig(config);
  return true;
}

/**
 * Remove repositories from an existing group
 */
export function removeReposFromGroup(name: string, repos: string[]): boolean {
  const config = loadRawConfig();
  const groups = (config.groups ?? {}) as Record<string, RepoGroup>;
  const group = groups[name];

  if (!group) {
    return false;
  }

  const reposToRemove = new Set(repos);
  group.repos = group.repos.filter((r) => !reposToRemove.has(r));

  // Don't allow empty groups
  if (group.repos.length === 0) {
    delete groups[name];
    if (config.defaultGroup === name) {
      delete config.defaultGroup;
    }
  }

  saveRawConfig(config);
  return true;
}

/**
 * Set the default group
 */
export function setDefaultGroup(name: string | null): boolean {
  const config = loadRawConfig();

  if (name === null) {
    delete config.defaultGroup;
    saveRawConfig(config);
    return true;
  }

  const groups = (config.groups ?? {}) as Record<string, RepoGroup>;
  if (!groups[name]) {
    return false;
  }

  config.defaultGroup = name;
  saveRawConfig(config);
  return true;
}

/**
 * Get the default group name
 */
export function getDefaultGroup(): string | null {
  const config = loadRawConfig();
  return (config.defaultGroup as string) ?? null;
}

/**
 * Check if a group exists
 */
export function groupExists(name: string): boolean {
  const config = loadRawConfig();
  const groups = (config.groups ?? {}) as Record<string, RepoGroup>;
  return name in groups;
}
