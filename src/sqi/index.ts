/**
 * Structured Query Index (SQI) for SourceRack
 *
 * A deterministic structure index in SQLite that stores rich AST information
 * from Tree-sitter and enables exact code queries - independent of embeddings/Qdrant.
 */

// Types
export * from './types.js';

// Storage
export { SQIStorage, CREATE_SQI_TABLES, SQI_SCHEMA_VERSION } from './storage.js';

// Extractors
export { SymbolExtractor } from './extractors/base.js';
export { TypeScriptExtractor } from './extractors/typescript.js';
export {
  ExtractorRegistry,
  getExtractorRegistry,
  createExtractorRegistry,
} from './extractors/registry.js';

// Query Engine
export {
  StructuredQueryEngine,
  createStructuredQueryEngine,
} from './query.js';

// Linker
export {
  UsageLinker,
  createUsageLinker,
  type LinkingOptions,
  type LinkingResult,
} from './linker/usage-linker.js';

// SQI Indexer
export {
  SQIIndexer,
  createSQIIndexer,
  type SQIIndexingOptions,
  type SQIIndexingResult,
  type SQIProgressCallback,
} from './sqi-indexer.js';
