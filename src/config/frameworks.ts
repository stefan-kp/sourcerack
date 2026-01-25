/**
 * Framework detection and preset configurations
 *
 * Provides boost patterns optimized for different frameworks and languages.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BoostConfig, FrameworkPreset } from './schema.js';

/**
 * Framework detection markers
 */
interface FrameworkMarker {
  /** Files or directories that indicate this framework */
  markers: string[];
  /** Framework preset name */
  preset: FrameworkPreset;
  /** Human-readable name */
  displayName: string;
}

/**
 * Framework detection rules (ordered by specificity)
 */
const FRAMEWORK_MARKERS: FrameworkMarker[] = [
  // Ruby on Rails
  {
    markers: ['Gemfile', 'config/routes.rb', 'app/controllers'],
    preset: 'rails',
    displayName: 'Ruby on Rails',
  },
  // Node.js / JavaScript
  {
    markers: ['package.json', 'node_modules'],
    preset: 'nodejs',
    displayName: 'Node.js',
  },
  // Go
  {
    markers: ['go.mod', 'go.sum'],
    preset: 'go',
    displayName: 'Go',
  },
  // Python
  {
    markers: ['requirements.txt', 'pyproject.toml', 'setup.py', 'manage.py'],
    preset: 'python',
    displayName: 'Python',
  },
  // Java / Spring
  {
    markers: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    preset: 'java',
    displayName: 'Java',
  },
  // Rust
  {
    markers: ['Cargo.toml'],
    preset: 'rust',
    displayName: 'Rust',
  },
];

/**
 * Framework-specific boost configurations
 */
export const FRAMEWORK_PRESETS: Record<FrameworkPreset, BoostConfig> = {
  auto: {
    enabled: true,
    penalties: [],
    bonuses: [],
  },
  rails: {
    enabled: true,
    penalties: [
      // Test directories
      { pattern: '/spec/', factor: 0.5 },
      { pattern: '/test/', factor: 0.5 },
      { pattern: '_spec.rb', factor: 0.5 },
      { pattern: '_test.rb', factor: 0.5 },
      // Fixtures and factories
      { pattern: '/fixtures/', factor: 0.4 },
      { pattern: '/factories/', factor: 0.4 },
      // Generated files
      { pattern: '/tmp/', factor: 0.3 },
      { pattern: '/log/', factor: 0.3 },
      { pattern: '/public/assets/', factor: 0.3 },
      { pattern: '.min.js', factor: 0.3 },
    ],
    bonuses: [
      // Application code (highest priority)
      { pattern: '/app/models/', factor: 1.3 },
      { pattern: '/app/controllers/', factor: 1.3 },
      { pattern: '/app/services/', factor: 1.3 },
      { pattern: '/app/jobs/', factor: 1.2 },
      { pattern: '/app/mailers/', factor: 1.2 },
      { pattern: '/app/', factor: 1.15 },
      // Library code
      { pattern: '/lib/', factor: 1.2 },
      // Configuration
      { pattern: '/config/', factor: 1.1 },
    ],
  },
  nodejs: {
    enabled: true,
    penalties: [
      // Test directories
      { pattern: '/test/', factor: 0.5 },
      { pattern: '/tests/', factor: 0.5 },
      { pattern: '/__tests__/', factor: 0.5 },
      { pattern: '.test.', factor: 0.5 },
      { pattern: '.spec.', factor: 0.5 },
      // Mocks
      { pattern: '/__mocks__/', factor: 0.4 },
      { pattern: '/mock/', factor: 0.4 },
      // Build artifacts
      { pattern: '/dist/', factor: 0.4 },
      { pattern: '/build/', factor: 0.4 },
      { pattern: '.min.js', factor: 0.3 },
      { pattern: '.bundle.', factor: 0.4 },
    ],
    bonuses: [
      // Source code
      { pattern: '/src/', factor: 1.25 },
      { pattern: '/lib/', factor: 1.2 },
      // Core modules
      { pattern: '/core/', factor: 1.2 },
      { pattern: '/services/', factor: 1.15 },
      { pattern: '/api/', factor: 1.15 },
      { pattern: '/controllers/', factor: 1.15 },
      { pattern: '/models/', factor: 1.15 },
    ],
  },
  go: {
    enabled: true,
    penalties: [
      // Test files
      { pattern: '_test.go', factor: 0.5 },
      { pattern: '/testdata/', factor: 0.4 },
      { pattern: '/test/', factor: 0.5 },
      // Generated files
      { pattern: '.pb.go', factor: 0.6 },  // Protobuf generated
      { pattern: '_gen.go', factor: 0.6 },
      { pattern: '/generated/', factor: 0.5 },
      // Vendor (if not using modules)
      { pattern: '/vendor/', factor: 0.4 },
    ],
    bonuses: [
      // Main entry points
      { pattern: '/cmd/', factor: 1.25 },
      // Internal packages (core logic)
      { pattern: '/internal/', factor: 1.2 },
      // Public packages
      { pattern: '/pkg/', factor: 1.15 },
      // API definitions
      { pattern: '/api/', factor: 1.15 },
    ],
  },
  python: {
    enabled: true,
    penalties: [
      // Test directories
      { pattern: '/tests/', factor: 0.5 },
      { pattern: '/test/', factor: 0.5 },
      { pattern: '_test.py', factor: 0.5 },
      { pattern: 'test_', factor: 0.5 },
      // Fixtures
      { pattern: '/conftest.py', factor: 0.6 },
      { pattern: '/fixtures/', factor: 0.4 },
      // Migrations
      { pattern: '/migrations/', factor: 0.6 },
      // Virtual environments
      { pattern: '/venv/', factor: 0.3 },
      { pattern: '/.venv/', factor: 0.3 },
      { pattern: '/__pycache__/', factor: 0.3 },
    ],
    bonuses: [
      // Source code
      { pattern: '/src/', factor: 1.2 },
      // Django/Flask patterns
      { pattern: '/views/', factor: 1.15 },
      { pattern: '/models/', factor: 1.2 },
      { pattern: '/services/', factor: 1.2 },
      { pattern: '/api/', factor: 1.15 },
      // Core modules
      { pattern: '/core/', factor: 1.2 },
      { pattern: '/lib/', factor: 1.15 },
    ],
  },
  java: {
    enabled: true,
    penalties: [
      // Test directories
      { pattern: '/test/', factor: 0.5 },
      { pattern: '/tests/', factor: 0.5 },
      { pattern: 'Test.java', factor: 0.5 },
      { pattern: 'Tests.java', factor: 0.5 },
      // Generated sources
      { pattern: '/generated/', factor: 0.5 },
      { pattern: '/target/', factor: 0.4 },
      { pattern: '/build/', factor: 0.4 },
    ],
    bonuses: [
      // Source code
      { pattern: '/src/main/', factor: 1.2 },
      // Core patterns
      { pattern: '/service/', factor: 1.2 },
      { pattern: '/controller/', factor: 1.15 },
      { pattern: '/repository/', factor: 1.15 },
      { pattern: '/model/', factor: 1.15 },
      { pattern: '/domain/', factor: 1.2 },
      { pattern: '/core/', factor: 1.2 },
    ],
  },
  rust: {
    enabled: true,
    penalties: [
      // Test modules
      { pattern: '/tests/', factor: 0.5 },
      { pattern: '#[cfg(test)]', factor: 0.5 },  // Won't match path but for reference
      // Build artifacts
      { pattern: '/target/', factor: 0.3 },
      // Examples
      { pattern: '/examples/', factor: 0.7 },
      // Benches
      { pattern: '/benches/', factor: 0.6 },
    ],
    bonuses: [
      // Source code
      { pattern: '/src/', factor: 1.2 },
      // Library root
      { pattern: '/src/lib.rs', factor: 1.3 },
      // Core modules
      { pattern: '/src/core/', factor: 1.2 },
      // Public API
      { pattern: '/src/api/', factor: 1.15 },
    ],
  },
  custom: {
    enabled: true,
    penalties: [],
    bonuses: [],
  },
};

/**
 * Default priority directories per framework
 */
export const FRAMEWORK_PRIORITY_DIRS: Record<FrameworkPreset, string[]> = {
  auto: [],
  rails: ['app/models', 'app/controllers', 'app/services', 'lib'],
  nodejs: ['src', 'lib', 'core', 'services'],
  go: ['cmd', 'internal', 'pkg'],
  python: ['src', 'core', 'api', 'services'],
  java: ['src/main/java', 'domain', 'service'],
  rust: ['src', 'src/core'],
  custom: [],
};

/**
 * Detect the framework used in a project directory
 *
 * @param projectPath - Path to the project root
 * @returns Detected framework preset and display name
 */
export function detectFramework(projectPath: string): { preset: FrameworkPreset; displayName: string } {
  for (const framework of FRAMEWORK_MARKERS) {
    for (const marker of framework.markers) {
      const fullPath = join(projectPath, marker);
      if (existsSync(fullPath)) {
        return { preset: framework.preset, displayName: framework.displayName };
      }
    }
  }

  return { preset: 'custom', displayName: 'Unknown' };
}

/**
 * Get boost configuration for a framework
 *
 * @param preset - Framework preset
 * @param customConfig - Optional custom configuration to merge
 * @returns Complete boost configuration
 */
export function getBoostConfigForFramework(
  preset: FrameworkPreset,
  customConfig?: Partial<BoostConfig>
): BoostConfig {
  const baseConfig = FRAMEWORK_PRESETS[preset] ?? FRAMEWORK_PRESETS.custom;

  if (!customConfig) {
    return baseConfig;
  }

  // Merge custom config with base
  return {
    enabled: customConfig.enabled ?? baseConfig.enabled,
    penalties: [
      ...baseConfig.penalties,
      ...(customConfig.penalties ?? []),
    ],
    bonuses: [
      ...baseConfig.bonuses,
      ...(customConfig.bonuses ?? []),
    ],
  };
}

/**
 * Get priority directories for a framework
 *
 * @param preset - Framework preset
 * @param customDirs - Optional custom directories to prepend
 * @returns Priority directories (highest priority first)
 */
export function getPriorityDirsForFramework(
  preset: FrameworkPreset,
  customDirs?: string[]
): string[] {
  const baseDirs = FRAMEWORK_PRIORITY_DIRS[preset] ?? [];

  if (!customDirs || customDirs.length === 0) {
    return baseDirs;
  }

  // Custom dirs take precedence
  const combined = [...customDirs];
  for (const dir of baseDirs) {
    if (!combined.includes(dir)) {
      combined.push(dir);
    }
  }

  return combined;
}
