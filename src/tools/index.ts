import { ToolRegistry, type Tool } from './registry.js';
import { filesystemTools } from './filesystem.js';
import { searchTools } from './search.js';
import { symbolTools } from './symbols.js';
import { terminalTools } from './terminal.js';
import { backgroundTools } from './background.js';
import { gitTools } from './git.js';
import { projectTools } from './project.js';
import { pdfTools } from './pdf.js';
import { imageTools } from './image.js';
import { webTools } from './web.js';

export interface BuildRegistryOptions {
  /** Omit tool groups the current session cannot use. */
  includeGit?: boolean;
  includeShell?: boolean;
  includeDocuments?: boolean;
  includeSymbols?: boolean;
  /** Background process tools; require shell to be available. */
  includeBackground?: boolean;
  /** Web tools are registered only when a key is configured. */
  includeWeb?: boolean;
  extraTools?: Tool[];
}

/** Assemble the default tool set. Kept separate so plugins can extend it. */
export function buildToolRegistry(options: BuildRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(filesystemTools);
  registry.registerAll(searchTools);
  registry.registerAll(projectTools);
  if (options.includeSymbols !== false) registry.registerAll(symbolTools);
  if (options.includeShell !== false) {
    registry.registerAll(terminalTools);
    if (options.includeBackground !== false) registry.registerAll(backgroundTools);
  }
  if (options.includeGit !== false) registry.registerAll(gitTools);
  if (options.includeDocuments !== false) {
    registry.registerAll(pdfTools);
    registry.registerAll(imageTools);
  }
  if (options.includeWeb) registry.registerAll(webTools);
  if (options.extraTools?.length) registry.registerAll(options.extraTools);
  return registry;
}

export * from './registry.js';
export { detectWorkspace, formatWorkspaceInfo, type WorkspaceInfo } from './project.js';
export { readGitState, summarizeGitState, type GitState } from './git.js';
export { isImagePath, readImageDimensions } from './image.js';
export { extractPdf, parsePageRange, rankPages } from './pdf.js';
export { shellInfo, matchesAllowlist } from './terminal.js';
export { extractSymbols } from './symbols.js';
export { BackgroundRegistry } from './background.js';
export { FileReadTracker, staleWriteMessage } from './tracker.js';
