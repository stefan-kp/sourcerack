/**
 * Cross-platform path utilities for SourceRack
 *
 * Provides platform-independent paths for data storage.
 * Supports macOS, Linux, and Windows.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

/**
 * Application name used for directory naming
 */
const APP_NAME = 'sourcerack';

/**
 * Get the user's home directory
 *
 * Works on all platforms:
 * - macOS/Linux: /Users/username or /home/username
 * - Windows: C:\Users\username
 */
export function getHomeDir(): string {
  return homedir();
}

/**
 * Get the SourceRack data directory
 *
 * Cross-platform locations:
 * - macOS: ~/.sourcerack
 * - Linux: ~/.sourcerack (or $XDG_DATA_HOME/sourcerack if set)
 * - Windows: %LOCALAPPDATA%\sourcerack (e.g., C:\Users\username\AppData\Local\sourcerack)
 *
 * The directory is created if it doesn't exist.
 */
export function getDataDir(): string {
  let dataDir: string;

  if (process.platform === 'win32') {
    // Windows: Use LOCALAPPDATA or fallback to home
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      dataDir = join(localAppData, APP_NAME);
    } else {
      // Fallback for older Windows or missing env var
      dataDir = join(getHomeDir(), 'AppData', 'Local', APP_NAME);
    }
  } else {
    // macOS and Linux: Use XDG_DATA_HOME or ~/.sourcerack
    const xdgDataHome = process.env.XDG_DATA_HOME;
    if (xdgDataHome) {
      dataDir = join(xdgDataHome, APP_NAME);
    } else {
      // Default: ~/.sourcerack (standard for both macOS and Linux)
      dataDir = join(getHomeDir(), `.${APP_NAME}`);
    }
  }

  return dataDir;
}

/**
 * Get the default database path
 *
 * Returns the path to the SQLite database file in the data directory.
 */
export function getDefaultDatabasePath(): string {
  return join(getDataDir(), 'metadata.db');
}

/**
 * Ensure the data directory exists
 *
 * Creates the directory and any parent directories if they don't exist.
 * Returns the path to the data directory.
 */
export function ensureDataDir(): string {
  const dataDir = getDataDir();

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  return dataDir;
}

/**
 * Get a path within the data directory
 *
 * @param relativePath - Path relative to the data directory
 * @returns Absolute path
 */
export function getDataPath(relativePath: string): string {
  return join(getDataDir(), relativePath);
}

/**
 * Get the cache directory for temporary files
 *
 * Cross-platform locations:
 * - macOS: ~/Library/Caches/sourcerack
 * - Linux: ~/.cache/sourcerack (or $XDG_CACHE_HOME/sourcerack)
 * - Windows: %LOCALAPPDATA%\sourcerack\cache
 */
export function getCacheDir(): string {
  let cacheDir: string;

  if (process.platform === 'darwin') {
    // macOS: Use Library/Caches
    cacheDir = join(getHomeDir(), 'Library', 'Caches', APP_NAME);
  } else if (process.platform === 'win32') {
    // Windows: Use LOCALAPPDATA\sourcerack\cache
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      cacheDir = join(localAppData, APP_NAME, 'cache');
    } else {
      cacheDir = join(getHomeDir(), 'AppData', 'Local', APP_NAME, 'cache');
    }
  } else {
    // Linux: Use XDG_CACHE_HOME or ~/.cache
    const xdgCacheHome = process.env.XDG_CACHE_HOME;
    if (xdgCacheHome) {
      cacheDir = join(xdgCacheHome, APP_NAME);
    } else {
      cacheDir = join(getHomeDir(), '.cache', APP_NAME);
    }
  }

  return cacheDir;
}

/**
 * Ensure the cache directory exists
 */
export function ensureCacheDir(): string {
  const cacheDir = getCacheDir();

  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  return cacheDir;
}

/**
 * Get the config directory for user configuration files
 *
 * Cross-platform locations:
 * - macOS: ~/.config/sourcerack (or ~/.sourcerack for simplicity)
 * - Linux: ~/.config/sourcerack (or $XDG_CONFIG_HOME/sourcerack)
 * - Windows: %APPDATA%\sourcerack (e.g., C:\Users\username\AppData\Roaming\sourcerack)
 */
export function getConfigDir(): string {
  let configDir: string;

  if (process.platform === 'win32') {
    // Windows: Use APPDATA
    const appData = process.env.APPDATA;
    if (appData) {
      configDir = join(appData, APP_NAME);
    } else {
      configDir = join(getHomeDir(), 'AppData', 'Roaming', APP_NAME);
    }
  } else {
    // macOS and Linux: Use XDG_CONFIG_HOME or ~/.config
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    if (xdgConfigHome) {
      configDir = join(xdgConfigHome, APP_NAME);
    } else {
      configDir = join(getHomeDir(), '.config', APP_NAME);
    }
  }

  return configDir;
}
