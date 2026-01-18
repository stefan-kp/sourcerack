/**
 * MCP types for SourceRack
 */

/**
 * MCP tool input for index_codebase
 */
export interface IndexCodebaseInput {
  /** Path to the repository on disk */
  repo_path: string;
  /** Commit SHA to index */
  commit: string;
  /** Branch name (optional, for reference) */
  branch?: string;
}

/**
 * MCP tool output for index_codebase
 */
export interface IndexCodebaseOutput {
  /** Whether indexing was successful */
  success: boolean;
  /** Repository ID */
  repo_id: string;
  /** Commit SHA that was indexed */
  commit_sha: string;
  /** Number of files processed */
  files_processed: number;
  /** Number of chunks created */
  chunks_created: number;
  /** Number of chunks reused */
  chunks_reused: number;
  /** Duration in milliseconds */
  duration_ms: number;
  /** Error message (if failed) */
  error?: string;
}

/**
 * MCP tool input for query_code
 */
export interface QueryCodeInput {
  /** Path to the repository on disk */
  repo_path: string;
  /** Commit SHA to search within */
  commit: string;
  /** Search query text */
  query: string;
  /** Maximum results to return (default: 50) */
  limit?: number;
  /** Pagination cursor */
  cursor?: string;
  /** Language filter */
  language?: string;
  /** Path pattern filter (glob-like) */
  path_pattern?: string;
}

/**
 * MCP tool output for query_code
 */
export interface QueryCodeOutput {
  /** Whether the query was successful */
  success: boolean;
  /** Whether the commit is indexed */
  indexed: boolean;
  /** Search results */
  results: CodeSnippet[];
  /** Total count of matching results */
  total_count: number;
  /** Next page cursor (null if no more pages) */
  next_cursor: string | null;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Code snippet in query results
 */
export interface CodeSnippet {
  /** Chunk ID */
  id: string;
  /** Relevance score (0-1) */
  score: number;
  /** File path */
  path: string;
  /** Symbol name */
  symbol: string;
  /** Symbol type */
  symbol_type: string;
  /** Programming language */
  language: string;
  /** Start line number */
  start_line: number;
  /** End line number */
  end_line: number;
  /** Source code content */
  content: string;
}

/**
 * MCP tool input for get_index_status
 */
export interface GetIndexStatusInput {
  /** Path to the repository on disk */
  repo_path: string;
  /** Commit SHA to check */
  commit: string;
}

/**
 * MCP tool output for get_index_status
 */
export interface GetIndexStatusOutput {
  /** Indexing status */
  status: 'not_indexed' | 'in_progress' | 'complete' | 'failed';
  /** Repository ID (if registered) */
  repo_id?: string;
  /** Commit SHA */
  commit_sha: string;
  /** When indexing was completed (ISO format) */
  indexed_at?: string;
  /** Number of chunks in the index */
  chunk_count?: number;
}

/**
 * MCP tool input for list_repositories
 */
export interface ListRepositoriesInput {
  // No input required
}

/**
 * MCP tool output for list_repositories
 */
export interface ListRepositoriesOutput {
  /** List of repositories */
  repositories: RepositoryInfo[];
}

/**
 * Repository information
 */
export interface RepositoryInfo {
  /** Repository ID */
  id: string;
  /** Repository name */
  name: string;
  /** Repository path on disk */
  path: string;
  /** Number of indexed commits */
  indexed_commit_count: number;
}

/**
 * MCP error response
 */
export interface MCPError {
  /** Error code */
  code: string;
  /** Error message */
  message: string;
}
