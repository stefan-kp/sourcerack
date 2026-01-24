/**
 * Endpoint Extractor Registry
 *
 * Central registry for framework-specific API endpoint extractors.
 * Handles framework detection and extractor selection.
 */

import Parser from 'tree-sitter';
import { EndpointExtractor } from './base.js';
import { DjangoExtractor } from './django.js';
import { ExpressExtractor } from './express.js';
import { FastAPIExtractor } from './fastapi.js';
import { FastifyExtractor } from './fastify.js';
import { FlaskExtractor } from './flask.js';
import { KoaExtractor } from './koa.js';
import { MCPExtractor } from './mcp.js';
import { NestJSExtractor } from './nestjs.js';
import { RailsExtractor } from './rails.js';
import { RailsControllerExtractor } from './rails-controller.js';
import { SinatraExtractor } from './sinatra.js';
import {
  Framework,
  FrameworkDetection,
  EndpointExtractionResult,
  ExtractedEndpoint,
} from './types.js';
import { parseCode, initializeTreeSitter, ensureLanguageGrammar } from '../../../parser/tree-sitter.js';

/**
 * Framework detection patterns based on imports
 */
const FRAMEWORK_IMPORT_PATTERNS: Record<Framework, RegExp[]> = {
  express: [
    /^express$/,
  ],
  fastify: [
    /^fastify$/,
  ],
  koa: [
    /^koa$/,
    /^@koa\//,
  ],
  fastapi: [
    /^fastapi$/,
  ],
  flask: [
    /^flask$/,
  ],
  django: [
    /^rest_framework/,
    /^django\./,
  ],
  rails: [
    // Rails uses routes.rb file detection
  ],
  sinatra: [
    /^sinatra/,
  ],
  nestjs: [
    /^@nestjs\//,
  ],
  mcp: [
    /^@modelcontextprotocol\//,
  ],
  unknown: [],
};

/**
 * File patterns for framework detection
 */
const FRAMEWORK_FILE_PATTERNS: Partial<Record<Framework, RegExp[]>> = {
  rails: [
    /config\/routes\.rb$/,
    /controllers\/.*_controller\.rb$/,
  ],
  express: [
    /routes?\/.*\.(js|ts)$/,
    /app\.(js|ts)$/,
    /server\.(js|ts)$/,
  ],
  fastapi: [
    /main\.py$/,
    /app\.py$/,
    /routes?\/.*\.py$/,
    /api\/.*\.py$/,
  ],
};

/**
 * Endpoint extractor registry
 */
export class EndpointExtractorRegistry {
  private extractorsByFramework = new Map<Framework, EndpointExtractor[]>();
  private allExtractors: EndpointExtractor[] = [];
  private initialized = false;

  constructor() {
    // Register built-in extractors
    this.register(new DjangoExtractor());
    this.register(new ExpressExtractor());
    this.register(new FastAPIExtractor());
    this.register(new FastifyExtractor());
    this.register(new FlaskExtractor());
    this.register(new KoaExtractor());
    this.register(new MCPExtractor());
    this.register(new NestJSExtractor());
    this.register(new RailsExtractor());
    this.register(new RailsControllerExtractor());
    this.register(new SinatraExtractor());
  }

  /**
   * Register an extractor
   */
  register(extractor: EndpointExtractor): void {
    this.allExtractors.push(extractor);

    const existing = this.extractorsByFramework.get(extractor.framework) ?? [];
    existing.push(extractor);
    this.extractorsByFramework.set(extractor.framework, existing);
  }

  /**
   * Get extractors for a framework
   */
  getExtractors(framework: Framework): EndpointExtractor[] {
    return this.extractorsByFramework.get(framework) ?? [];
  }

  /**
   * Get first extractor for a framework (backwards compatibility)
   */
  getExtractor(framework: Framework): EndpointExtractor | null {
    const extractors = this.extractorsByFramework.get(framework);
    return extractors?.[0] ?? null;
  }

  /**
   * Get all registered frameworks
   */
  getRegisteredFrameworks(): Framework[] {
    return Array.from(this.extractorsByFramework.keys());
  }

  /**
   * Detect frameworks used in a file based on imports
   */
  detectFrameworks(imports: string[], filePath: string): FrameworkDetection[] {
    const detections: FrameworkDetection[] = [];

    // Check import patterns (each import individually)
    for (const [framework, patterns] of Object.entries(FRAMEWORK_IMPORT_PATTERNS)) {
      if (framework === 'unknown') continue;

      const evidence: string[] = [];
      let matchCount = 0;

      // Check each import against each pattern
      for (const imp of imports) {
        for (const pattern of patterns) {
          if (pattern.test(imp)) {
            matchCount++;
            evidence.push(`Import matches: ${pattern.source}`);
            break; // Only count each import once per framework
          }
        }
      }

      // Check file patterns
      const filePatterns = FRAMEWORK_FILE_PATTERNS[framework as Framework];
      if (filePatterns) {
        for (const pattern of filePatterns) {
          if (pattern.test(filePath)) {
            matchCount++;
            evidence.push(`File path matches: ${pattern.source}`);
          }
        }
      }

      if (matchCount > 0) {
        // Calculate confidence based on number of matches
        const confidence = Math.min(matchCount * 0.4, 1);
        detections.push({
          framework: framework as Framework,
          confidence,
          evidence,
        });
      }
    }

    // Sort by confidence
    detections.sort((a, b) => b.confidence - a.confidence);

    return detections;
  }

  /**
   * Extract endpoints from a file
   *
   * @param filePath - Relative file path
   * @param content - File content
   * @param language - Programming language
   * @param imports - Detected imports in the file
   */
  async extract(
    filePath: string,
    content: string,
    language: string,
    imports: string[]
  ): Promise<EndpointExtractionResult> {
    // Ensure tree-sitter is initialized
    if (!this.initialized) {
      await initializeTreeSitter();
      this.initialized = true;
    }

    // Detect frameworks
    const detections = this.detectFrameworks(imports, filePath);
    if (detections.length === 0) {
      return {
        file_path: filePath,
        framework: 'unknown',
        endpoints: [],
        success: true,
      };
    }

    // Collect endpoints from all detected frameworks
    const allEndpoints: ExtractedEndpoint[] = [];
    let usedFramework: Framework = 'unknown';

    for (const detection of detections) {
      const extractors = this.extractorsByFramework.get(detection.framework);
      if (!extractors || extractors.length === 0) continue;

      // Try each extractor for this framework
      for (const extractor of extractors) {
        // Check if extractor can handle this file
        if (!extractor.canHandle(filePath, imports)) continue;

        // Check if extractor's language matches
        if (extractor.language !== language && !extractor.aliases.includes(language)) {
          continue;
        }

        // Ensure grammar is loaded
        const grammarReady = await ensureLanguageGrammar(language);
        if (!grammarReady) continue;

        // Parse the code
        let tree: Parser.Tree;
        try {
          tree = parseCode(content, language);
        } catch (error) {
          continue;
        }

        // Extract endpoints
        const result = extractor.extract(tree, filePath, content);
        if (result.success && result.endpoints.length > 0) {
          allEndpoints.push(...result.endpoints);
          usedFramework = detection.framework;
        }
      }
    }

    return {
      file_path: filePath,
      framework: usedFramework,
      endpoints: allEndpoints,
      success: true,
    };
  }

  /**
   * Check if any registered extractor might handle this file
   */
  mightHaveEndpoints(filePath: string, _language: string, imports: string[]): boolean {
    // Quick check for common API-related imports (match module specifiers)
    const importPatterns = [
      /^express$/i,
      /^fastify$/i,
      /^koa$/i,
      /^@koa\//i,
      /^fastapi$/i,
      /^flask$/i,
      /^rest_framework/i,
      /^django\./i,
      /^@nestjs\//i,
      /^@modelcontextprotocol\//i,
      /^sinatra$/i,
    ];

    // Check file patterns
    const filePatterns = [
      /routes?\.rb$/i,
      /controllers\/.*_controller\.rb$/i,
    ];

    // Check each import against patterns
    for (const imp of imports) {
      for (const pattern of importPatterns) {
        if (pattern.test(imp)) {
          return true;
        }
      }
    }

    // Check file path
    for (const pattern of filePatterns) {
      if (pattern.test(filePath)) {
        return true;
      }
    }

    return false;
  }
}

/**
 * Default registry instance
 */
let defaultRegistry: EndpointExtractorRegistry | null = null;

/**
 * Get the default endpoint extractor registry
 */
export function getEndpointExtractorRegistry(): EndpointExtractorRegistry {
  defaultRegistry ??= new EndpointExtractorRegistry();
  return defaultRegistry;
}

/**
 * Create a new endpoint extractor registry
 */
export function createEndpointExtractorRegistry(): EndpointExtractorRegistry {
  return new EndpointExtractorRegistry();
}
