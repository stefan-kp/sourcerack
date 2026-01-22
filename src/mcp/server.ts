/**
 * MCP Server for SourceRack
 *
 * Exposes semantic code search functionality via MCP protocol.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { MetadataStorage } from '../storage/metadata.js';
import type { VectorStorage } from '../storage/vector-storage.js';
import { createVectorStorage, detectProviderFromConfig, getDefaultVectorDatabasePath } from '../storage/vector-factory.js';
import { createEmbeddingProvider } from '../embeddings/provider.js';
import { loadConfig } from '../config/config.js';

import { handleIndexCodebase } from './tools/index.js';
import { handleQueryCode } from './tools/query.js';
import { handleGetIndexStatus } from './tools/status.js';
import { handleListRepositories } from './tools/repos.js';
import { handleFindDefinition } from './tools/sqi-find-definition.js';
import { handleFindUsages } from './tools/sqi-find-usages.js';
import { handleFindHierarchy } from './tools/sqi-find-hierarchy.js';
import { handleFindImports, handleFindImporters } from './tools/sqi-find-imports.js';
import type {
  IndexCodebaseInput,
  QueryCodeInput,
  GetIndexStatusInput,
} from './types.js';
import type {
  FindDefinitionInput,
  FindUsagesInput,
  FindHierarchyInput,
  FindImportsInput,
  FindImportersInput,
} from '../sqi/types.js';

/**
 * MCP tool definitions
 */
const TOOLS = [
  {
    name: 'index_codebase',
    description:
      'Index a codebase at a specific commit for semantic search. This processes all code files, creates embeddings, and stores them for later searching.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Path to the repository on disk',
        },
        commit: {
          type: 'string',
          description: 'Commit SHA, branch name, or tag to index',
        },
        branch: {
          type: 'string',
          description: 'Branch name (optional, for reference)',
        },
      },
      required: ['repo_path', 'commit'],
    },
  },
  {
    name: 'query_code',
    description:
      'Search for code semantically within an indexed commit. Returns ranked code snippets matching the query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Path to the repository on disk',
        },
        commit: {
          type: 'string',
          description: 'Commit SHA to search within (must be indexed)',
        },
        query: {
          type: 'string',
          description: 'Natural language search query',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 50, max: 100)',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor from previous response',
        },
        language: {
          type: 'string',
          description: 'Filter by programming language (e.g., "typescript")',
        },
        path_pattern: {
          type: 'string',
          description: 'Filter by path pattern (e.g., "src/services/*")',
        },
      },
      required: ['repo_path', 'commit', 'query'],
    },
  },
  {
    name: 'get_index_status',
    description:
      'Get the indexing status for a specific commit. Returns whether the commit is indexed, in progress, or not indexed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Path to the repository on disk',
        },
        commit: {
          type: 'string',
          description: 'Commit SHA to check status for',
        },
      },
      required: ['repo_path', 'commit'],
    },
  },
  {
    name: 'list_repositories',
    description:
      'List all registered repositories with their indexed commit counts.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  // SQI Tools
  {
    name: 'find_definition',
    description:
      'Find symbol definitions by name. Returns exact matches from the structural code index, not semantic similarity.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Path to the repository on disk',
        },
        commit: {
          type: 'string',
          description: 'Commit SHA to search within (must be indexed)',
        },
        symbol_name: {
          type: 'string',
          description: 'Name of the symbol to find (e.g., "MyClass", "handleRequest")',
        },
        symbol_kind: {
          type: 'string',
          description: 'Filter by symbol kind (e.g., "function", "class", "method", "interface")',
        },
      },
      required: ['repo_path', 'commit', 'symbol_name'],
    },
  },
  {
    name: 'find_usages',
    description:
      'Find all usages/references of a symbol. Returns call sites, reads, writes, and type references.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Path to the repository on disk',
        },
        commit: {
          type: 'string',
          description: 'Commit SHA to search within (must be indexed)',
        },
        symbol_name: {
          type: 'string',
          description: 'Name of the symbol to find usages for',
        },
        file_path: {
          type: 'string',
          description: 'Optional: limit search to a specific file',
        },
      },
      required: ['repo_path', 'commit', 'symbol_name'],
    },
  },
  {
    name: 'find_hierarchy',
    description:
      'Find symbol hierarchy - children (methods of a class) and/or parents (containing class/namespace).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Path to the repository on disk',
        },
        commit: {
          type: 'string',
          description: 'Commit SHA to search within (must be indexed)',
        },
        symbol_name: {
          type: 'string',
          description: 'Name of the symbol to get hierarchy for',
        },
        direction: {
          type: 'string',
          enum: ['children', 'parents', 'both'],
          description: 'Which direction to search: children, parents, or both',
        },
      },
      required: ['repo_path', 'commit', 'symbol_name', 'direction'],
    },
  },
  {
    name: 'find_imports',
    description:
      'Find all import statements in a file. Shows what modules the file depends on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Path to the repository on disk',
        },
        commit: {
          type: 'string',
          description: 'Commit SHA to search within (must be indexed)',
        },
        file_path: {
          type: 'string',
          description: 'File path to analyze imports for',
        },
      },
      required: ['repo_path', 'commit', 'file_path'],
    },
  },
  {
    name: 'find_importers',
    description:
      'Find all files that import a given module. Shows reverse dependencies.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Path to the repository on disk',
        },
        commit: {
          type: 'string',
          description: 'Commit SHA to search within (must be indexed)',
        },
        module: {
          type: 'string',
          description: 'Module specifier to search for (e.g., "@/utils", "lodash")',
        },
      },
      required: ['repo_path', 'commit', 'module'],
    },
  },
];

/**
 * Create and configure the MCP server
 */
export async function createMCPServer(): Promise<Server> {
  // Load configuration
  const config = loadConfig();

  // Initialize storage components
  const metadata = MetadataStorage.create(config.storage.databasePath);

  // Create embedding provider first to get dimensions
  const embeddingConfig: {
    provider: 'fastembed' | 'remote';
    model: string;
    batchSize: number;
    remoteUrl?: string;
    remoteApiKey?: string;
  } = {
    provider: config.embedding.provider,
    model: config.embedding.model,
    batchSize: config.embedding.batchSize,
  };
  if (config.embedding.remoteUrl) {
    embeddingConfig.remoteUrl = config.embedding.remoteUrl;
  }
  if (config.embedding.remoteApiKey) {
    embeddingConfig.remoteApiKey = config.embedding.remoteApiKey;
  }

  const embeddings = await createEmbeddingProvider(embeddingConfig);

  // Detect provider and create vector storage
  const provider = detectProviderFromConfig(config);
  let vectors: VectorStorage;

  if (provider === 'qdrant') {
    const qdrantConfig = config.vectorStorage?.qdrant ?? config.qdrant;
    const qdrantOptions: Parameters<typeof createVectorStorage>[0] = {
      provider: 'qdrant',
      dimensions: embeddings.dimensions,
      qdrantUrl: qdrantConfig.url,
      qdrantCollection: qdrantConfig.collection,
    };
    if (qdrantConfig.apiKey) {
      qdrantOptions.qdrantApiKey = qdrantConfig.apiKey;
    }
    vectors = await createVectorStorage(qdrantOptions);
  } else {
    vectors = await createVectorStorage({
      provider: 'sqlite-vss',
      dimensions: embeddings.dimensions,
      databasePath: config.vectorStorage?.sqliteVss?.databasePath ?? getDefaultVectorDatabasePath(),
    });
  }

  // Create MCP server
  const server = new Server(
    {
      name: 'sourcerack',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS,
    };
  });

  // Register tool call handler
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'index_codebase': {
            const input = args as unknown as IndexCodebaseInput;
            const result = await handleIndexCodebase(
              input,
              metadata,
              vectors,
              embeddings
            );
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'query_code': {
            const input = args as unknown as QueryCodeInput;
            const result = await handleQueryCode(
              input,
              metadata,
              vectors,
              embeddings
            );
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'get_index_status': {
            const input = args as unknown as GetIndexStatusInput;
            const result = await handleGetIndexStatus(input, metadata);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'list_repositories': {
            const result = handleListRepositories(metadata);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          // SQI Tools
          case 'find_definition': {
            const input = args as unknown as FindDefinitionInput;
            const result = await handleFindDefinition(input, metadata);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'find_usages': {
            const input = args as unknown as FindUsagesInput;
            const result = await handleFindUsages(input, metadata);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'find_hierarchy': {
            const input = args as unknown as FindHierarchyInput;
            const result = await handleFindHierarchy(input, metadata);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'find_imports': {
            const input = args as unknown as FindImportsInput;
            const result = await handleFindImports(input, metadata);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'find_importers': {
            const input = args as unknown as FindImportersInput;
            const result = await handleFindImporters(input, metadata);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          default:
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: {
                      code: 'UNKNOWN_TOOL',
                      message: `Unknown tool: ${name}`,
                    },
                  }),
                },
              ],
              isError: true,
            };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: {
                  code: 'INTERNAL_ERROR',
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

/**
 * Start the MCP server with stdio transport
 */
export async function startMCPServer(): Promise<void> {
  const server = await createMCPServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    void server.close().then(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    void server.close().then(() => process.exit(0));
  });
}

// Export for use as module
export { Server };
