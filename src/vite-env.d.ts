/// <reference types="vite/client" />

/**
 * The dungeon-loop skill is imported as raw text, not parsed. Vite's `?raw`
 * suffix works identically under vitest, so prompt assembly is testable
 * headlessly.
 */
declare module "*.md?raw" {
  const content: string;
  export default content;
}
