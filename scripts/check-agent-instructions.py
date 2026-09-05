#!/usr/bin/env python3
"""Check instruction structure without installing application dependencies.

This is a structural check; semantic instruction quality still needs review.
"""
from pathlib import Path
import re
import tomllib

root = Path(__file__).resolve().parents[1]
for directory in ('.agents', '.codex'):
    for path in sorted((root / directory).rglob('*.md')):
        if path.is_symlink():
            raise SystemExit(f'{path.relative_to(root)}: instruction symlinks require explicit review')
        text = path.read_text(encoding='utf-8')
        if not text.strip() or re.search(r'^(<<<<<<< |=======$|>>>>>>> )', text, re.MULTILINE):
            raise SystemExit(f'{path.relative_to(root)}: empty content or unresolved conflict')
        if path.name == 'SKILL.md':
            parts = text.split('---', 2)
            if len(parts) != 3 or parts[0].strip():
                raise SystemExit(f'{path.relative_to(root)}: missing skill frontmatter')
            for field in ('name', 'description'):
                if not re.search(rf'^{field}:\s*\S', parts[1], re.MULTILINE):
                    raise SystemExit(f'{path.relative_to(root)}: missing {field}')
for path in sorted((root / '.codex/agents').glob('*.toml')):
    with path.open('rb') as source:
        agent = tomllib.load(source)
    for field in ('name', 'description', 'developer_instructions'):
        if not isinstance(agent.get(field), str) or not agent[field].strip():
            raise SystemExit(f'{path.relative_to(root)}: missing {field}')
print('Agent Markdown and role TOML structure passed; semantic quality requires review.')
