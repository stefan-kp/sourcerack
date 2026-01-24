/**
 * MCP Tool Extractor
 *
 * Extracts MCP (Model Context Protocol) tool definitions from TypeScript/JavaScript code.
 *
 * Supports:
 * - Tool array definitions: const TOOLS = [{ name: '...', ... }]
 * - server.setRequestHandler() patterns
 * - Tool input schemas
 * - Tool descriptions
 */

import Parser from 'tree-sitter';
import { EndpointExtractor, CreateEndpointOptions, CreateParamOptions } from './base.js';
import {
  Framework,
  ExtractedEndpoint,
  EndpointParam,
} from './types.js';

/**
 * MCP tool extractor for TypeScript/JavaScript
 */
export class MCPExtractor extends EndpointExtractor {
  readonly framework: Framework = 'mcp';
  readonly language = 'typescript';
  readonly aliases = ['javascript', 'tsx', 'jsx'];

  /**
   * Check if this extractor can handle the file based on imports
   */
  canHandle(_filePath: string, imports: string[]): boolean {
    // Check for MCP SDK imports
    return imports.some((imp) =>
      imp.includes('@modelcontextprotocol/sdk') ||
      imp.includes('mcp/server') ||
      imp.includes('mcp/types')
    );
  }

  /**
   * Extract MCP tools from TypeScript/JavaScript code
   */
  protected extractEndpoints(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];

    // Strategy 1: Find tool array definitions (const TOOLS = [...])
    const toolArrayEndpoints = this.extractToolArrayDefinitions(rootNode, filePath);
    endpoints.push(...toolArrayEndpoints);

    // Strategy 2: Find server.tool() or server.setRequestHandler() calls
    const handlerEndpoints = this.extractToolHandlers(rootNode, filePath);
    endpoints.push(...handlerEndpoints);

    return endpoints;
  }

  /**
   * Extract tools from array definitions like:
   * const TOOLS = [{ name: 'tool_name', description: '...', inputSchema: {...} }]
   */
  private extractToolArrayDefinitions(
    rootNode: Parser.SyntaxNode,
    filePath: string
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];

    // Find variable declarations that look like tool arrays
    const varDeclarations = this.findAllDescendantsByTypes(rootNode, [
      'variable_declaration',
      'lexical_declaration',
    ]);

    for (const varDecl of varDeclarations) {
      // Check if it's a tool array (name contains TOOL or tools)
      const declarators = this.findAllDescendantsByType(varDecl, 'variable_declarator');
      for (const declarator of declarators) {
        const nameNode = this.getChildByField(declarator, 'name');
        const valueNode = this.getChildByField(declarator, 'value');

        if (!nameNode || !valueNode) continue;

        const name = nameNode.text.toLowerCase();
        if (!name.includes('tool') && !name.includes('handler')) continue;

        // Check if value is an array
        if (valueNode.type === 'array') {
          const toolEndpoints = this.extractToolsFromArray(valueNode, filePath);
          endpoints.push(...toolEndpoints);
        }
      }
    }

    return endpoints;
  }

  /**
   * Extract individual tools from a tool array
   */
  private extractToolsFromArray(
    arrayNode: Parser.SyntaxNode,
    filePath: string
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];

    // Find all object literals in the array
    for (const child of arrayNode.children) {
      if (child.type === 'object') {
        const tool = this.extractToolFromObject(child, filePath);
        if (tool) {
          endpoints.push(tool);
        }
      }
    }

    return endpoints;
  }

  /**
   * Extract a single tool from an object literal
   */
  private extractToolFromObject(
    objectNode: Parser.SyntaxNode,
    filePath: string
  ): ExtractedEndpoint | null {
    let toolName: string | undefined;
    let description: string | undefined;
    let inputSchema: string | undefined;
    const params: EndpointParam[] = [];

    // Find properties
    const properties = this.getChildrenByType(objectNode, 'pair');
    for (const prop of properties) {
      const keyNode = this.getChildByField(prop, 'key');
      const valueNode = this.getChildByField(prop, 'value');

      if (!keyNode || !valueNode) continue;

      const key = this.extractPropertyName(keyNode);

      switch (key) {
        case 'name': {
          const nameVal = this.extractStringValue(valueNode);
          if (nameVal) toolName = nameVal;
          break;
        }
        case 'description': {
          const descVal = this.extractStringValue(valueNode);
          if (descVal) description = descVal;
          break;
        }
        case 'inputSchema': {
          inputSchema = valueNode.text;
          // Also extract parameters from schema
          const schemaParams = this.extractParamsFromSchema(valueNode);
          params.push(...schemaParams);
          break;
        }
      }
    }

    if (!toolName) return null;

    const location = this.getLocation(objectNode);

    const options: CreateEndpointOptions = {
      http_method: 'ALL', // MCP tools don't have HTTP methods
      path: `mcp://${toolName}`,
      path_params: [],
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      framework: 'mcp',
      handler_name: toolName,
      handler_type: 'reference',
      middleware: [],
      dependencies: [],
      tags: ['mcp-tool'],
      query_params: params,
      mcp_tool_name: toolName,
    };

    if (description) {
      options.summary = description;
      options.description = description;
    }
    if (inputSchema) options.mcp_input_schema = inputSchema;

    return this.createEndpoint(options);
  }

  /**
   * Extract parameters from an MCP input schema
   */
  private extractParamsFromSchema(schemaNode: Parser.SyntaxNode): EndpointParam[] {
    const params: EndpointParam[] = [];

    if (schemaNode.type !== 'object') return params;

    // Find the 'properties' object
    const properties = this.getChildrenByType(schemaNode, 'pair');
    let propsObject: Parser.SyntaxNode | null = null;
    let requiredArray: string[] = [];

    for (const prop of properties) {
      const keyNode = this.getChildByField(prop, 'key');
      const valueNode = this.getChildByField(prop, 'value');
      if (!keyNode || !valueNode) continue;

      const key = this.extractPropertyName(keyNode);

      if (key === 'properties' && valueNode.type === 'object') {
        propsObject = valueNode;
      } else if (key === 'required' && valueNode.type === 'array') {
        requiredArray = this.extractArrayStrings(valueNode);
      }
    }

    if (!propsObject) return params;

    // Extract each property as a parameter
    const propPairs = this.getChildrenByType(propsObject, 'pair');
    for (const pair of propPairs) {
      const keyNode = this.getChildByField(pair, 'key');
      const valueNode = this.getChildByField(pair, 'value');
      if (!keyNode || !valueNode) continue;

      const paramName = this.extractPropertyName(keyNode);
      if (!paramName) continue;

      // Extract type and description from the value object
      let paramType: string | undefined;
      let paramDescription: string | undefined;

      if (valueNode.type === 'object') {
        const paramProps = this.getChildrenByType(valueNode, 'pair');
        for (const paramProp of paramProps) {
          const pKeyNode = this.getChildByField(paramProp, 'key');
          const pValueNode = this.getChildByField(paramProp, 'value');
          if (!pKeyNode || !pValueNode) continue;

          const pKey = this.extractPropertyName(pKeyNode);
          if (pKey === 'type') {
            paramType = this.extractStringValue(pValueNode) ?? undefined;
          } else if (pKey === 'description') {
            paramDescription = this.extractStringValue(pValueNode) ?? undefined;
          }
        }
      }

      const paramOptions: CreateParamOptions = {
        name: paramName,
        location: 'body', // MCP params are in the request body
        required: requiredArray.includes(paramName),
      };
      if (paramType) paramOptions.type = paramType;
      if (paramDescription) paramOptions.description = paramDescription;
      params.push(this.createParam(paramOptions));
    }

    return params;
  }

  /**
   * Extract tools from server.tool() or setRequestHandler() calls
   */
  private extractToolHandlers(
    rootNode: Parser.SyntaxNode,
    filePath: string
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];

    // Find call expressions
    const callExpressions = this.findAllDescendantsByType(rootNode, 'call_expression');

    for (const call of callExpressions) {
      const funcNode = this.getChildByField(call, 'function');
      if (!funcNode) continue;

      // Check for member expression (server.tool, server.setRequestHandler)
      if (funcNode.type === 'member_expression') {
        const propertyNode = this.getChildByField(funcNode, 'property');
        if (!propertyNode) continue;

        const methodName = propertyNode.text;

        // Handle server.tool() pattern
        if (methodName === 'tool') {
          const endpoint = this.extractToolFromToolCall(call, filePath);
          if (endpoint) {
            endpoints.push(endpoint);
          }
        }
        // Handle server.setRequestHandler(ListToolsRequestSchema, ...) pattern
        else if (methodName === 'setRequestHandler') {
          // This is typically the handler registration, not the tool definition
          // The actual tools are usually in a separate array
        }
      }
    }

    return endpoints;
  }

  /**
   * Extract tool from a server.tool() call
   */
  private extractToolFromToolCall(
    callNode: Parser.SyntaxNode,
    filePath: string
  ): ExtractedEndpoint | null {
    const argsNode = this.getChildByField(callNode, 'arguments');
    if (!argsNode) return null;

    // First argument is usually the tool definition object or name
    const args = argsNode.children.filter(c =>
      c.type !== '(' && c.type !== ')' && c.type !== ','
    );

    if (args.length === 0) return null;

    const firstArg = args[0];

    // If first arg is an object, extract tool from it
    if (firstArg?.type === 'object') {
      return this.extractToolFromObject(firstArg, filePath);
    }

    // If first arg is a string (tool name), try to extract from remaining args
    if (firstArg?.type === 'string') {
      const toolName = this.extractStringValue(firstArg);
      if (!toolName) return null;

      let description: string | undefined;
      let inputSchema: string | undefined;

      // Look for description and schema in remaining args
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (!arg) continue;

        if (arg.type === 'string' && !description) {
          const val = this.extractStringValue(arg);
          if (val) description = val;
        } else if (arg.type === 'object') {
          inputSchema = arg.text;
        }
      }

      const location = this.getLocation(callNode);

      const options: CreateEndpointOptions = {
        http_method: 'ALL',
        path: `mcp://${toolName}`,
        path_params: [],
        file_path: filePath,
        start_line: location.startLine,
        end_line: location.endLine,
        framework: 'mcp',
        handler_name: toolName,
        handler_type: 'reference',
        middleware: [],
        dependencies: [],
        tags: ['mcp-tool'],
        query_params: [],
        mcp_tool_name: toolName,
      };
      if (description) {
        options.summary = description;
        options.description = description;
      }
      if (inputSchema) options.mcp_input_schema = inputSchema;

      return this.createEndpoint(options);
    }

    return null;
  }

  /**
   * Extract property name from a key node (handles identifiers and strings)
   */
  private extractPropertyName(node: Parser.SyntaxNode): string | null {
    if (node.type === 'property_identifier' || node.type === 'identifier') {
      return node.text;
    }
    if (node.type === 'string') {
      return this.extractStringValue(node);
    }
    return null;
  }

  /**
   * Extract strings from an array node
   */
  private extractArrayStrings(arrayNode: Parser.SyntaxNode): string[] {
    const strings: string[] = [];

    for (const child of arrayNode.children) {
      if (child.type === 'string') {
        const value = this.extractStringValue(child);
        if (value) {
          strings.push(value);
        }
      }
    }

    return strings;
  }
}
