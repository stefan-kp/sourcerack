/**
 * Django REST Framework Endpoint Extractor
 *
 * Extracts API endpoints from Django REST Framework Python applications.
 *
 * Supports:
 * - @api_view(['GET', 'POST']) decorator for function-based views
 * - ViewSet classes with action methods (list, create, retrieve, update, destroy)
 * - @action decorator for custom actions on ViewSets
 * - APIView classes with get, post, put, patch, delete methods
 */

import Parser from 'tree-sitter';
import { EndpointExtractor } from './base.js';
import {
  Framework,
  HttpMethod,
  ExtractedEndpoint,
} from './types.js';

/**
 * Standard ViewSet actions and their HTTP methods
 */
const VIEWSET_ACTIONS: Record<string, HttpMethod> = {
  list: 'GET',
  create: 'POST',
  retrieve: 'GET',
  update: 'PUT',
  partial_update: 'PATCH',
  destroy: 'DELETE',
};

/**
 * HTTP method names used in APIView classes
 */
const API_VIEW_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/**
 * Django REST Framework endpoint extractor
 */
export class DjangoExtractor extends EndpointExtractor {
  readonly framework: Framework = 'django';
  readonly language = 'python';

  /**
   * Check if this extractor can handle the file based on imports
   */
  canHandle(_filePath: string, imports: string[]): boolean {
    return imports.some((imp) =>
      imp === 'rest_framework' ||
      imp.startsWith('rest_framework.') ||
      imp === 'rest_framework.decorators' ||
      imp === 'rest_framework.views' ||
      imp === 'rest_framework.viewsets'
    );
  }

  /**
   * Extract endpoints from Django REST Framework code
   */
  protected extractEndpoints(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];

    // Extract from @api_view decorated functions
    const decoratedDefs = this.findAllDescendantsByType(rootNode, 'decorated_definition');
    for (const decoratedDef of decoratedDefs) {
      const endpoint = this.extractFromApiViewDecorator(decoratedDef, filePath);
      if (endpoint) {
        endpoints.push(...endpoint);
      }
    }

    // Extract from ViewSet and APIView classes
    const classDefs = this.findAllDescendantsByType(rootNode, 'class_definition');
    for (const classDef of classDefs) {
      const classEndpoints = this.extractFromClass(classDef, filePath);
      endpoints.push(...classEndpoints);
    }

    return endpoints;
  }

  /**
   * Extract endpoints from @api_view decorated functions
   * Pattern: @api_view(['GET', 'POST'])
   */
  private extractFromApiViewDecorator(
    node: Parser.SyntaxNode,
    filePath: string
  ): ExtractedEndpoint[] | null {
    const decorators = this.getChildrenByType(node, 'decorator');
    let apiViewDecorator: Parser.SyntaxNode | null = null;
    let httpMethods: HttpMethod[] = [];

    for (const decorator of decorators) {
      const result = this.parseApiViewDecorator(decorator);
      if (result) {
        apiViewDecorator = decorator;
        httpMethods = result.methods;
        break;
      }
    }

    if (!apiViewDecorator || httpMethods.length === 0) {
      return null;
    }

    // Get the function definition
    const funcDef = this.getChildByField(node, 'definition');
    if (!funcDef || funcDef.type !== 'function_definition') {
      return null;
    }

    // Get function name as handler and path hint
    const nameNode = this.getChildByField(funcDef, 'name');
    const handlerName = nameNode?.text ?? 'anonymous';

    // Extract docstring for description
    const { summary, description } = this.extractDocstring(funcDef);

    // Get location
    const location = this.getLocation(node);

    // Create endpoint for each HTTP method
    const endpoints: ExtractedEndpoint[] = [];
    for (const method of httpMethods) {
      const options: Parameters<typeof this.createEndpoint>[0] = {
        http_method: method,
        path: `/${handlerName}`,  // Path is defined in urls.py, use function name as hint
        path_params: [],
        file_path: filePath,
        start_line: location.startLine,
        end_line: location.endLine,
        framework: 'django',
        handler_name: handlerName,
        handler_type: 'reference',
        middleware: [],
        dependencies: [],
        tags: [],
        query_params: [],
      };

      if (summary) options.summary = summary;
      if (description) options.description = description;

      endpoints.push(this.createEndpoint(options));
    }

    return endpoints;
  }

  /**
   * Parse @api_view decorator to extract HTTP methods
   */
  private parseApiViewDecorator(decorator: Parser.SyntaxNode): { methods: HttpMethod[] } | null {
    const call = this.findDescendantByType(decorator, 'call');
    if (!call) return null;

    const funcNode = this.getChildByField(call, 'function');
    if (!funcNode || funcNode.text !== 'api_view') {
      return null;
    }

    const args = this.getChildByField(call, 'arguments');
    if (!args) {
      // @api_view() with no args defaults to GET
      return { methods: ['GET'] };
    }

    // Find the list of methods
    const listNode = this.findDescendantByType(args, 'list');
    if (!listNode) {
      return { methods: ['GET'] };
    }

    const methods: HttpMethod[] = [];
    for (const child of listNode.children) {
      if (child.type === 'string') {
        const methodStr = this.extractStringValue(child);
        if (methodStr) {
          methods.push(this.normalizeHttpMethod(methodStr));
        }
      }
    }

    return methods.length > 0 ? { methods } : { methods: ['GET'] };
  }

  /**
   * Extract endpoints from ViewSet or APIView classes
   */
  private extractFromClass(
    classDef: Parser.SyntaxNode,
    filePath: string
  ): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];

    // Get class name
    const nameNode = this.getChildByField(classDef, 'name');
    const className = nameNode?.text ?? 'UnknownView';

    // Check if this is a ViewSet or APIView by looking at base classes
    const superclasses = this.getChildByField(classDef, 'superclasses');
    if (!superclasses) return endpoints;

    const isViewSet = this.hasBaseClass(superclasses, ['ViewSet', 'ModelViewSet', 'GenericViewSet', 'ReadOnlyModelViewSet']);
    const isAPIView = this.hasBaseClass(superclasses, ['APIView', 'GenericAPIView']);

    if (!isViewSet && !isAPIView) {
      return endpoints;
    }

    // Get class body
    const bodyNode = this.getChildByField(classDef, 'body');
    if (!bodyNode) return endpoints;

    // Find all methods in the class
    const methods = this.findAllDescendantsByType(bodyNode, 'function_definition');

    for (const method of methods) {
      const methodName = this.getChildByField(method, 'name')?.text;
      if (!methodName) continue;

      // Check for @action decorator on methods
      const decoratedDef = method.parent;
      if (decoratedDef?.type === 'decorated_definition') {
        const actionEndpoint = this.extractActionDecorator(decoratedDef, className, filePath);
        if (actionEndpoint) {
          endpoints.push(actionEndpoint);
          continue;
        }
      }

      if (isViewSet) {
        // Check if it's a standard ViewSet action
        const httpMethod = VIEWSET_ACTIONS[methodName];
        if (httpMethod) {
          const endpoint = this.createViewSetEndpoint(method, className, methodName, httpMethod, filePath);
          endpoints.push(endpoint);
        }
      } else if (isAPIView) {
        // Check if it's an HTTP method handler
        if (API_VIEW_METHODS.includes(methodName.toLowerCase())) {
          const endpoint = this.createAPIViewEndpoint(method, className, methodName, filePath);
          endpoints.push(endpoint);
        }
      }
    }

    return endpoints;
  }

  /**
   * Check if class has any of the specified base classes
   */
  private hasBaseClass(superclasses: Parser.SyntaxNode, baseNames: string[]): boolean {
    const text = superclasses.text;
    return baseNames.some(name => text.includes(name));
  }

  /**
   * Extract endpoint from @action decorator
   * Pattern: @action(detail=True, methods=['post'])
   */
  private extractActionDecorator(
    decoratedDef: Parser.SyntaxNode,
    className: string,
    filePath: string
  ): ExtractedEndpoint | null {
    const decorators = this.getChildrenByType(decoratedDef, 'decorator');

    for (const decorator of decorators) {
      const call = this.findDescendantByType(decorator, 'call');
      if (!call) continue;

      const funcNode = this.getChildByField(call, 'function');
      if (!funcNode || funcNode.text !== 'action') continue;

      // Parse action decorator arguments
      const args = this.getChildByField(call, 'arguments');
      let methods: HttpMethod[] = ['GET'];
      let detail = false;
      let urlPath: string | undefined;

      if (args) {
        const keywordArgs = this.findAllDescendantsByType(args, 'keyword_argument');
        for (const kwarg of keywordArgs) {
          const nameNode = this.getChildByField(kwarg, 'name');
          const valueNode = this.getChildByField(kwarg, 'value');
          if (!nameNode || !valueNode) continue;

          const name = nameNode.text;

          switch (name) {
            case 'methods': {
              const listNode = this.findDescendantByType(valueNode, 'list');
              if (listNode) {
                methods = [];
                for (const child of listNode.children) {
                  if (child.type === 'string') {
                    const methodStr = this.extractStringValue(child);
                    if (methodStr) {
                      methods.push(this.normalizeHttpMethod(methodStr));
                    }
                  }
                }
              }
              break;
            }
            case 'detail':
              detail = valueNode.text === 'True';
              break;
            case 'url_path': {
              const pathStr = this.extractStringValue(valueNode);
              if (pathStr) urlPath = pathStr;
              break;
            }
          }
        }
      }

      // Get the method definition
      const funcDef = this.getChildByField(decoratedDef, 'definition');
      if (!funcDef || funcDef.type !== 'function_definition') continue;

      const methodNameNode = this.getChildByField(funcDef, 'name');
      const methodName = methodNameNode?.text ?? 'custom_action';

      // Extract docstring
      const { summary, description } = this.extractDocstring(funcDef);

      const location = this.getLocation(decoratedDef);

      // Build path - detail actions include {id}, url_path overrides method name
      const actionPath = urlPath ?? methodName;
      const path = detail
        ? `/${className.toLowerCase()}/{id}/${actionPath}`
        : `/${className.toLowerCase()}/${actionPath}`;

      // Create endpoint for first method (most common case)
      const method = methods[0] ?? 'GET';

      const options: Parameters<typeof this.createEndpoint>[0] = {
        http_method: method,
        path,
        path_params: detail ? ['id'] : [],
        file_path: filePath,
        start_line: location.startLine,
        end_line: location.endLine,
        framework: 'django',
        handler_name: `${className}.${methodName}`,
        handler_type: 'class_method',
        middleware: [],
        dependencies: [],
        tags: [className],
        query_params: [],
      };

      if (summary) options.summary = summary;
      if (description) options.description = description;

      return this.createEndpoint(options);
    }

    return null;
  }

  /**
   * Create endpoint for a standard ViewSet action
   */
  private createViewSetEndpoint(
    method: Parser.SyntaxNode,
    className: string,
    actionName: string,
    httpMethod: HttpMethod,
    filePath: string
  ): ExtractedEndpoint {
    const { summary, description } = this.extractDocstring(method);
    const location = this.getLocation(method);

    // Build path based on action type
    const needsId = ['retrieve', 'update', 'partial_update', 'destroy'].includes(actionName);
    const basePath = `/${className.toLowerCase()}`;
    const path = needsId ? `${basePath}/{id}` : basePath;

    const options: Parameters<typeof this.createEndpoint>[0] = {
      http_method: httpMethod,
      path,
      path_params: needsId ? ['id'] : [],
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      framework: 'django',
      handler_name: `${className}.${actionName}`,
      handler_type: 'class_method',
      middleware: [],
      dependencies: [],
      tags: [className],
      query_params: [],
    };

    if (summary) options.summary = summary;
    if (description) options.description = description;

    return this.createEndpoint(options);
  }

  /**
   * Create endpoint for an APIView method
   */
  private createAPIViewEndpoint(
    method: Parser.SyntaxNode,
    className: string,
    methodName: string,
    filePath: string
  ): ExtractedEndpoint {
    const { summary, description } = this.extractDocstring(method);
    const location = this.getLocation(method);

    const httpMethod = this.normalizeHttpMethod(methodName);
    const path = `/${className.toLowerCase()}`;

    const options: Parameters<typeof this.createEndpoint>[0] = {
      http_method: httpMethod,
      path,
      path_params: [],
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      framework: 'django',
      handler_name: `${className}.${methodName}`,
      handler_type: 'class_method',
      middleware: [],
      dependencies: [],
      tags: [className],
      query_params: [],
    };

    if (summary) options.summary = summary;
    if (description) options.description = description;

    return this.createEndpoint(options);
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
}
