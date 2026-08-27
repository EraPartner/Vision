// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function tsxSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxSources(path);
    return entry.name.endsWith('.tsx') ? [readFileSync(path, 'utf8')] : [];
  });
}

describe('Card material ownership', () => {
  it('does not restate Card-owned material and frame classes at call sites', () => {
    const cardTags = tsxSources(join(process.cwd(), 'src')).flatMap((source) => (
      [...source.matchAll(/<Card\b[\s\S]*?>/g)].map((match) => match[0])
    ));
    expect(cardTags.join('\n')).not.toMatch(/\b(?:glass-regular|premium-frame|micro-lift)\b/);
  });
});
