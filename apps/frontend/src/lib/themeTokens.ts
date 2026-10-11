/**
 * Read active CSS custom property tokens from the document root and convert
 * them to the shape expected by the backend PDF report POST body.
 *
 * Frontend uses `--background` / `--foreground`; backend template CSS uses
 * `--surface` / `--text`. The mapping below bridges that gap.
 */

export interface ReportThemeTokens {
  primary?: string | undefined;
  accent?: string | undefined;
  success?: string | undefined;
  expense?: string | undefined;
  surface?: string | undefined;
  text?: string | undefined;
  muted?: string | undefined;
  border?: string | undefined;
  chart1?: string | undefined;
  chart2?: string | undefined;
  chart3?: string | undefined;
  chart4?: string | undefined;
  chart5?: string | undefined;
  chart6?: string | undefined;
  chart7?: string | undefined;
  chart8?: string | undefined;
  mode: 'light' | 'dark';
}

function readVar(name: string): string | undefined {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return raw.length > 0 ? raw : undefined;
}

export function resolveActiveThemeTokens(): ReportThemeTokens {
  const mode = document.documentElement.classList.contains('dark') ? 'dark' : 'light';

  return {
    primary:  readVar('--primary'),
    accent:   readVar('--accent'),
    success:  readVar('--success'),
    expense:  readVar('--expense'),
    surface:  readVar('--background'),
    text:     readVar('--foreground'),
    muted:    readVar('--muted-foreground'),
    border:   readVar('--border'),
    chart1:   readVar('--chart-1'),
    chart2:   readVar('--chart-2'),
    chart3:   readVar('--chart-3'),
    chart4:   readVar('--chart-4'),
    chart5:   readVar('--chart-5'),
    chart6:   readVar('--chart-6'),
    chart7:   readVar('--chart-7'),
    chart8:   readVar('--chart-8'),
    mode,
  };
}
