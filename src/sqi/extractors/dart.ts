/**
 * Dart Symbol Extractor for SQI
 *
 * Extracts symbols, usages, and imports from Dart code using Tree-sitter.
 * Supports Flutter and Dart language constructs including:
 * - Classes (including abstract classes)
 * - Mixins
 * - Extensions
 * - Enums
 * - Functions (top-level and methods)
 * - Getters and Setters
 * - Constructors (named, factory, const)
 * - Fields and Constants
 */

import Parser from 'tree-sitter';
import { SymbolExtractor, NodeTypeMapping } from './base.js';
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

/**
 * Mapping of Dart AST node types to SymbolKind
 */
const DART_SYMBOL_TYPES: NodeTypeMapping = {
  class_definition: SymbolKind.CLASS,
  mixin_declaration: SymbolKind.TRAIT, // Dart mixins are similar to traits
  enum_declaration: SymbolKind.ENUM,
  extension_declaration: SymbolKind.NAMESPACE, // Extensions add methods to types
};

/**
 * Node types that represent usages/references
 */
const USAGE_NODE_TYPES = [
  'identifier',
  'type_identifier',
  'selector', // for method calls like obj.method()
];

/**
 * Common Dart built-in types and functions to skip in usage tracking
 */
const DART_BUILTINS = new Set([
  // Core types
  'void', 'dynamic', 'Object', 'Null', 'Never',
  'bool', 'num', 'int', 'double', 'String',
  'List', 'Set', 'Map', 'Iterable', 'Iterator',
  'Future', 'Stream', 'Function', 'Type', 'Symbol',
  'Duration', 'DateTime', 'Uri', 'Pattern', 'Match',
  'RegExp', 'Error', 'Exception', 'StackTrace',
  // Common functions
  'print', 'main', 'assert', 'throw', 'rethrow',
  // Constants
  'true', 'false', 'null', 'this', 'super',
  // Keywords used as identifiers
  'get', 'set', 'async', 'await', 'yield', 'sync',
]);

/**
 * Dart Symbol Extractor
 */
export class DartExtractor extends SymbolExtractor {
  readonly language = 'dart';
  readonly aliases: string[] = [];

  /**
   * Extract symbols from Dart AST
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
    // Handle top-level declarations (in program node)
    if (node.type === 'program') {
      for (const child of node.children) {
        this.traverseForSymbols(child, filePath, sourceCode, symbols, parentQualifiedName);
      }
      return;
    }

    // Handle class/enum/mixin/extension definitions
    const symbolKind = DART_SYMBOL_TYPES[node.type];
    if (symbolKind) {
      const symbol = this.extractClassLikeSymbol(node, filePath, sourceCode, symbolKind);
      if (symbol) {
        symbols.push(symbol);
      }
      return;
    }

    // Handle top-level function declarations (declaration node containing function_signature)
    if (node.type === 'declaration' && !parentQualifiedName) {
      const funcSig = this.getFirstChildByType(node, 'function_signature');
      if (funcSig) {
        const symbol = this.extractFunctionSymbol(
          node,
          funcSig,
          filePath,
          sourceCode,
          parentQualifiedName
        );
        if (symbol) {
          symbols.push(symbol);
        }
        return;
      }

      // Handle top-level variable/constant declarations
      const varSymbol = this.extractVariableDeclaration(node, filePath, sourceCode);
      if (varSymbol) {
        symbols.push(varSymbol);
      }
      return;
    }

    // Handle class body members
    if (node.type === 'class_body' || node.type === 'extension_body') {
      for (const child of node.children) {
        this.traverseForSymbols(child, filePath, sourceCode, symbols, parentQualifiedName);
      }
      return;
    }

    // Handle declaration nodes (methods, getters, setters, constructors, fields)
    if (node.type === 'declaration' && parentQualifiedName) {
      this.extractClassMember(node, filePath, sourceCode, symbols, parentQualifiedName);
      return;
    }

    // Handle method_signature nodes with function body
    if (node.type === 'method_signature' && parentQualifiedName) {
      this.extractMethodSignature(node, filePath, sourceCode, symbols, parentQualifiedName);
      return;
    }

    // Continue recursion for other node types
    for (const child of node.children) {
      if (child.type !== 'class_body' && child.type !== 'extension_body') {
        this.traverseForSymbols(child, filePath, sourceCode, symbols, parentQualifiedName);
      }
    }
  }

  /**
   * Extract class, mixin, enum, or extension symbol
   */
  private extractClassLikeSymbol(
    node: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string,
    kind: SymbolKind
  ): ExtractedSymbol | null {
    // Get name - class_definition uses field, mixin/extension use first identifier
    let name: string | null = null;
    const nameNode = this.getChildByField(node, 'name');
    if (nameNode) {
      name = nameNode.text;
    } else {
      // For mixin_declaration, find first identifier
      const identNode = this.getFirstChildByType(node, 'identifier');
      if (identNode) {
        name = identNode.text;
      }
    }

    if (!name) return null;

    const location = this.getLocation(node);
    // Note: isAbstract could be used to add an "is_abstract" field if needed
    // const isAbstract = this.hasModifier(node, 'abstract');
    const docstring = this.extractDocComment(node, sourceCode);

    const symbol: ExtractedSymbol = {
      name,
      qualified_name: name,
      symbol_kind: kind,
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      visibility: 'public',
      is_static: false,
      is_exported: !name.startsWith('_'),
      content_hash: this.generateContentHash(node.text),
      docstring,
    };

    // Extract children (methods, fields, etc.)
    const bodyNode = this.getChildByField(node, 'body');
    if (bodyNode) {
      symbol.children = [];
      for (const child of bodyNode.children) {
        this.traverseForSymbols(
          child,
          filePath,
          sourceCode,
          symbol.children,
          name
        );
      }
    }

    return symbol;
  }

  /**
   * Extract function symbol (top-level or lambda)
   */
  private extractFunctionSymbol(
    declarationNode: Parser.SyntaxNode,
    signatureNode: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string,
    parentQualifiedName?: string
  ): ExtractedSymbol | null {
    const nameNode = this.getChildByField(signatureNode, 'name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const location = this.getLocation(declarationNode);
    const qualifiedName = this.buildQualifiedName(name, parentQualifiedName);
    const isAsync = this.isAsyncFunction(declarationNode);
    const returnType = this.extractReturnType(signatureNode);
    const parameters = this.extractParameters(signatureNode);
    const docstring = this.extractDocComment(declarationNode, sourceCode);
    const visibility = this.determineVisibility(name);

    return {
      name,
      qualified_name: qualifiedName,
      symbol_kind: parentQualifiedName ? SymbolKind.METHOD : SymbolKind.FUNCTION,
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      visibility,
      is_async: isAsync,
      is_static: this.hasModifier(declarationNode, 'static'),
      is_exported: !name.startsWith('_'),
      return_type: returnType,
      parameters,
      docstring,
      content_hash: this.generateContentHash(declarationNode.text),
    };
  }

  /**
   * Extract class member from declaration node
   */
  private extractClassMember(
    node: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string,
    symbols: ExtractedSymbol[],
    parentQualifiedName: string
  ): void {
    // Check for function (method)
    const funcSig = this.getFirstChildByType(node, 'function_signature');
    if (funcSig) {
      const symbol = this.extractFunctionSymbol(
        node,
        funcSig,
        filePath,
        sourceCode,
        parentQualifiedName
      );
      if (symbol) {
        symbol.is_static = this.hasModifier(node, 'static');
        symbols.push(symbol);
      }
      return;
    }

    // Check for getter
    const getterSig = this.getFirstChildByType(node, 'getter_signature');
    if (getterSig) {
      const symbol = this.extractGetterSetter(
        node,
        getterSig,
        filePath,
        sourceCode,
        parentQualifiedName,
        SymbolKind.GETTER
      );
      if (symbol) symbols.push(symbol);
      return;
    }

    // Check for setter
    const setterSig = this.getFirstChildByType(node, 'setter_signature');
    if (setterSig) {
      const symbol = this.extractGetterSetter(
        node,
        setterSig,
        filePath,
        sourceCode,
        parentQualifiedName,
        SymbolKind.SETTER
      );
      if (symbol) symbols.push(symbol);
      return;
    }

    // Check for constructor
    const ctorSig = this.getFirstChildByType(node, 'constructor_signature');
    if (ctorSig) {
      const symbol = this.extractConstructor(
        node,
        ctorSig,
        filePath,
        sourceCode,
        parentQualifiedName,
        false
      );
      if (symbol) symbols.push(symbol);
      return;
    }

    // Check for factory constructor
    const factorySig = this.getFirstChildByType(node, 'factory_constructor_signature');
    if (factorySig) {
      const symbol = this.extractConstructor(
        node,
        factorySig,
        filePath,
        sourceCode,
        parentQualifiedName,
        true
      );
      if (symbol) symbols.push(symbol);
      return;
    }

    // Check for const constructor
    const constCtorSig = this.getFirstChildByType(node, 'constant_constructor_signature');
    if (constCtorSig) {
      const symbol = this.extractConstructor(
        node,
        constCtorSig,
        filePath,
        sourceCode,
        parentQualifiedName,
        false
      );
      if (symbol) symbols.push(symbol);
      return;
    }

    // Check for field declaration
    const fieldSymbol = this.extractFieldDeclaration(node, filePath, sourceCode, parentQualifiedName);
    if (fieldSymbol) {
      symbols.push(fieldSymbol);
    }
  }

  /**
   * Extract method signature (abstract methods)
   */
  private extractMethodSignature(
    node: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string,
    symbols: ExtractedSymbol[],
    parentQualifiedName: string
  ): void {
    // Check for function signature
    const funcSig = this.getFirstChildByType(node, 'function_signature');
    if (funcSig) {
      const nameNode = this.getChildByField(funcSig, 'name');
      if (!nameNode) return;

      const name = nameNode.text;
      const location = this.getLocation(node);
      const qualifiedName = this.buildQualifiedName(name, parentQualifiedName);
      const returnType = this.extractReturnType(funcSig);
      const parameters = this.extractParameters(funcSig);
      const docstring = this.extractDocComment(node, sourceCode);

      symbols.push({
        name,
        qualified_name: qualifiedName,
        symbol_kind: SymbolKind.METHOD,
        file_path: filePath,
        start_line: location.startLine,
        end_line: location.endLine,
        visibility: this.determineVisibility(name),
        is_async: false,
        is_static: false,
        is_exported: !name.startsWith('_'),
        return_type: returnType,
        parameters,
        docstring,
        content_hash: this.generateContentHash(node.text),
      });
      return;
    }

    // Check for getter signature
    const getterSig = this.getFirstChildByType(node, 'getter_signature');
    if (getterSig) {
      const symbol = this.extractGetterSetter(
        node,
        getterSig,
        filePath,
        sourceCode,
        parentQualifiedName,
        SymbolKind.GETTER
      );
      if (symbol) symbols.push(symbol);
      return;
    }

    // Check for setter signature
    const setterSig = this.getFirstChildByType(node, 'setter_signature');
    if (setterSig) {
      const symbol = this.extractGetterSetter(
        node,
        setterSig,
        filePath,
        sourceCode,
        parentQualifiedName,
        SymbolKind.SETTER
      );
      if (symbol) symbols.push(symbol);
      return;
    }

    // Check for constructor signature
    const ctorSig = this.getFirstChildByType(node, 'constructor_signature');
    if (ctorSig) {
      const symbol = this.extractConstructor(
        node,
        ctorSig,
        filePath,
        sourceCode,
        parentQualifiedName,
        false
      );
      if (symbol) symbols.push(symbol);
    }
  }

  /**
   * Extract getter or setter
   */
  private extractGetterSetter(
    declarationNode: Parser.SyntaxNode,
    signatureNode: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string,
    parentQualifiedName: string,
    kind: SymbolKind.GETTER | SymbolKind.SETTER
  ): ExtractedSymbol | null {
    const nameNode = this.getChildByField(signatureNode, 'name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const location = this.getLocation(declarationNode);
    const qualifiedName = this.buildQualifiedName(name, parentQualifiedName);
    const returnType = this.extractReturnType(signatureNode);
    const docstring = this.extractDocComment(declarationNode, sourceCode);
    const parameters = kind === SymbolKind.SETTER
      ? this.extractParameters(signatureNode)
      : undefined;

    return {
      name,
      qualified_name: qualifiedName,
      symbol_kind: kind,
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      visibility: this.determineVisibility(name),
      is_static: this.hasModifier(declarationNode, 'static'),
      is_exported: !name.startsWith('_'),
      return_type: returnType,
      parameters,
      docstring,
      content_hash: this.generateContentHash(declarationNode.text),
    };
  }

  /**
   * Extract constructor
   */
  private extractConstructor(
    declarationNode: Parser.SyntaxNode,
    signatureNode: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string,
    parentQualifiedName: string,
    isFactory: boolean
  ): ExtractedSymbol | null {
    // Constructor name is typically the class name, or class.namedConstructor
    const nameNodes = signatureNode.children.filter(
      (c) => c.type === 'identifier'
    );

    let name: string;
    if (nameNodes.length > 1) {
      // Named constructor: ClassName.constructorName
      name = nameNodes.map((n) => n.text).join('.');
    } else if (nameNodes.length === 1) {
      name = nameNodes[0]!.text;
    } else {
      return null;
    }

    const location = this.getLocation(declarationNode);
    const qualifiedName = this.buildQualifiedName(name, parentQualifiedName);
    const parameters = this.extractParameters(signatureNode);
    const docstring = this.extractDocComment(declarationNode, sourceCode);

    return {
      name,
      qualified_name: qualifiedName,
      symbol_kind: SymbolKind.CONSTRUCTOR,
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      visibility: this.determineVisibility(name),
      is_static: isFactory, // Factory constructors are effectively static
      is_exported: !name.startsWith('_'),
      parameters,
      docstring,
      content_hash: this.generateContentHash(declarationNode.text),
    };
  }

  /**
   * Extract field declaration
   */
  private extractFieldDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string,
    parentQualifiedName: string
  ): ExtractedSymbol | null {
    // Look for identifier_list or initialized_identifier_list
    const identListNode = this.getFirstChildByType(node, 'identifier_list');
    const initListNode = this.getFirstChildByType(node, 'initialized_identifier_list');

    let name: string | null = null;

    if (initListNode) {
      const initIdNode = this.getFirstChildByType(initListNode, 'initialized_identifier');
      if (initIdNode) {
        const idNode = this.getFirstChildByType(initIdNode, 'identifier');
        if (idNode) name = idNode.text;
      }
    } else if (identListNode) {
      const idNode = this.getFirstChildByType(identListNode, 'identifier');
      if (idNode) name = idNode.text;
    }

    if (!name) return null;

    const location = this.getLocation(node);
    const qualifiedName = this.buildQualifiedName(name, parentQualifiedName);
    const isConst = this.hasModifier(node, 'const') || this.hasChildType(node, 'const_builtin');
    // Note: isFinal could be used to differentiate final from var fields
    // const isFinal = this.hasChildType(node, 'final_builtin');
    const isStatic = this.hasModifier(node, 'static');
    const docstring = this.extractDocComment(node, sourceCode);
    const returnType = this.extractFieldType(node);

    return {
      name,
      qualified_name: qualifiedName,
      symbol_kind: isConst ? SymbolKind.CONSTANT : SymbolKind.FIELD,
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      visibility: this.determineVisibility(name),
      is_static: isStatic || isConst,
      is_exported: !name.startsWith('_'),
      return_type: returnType,
      docstring,
      content_hash: this.generateContentHash(node.text),
    };
  }

  /**
   * Extract top-level variable/constant declaration
   */
  private extractVariableDeclaration(
    node: Parser.SyntaxNode,
    filePath: string,
    sourceCode: string
  ): ExtractedSymbol | null {
    // Look for initialized_identifier_list or identifier_list
    const initListNode = this.getFirstChildByType(node, 'initialized_identifier_list');
    const identListNode = this.getFirstChildByType(node, 'identifier_list');

    let name: string | null = null;

    if (initListNode) {
      const initIdNode = this.getFirstChildByType(initListNode, 'initialized_identifier');
      if (initIdNode) {
        const idNode = this.getFirstChildByType(initIdNode, 'identifier');
        if (idNode) name = idNode.text;
      }
    } else if (identListNode) {
      const idNode = this.getFirstChildByType(identListNode, 'identifier');
      if (idNode) name = idNode.text;
    }

    if (!name) return null;

    const location = this.getLocation(node);
    const isConst = this.hasModifier(node, 'const') || this.hasChildType(node, 'const_builtin');
    const docstring = this.extractDocComment(node, sourceCode);
    const returnType = this.extractFieldType(node);

    return {
      name,
      qualified_name: name,
      symbol_kind: isConst ? SymbolKind.CONSTANT : SymbolKind.VARIABLE,
      file_path: filePath,
      start_line: location.startLine,
      end_line: location.endLine,
      visibility: this.determineVisibility(name),
      is_static: true, // Top-level is effectively static
      is_exported: !name.startsWith('_'),
      return_type: returnType,
      docstring,
      content_hash: this.generateContentHash(node.text),
    };
  }

  // ==================== Helper Methods ====================

  /**
   * Check if a modifier is present
   */
  private hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
    for (const child of node.children) {
      if (child.type === modifier || child.text === modifier) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if node has a child of specific type
   */
  private hasChildType(node: Parser.SyntaxNode, type: string): boolean {
    return node.children.some((c) => c.type === type);
  }

  /**
   * Determine visibility from name convention
   */
  private determineVisibility(name: string): Visibility {
    // Dart uses underscore prefix for private
    return name.startsWith('_') ? 'private' : 'public';
  }

  /**
   * Check if function is async
   */
  private isAsyncFunction(node: Parser.SyntaxNode): boolean {
    const bodyNode = this.findDescendantByType(node, 'function_body');
    if (bodyNode) {
      for (const child of bodyNode.children) {
        if (child.type === 'async') return true;
      }
    }
    return node.text.includes(' async ') || node.text.includes(' async*');
  }

  /**
   * Extract return type from signature
   */
  private extractReturnType(signatureNode: Parser.SyntaxNode): string | undefined {
    // Look for type_identifier or void_type before the name
    for (const child of signatureNode.children) {
      if (child.type === 'type_identifier') {
        // May have type arguments
        const typeArgs = this.getFirstChildByType(signatureNode, 'type_arguments');
        if (typeArgs) {
          return child.text + typeArgs.text;
        }
        return child.text;
      }
      if (child.type === 'void_type') {
        return 'void';
      }
      if (child.type === 'function_type') {
        return child.text;
      }
    }
    return undefined;
  }

  /**
   * Extract type from field declaration
   */
  private extractFieldType(node: Parser.SyntaxNode): string | undefined {
    const typeIdNode = this.getFirstChildByType(node, 'type_identifier');
    if (typeIdNode) {
      const typeArgs = this.getFirstChildByType(node, 'type_arguments');
      if (typeArgs) {
        return typeIdNode.text + typeArgs.text;
      }
      return typeIdNode.text;
    }
    return undefined;
  }

  /**
   * Extract function parameters
   */
  private extractParameters(
    signatureNode: Parser.SyntaxNode
  ): ExtractedParameter[] | undefined {
    const paramsNode = this.findDescendantByType(signatureNode, 'formal_parameter_list');
    if (!paramsNode) return undefined;

    const parameters: ExtractedParameter[] = [];
    let position = 0;

    this.traverse(paramsNode, (child) => {
      if (child.type === 'formal_parameter' || child.type === 'constructor_param') {
        const param = this.extractSingleParameter(child, position);
        if (param) {
          parameters.push(param);
          position++;
        }
      }
    });

    return parameters.length > 0 ? parameters : undefined;
  }

  /**
   * Extract single parameter
   */
  private extractSingleParameter(
    node: Parser.SyntaxNode,
    position: number
  ): ExtractedParameter | null {
    // Look for identifier
    const idNode = this.getFirstChildByType(node, 'identifier');
    if (!idNode) return null;

    const name = idNode.text;

    // Check for type
    let typeAnnotation: string | undefined;
    const typeNode = this.getFirstChildByType(node, 'type_identifier');
    if (typeNode) {
      typeAnnotation = typeNode.text;
      const typeArgs = this.getFirstChildByType(node, 'type_arguments');
      if (typeArgs) {
        typeAnnotation += typeArgs.text;
      }
    }

    // Check for optional (named params in {} or optional positional in [])
    const isOptional = this.isInsideNodeType(node, 'optional_formal_parameters') ||
      this.isInsideNodeType(node, 'optional_positional_formal_parameters');

    return {
      position,
      name,
      type_annotation: typeAnnotation,
      is_optional: isOptional,
    };
  }

  /**
   * Extract documentation comment
   */
  private extractDocComment(
    node: Parser.SyntaxNode,
    _sourceCode: string
  ): ExtractedDocstring | undefined {
    // Look for preceding comment
    let prevSibling = node.previousNamedSibling;

    // Skip annotations to find comments
    while (prevSibling && (prevSibling.type === 'annotation' || prevSibling.type === 'marker_annotation')) {
      prevSibling = prevSibling.previousNamedSibling;
    }

    if (prevSibling?.type === 'documentation_comment') {
      const rawText = prevSibling.text;
      const description = this.cleanDocComment(rawText);

      return {
        doc_type: 'other',
        raw_text: rawText,
        description,
      };
    }

    // Also check for comment node
    if (prevSibling?.type === 'comment') {
      const text = prevSibling.text;
      if (text.startsWith('///') || text.startsWith('/**')) {
        return {
          doc_type: 'other',
          raw_text: text,
          description: this.cleanDocComment(text),
        };
      }
    }

    return undefined;
  }

  /**
   * Clean documentation comment
   */
  private cleanDocComment(comment: string): string {
    return comment
      .split('\n')
      .map((line) => {
        // Remove /// prefix
        if (line.trimStart().startsWith('///')) {
          return line.replace(/^\s*\/\/\/\s?/, '');
        }
        // Remove /** */ prefix/suffix
        return line
          .replace(/^\s*\/\*\*\s?/, '')
          .replace(/\s*\*\/\s*$/, '')
          .replace(/^\s*\*\s?/, '');
      })
      .join(' ')
      .trim();
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
      // Skip if this is a name in a definition
      if (current.type === 'class_definition' ||
          current.type === 'function_signature' ||
          current.type === 'getter_signature' ||
          current.type === 'setter_signature' ||
          current.type === 'constructor_signature' ||
          current.type === 'factory_constructor_signature' ||
          current.type === 'mixin_declaration' ||
          current.type === 'enum_declaration' ||
          current.type === 'extension_declaration') {
        const nameNode = this.getChildByField(current, 'name');
        if (nameNode?.id === node.id) return true;
      }

      // Skip parameter definitions
      if (current.type === 'formal_parameter_list' ||
          current.type === 'formal_parameter' ||
          current.type === 'constructor_param') {
        return true;
      }

      // Skip import statements
      if (current.type === 'import_specification' ||
          current.type === 'library_import' ||
          current.type === 'library_export') {
        return true;
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

    if (node.type === 'identifier' || node.type === 'type_identifier') {
      symbolName = node.text;
    } else if (node.type === 'selector') {
      // For selector like .method(), get the unconditional_assignable_selector
      const assignable = this.getFirstChildByType(node, 'unconditional_assignable_selector');
      if (assignable) {
        const idNode = this.getFirstChildByType(assignable, 'identifier');
        if (idNode) {
          symbolName = idNode.text;
        } else {
          return null;
        }
      } else {
        return null;
      }
    } else {
      return null;
    }

    if (!symbolName || symbolName.length === 0) return null;

    // Skip Dart builtins
    if (DART_BUILTINS.has(symbolName)) return null;

    const location = this.getLocation(node);
    const usageType = this.determineUsageType(node);
    const enclosingSymbol = this.findEnclosingSymbolName(node);

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

    // Constructor invocation (new Foo())
    if (parent.type === 'new_expression' || parent.type === 'const_object_expression') {
      return 'instantiate';
    }

    // Method/function call
    if (parent.type === 'selector' || parent.type === 'argument_part') {
      return 'call';
    }

    // Type reference (extends, implements, with, type annotation)
    if (parent.type === 'superclass') {
      return 'extend';
    }
    if (parent.type === 'interfaces' || parent.type === 'mixins') {
      return 'implement';
    }
    if (node.type === 'type_identifier') {
      return 'type_ref';
    }

    // Annotation
    if (parent.type === 'annotation' || parent.type === 'marker_annotation') {
      return 'decorator';
    }

    // Assignment
    if (parent.type === 'assignment_expression') {
      const left = parent.children[0];
      if (left?.id === node.id) {
        return 'write';
      }
    }

    return 'read';
  }

  /**
   * Find enclosing symbol qualified name
   */
  private findEnclosingSymbolName(node: Parser.SyntaxNode): string | undefined {
    const enclosingTypes = [
      'function_signature',
      'class_definition',
      'mixin_declaration',
      'extension_declaration',
    ];

    let current = node.parent;
    const parts: string[] = [];

    while (current) {
      for (const type of enclosingTypes) {
        if (current.type === type) {
          const nameNode = this.getChildByField(current, 'name');
          if (nameNode) {
            parts.unshift(nameNode.text);
          } else if (current.type === 'mixin_declaration') {
            const idNode = this.getFirstChildByType(current, 'identifier');
            if (idNode) parts.unshift(idNode.text);
          }
          break;
        }
      }
      current = current.parent;
    }

    return parts.length > 0 ? parts.join('.') : undefined;
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
    const importNodes = this.findAllDescendantsByType(rootNode, 'library_import');
    for (const node of importNodes) {
      const importData = this.extractImportStatement(node, filePath);
      if (importData) {
        imports.push(importData);
      }
    }

    return imports;
  }

  /**
   * Extract import statement
   */
  private extractImportStatement(
    node: Parser.SyntaxNode,
    filePath: string
  ): ExtractedImport | null {
    // Get import URI from import_specification
    const importSpec = this.getFirstChildByType(node, 'import_specification');
    if (!importSpec) return null;

    const uriNode = this.getFirstChildByType(importSpec, 'uri');
    if (!uriNode) return null;

    // Extract the string value
    const stringNode = this.getFirstChildByType(uriNode, 'string_literal');
    if (!stringNode) return null;

    const moduleSpecifier = stringNode.text.replace(/^['"]|['"]$/g, '');
    const location = this.getLocation(node);
    const bindings: ExtractedImportBinding[] = [];

    // Check for 'as' alias
    const asNode = this.getFirstChildByType(importSpec, 'identifier');
    if (asNode) {
      bindings.push({
        imported_name: '*',
        local_name: asNode.text,
      });
    }

    // Check for show/hide combinators
    const showNode = this.findDescendantByType(importSpec, 'show_combinator');
    if (showNode) {
      for (const child of showNode.children) {
        if (child.type === 'identifier') {
          bindings.push({
            imported_name: child.text,
            local_name: child.text,
          });
        }
      }
    }

    // If no specific bindings, import is full namespace
    if (bindings.length === 0) {
      bindings.push({
        imported_name: '*',
        local_name: '*',
      });
    }

    return {
      file_path: filePath,
      line: location.startLine,
      import_type: 'python', // Dart imports are similar to Python style
      module_specifier: moduleSpecifier,
      bindings,
    };
  }
}
