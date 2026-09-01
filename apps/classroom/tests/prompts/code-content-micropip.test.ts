import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('OpenMAIC code widget runtime contract', () => {
  test('loads micropip before generated code imports it', () => {
    const source = readFileSync(
      join(process.cwd(), 'lib', 'prompts', 'templates', 'code-content', 'system.md'),
      'utf8',
    );
    const loadIndex = source.search(
      /await pyodide\.loadPackage\(\s*(?:['"]micropip['"]|\[[^\]]*['"]micropip['"][^\]]*\])\s*\)/,
    );
    const firstImportIndex = source.indexOf('import micropip');
    const orderedExample =
      /await pyodide\.loadPackage\(\s*(?:['"]micropip['"]|\[[^\]]*['"]micropip['"][^\]]*\])\s*\);\s*await pyodide\.runPythonAsync\(`\s*import micropip\b/;

    expect(loadIndex).toBeGreaterThanOrEqual(0);
    expect(firstImportIndex).toBeGreaterThan(loadIndex);
    expect(source).toMatch(orderedExample);
  });
});
