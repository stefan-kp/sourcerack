/**
 * Rails Controller Endpoint Extractor
 *
 * Extracts API endpoint details from Rails controller files.
 * Complements the routes.rb extractor by providing:
 * - Strong parameters (params.require/permit)
 * - Before actions (middleware)
 * - Apipie-rails documentation (desc, param blocks)
 * - YARD documentation
 *
 * Supports:
 * - params.require(:user).permit(:name, :email)
 * - before_action :authenticate_user!, only: [:create, :update]
 * - Apipie: desc, param, returns, error blocks
 * - YARD: @param, @return annotations
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
 * RESTful actions and their HTTP methods
 */
const RESTFUL_ACTIONS: Record<string, HttpMethod> = {
  index: 'GET',
  show: 'GET',
  new: 'GET',
  create: 'POST',
  edit: 'GET',
  update: 'PUT',
  destroy: 'DELETE',
};

/**
 * Before action entry
 */
interface BeforeActionEntry {
  name: string;
  only: string[] | null;
  except: string[] | null;
}

/**
 * Rails controller endpoint extractor
 */
export class RailsControllerExtractor extends EndpointExtractor {
  readonly framework: Framework = 'rails';
  readonly language = 'ruby';

  /**
   * Check if this extractor can handle the file
   */
  canHandle(filePath: string, _imports: string[]): boolean {
    // Rails controllers are in app/controllers/*_controller.rb
    return filePath.includes('controllers/') && filePath.endsWith('_controller.rb');
  }

  /**
   * Extract endpoints from Rails controller
   */
  protected extractEndpoints(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];

    // Find the controller class
    const classDefs = this.findAllDescendantsByType(rootNode, 'class');
    for (const classDef of classDefs) {
      const classEndpoints = this.extractFromControllerClass(classDef, filePath, sourceCode);
      endpoints.push(...classEndpoints);
    }

    return endpoints;
  }

  /**
   * Extract endpoints from a controller class
   */
  private extractFromControllerClass(
    classDef: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];

    // Get controller name
    const nameNode = this.getChildByField(classDef, 'name') ||
                     this.getFirstChildByType(classDef, 'constant');
    const className = nameNode?.text ?? 'UnknownController';

    // Convert UsersController -> users
    const controllerName = className
      .replace(/Controller$/, '')
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase();

    // Extract before_actions for the class
    const beforeActions = this.extractBeforeActions(classDef);

    // Find all method definitions
    const bodyNode = this.getChildByField(classDef, 'body') ||
                     this.findDescendantByType(classDef, 'body_statement');
    if (!bodyNode) return endpoints;

    const methods = this.findAllDescendantsByType(bodyNode, 'method');

    for (const method of methods) {
      const methodNameNode = this.getChildByField(method, 'name') ||
                             this.getFirstChildByType(method, 'identifier');
      const methodName = methodNameNode?.text;
      if (!methodName) continue;

      // Check if it's a RESTful action or has apipie documentation
      const restfulHttpMethod = RESTFUL_ACTIONS[methodName];
      const apipieDoc = this.extractApipieDocumentation(method, sourceCode);

      // Skip if not a RESTful action and no apipie documentation
      if (!restfulHttpMethod && !apipieDoc) continue;

      // Extract strong parameters from method body
      const strongParams = this.extractStrongParams(method);

      // Extract YARD documentation
      const yardDoc = this.extractYardDocumentation(method, sourceCode);

      // Get before_actions that apply to this method
      const middleware = this.getApplicableBeforeActions(beforeActions, methodName);

      const location = this.getLocation(method);

      // Determine HTTP method and path
      // Prefer apipie if available, fall back to RESTful conventions
      let httpMethod: HttpMethod;
      let path: string;
      let pathParams: string[];

      if (apipieDoc?.httpMethod && apipieDoc?.path) {
        // Use apipie declaration
        httpMethod = this.normalizeHttpMethod(apipieDoc.httpMethod);
        path = apipieDoc.path;
        pathParams = this.parsePathParams(path);
      } else {
        // Fall back to RESTful conventions
        httpMethod = restfulHttpMethod ?? 'GET';
        const needsId = ['show', 'edit', 'update', 'destroy'].includes(methodName);
        const basePath = `/${controllerName}`;
        path = needsId ? `${basePath}/:id` :
               methodName === 'new' ? `${basePath}/new` :
               methodName === 'edit' ? `${basePath}/:id/edit` :
               basePath;
        pathParams = needsId ? ['id'] : [];
      }

      const options: Record<string, unknown> = {
        http_method: httpMethod,
        path,
        path_params: pathParams,
        file_path: filePath,
        start_line: location.startLine,
        end_line: location.endLine,
        framework: 'rails',
        handler_name: `${controllerName}#${methodName}`,
        handler_type: 'controller_action',
        middleware,
        dependencies: [],
        tags: [controllerName],
        query_params: strongParams,
      };

      // Add apipie documentation if available
      if (apipieDoc) {
        if (apipieDoc.description) options.description = apipieDoc.description;
        if (apipieDoc.summary) options.summary = apipieDoc.summary;
        if (apipieDoc.params.length > 0) {
          options.query_params = apipieDoc.params;
        }
        if (apipieDoc.returns) options.response_model = apipieDoc.returns;
      }

      // Fall back to YARD documentation
      if (yardDoc && !apipieDoc) {
        if (yardDoc.description) options.description = yardDoc.description;
        if (yardDoc.returns) options.response_model = yardDoc.returns;
      }

      endpoints.push(this.createEndpoint(options as Parameters<EndpointExtractor['createEndpoint']>[0]));
    }

    return endpoints;
  }

  /**
   * Extract before_action declarations from class
   */
  private extractBeforeActions(classDef: Parser.SyntaxNode): BeforeActionEntry[] {
    const beforeActions: BeforeActionEntry[] = [];

    const calls = this.findAllDescendantsByType(classDef, 'call');
    for (const call of calls) {
      const methodNode = this.getChildByField(call, 'method') ||
                         this.getFirstChildByType(call, 'identifier');
      if (!methodNode) continue;

      const methodName = methodNode.text;
      if (methodName !== 'before_action' && methodName !== 'before_filter') continue;

      const argsNode = this.getChildByField(call, 'arguments');
      if (!argsNode) continue;

      let actionName: string | null = null;
      let only: string[] | null = null;
      let except: string[] | null = null;

      for (const child of argsNode.children) {
        // Symbol :authenticate_user!
        if (child.type === 'simple_symbol' || child.type === 'symbol') {
          actionName = child.text.replace(/^:/, '');
        }
        // Hash with only:/except:
        else if (child.type === 'hash' || child.type === 'pair') {
          const pairs = child.type === 'hash'
            ? this.findAllDescendantsByType(child, 'pair')
            : [child];

          for (const pair of pairs) {
            const keyNode = this.getFirstChildByType(pair, 'hash_key_symbol') ||
                           this.getFirstChildByType(pair, 'simple_symbol');
            if (!keyNode) continue;

            const keyText = keyNode.text.replace(/^:/, '');
            const valueNode = this.findDescendantByType(pair, 'array');

            if (valueNode) {
              const symbols = this.extractSymbolArray(valueNode);
              if (keyText === 'only') {
                only = symbols;
              } else if (keyText === 'except') {
                except = symbols;
              }
            }
          }
        }
      }

      if (actionName) {
        beforeActions.push({ name: actionName, only, except });
      }
    }

    return beforeActions;
  }

  /**
   * Get before_actions that apply to a specific method
   */
  private getApplicableBeforeActions(
    beforeActions: BeforeActionEntry[],
    methodName: string
  ): string[] {
    const applicable: string[] = [];

    for (const action of beforeActions) {
      // Check if this action applies to the method
      if (action.only !== null && !action.only.includes(methodName)) {
        continue;
      }
      if (action.except !== null && action.except.includes(methodName)) {
        continue;
      }
      applicable.push(action.name);
    }

    return applicable;
  }

  /**
   * Extract strong parameters from method body
   * Pattern: params.require(:user).permit(:name, :email)
   */
  private extractStrongParams(method: Parser.SyntaxNode): EndpointParam[] {
    const params: EndpointParam[] = [];
    const calls = this.findAllDescendantsByType(method, 'call');

    for (const call of calls) {
      const text = call.text;

      // Look for permit calls
      if (!text.includes('permit')) continue;

      // Find permit arguments
      const permitMatch = text.match(/\.permit\(([^)]+)\)/);
      if (permitMatch && permitMatch[1]) {
        const permitArgs = permitMatch[1];
        // Extract symbols like :name, :email
        const symbolMatches = permitArgs.matchAll(/:(\w+)/g);
        for (const match of symbolMatches) {
          if (match[1]) {
            params.push(this.createParam({
              name: match[1],
              location: 'body',
              required: false,
            }));
          }
        }
      }
    }

    return params;
  }

  /**
   * Extract Apipie-rails documentation
   * Supports:
   *   api :POST, '/v1/conversation_threads', 'Create a thread'
   *   desc <<-EOF
   *     Long description here
   *   EOF
   *   param :user, Hash, required: true do
   *     param :name, String, required: true, desc: "User name"
   *   end
   *   returns :code => 200, :desc => "Success"
   *   def create
   */
  private extractApipieDocumentation(
    method: Parser.SyntaxNode,
    sourceCode: string
  ): {
    description: string | null;
    summary: string | null;
    params: EndpointParam[];
    returns: string | null;
    httpMethod: string | null;
    path: string | null;
  } | null {
    const result: {
      description: string | null;
      summary: string | null;
      params: EndpointParam[];
      returns: string | null;
      httpMethod: string | null;
      path: string | null;
    } = { description: null, summary: null, params: [], returns: null, httpMethod: null, path: null };

    // Look for apipie DSL before the method (increased buffer for large docs)
    const methodStart = method.startIndex;
    const beforeMethod = sourceCode.substring(Math.max(0, methodStart - 5000), methodStart);

    // Extract api declaration: api :POST, '/v1/conversation_threads', 'Description'
    const apiMatch = beforeMethod.match(/api\s+:(\w+),\s*['"]([^'"]+)['"](?:,\s*['"]([^'"]+)['"])?/);
    if (apiMatch) {
      result.httpMethod = apiMatch[1] ?? null;
      result.path = apiMatch[2] ?? null;
      if (apiMatch[3]) {
        result.summary = apiMatch[3];
      }
    }

    // Extract desc with heredoc support: desc <<-EOF ... EOF or desc "text"
    // Match heredoc pattern
    const heredocMatch = beforeMethod.match(/desc\s+<<-?(\w+)\s*\n([\s\S]*?)\n\s*\1/);
    if (heredocMatch && heredocMatch[2]) {
      result.description = heredocMatch[2].trim();
      // First line as summary if not already set
      if (!result.summary) {
        const lines = result.description.split('\n');
        const firstLine = lines[0]?.trim();
        if (firstLine) {
          result.summary = firstLine;
        }
      }
    } else {
      // Match simple string desc: desc "text" or desc 'text'
      const simpleDescMatch = beforeMethod.match(/desc\s+(['"])([\s\S]*?)\1/);
      if (simpleDescMatch && simpleDescMatch[2]) {
        result.description = simpleDescMatch[2].trim();
        if (!result.summary) {
          result.summary = result.description.split('\n')[0]?.trim() ?? null;
        }
      }
    }

    // Extract all param declarations (including nested ones)
    // Pattern: param :name, Type, options do ... end OR param :name, Type, options
    this.extractApipieParams(beforeMethod, result.params, '');

    // Extract returns
    const returnsMatch = beforeMethod.match(/returns\s+(?::code\s*=>\s*(\d+)|:(\w+))/);
    if (returnsMatch) {
      result.returns = returnsMatch[1] ?? returnsMatch[2] ?? null;
    }

    // Only return if we found something
    if (result.description || result.params.length > 0 || result.returns || result.path) {
      return result;
    }

    return null;
  }

  /**
   * Extract Apipie params recursively, handling nested param blocks
   */
  private extractApipieParams(
    text: string,
    params: EndpointParam[],
    prefix: string
  ): void {
    // Match param declarations - handle both with and without do blocks
    // param :name, Type, options do ... end
    // param :name, Type, options
    const paramRegex = /param\s+:(\w+),\s*(\[?[\w',\s\[\]]+\]?)(?:,\s*([^d\n][^\n]*?))?(?:\s+do\s*\n([\s\S]*?)\n\s*end)?/g;

    let match;
    while ((match = paramRegex.exec(text)) !== null) {
      const paramName = match[1];
      const paramType = match[2]?.trim();
      const options = match[3] ?? '';
      const nestedBlock = match[4];

      if (paramName && paramType) {
        // Parse options
        const required = options.includes('required: true') || options.includes('required:true');

        // Extract description from desc: "..." or desc: '...'
        let description: string | null = null;
        const descMatch = options.match(/desc:\s*['"]([^'"]+)['"]/);
        if (descMatch && descMatch[1]) {
          description = descMatch[1];
        }

        // Extract default value
        let defaultValue: string | null = null;
        const defaultMatch = options.match(/default:\s*(['"]?)([^'",\s]+)\1/);
        if (defaultMatch) {
          defaultValue = defaultMatch[2] ?? null;
        }

        const fullName = prefix ? `${prefix}.${paramName}` : paramName;

        const paramOptions: Parameters<typeof this.createParam>[0] = {
          name: fullName,
          location: 'body',
          type: this.cleanApipieType(paramType),
          required,
        };
        if (description) {
          paramOptions.description = description;
        }
        if (defaultValue) {
          paramOptions.default_value = defaultValue;
        }

        params.push(this.createParam(paramOptions));

        // Process nested params if there's a do block
        if (nestedBlock) {
          this.extractApipieParams(nestedBlock, params, fullName);
        }
      }
    }
  }

  /**
   * Clean up Apipie type notation
   */
  private cleanApipieType(type: string): string {
    // Handle array types like ['text','json_object'] -> enum
    if (type.startsWith('[') && type.includes("'")) {
      return 'enum';
    }
    // Handle Array type
    if (type === 'Array') {
      return 'array';
    }
    // Handle Hash type
    if (type === 'Hash') {
      return 'object';
    }
    return type.toLowerCase();
  }

  /**
   * Extract YARD documentation from comments before method
   */
  private extractYardDocumentation(
    method: Parser.SyntaxNode,
    sourceCode: string
  ): {
    description: string | null;
    params: EndpointParam[];
    returns: string | null;
  } | null {
    const result: {
      description: string | null;
      params: EndpointParam[];
      returns: string | null;
    } = { description: null, params: [], returns: null };

    // Get comments before method
    const methodStart = method.startIndex;
    const beforeMethod = sourceCode.substring(Math.max(0, methodStart - 500), methodStart);

    // Find YARD comment block
    const lines = beforeMethod.split('\n').reverse();
    const commentLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        commentLines.unshift(trimmed.replace(/^#\s?/, ''));
      } else if (trimmed === '') {
        continue;
      } else {
        break;
      }
    }

    if (commentLines.length === 0) return null;

    // Parse YARD tags
    const currentDescription: string[] = [];

    for (const line of commentLines) {
      if (line.startsWith('@param')) {
        // @param name [Type] description
        const match = line.match(/@param\s+(\w+)\s+\[([^\]]+)\]\s*(.*)/);
        if (match && match[1] && match[2]) {
          const paramOptions: Parameters<typeof this.createParam>[0] = {
            name: match[1],
            location: 'query',
            type: match[2],
            required: false,
          };
          if (match[3]) {
            paramOptions.description = match[3];
          }
          result.params.push(this.createParam(paramOptions));
        }
      } else if (line.startsWith('@return')) {
        // @return [Type] description
        const match = line.match(/@return\s+\[([^\]]+)\]/);
        if (match && match[1]) {
          result.returns = match[1];
        }
      } else if (!line.startsWith('@')) {
        currentDescription.push(line);
      }
    }

    if (currentDescription.length > 0) {
      result.description = currentDescription.join(' ').trim();
    }

    if (result.description || result.params.length > 0 || result.returns) {
      return result;
    }

    return null;
  }

  /**
   * Extract array of symbols
   */
  private extractSymbolArray(arrayNode: Parser.SyntaxNode): string[] {
    const symbols: string[] = [];
    for (const child of arrayNode.children) {
      if (child.type === 'simple_symbol' || child.type === 'symbol') {
        symbols.push(child.text.replace(/^:/, ''));
      }
    }
    return symbols;
  }
}
