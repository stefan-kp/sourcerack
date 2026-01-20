# Changelog

All notable changes to SourceRack will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- File content cache in Indexer and IncrementalIndexer for 30-50% I/O reduction during indexing
- Symbol importance ranking with boosts for top-level symbols, index files, and exported symbols
- `is_exported` optional field in ChunkPayload for future ranking improvements
- Error logging for chunk operations (previously silent failures)
- Tests for glob filtering and ranking functionality
- YAML-based test framework for SQI extractors (structural symbol extraction tests)

### Changed
- **Dart**: Switched to `@sengac/tree-sitter-dart@1.1.6` (actively maintained, requires tree-sitter 0.25+ - see Known Issues)
- **Go**: Updated to `tree-sitter-go@0.25.0`
- **Rust**: Updated to `tree-sitter-rust@0.24.0`
- **Java**: Updated to `tree-sitter-java@0.23.0`
- **C/C++**: Updated to `tree-sitter-c@0.24.0` and `tree-sitter-cpp@0.23.0`
- **Ruby**: Updated to `tree-sitter-ruby@0.23.0`
- **PHP**: Updated to `tree-sitter-php@0.24.0`
- **Swift**: Updated to `tree-sitter-swift@0.7.0`
- **Scala**: Updated to `tree-sitter-scala@0.24.0`
- **Kotlin**: Updated to `tree-sitter-kotlin@0.3.8`
- **HCL/Terraform**: Switched to `@tree-sitter-grammars/tree-sitter-hcl@1.2.0`
- Various config languages updated to latest versions

### Fixed
- Path pattern filtering now uses minimatch for proper glob support (e.g., `**/*.test.ts` works correctly)

### Removed
- Dockerfile grammar support (npm package is a security placeholder)

### Known Issues
- **Dart grammar requires tree-sitter 0.25+**: The `@sengac/tree-sitter-dart` package has a peer dependency on `@sengac/tree-sitter@^0.25.10`, but SourceRack currently uses `tree-sitter@0.21.1`. A full tree-sitter ecosystem upgrade is planned for a future release.

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
