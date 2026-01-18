/**
 * Python Symbol Extractor for SQI
 *
 * Extracts symbols, usages, and imports from Python files.
 *
 * Supports:
 * - Classes (with inheritance)
 * - Functions and methods
 * - Decorators
 * - Type annotations
 * - Docstrings
 * - Import statements (import, from ... import)
 * - Module-level variables and constants
 */

import Parser from 'tree-sitter';
import {
  SymbolKind,
  Visibility,
  UsageType,
  ExtractedSymbol,
  ExtractedUsage,
  ExtractedImport,
  ExtractedParameter,
  ExtractedDocstring,
  ExtractedImportBinding,
} from '../types.js';
import { SymbolExtractor, NodeTypeMapping } from './base.js';

/**
 * Node types that map to symbol kinds in Python
 */
const PY_SYMBOL_TYPES: NodeTypeMapping = {
  // Functions
  function_definition: SymbolKind.FUNCTION,

  // Classes
  class_definition: SymbolKind.CLASS,

  // Variables (handled separately for better detection)
  // assignment: SymbolKind.VARIABLE,
};

/**
 * Node types that represent usages/references
 */
const USAGE_NODE_TYPES = ['identifier', 'attribute'];

/**
 * Built-in Python names to skip in usage tracking
 */
const PYTHON_BUILTINS = new Set([
  // Constants
  'True',
  'False',
  'None',
  // Built-in functions
  'print',
  'len',
  'range',
  'str',
  'int',
  'float',
  'bool',
  'list',
  'dict',
  'set',
  'tuple',
  'type',
  'isinstance',
  'issubclass',
  'hasattr',
  'getattr',
  'setattr',
  'delattr',
  'property',
  'staticmethod',
  'classmethod',
  'super',
  'object',
  'open',
  'file',
  'input',
  'map',
  'filter',
  'zip',
  'enumerate',
  'sorted',
  'reversed',
  'min',
  'max',
  'sum',
  'abs',
  'round',
  'pow',
  'divmod',
  'all',
  'any',
  'repr',
  'hash',
  'id',
  'callable',
  'dir',
  'vars',
  'globals',
  'locals',
  'exec',
  'eval',
  'compile',
  '__name__',
  '__file__',
  '__doc__',
  '__package__',
  '__spec__',
  '__annotations__',
  '__dict__',
  '__class__',
  '__init__',
  '__new__',
  '__del__',
  '__repr__',
  '__str__',
  '__bytes__',
  '__format__',
  '__lt__',
  '__le__',
  '__eq__',
  '__ne__',
  '__gt__',
  '__ge__',
  '__hash__',
  '__bool__',
  '__getattr__',
  '__setattr__',
  '__delattr__',
  '__getattribute__',
  '__get__',
  '__set__',
  '__delete__',
  '__call__',
  '__len__',
  '__getitem__',
  '__setitem__',
  '__delitem__',
  '__iter__',
  '__next__',
  '__contains__',
  '__add__',
  '__sub__',
  '__mul__',
  '__truediv__',
  '__floordiv__',
  '__mod__',
  '__pow__',
  '__and__',
  '__or__',
  '__xor__',
  '__invert__',
  '__neg__',
  '__pos__',
  '__abs__',
  '__enter__',
  '__exit__',
  '__await__',
  '__aiter__',
  '__anext__',
  '__aenter__',
  '__aexit__',
  // Common type hints
  'Optional',
  'Union',
  'List',
  'Dict',
  'Set',
  'Tuple',
  'Any',
  'Callable',
  'TypeVar',
  'Generic',
  'Protocol',
  'Final',
  'Literal',
  'ClassVar',
  'Annotated',
  // Exceptions
  'Exception',
  'BaseException',
  'ValueError',
  'TypeError',
  'KeyError',
  'IndexError',
  'AttributeError',
  'RuntimeError',
  'StopIteration',
  'GeneratorExit',
  'AssertionError',
  'ImportError',
  'ModuleNotFoundError',
  'OSError',
  'IOError',
  'FileNotFoundError',
  'PermissionError',
  'NotImplementedError',
  // Self/cls
  'self',
  'cls',
]);

/**
 * Python symbol extractor
 */
export class PythonExtractor extends SymbolExtractor {
  readonly language = 'python';
  readonly aliases: string[] = [];

  /**
   * Extract symbols from Python AST
   */
  protected extractSymbols(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string
  ): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];

    this.traverseForSymbols(rootNode, filePath, sourceCode, symbols);

    return symbols;
  }

  /**
   * Traverse AST to extract symbols
   */
  private traverseForSymbols(
    node: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string,
    symbols: ExtractedSymbol[],
    parentQualifiedName?: string
  ): void {
    // Handle decorated definitions
    if (node.type === 'decorated_definition') {
      const definition = this.getChildByField(node, 'definition');
      if (definition) {
        const decorators = this.extractDecorators(node);
        const symbol = this.extractSymbolFromDefinition(
          definition,
          filePath,
          sourceCode,
          parentQualifiedName,
          decorators,
          node // Use decorated_definition for location
        );

        if (symbol) {
          symbols.push(symbol);

          // For classes, extract children
          if (symbol.symbol_kind === SymbolKind.CLASS) {
            const bodyNode = this.getChildByField(definition, 'body');
            if (bodyNode) {
              symbol.children = [];
              for (const child of bodyNode.children) {
                this.traverseForSymbols(
                  child,
                  filePath,
                  sourceCode,
                  symbol.children,
                  symbol.qualified_name
                );
              }
            }
          }
        }
        return;
      }
    }

    // Handle direct definitions
    const symbolKind = PY_SYMBOL_TYPES[node.type];
    if (symbolKind) {
      const symbol = this.extractSymbolFromDefinition(
        node,
        filePath,
        sourceCode,
        parentQualifiedName
      );

      if (symbol) {
        symbols.push(symbol);

        // For classes, extract children
        if (symbolKind === SymbolKind.CLASS) {
          const bodyNode = this.getChildByField(node, 'body');
          if (bodyNode) {
            symbol.children = [];
            for (const child of bodyNode.children) {
              this.traverseForSymbols(
                child,
                filePath,
                sourceCode,
                symbol.children,
                symbol.qualified_name
              );
            }
          }
        }
        return;
      }
    }

    // Handle module-level assignments (variables/constants)
    if (node.type === 'expression_statement' && !parentQualifiedName) {
      const assignment = this.getFirstChildByType(node, 'assignment');
      if (assignment) {
        const varSymbol = this.extractVariableFromAssignment(
          assignment,
          filePath,
          sourceCode
        );
        if (varSymbol) {
          symbols.push(varSymbol);
        }
        return;
      }
    }

    // Recurse into children - handle different cases based on context
    for (const child of node.children) {
      // At module level (rootNode), process definitions directly
      if (node.type === 'module') {
        if (
          child.type === 'function_definition' ||
          child.type === 'class_definition' ||
          child.type === 'decorated_definition' ||
          child.type === 'expression_statement'
        ) {
          this.traverseForSymbols(
            child,
            filePath,
            sourceCode,
            symbols,
            parentQualifiedName
          );
        }
      } else if (child.type === 'block') {
        // Inside other nodes, only recurse into blocks
        this.traverseForSymbols(
          child,
          filePath,
          sourceCode,
          symbols,
          parentQualifiedName
        );
      }
    }
  }

  /**
   * Extract symbol from a function or class definition
   */
  private extractSymbolFromDefinition(
    node: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string,
    parentQualifiedName?: string,
    decorators?: string[],
    locationNode?: Parser.SyntaxNode
  ): ExtractedSymbol | null {
    const nameNode = this.getChildByField(node, 'name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const locNode = locationNode ?? node;
    const location = this.getLocation(locNode);
    const qualifiedName = this.buildQualifiedName(name, parentQualifiedName);

    // Determine symbol kind
    let kind: SymbolKind;
    if (node.type === 'class_definition') {
      kind = SymbolKind.CLASS;
    } else if (node.type === 'function_definition') {
      // Check if it's a method (has parent class)
      kind = parentQualifiedName ? SymbolKind.METHOD : SymbolKind.FUNCTION;
    } else {
      return null;
    }

    // Extract metadata
    const isAsync = this.isAsyncFunction(node);
    const isStatic = decorators?.includes('staticmethod') ?? false;
    const isClassMethod = decorators?.includes('classmethod') ?? false;
    const visibility = this.determineVisibility(name);
    const returnType = this.extractReturnType(node);
    const parameters = this.extractParameters(node, kind === SymbolKind.METHOD);
    const docstring = this.extractDocstring(node, sourceCode);

    return {
      name,
      qualified_name: qualifiedName,
      symbol_kind: kind,
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      visibility,
      is_async: isAsync,
      is_static: isStatic || isClassMethod,
      is_exported: !name.startsWith('_'), // Python convention
      return_type: returnType,
      parameters,
      docstring,
      content_hash: this.generateContentHash(locNode.text),
    };
  }

  /**
   * Extract variable from assignment
   */
  private extractVariableFromAssignment(
    node: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string
  ): ExtractedSymbol | null {
    const leftNode = this.getChildByField(node, 'left');
    if (leftNode?.type !== 'identifier') return null;

    const name = leftNode.text;

    // Skip private/dunder names at module level
    if (name.startsWith('__') && name.endsWith('__')) return null;

    const location = this.getLocation(node);

    // Determine if it's a constant (UPPER_CASE convention)
    const isConstant = /^[A-Z][A-Z0-9_]*$/.test(name);
    const kind = isConstant ? SymbolKind.CONSTANT : SymbolKind.VARIABLE;

    // Try to get type annotation
    const typeNode = this.getChildByField(node, 'type');
    const returnType = typeNode ? typeNode.text : undefined;

    return {
      name,
      qualified_name: name,
      symbol_kind: kind,
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      visibility: this.determineVisibility(name),
      is_exported: !name.startsWith('_'),
      return_type: returnType,
      content_hash: this.generateContentHash(node.text),
    };
  }

  /**
   * Extract decorators from decorated_definition
   */
  private extractDecorators(node: Parser.SyntaxNode): string[] {
    const decorators: string[] = [];

    for (const child of node.children) {
      if (child.type === 'decorator') {
        // Get the decorator name (might be @name or @name(...))
        const identNode = this.getFirstChildByType(child, 'identifier');
        if (identNode) {
          decorators.push(identNode.text);
        } else {
          // Try attribute access like @functools.wraps
          const attrNode = this.getFirstChildByType(child, 'attribute');
          if (attrNode) {
            const attr = this.getChildByField(attrNode, 'attribute');
            if (attr) {
              decorators.push(attr.text);
            }
          }
        }
      }
    }

    return decorators;
  }

  /**
   * Check if function is async
   */
  private isAsyncFunction(node: Parser.SyntaxNode): boolean {
    // Check for 'async' keyword before 'def'
    for (const child of node.children) {
      if (child.type === 'async') return true;
    }
    // Also check parent for async keyword
    return node.text.trim().startsWith('async ');
  }

  /**
   * Determine visibility from name convention
   */
  private determineVisibility(name: string): Visibility | undefined {
    if (name.startsWith('__') && !name.endsWith('__')) {
      return 'private'; // Name mangling (strongly private)
    }
    if (name.startsWith('_')) {
      return 'private'; // Convention for internal/private use
    }
    return 'public';
  }

  /**
   * Extract return type annotation
   */
  private extractReturnType(node: Parser.SyntaxNode): string | undefined {
    const returnType = this.getChildByField(node, 'return_type');
    if (returnType) {
      // Remove the '-> ' prefix if present
      const text = returnType.text;
      return text.startsWith('->') ? text.slice(2).trim() : text;
    }
    return undefined;
  }

  /**
   * Extract function parameters
   */
  private extractParameters(
    node: Parser.SyntaxNode,
    isMethod: boolean
  ): ExtractedParameter[] | undefined {
    const params = this.getChildByField(node, 'parameters');
    if (!params) return undefined;

    const parameters: ExtractedParameter[] = [];
    let position = 0;

    for (const child of params.children) {
      if (
        child.type === 'identifier' ||
        child.type === 'typed_parameter' ||
        child.type === 'default_parameter' ||
        child.type === 'typed_default_parameter' ||
        child.type === 'list_splat_pattern' ||
        child.type === 'dictionary_splat_pattern'
      ) {
        const param = this.extractParameter(child, position, isMethod);
        if (param) {
          // Skip 'self' and 'cls' from parameter list
          if (param.name !== 'self' && param.name !== 'cls') {
            parameters.push(param);
            position++;
          } else if (position === 0) {
            // Don't increment position for self/cls, but mark we've seen it
          }
        }
      }
    }

    return parameters.length > 0 ? parameters : undefined;
  }

  /**
   * Extract single parameter
   */
  private extractParameter(
    node: Parser.SyntaxNode,
    position: number,
    _isMethod: boolean
  ): ExtractedParameter | null {
    let name: string;
    let typeAnnotation: string | undefined;
    let isOptional = false;

    switch (node.type) {
      case 'identifier':
        name = node.text;
        break;

      case 'typed_parameter': {
        const nameNode = this.getFirstChildByType(node, 'identifier');
        if (!nameNode) return null;
        name = nameNode.text;
        const typeNode = this.getChildByField(node, 'type');
        if (typeNode) {
          typeAnnotation = typeNode.text;
        }
        break;
      }

      case 'default_parameter': {
        const nameNode = this.getChildByField(node, 'name');
        if (!nameNode) return null;
        name = nameNode.text;
        isOptional = true;
        break;
      }

      case 'typed_default_parameter': {
        const nameNode = this.getChildByField(node, 'name');
        if (!nameNode) return null;
        name = nameNode.text;
        const typeNode = this.getChildByField(node, 'type');
        if (typeNode) {
          typeAnnotation = typeNode.text;
        }
        isOptional = true;
        break;
      }

      case 'list_splat_pattern': {
        // *args
        const nameNode = this.getFirstChildByType(node, 'identifier');
        if (!nameNode) return null;
        name = '*' + nameNode.text;
        break;
      }

      case 'dictionary_splat_pattern': {
        // **kwargs
        const nameNode = this.getFirstChildByType(node, 'identifier');
        if (!nameNode) return null;
        name = '**' + nameNode.text;
        break;
      }

      default:
        return null;
    }

    return {
      position,
      name,
      type_annotation: typeAnnotation,
      is_optional: isOptional,
    };
  }

  /**
   * Extract docstring from function/class
   */
  private extractDocstring(
    node: Parser.SyntaxNode,
    _sourceCode: string
  ): ExtractedDocstring | undefined {
    // Python docstrings are the first statement in a function/class body
    const bodyNode = this.getChildByField(node, 'body');
    if (!bodyNode) return undefined;

    // Get first child that's an expression_statement containing a string
    for (const child of bodyNode.children) {
      if (child.type === 'expression_statement') {
        const stringNode = this.getFirstChildByType(child, 'string');
        if (stringNode) {
          const rawText = stringNode.text;
          // Remove quotes
          const cleanText = this.cleanDocstring(rawText);

          return {
            doc_type: 'pydoc',
            raw_text: rawText,
            description: cleanText,
          };
        }
        break; // Docstring must be first statement
      } else if (child.type !== 'comment') {
        break; // Not a docstring
      }
    }

    return undefined;
  }

  /**
   * Clean docstring by removing quotes and leading whitespace
   */
  private cleanDocstring(docstring: string): string {
    // Remove triple quotes
    let clean = docstring;
    if (clean.startsWith('"""') || clean.startsWith("'''")) {
      clean = clean.slice(3);
    }
    if (clean.endsWith('"""') || clean.endsWith("'''")) {
      clean = clean.slice(0, -3);
    }
    // Remove single quotes
    if (clean.startsWith('"') || clean.startsWith("'")) {
      clean = clean.slice(1);
    }
    if (clean.endsWith('"') || clean.endsWith("'")) {
      clean = clean.slice(0, -1);
    }

    // Trim and collapse whitespace
    return clean.trim().split('\n').map((l) => l.trim()).join(' ').trim();
  }

  // ==================== Usage Extraction ====================

  /**
   * Extract usages/references from AST
   */
  protected extractUsages(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string
  ): ExtractedUsage[] {
    const usages: ExtractedUsage[] = [];
    const seenLocations = new Set<string>();

    this.traverse(rootNode, (node) => {
      if (!USAGE_NODE_TYPES.includes(node.type)) return;

      // Skip if in definition context
      if (this.isInDefinitionContext(node)) return;

      const usage = this.extractUsageFromNode(node, filePath);
      if (usage) {
        // Deduplicate by location
        const key = `${usage.line}:${usage.column}:${usage.symbol_name}`;
        if (!seenLocations.has(key)) {
          seenLocations.add(key);
          usages.push(usage);
        }
      }
    });

    return usages;
  }

  /**
   * Check if node is in a definition context
   */
  private isInDefinitionContext(node: Parser.SyntaxNode): boolean {
    let current = node.parent;
    let depth = 0;

    while (current && depth < 5) {
      // Skip if this is a name field of a definition
      if (
        current.type === 'function_definition' ||
        current.type === 'class_definition'
      ) {
        const nameNode = this.getChildByField(current, 'name');
        if (nameNode?.id === node.id) return true;
      }

      // Skip parameter definitions
      if (current.type === 'parameters') {
        return true;
      }

      // Skip import statements
      if (
        current.type === 'import_statement' ||
        current.type === 'import_from_statement'
      ) {
        return true;
      }

      // Skip assignment left side
      if (current.type === 'assignment') {
        const left = this.getChildByField(current, 'left');
        if (left?.id === node.id) return true;
      }

      // Skip for loop variable
      if (current.type === 'for_statement') {
        const left = this.getChildByField(current, 'left');
        if (left && (left.id === node.id || left.text.includes(node.text))) {
          return true;
        }
      }

      current = current.parent;
      depth++;
    }

    return false;
  }

  /**
   * Extract usage from node
   */
  private extractUsageFromNode(
    node: Parser.SyntaxNode,
    filePath: string
  ): ExtractedUsage | null {
    let symbolName: string;

    if (node.type === 'identifier') {
      symbolName = node.text;
    } else if (node.type === 'attribute') {
      // For attribute access like obj.method, we want 'method'
      const attrNode = this.getChildByField(node, 'attribute');
      if (!attrNode) return null;
      symbolName = attrNode.text;
    } else {
      return null;
    }

    if (!symbolName || symbolName.length === 0) return null;

    const location = this.getLocation(node);
    const usageType = this.determineUsageType(node);
    const enclosingSymbol = this.findEnclosingSymbolName(node);

    // Skip Python builtins for regular usages, but allow class inheritance
    // We want to track when user code extends built-in types like Exception
    if (PYTHON_BUILTINS.has(symbolName) && usageType !== 'extend') {
      return null;
    }

    return {
      symbol_name: symbolName,
      file_path: filePath,
      line: location.startLine,
      column: location.startColumn,
      usage_type: usageType,
      enclosing_symbol_qualified_name: enclosingSymbol,
    };
  }

  /**
   * Determine the type of usage
   */
  private determineUsageType(node: Parser.SyntaxNode): UsageType {
    const parent = node.parent;
    if (!parent) return 'read';

    // Function/method call
    if (parent.type === 'call') {
      const func = this.getChildByField(parent, 'function');
      if (func && (func.id === node.id || func.text.endsWith(node.text))) {
        return 'call';
      }
    }

    // Assignment
    if (parent.type === 'assignment') {
      const left = this.getChildByField(parent, 'left');
      if (left?.id === node.id) {
        return 'write';
      }
    }

    // Class inheritance
    if (parent.type === 'argument_list') {
      const grandparent = parent.parent;
      if (grandparent?.type === 'class_definition') {
        return 'extend';
      }
    }

    // Type annotation
    if (
      parent.type === 'type' ||
      this.isInsideNodeType(node, 'type')
    ) {
      return 'type_ref';
    }

    // Decorator
    if (parent.type === 'decorator') {
      return 'decorator';
    }

    return 'read';
  }

  /**
   * Find enclosing symbol qualified name
   */
  private findEnclosingSymbolName(node: Parser.SyntaxNode): string | undefined {
    const enclosingTypes = ['function_definition', 'class_definition'];
    const enclosing = this.findEnclosingSymbol(node, enclosingTypes);

    if (!enclosing) return undefined;

    const nameNode = this.getChildByField(enclosing, 'name');
    if (!nameNode) return undefined;

    const name = nameNode.text;

    // Build qualified name by walking up
    const parts: string[] = [name];
    let current = enclosing.parent;

    while (current) {
      if (current.type === 'class_definition') {
        const classNameNode = this.getChildByField(current, 'name');
        if (classNameNode) {
          parts.unshift(classNameNode.text);
        }
      }
      current = current.parent;
    }

    return parts.join('.');
  }

  // ==================== Import Extraction ====================

  /**
   * Extract imports from AST
   */
  protected extractImports(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    _sourceCode: string
  ): ExtractedImport[] {
    const imports: ExtractedImport[] = [];

    // Find all import statements
    const importStatements = this.findAllDescendantsByType(
      rootNode,
      'import_statement'
    );
    for (const node of importStatements) {
      const importData = this.extractImportStatement(node, filePath);
      if (importData) {
        imports.push(importData);
      }
    }

    // Find all from ... import statements
    const fromImports = this.findAllDescendantsByType(
      rootNode,
      'import_from_statement'
    );
    for (const node of fromImports) {
      const importData = this.extractFromImportStatement(node, filePath);
      if (importData) {
        imports.push(importData);
      }
    }

    return imports;
  }

  /**
   * Extract from simple import statement (import x, import x as y)
   */
  private extractImportStatement(
    node: Parser.SyntaxNode,
    filePath: string
  ): ExtractedImport | null {
    const location = this.getLocation(node);
    const bindings: ExtractedImportBinding[] = [];

    // Find all dotted_name or aliased_import children
    for (const child of node.children) {
      if (child.type === 'dotted_name') {
        bindings.push({
          imported_name: child.text,
          local_name: child.text.split('.').pop() ?? child.text,
        });
      } else if (child.type === 'aliased_import') {
        const nameNode = this.getChildByField(child, 'name');
        const aliasNode = this.getChildByField(child, 'alias');
        if (nameNode) {
          bindings.push({
            imported_name: nameNode.text,
            local_name: aliasNode?.text ?? nameNode.text,
          });
        }
      }
    }

    if (bindings.length === 0) return null;

    // Module specifier is the first imported name
    const firstBinding = bindings[0];
    if (!firstBinding) return null;
    const moduleSpecifier = firstBinding.imported_name;

    return {
      file_path: filePath,
      line: location.startLine,
      import_type: 'python',
      module_specifier: moduleSpecifier,
      bindings,
    };
  }

  /**
   * Extract from "from x import y" statement
   */
  private extractFromImportStatement(
    node: Parser.SyntaxNode,
    filePath: string
  ): ExtractedImport | null {
    const location = this.getLocation(node);

    // Get module name
    const moduleNode = this.getChildByField(node, 'module_name');
    if (!moduleNode) return null;

    const moduleSpecifier = moduleNode.text;
    const bindings: ExtractedImportBinding[] = [];

    // Find imported names
    for (const child of node.children) {
      if (child.type === 'dotted_name' || child.type === 'identifier') {
        // Skip the module name itself
        if (child.id === moduleNode.id) continue;

        bindings.push({
          imported_name: child.text,
          local_name: child.text,
        });
      } else if (child.type === 'aliased_import') {
        const nameNode = this.getChildByField(child, 'name');
        const aliasNode = this.getChildByField(child, 'alias');
        if (nameNode) {
          bindings.push({
            imported_name: nameNode.text,
            local_name: aliasNode?.text ?? nameNode.text,
          });
        }
      } else if (child.type === 'wildcard_import') {
        bindings.push({
          imported_name: '*',
          local_name: '*',
        });
      }
    }

    return {
      file_path: filePath,
      line: location.startLine,
      import_type: 'python',
      module_specifier: moduleSpecifier,
      bindings,
    };
  }
}
