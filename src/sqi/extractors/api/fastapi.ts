/**
 * FastAPI Endpoint Extractor
 *
 * Extracts API endpoints from FastAPI Python applications.
 *
 * Supports:
 * - Route decorators: @app.get(), @app.post(), @router.get(), etc.
 * - Path parameters: /users/{user_id}
 * - Query parameters from function signatures with Query()
 * - Response models: response_model=UserResponse
 * - Dependencies: Depends(get_db)
 * - OpenAPI metadata: summary, description, tags, status_code
 * - APIRouter prefixes and tags
 */

import Parser from 'tree-sitter';
import { EndpointExtractor } from './base.js';
import {
  Framework,
  HttpMethod,
  ExtractedEndpoint,
  EndpointParam,
} from './types.js';

/**
 * FastAPI HTTP method decorators
 */
const FASTAPI_HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'api_route'];

/**
 * FastAPI-specific parameter types
 */
const FASTAPI_PARAM_TYPES = ['Query', 'Path', 'Header', 'Cookie', 'Body', 'Form', 'File'];

/**
 * FastAPI endpoint extractor
 */
export class FastAPIExtractor extends EndpointExtractor {
  readonly framework: Framework = 'fastapi';
  readonly language = 'python';

  /**
   * Check if this extractor can handle the file based on imports
   */
  canHandle(_filePath: string, imports: string[]): boolean {
    // Check for FastAPI imports
    return imports.some((imp) =>
      imp.includes('fastapi') ||
      imp.includes('FastAPI') ||
      imp.includes('APIRouter')
    );
  }

  /**
   * Extract endpoints from FastAPI Python code
   */
  protected extractEndpoints(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];

    // Find all decorated_definition nodes
    const decoratedDefs = this.findAllDescendantsByType(rootNode, 'decorated_definition');

    for (const decoratedDef of decoratedDefs) {
      const endpoint = this.extractEndpointFromDecoratedDef(decoratedDef, filePath);
      if (endpoint) {
        endpoints.push(endpoint);
      }
    }

    return endpoints;
  }

  /**
   * Extract endpoint from a decorated function definition
   */
  private extractEndpointFromDecoratedDef(
    node: Parser.SyntaxNode,
    filePath: string
  ): ExtractedEndpoint | null {
    // Find the route decorator
    const decorators = this.getChildrenByType(node, 'decorator');
    let routeDecorator: Parser.SyntaxNode | null = null;
    let httpMethod: HttpMethod | null = null;

    for (const decorator of decorators) {
      const result = this.parseRouteDecorator(decorator);
      if (result) {
        routeDecorator = decorator;
        httpMethod = result.method;
        break;
      }
    }

    if (!routeDecorator || !httpMethod) {
      return null;
    }

    // Get the function definition
    const funcDef = this.getChildByField(node, 'definition');
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
    if (!funcDef || funcDef.type !== 'function_definition') {
      return null;
    }

    // Extract route path
    const path = this.extractRoutePath(routeDecorator);
    if (!path) {
      return null;
    }

    // Extract decorator arguments (response_model, tags, etc.)
    const decoratorArgs = this.extractDecoratorArgs(routeDecorator);

    // Extract function parameters (Query, Path, etc.)
    const { queryParams, pathParams, bodySchema } = this.extractFunctionParams(funcDef);

    // Extract docstring
    const { summary, description } = this.extractDocstring(funcDef);

    // Get function name as handler
    const nameNode = this.getChildByField(funcDef, 'name');
    const handlerName = nameNode?.text ?? 'anonymous';

    // Get location
    const location = this.getLocation(node);

    // Extract return type for response model fallback
    const returnType = this.extractReturnType(funcDef);

    // Build the endpoint options, only including non-undefined values
    const options: Parameters<typeof this.createEndpoint>[0] = {
      http_method: httpMethod,
      path,
      path_params: pathParams,
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      framework: 'fastapi',
      handler_name: handlerName,
      handler_type: 'reference',
      middleware: [],
      dependencies: decoratorArgs.dependencies,
      tags: decoratorArgs.tags,
      query_params: queryParams,
    };

    // Add optional fields only if they have values
    const finalSummary = decoratorArgs.summary ?? summary;
    const finalDescription = decoratorArgs.description ?? description;
    const finalBodySchema = bodySchema ?? decoratorArgs.bodySchema;
    const finalResponseModel = decoratorArgs.responseModel ?? returnType;

    if (finalSummary) options.summary = finalSummary;
    if (finalDescription) options.description = finalDescription;
    if (finalBodySchema) {
      options.body_schema = finalBodySchema;
      options.body_content_type = 'application/json';
    }
    if (finalResponseModel) options.response_model = finalResponseModel;
    if (decoratorArgs.statusCode !== undefined) options.response_status = decoratorArgs.statusCode;

    return this.createEndpoint(options);
  }

  /**
   * Parse a decorator to check if it's a route decorator
   */
  private parseRouteDecorator(decorator: Parser.SyntaxNode): { method: HttpMethod } | null {
    // Find the call expression in the decorator
    const call = this.findDescendantByType(decorator, 'call');
    if (!call) return null;

    // Get the function being called (e.g., app.get, router.post)
    const funcNode = this.getChildByField(call, 'function');
    if (!funcNode) return null;

    // Check for attribute access (app.get, router.post)
    if (funcNode.type === 'attribute') {
      const attrNode = this.getChildByField(funcNode, 'attribute');
      if (attrNode) {
        const methodName = attrNode.text.toLowerCase();
        if (FASTAPI_HTTP_METHODS.includes(methodName)) {
          // Handle api_route specially - need to check method arg
          if (methodName === 'api_route') {
            return { method: 'ALL' };
          }
          return { method: this.normalizeHttpMethod(methodName) };
        }
      }
    }

    return null;
  }

  /**
   * Extract the route path from a decorator
   */
  private extractRoutePath(decorator: Parser.SyntaxNode): string | null {
    const call = this.findDescendantByType(decorator, 'call');
    if (!call) return null;

    const args = this.getChildByField(call, 'arguments');
    if (!args) return null;

    // First positional argument is typically the path
    for (const child of args.children) {
      if (child.type === 'string') {
        return this.extractStringValue(child);
      }
    }

    return null;
  }

  /**
   * Extract decorator arguments (response_model, tags, etc.)
   */
  private extractDecoratorArgs(decorator: Parser.SyntaxNode): {
    responseModel?: string;
    summary?: string;
    description?: string;
    tags: string[];
    dependencies: string[];
    statusCode?: number;
    bodySchema?: string;
  } {
    const result: {
      responseModel?: string;
      summary?: string;
      description?: string;
      tags: string[];
      dependencies: string[];
      statusCode?: number;
      bodySchema?: string;
    } = {
      tags: [],
      dependencies: [],
    };

    const call = this.findDescendantByType(decorator, 'call');
    if (!call) return result;

    const args = this.getChildByField(call, 'arguments');
    if (!args) return result;

    // Find keyword arguments
    const keywordArgs = this.findAllDescendantsByType(args, 'keyword_argument');
    for (const kwarg of keywordArgs) {
      const nameNode = this.getChildByField(kwarg, 'name');
      const valueNode = this.getChildByField(kwarg, 'value');
      if (!nameNode || !valueNode) continue;

      const name = nameNode.text;
      const value = valueNode.text;

      switch (name) {
        case 'response_model':
          result.responseModel = value;
          break;
        case 'summary': {
          const summaryVal = this.extractStringValue(valueNode);
          if (summaryVal) result.summary = summaryVal;
          break;
        }
        case 'description': {
          const descVal = this.extractStringValue(valueNode);
          if (descVal) result.description = descVal;
          break;
        }
        case 'tags':
          result.tags = this.extractListStrings(valueNode);
          break;
        case 'dependencies':
          result.dependencies = this.extractDependencies(valueNode);
          break;
        case 'status_code': {
          const statusNum = parseInt(value, 10);
          if (!isNaN(statusNum)) {
            result.statusCode = statusNum;
          }
          break;
        }
      }
    }

    return result;
  }

  /**
   * Extract function parameters to find Query, Path, Body, etc.
   */
  private extractFunctionParams(funcDef: Parser.SyntaxNode): {
    queryParams: EndpointParam[];
    pathParams: string[];
    bodySchema: string | undefined;
  } {
    const queryParams: EndpointParam[] = [];
    const pathParams: string[] = [];
    let bodySchema: string | undefined;

    const paramsNode = this.getChildByField(funcDef, 'parameters');
    if (!paramsNode) {
      return { queryParams, pathParams, bodySchema };
    }

    // Iterate through parameters
    for (const child of paramsNode.children) {
      const param = this.extractSingleParam(child);
      if (param) {
        if (param.location === 'path') {
          pathParams.push(param.name);
        } else if (param.location === 'query') {
          queryParams.push(param);
        } else if (param.location === 'body' && param.type) {
          bodySchema = param.type;
        }
      }
    }

    return { queryParams, pathParams, bodySchema };
  }

  /**
   * Extract a single parameter from various node types
   */
  private extractSingleParam(node: Parser.SyntaxNode): EndpointParam | null {
    // Handle typed_parameter: name: Type
    // Handle typed_default_parameter: name: Type = Default
    // Handle default_parameter: name = Default

    let paramName: string | undefined;
    let paramType: string | undefined;
    let defaultValue: Parser.SyntaxNode | undefined;
    let location: EndpointParam['location'] = 'query';
    let required = true;
    let description: string | undefined;

    if (node.type === 'typed_parameter' || node.type === 'typed_default_parameter') {
      const nameNode = node.type === 'typed_parameter'
        ? this.getFirstChildByType(node, 'identifier')
        : this.getChildByField(node, 'name');
      paramName = nameNode?.text;

      const typeNode = this.getChildByField(node, 'type');
      paramType = typeNode?.text;

      if (node.type === 'typed_default_parameter') {
        defaultValue = this.getChildByField(node, 'value') ?? undefined;
        required = false;
      }
    } else if (node.type === 'default_parameter') {
      const nameNode = this.getChildByField(node, 'name');
      paramName = nameNode?.text;
      defaultValue = this.getChildByField(node, 'value') ?? undefined;
      required = false;
    } else if (node.type === 'identifier') {
      paramName = node.text;
    }

    if (!paramName || paramName === 'self' || paramName === 'cls') {
      return null;
    }

    // Check if default value is a FastAPI param type (Query, Path, etc.)
    if (defaultValue) {
      const paramInfo = this.parseFastAPIParam(defaultValue);
      if (paramInfo) {
        location = paramInfo.location;
        required = paramInfo.required;
        description = paramInfo.description;
        if (paramInfo.default !== undefined) {
          required = false;
        }
      }
    }

    // Build param object with only non-undefined values
    const paramOptions: Parameters<typeof this.createParam>[0] = {
      name: paramName,
      location,
      required,
    };

    if (paramType) paramOptions.type = paramType;
    if (description) paramOptions.description = description;

    return this.createParam(paramOptions);
  }

  /**
   * Parse a FastAPI parameter call (Query(), Path(), etc.)
   */
  private parseFastAPIParam(node: Parser.SyntaxNode): {
    location: EndpointParam['location'];
    required: boolean;
    default?: string;
    description?: string;
  } | null {
    // Check if it's a call expression
    if (node.type !== 'call') {
      // Check for simple identifier like Query or Path used as default
      if (node.type === 'identifier' && FASTAPI_PARAM_TYPES.includes(node.text)) {
        return {
          location: this.mapFastAPIParamType(node.text),
          required: true,
        };
      }
      return null;
    }

    const funcNode = this.getChildByField(node, 'function');
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
    if (!funcNode || funcNode.type !== 'identifier') {
      return null;
    }

    const funcName = funcNode.text;
    if (!FASTAPI_PARAM_TYPES.includes(funcName)) {
      return null;
    }

    const location = this.mapFastAPIParamType(funcName);
    let required = true;
    let defaultVal: string | undefined;
    let description: string | undefined;

    // Parse arguments
    const args = this.getChildByField(node, 'arguments');
    if (args) {
      // First positional arg is usually the default
      let firstPosArg = true;
      for (const child of args.children) {
        if (child.type === 'keyword_argument') {
          const nameNode = this.getChildByField(child, 'name');
          const valueNode = this.getChildByField(child, 'value');
          if (nameNode && valueNode) {
            const kwName = nameNode.text;
            if (kwName === 'description') {
              const descVal = this.extractStringValue(valueNode);
              if (descVal) description = descVal;
            } else if (kwName === 'default') {
              defaultVal = valueNode.text;
              required = false;
            }
          }
        } else if (firstPosArg && child.type !== '(' && child.type !== ')' && child.type !== ',') {
          // Check if it's ... (Ellipsis) meaning required
          if (child.text === '...') {
            required = true;
          } else if (child.text !== 'None') {
            defaultVal = child.text;
            required = false;
          }
          firstPosArg = false;
        }
      }
    }

    const result: {
      location: EndpointParam['location'];
      required: boolean;
      default?: string;
      description?: string;
    } = { location, required };
    if (defaultVal !== undefined) result.default = defaultVal;
    if (description !== undefined) result.description = description;
    return result;
  }

  /**
   * Map FastAPI parameter type to location
   */
  private mapFastAPIParamType(typeName: string): EndpointParam['location'] {
    switch (typeName) {
      case 'Path':
        return 'path';
      case 'Query':
        return 'query';
      case 'Header':
        return 'header';
      case 'Cookie':
        return 'cookie';
      case 'Body':
      case 'Form':
      case 'File':
        return 'body';
      default:
        return 'query';
    }
  }

  /**
   * Extract docstring from function definition
   */
  private extractDocstring(funcDef: Parser.SyntaxNode): {
    summary?: string;
    description?: string;
  } {
    const bodyNode = this.getChildByField(funcDef, 'body');
    if (!bodyNode) return {};

    // Docstring is the first expression_statement containing a string
    for (const child of bodyNode.children) {
      if (child.type === 'expression_statement') {
        const stringNode = this.getFirstChildByType(child, 'string');
        if (stringNode) {
          const docstring = this.extractStringValue(stringNode);
          if (docstring) {
            // First line is summary, rest is description
            const lines = docstring.trim().split('\n');
            const summary = lines[0]?.trim();
            const description = lines.length > 1
              ? lines.slice(1).map(l => l.trim()).join(' ').trim()
              : undefined;
            const result: { summary?: string; description?: string } = {};
            if (summary) result.summary = summary;
            if (description) result.description = description;
            return result;
          }
        }
        break;
      } else if (child.type !== 'comment') {
        break;
      }
    }

    return {};
  }

  /**
   * Extract return type annotation
   */
  private extractReturnType(funcDef: Parser.SyntaxNode): string | undefined {
    const returnType = this.getChildByField(funcDef, 'return_type');
    if (returnType) {
      // Remove the '-> ' prefix if present
      const text = returnType.text;
      return text.startsWith('->') ? text.slice(2).trim() : text;
    }
    return undefined;
  }

  /**
   * Extract strings from a list node
   */
  private extractListStrings(node: Parser.SyntaxNode): string[] {
    const strings: string[] = [];

    if (node.type === 'list') {
      for (const child of node.children) {
        if (child.type === 'string') {
          const value = this.extractStringValue(child);
          if (value) {
            strings.push(value);
          }
        }
      }
    }

    return strings;
  }

  /**
   * Extract dependency names from Depends() calls
   */
  private extractDependencies(node: Parser.SyntaxNode): string[] {
    const dependencies: string[] = [];

    // Look for Depends() calls
    const calls = this.findAllDescendantsByType(node, 'call');
    for (const call of calls) {
      const funcNode = this.getChildByField(call, 'function');
      if (funcNode?.text === 'Depends') {
        const args = this.getChildByField(call, 'arguments');
        if (args) {
          // First argument is the dependency function
          for (const child of args.children) {
            if (child.type === 'identifier' || child.type === 'attribute') {
              dependencies.push(child.text);
              break;
            }
          }
        }
      }
    }

    return dependencies;
  }
}
