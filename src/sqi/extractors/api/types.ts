/**
 * API Endpoint Types for SourceRack
 *
 * Types and interfaces for API endpoint discovery across different frameworks.
 * Supports Express, FastAPI, Flask, Rails, NestJS, and MCP tools.
 */

/**
 * HTTP methods supported for endpoint detection
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'ALL';

/**
 * Supported API frameworks
 */
export type Framework =
  | 'express'   // Express.js (Node.js)
  | 'fastify'   // Fastify (Node.js)
  | 'koa'       // Koa (Node.js)
  | 'fastapi'   // FastAPI (Python)
  | 'flask'     // Flask (Python)
  | 'django'    // Django REST Framework (Python)
  | 'rails'     // Ruby on Rails
  | 'sinatra'   // Sinatra (Ruby)
  | 'nestjs'    // NestJS (Node.js)
  | 'mcp'       // Model Context Protocol tools
  | 'unknown';

/**
 * Handler types for endpoint implementations
 */
export type HandlerType =
  | 'inline'            // Anonymous function defined inline
  | 'reference'         // Reference to a named function
  | 'controller_action' // Controller#action pattern (Rails, NestJS)
  | 'class_method';     // Method on a class

/**
 * Parameter location in HTTP request
 */
export type ParamLocation = 'path' | 'query' | 'header' | 'cookie' | 'body';

/**
 * Endpoint parameter definition
 */
export interface EndpointParam {
  name: string;
  location: ParamLocation;
  type?: string | undefined;          // e.g., 'int', 'str', 'UUID'
  required: boolean;
  default_value?: string | undefined;
  description?: string | undefined;
}

/**
 * Extracted API endpoint (before storage)
 */
export interface ExtractedEndpoint {
  // HTTP routing
  http_method: HttpMethod;
  path: string;                    // '/users/:id', '/api/v1/*'
  path_params: string[];           // ['id'] extracted from path

  // Source location
  file_path: string;
  start_line: number;
  end_line: number;

  // Framework identification
  framework: Framework;

  // Handler information
  handler_name?: string | undefined;           // 'UserController#show' or 'getUser'
  handler_type: HandlerType;

  // Middleware and dependencies
  middleware: string[];            // ['auth', 'validate']
  dependencies: string[];          // FastAPI: Depends(get_db)

  // Documentation
  summary?: string | undefined;                // Short description
  description?: string | undefined;            // Full description
  tags: string[];                  // OpenAPI tags

  // Request parameters
  query_params: EndpointParam[];   // ?name=foo&limit=10

  // Request body
  body_schema?: string | undefined;            // Pydantic Model name or JSON schema
  body_content_type?: string | undefined;      // application/json, multipart/form-data

  // Response
  response_model?: string | undefined;         // Pydantic Model / DTO name
  response_status?: number | undefined;        // 200, 201, 404
  response_description?: string | undefined;

  // MCP-specific
  mcp_tool_name?: string | undefined;
  mcp_input_schema?: string | undefined;
}

/**
 * API endpoint record (from database)
 */
export interface EndpointRecord {
  id: number;
  commit_id: number;

  // HTTP
  http_method: HttpMethod;
  path: string;

  // Location
  file_path: string;
  start_line: number;
  end_line: number;

  // Framework
  framework: Framework;

  // Handler
  handler_symbol_id: number | null;
  handler_type: HandlerType;

  // Documentation
  summary: string | null;
  description: string | null;
  tags: string | null;                // JSON array

  // Middleware
  middleware: string | null;          // JSON array
  dependencies: string | null;        // JSON array

  // Response
  response_model: string | null;
  response_status: number | null;
  response_content_type: string | null;

  // Request body
  body_schema: string | null;
  body_content_type: string | null;

  // MCP
  mcp_tool_name: string | null;
  mcp_input_schema: string | null;
}

/**
 * Endpoint parameter record (from database)
 */
export interface EndpointParamRecord {
  id: number;
  endpoint_id: number;
  name: string;
  location: ParamLocation;
  param_type: string | null;
  required: number;               // SQLite boolean
  default_value: string | null;
  description: string | null;
}

/**
 * Endpoint info for query results
 */
export interface EndpointInfo {
  http_method: HttpMethod;
  path: string;
  file_path: string;
  start_line: number;
  end_line: number;
  framework: Framework;
  handler_name?: string | undefined;
  handler_type: HandlerType;
  summary?: string | undefined;
  description?: string | undefined;
  tags: string[];
  middleware: string[];
  params: EndpointParam[];
  response_model?: string | undefined;
  response_status?: number | undefined;
  body_schema?: string | undefined;
  // Cross-repo
  repo_name?: string | undefined;
  repo_path?: string | undefined;
}

/**
 * Result of endpoint extraction from a file
 */
export interface EndpointExtractionResult {
  file_path: string;
  framework: Framework;
  endpoints: ExtractedEndpoint[];
  success: boolean;
  error?: string;
}

/**
 * Input for find_endpoints query
 */
export interface FindEndpointsInput {
  /** Repository path (required unless all_repos or repo_ids is set) */
  repo_path?: string;
  /** Commit to search (default: HEAD) */
  commit?: string;
  /** Filter by HTTP method */
  method?: HttpMethod;
  /** Filter by path pattern (supports wildcards) */
  path_pattern?: string;
  /** Filter by framework */
  framework?: Framework;
  /** Search across all indexed repositories */
  all_repos?: boolean;
  /** Search only in specific repositories (by ID) */
  repo_ids?: string[];
}

/**
 * Output for find_endpoints query
 */
export interface FindEndpointsOutput {
  success: boolean;
  endpoints: EndpointInfo[];
  total_count: number;
  error?: string | undefined;
}

/**
 * Input for endpoint callers query (who calls this endpoint?)
 */
export interface FindEndpointCallersInput {
  repo_path: string;
  commit?: string;
  path: string;
  method?: HttpMethod;
}

/**
 * Output for endpoint callers query
 */
export interface FindEndpointCallersOutput {
  success: boolean;
  endpoint?: EndpointInfo;
  callers: {
    file_path: string;
    line: number;
    context: string;
    repo_name?: string;
    repo_path?: string;
  }[];
  error?: string;
}

/**
 * Framework detection result
 */
export interface FrameworkDetection {
  framework: Framework;
  confidence: number;     // 0-1
  evidence: string[];     // Why this framework was detected
}
