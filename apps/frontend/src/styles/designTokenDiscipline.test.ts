// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readTsxTree(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readTsxTree(path);
    return entry.name.endsWith('.tsx') ? [readFileSync(path, 'utf8')] : [];
  });
}

describe('semantic colour token discipline', () => {
  it('has no raw warning or informational Tailwind hues in TSX', () => {
    const source = readTsxTree(join(process.cwd(), 'src')).join('\n');
    expect(source).not.toMatch(/\b(?:amber|yellow|blue|sky)-\d{2,3}\b/);
  });

  it('routes every material shadow through the theme shadow token', () => {
    const indexCss = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
    expect(indexCss).not.toMatch(/hsl\(0\s+0%\s+0%\s*\/\s*[\d.]+\)/);
  });

  it('defines the info token in light and dark base palettes', () => {
    const tokensCss = readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf8');
    expect(tokensCss.match(/--info:/g)).toHaveLength(2);
  });

  it('lets icon-tile glows inherit each tile semantic colour', () => {
    const source = readTsxTree(join(process.cwd(), 'src')).join('\n');
    expect(source).not.toContain('shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.25)]');
    expect(source).not.toMatch(/(?:from|to|text)-orange-\d{2,3}/);
    const indexCss = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
    expect(indexCss).toMatch(/\.icon-tile-glow\s*\{[\s\S]*currentColor 25%/);
    const bankWidget = readFileSync(join(process.cwd(), 'src/features/dashboard/BankBalancesWidget.tsx'), 'utf8');
    expect(bankWidget).toMatch(/from-primary\/20 to-primary\/10 text-primary icon-tile-glow/);
  });
});
