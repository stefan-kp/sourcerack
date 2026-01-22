# Changelog

All notable changes to SourceRack will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **SQLite-vec as default vector storage** - No Docker required for semantic search
  - Uses native kNN search with L2 distance via sqlite-vec extension
  - Single-file database at `~/.sourcerack/vectors.db`
  - Qdrant remains available as optional backend
- VectorStorage abstraction layer for pluggable vector backends
- Factory pattern for vector storage creation (`createVectorStorage()`)
- File content cache in Indexer and IncrementalIndexer for 30-50% I/O reduction during indexing
- Symbol importance ranking with boosts for top-level symbols, index files, and exported symbols
- `is_exported` optional field in ChunkPayload for future ranking improvements
- Error logging for chunk operations (previously silent failures)
- Warning messages when SQI extraction fails for files (previously silent)
- Tests for glob filtering and ranking functionality
- YAML-based test framework for SQI extractors (structural symbol extraction tests)
- `--force` flag for `sourcerack index` to re-index already indexed commits
- `--sqi` flag for `sourcerack index` to skip embeddings (SQI-only mode without Qdrant)

### Changed
- **Vector storage**: SQLite-vec is now the default (previously Qdrant required Docker)
- **Config schema**: New `vectorStorage` config section for provider selection
- **tree-sitter**: Upgraded to `tree-sitter@0.25.0` - fixes "Invalid argument" crash with large Ruby files
- **Dart**: Switched to `@sengac/tree-sitter-dart@1.1.6` (actively maintained)
- **Go**: Updated to `tree-sitter-go@0.25.0`
- **Rust**: Updated to `tree-sitter-rust@0.24.0`
- **Java**: Updated to `tree-sitter-java@0.23.0`
- **C/C++**: Updated to `tree-sitter-c@0.24.0` and `tree-sitter-cpp@0.23.0`
- **Ruby**: Updated to `tree-sitter-ruby@0.23.1`
- **PHP**: Updated to `tree-sitter-php@0.24.0`
- **Swift**: Updated to `tree-sitter-swift@0.7.0`
- **Scala**: Updated to `tree-sitter-scala@0.24.0`
- **Kotlin**: Updated to `tree-sitter-kotlin@0.3.8`
- **HCL/Terraform**: Switched to `@tree-sitter-grammars/tree-sitter-hcl@1.2.0`
- Various config languages updated to latest versions
- Improved error messages with actionable hints (e.g., "Use --force to re-index")
- Grammar install warnings are now cleaner (single-line summary instead of full stack trace)

### Fixed
- Path pattern filtering now uses minimatch for proper glob support (e.g., `**/*.test.ts` works correctly)
- Large Ruby files (>800 lines) now parse correctly without crashing

### Removed
- Dockerfile grammar support (npm package is a security placeholder)

## [0.1.0] - 2025-01-18

### Added
- Initial release of SourceRack
- Semantic code search with vector embeddings (FastEmbed)
- Structural Query Index (SQI) for symbol extraction
- Support for TypeScript, JavaScript, Python, Ruby, and 20+ other languages
- MCP server for AI assistant integration
- Incremental indexing with blob-level deduplication
- Git integration for commit-based indexing

[Unreleased]: https://github.com/sourcerack/sourcerack/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sourcerack/sourcerack/releases/tag/v0.1.0
