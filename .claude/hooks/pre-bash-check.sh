#!/usr/bin/env node
// PreToolUse security hook — blocks dangerous Bash command patterns

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(data);
  const cmd = (input.tool_input && input.tool_input.command) || '';

  const blocked = [
    { pattern: /rm\s+-rf\s+[/~*]/, label: 'recursive force delete' },
    { pattern: /curl[^|]+\|\s*(ba)?sh/, label: 'curl pipe to shell' },
    { pattern: /wget[^|]+\|\s*(ba)?sh/, label: 'wget pipe to shell' },
    { pattern: /git\s+push\s+(--force|-f)/, label: 'force push' },
    { pattern: /git\s+reset\s+--hard/, label: 'hard reset' },
    { pattern: /\beval\s+/, label: 'eval execution' },
    { pattern: />\s*\/dev\/(?!null)/, label: 'write to device file' },
    { pattern: /\bssh\s+/, label: 'outbound SSH connection' },
  ];

  const match = blocked.find(b => b.pattern.test(cmd));
  if (match) {
    process.stderr.write(`[Security] BLOCKED: ${match.label}\n`);
    process.stderr.write(`[Security] Command: ${cmd.substring(0, 120)}\n`);
    process.exit(2);
  }

  process.stdout.write(data);
});
