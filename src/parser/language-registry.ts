/**
 * Language Registry for SourceRack
 *
 * Manages tree-sitter grammar discovery, loading, and on-demand installation.
 * Uses languages.yml as the source of truth for supported languages.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

/**
 * Language tier determines installation behavior
 */
export type LanguageTier = 'core' | 'optional';

/**
 * Language definition from registry
 */
export interface LanguageDefinition {
  /** Language identifier */
  id: string;
  /** File extensions that map to this language */
  extensions: string[];
  /** NPM package name for the grammar */
  package: string;
  /** Version specifier for the grammar package (optional) */
  version?: string;
  /** Submodule within package (optional) */
  submodule?: string;
  /** Installation tier */
  tier: LanguageTier;
  /** Typical source paths for this language (used for untracked file detection) */
  sourcePaths?: string[];
}

/**
 * Grammar installation result
 */
export interface GrammarInstallResult {
  /** Whether installation succeeded */
  success: boolean;
  /** Language that was installed */
  language: string;
  /** Package that was installed */
  package: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Language status
 */
export interface LanguageStatus {
  /** Language identifier */
  id: string;
  /** Whether grammar is installed */
  installed: boolean;
  /** Whether grammar is loaded */
  loaded: boolean;
  /** Installation tier */
  tier: LanguageTier;
  /** Package name */
  package: string;
}

// Get the directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Language Registry
 *
 * Discovers, loads, and manages tree-sitter grammars for multiple languages.
 */
export class LanguageRegistry {
  private languages = new Map<string, LanguageDefinition>();
  private extensionMap = new Map<string, string>();
  private loadedGrammars = new Map<string, unknown>();
  private installInProgress = new Set<string>();
  private autoInstall: boolean;

  constructor(options: { autoInstall?: boolean } = {}) {
    this.autoInstall = options.autoInstall ?? true;
    this.loadRegistry();
  }

  /**
   * Load language definitions from YAML registry
   */
  private loadRegistry(): void {
    const registryPath = join(__dirname, 'languages.yml');

    if (!existsSync(registryPath)) {
      console.warn('Language registry not found:', registryPath);
      return;
    }

    try {
      const content = readFileSync(registryPath, 'utf-8');
      const registry = parseYaml(content) as Record<
        string,
        {
          extensions: string[];
          package: string;
          version?: string;
          submodule?: string;
          tier: LanguageTier;
          sourcePaths?: string[];
        }
      >;

      for (const [id, def] of Object.entries(registry)) {
        const langDef: LanguageDefinition = {
          id,
          extensions: def.extensions,
          package: def.package,
          tier: def.tier,
        };
        // Only set version if it's defined
        if (def.version !== undefined) {
          langDef.version = def.version;
        }
        // Only set submodule if it's defined
        if (def.submodule !== undefined) {
          langDef.submodule = def.submodule;
        }
        // Only set sourcePaths if it's defined
        if (def.sourcePaths !== undefined) {
          langDef.sourcePaths = def.sourcePaths;
        }

        this.languages.set(id, langDef);

        // Build extension map
        for (const ext of def.extensions) {
          // Normalize extension (ensure leading dot)
          const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`;
          this.extensionMap.set(normalizedExt.toLowerCase(), id);
        }
      }

      console.log(
        `Language registry loaded: ${this.languages.size} languages, ${this.extensionMap.size} extensions`
      );
    } catch (error) {
      console.error('Failed to load language registry:', error);
    }
  }

  /**
   * Get language ID from file path
   */
  getLanguageForFile(filePath: string): string | null {
    // Handle special filenames (Dockerfile, Makefile, etc.)
    const basename = filePath.split('/').pop() ?? '';
    if (this.extensionMap.has(basename)) {
      return this.extensionMap.get(basename) ?? null;
    }

    // Get extension
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1) return null;

    const ext = filePath.slice(lastDot).toLowerCase();
    return this.extensionMap.get(ext) ?? null;
  }

  /**
   * Get language definition
   */
  getLanguage(id: string): LanguageDefinition | null {
    return this.languages.get(id) ?? null;
  }

  /**
   * Get all registered languages
   */
  getAllLanguages(): LanguageDefinition[] {
    return Array.from(this.languages.values());
  }

  /**
   * Get languages by tier
   */
  getLanguagesByTier(tier: LanguageTier): LanguageDefinition[] {
    return this.getAllLanguages().filter((lang) => lang.tier === tier);
  }

  /**
   * Get language ID by file extension
   */
  getLanguageByExtension(ext: string): string | null {
    const normalizedExt = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
    return this.extensionMap.get(normalizedExt) ?? null;
  }

  /**
   * Get source paths for a language (used for untracked file detection)
   */
  getSourcePaths(languageId: string): string[] | null {
    const lang = this.languages.get(languageId);
    return lang?.sourcePaths ?? null;
  }

  /**
   * Get all source paths across all languages (deduplicated)
   */
  getAllSourcePaths(): string[] {
    const paths = new Set<string>();
    for (const lang of this.languages.values()) {
      if (lang.sourcePaths) {
        for (const path of lang.sourcePaths) {
          paths.add(path);
        }
      }
    }
    return Array.from(paths);
  }

  /**
   * Check if a grammar package is installed
   */
  async isGrammarInstalled(packageName: string): Promise<boolean> {
    try {
      await import(packageName);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a language grammar is loaded
   */
  isLanguageLoaded(languageId: string): boolean {
    return this.loadedGrammars.has(languageId);
  }

  /**
   * Load a grammar for a language
   */
  async loadGrammar(languageId: string): Promise<boolean> {
    // Already loaded
    if (this.loadedGrammars.has(languageId)) {
      return true;
    }

    const langDef = this.languages.get(languageId);
    if (!langDef) {
      console.warn(`Unknown language: ${languageId}`);
      return false;
    }

    try {
      const module = await import(langDef.package);
      const moduleDefault = module.default ?? module;

      // For packages with submodules (e.g., tree-sitter-typescript has typescript and tsx)
      const grammar = langDef.submodule
        ? moduleDefault[langDef.submodule]
        : moduleDefault;

      if (grammar) {
        this.loadedGrammars.set(languageId, grammar);
        return true;
      }

      return false;
    } catch (error) {
      // Grammar not installed
      if (this.autoInstall && langDef.tier === 'optional') {
        // Try to install
        const result = await this.installGrammar(languageId);
        if (result.success) {
          // Retry loading
          return this.loadGrammar(languageId);
        }
      }
      return false;
    }
  }

  /**
   * Get loaded grammar
   */
  getGrammar(languageId: string): unknown | null {
    return this.loadedGrammars.get(languageId) ?? null;
  }

  /**
   * Install a grammar package
   */
  async installGrammar(languageId: string): Promise<GrammarInstallResult> {
    const langDef = this.languages.get(languageId);
    if (!langDef) {
      return {
        success: false,
        language: languageId,
        package: '',
        error: `Unknown language: ${languageId}`,
      };
    }

    // Prevent concurrent installations of the same package
    if (this.installInProgress.has(langDef.package)) {
      // Wait for ongoing installation
      await this.waitForInstallation(langDef.package);
      return {
        success: await this.isGrammarInstalled(langDef.package),
        language: languageId,
        package: langDef.package,
      };
    }

    this.installInProgress.add(langDef.package);

    try {
      // Build package specifier with version if available
      const packageSpec = langDef.version
        ? `${langDef.package}@${langDef.version}`
        : langDef.package;

      console.log(`Installing grammar for ${languageId}: ${packageSpec}`);

      // Use npm to install the package with legacy-peer-deps to avoid peer dep conflicts
      execSync(`npm install --save --legacy-peer-deps ${packageSpec}`, {
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 120000, // 2 minute timeout for native builds
      });

      console.log(`Successfully installed grammar: ${packageSpec}`);

      return {
        success: true,
        language: languageId,
        package: langDef.package,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      // Log a clean warning instead of the full error object
      console.warn(`⚠️  Grammar install failed for ${langDef.package}: ${errorMessage.split('\n')[0]}`);

      return {
        success: false,
        language: languageId,
        package: langDef.package,
        error: errorMessage,
      };
    } finally {
      this.installInProgress.delete(langDef.package);
    }
  }

  /**
   * Wait for an ongoing installation to complete
   */
  private async waitForInstallation(packageName: string): Promise<void> {
    const maxWait = 120000; // 2 minutes
    const interval = 1000; // 1 second
    let waited = 0;

    while (this.installInProgress.has(packageName) && waited < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      waited += interval;
    }
  }

  /**
   * Initialize core languages (load all tier=core grammars)
   */
  async initializeCore(): Promise<void> {
    const coreLanguages = this.getLanguagesByTier('core');

    for (const lang of coreLanguages) {
      await this.loadGrammar(lang.id);
    }

    console.log(
      `Initialized ${this.loadedGrammars.size} core language grammars`
    );
  }

  /**
   * Get status of all languages
   */
  async getLanguageStatus(): Promise<LanguageStatus[]> {
    const statuses: LanguageStatus[] = [];

    for (const lang of this.languages.values()) {
      const installed = await this.isGrammarInstalled(lang.package);
      const loaded = this.isLanguageLoaded(lang.id);

      statuses.push({
        id: lang.id,
        installed,
        loaded,
        tier: lang.tier,
        package: lang.package,
      });
    }

    return statuses;
  }

  /**
   * Ensure grammar is available for a language
   * Will install if necessary and autoInstall is enabled
   */
  async ensureGrammar(languageId: string): Promise<boolean> {
    // Already loaded
    if (this.isLanguageLoaded(languageId)) {
      return true;
    }

    // Try to load (will auto-install if needed)
    return this.loadGrammar(languageId);
  }

  /**
   * Get missing grammars for a list of file paths
   * Useful for pre-checking before indexing
   */
  async getMissingGrammars(filePaths: string[]): Promise<LanguageDefinition[]> {
    const requiredLanguages = new Set<string>();

    for (const filePath of filePaths) {
      const langId = this.getLanguageForFile(filePath);
      if (langId) {
        requiredLanguages.add(langId);
      }
    }

    const missing: LanguageDefinition[] = [];

    for (const langId of requiredLanguages) {
      const langDef = this.languages.get(langId);
      if (!langDef) continue;

      const installed = await this.isGrammarInstalled(langDef.package);
      if (!installed) {
        missing.push(langDef);
      }
    }

    return missing;
  }

  /**
   * Pre-install grammars for a list of file paths
   * Returns list of successfully installed packages
   */
  async preInstallGrammars(filePaths: string[]): Promise<GrammarInstallResult[]> {
    const missing = await this.getMissingGrammars(filePaths);
    const results: GrammarInstallResult[] = [];

    for (const lang of missing) {
      const result = await this.installGrammar(lang.id);
      results.push(result);
    }

    return results;
  }
}

// Singleton instance
let registryInstance: LanguageRegistry | null = null;

/**
 * Get the language registry singleton
 */
export function getLanguageRegistry(
  options?: { autoInstall?: boolean }
): LanguageRegistry {
  registryInstance ??= new LanguageRegistry(options);
  return registryInstance;
}

/**
 * Reset the registry (for testing)
 */
export function resetLanguageRegistry(): void {
  registryInstance = null;
}
