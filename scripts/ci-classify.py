#!/usr/bin/env python3
"""Fail closed when deciding whether application and Docker CI may be skipped."""
import os
import subprocess


def classify(paths, special_paths=()):
    if not paths:
        return True
    for path in paths:
        if path in special_paths:
            return True
        if path.startswith(('docs/',)) or ('/' not in path and path.endswith('.md')):
            continue
        # Configuration, executables and unknown formats still run the full suite.
        if path.startswith(('.agents/', '.codex/')) and path.endswith('.md'):
            continue
        return True
    return False


def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL)


def classify_range(base, head):
    try:
        if not base or not head or base == '0' * 40:
            return True
        git('cat-file', '-e', base + '^{commit}')
        git('cat-file', '-e', head + '^{commit}')
        # Disable rename detection so both sides of a move are classified.
        paths = git('diff', '--name-only', '--no-renames', '-z', base, head).decode().split('\0')[:-1]
        special = set()
        for ref in (base, head):
            for entry in git('ls-tree', '-rz', ref).decode().split('\0'):
                if entry:
                    metadata, path = entry.split('\t', 1)
                    if metadata.split()[0] != '100644':
                        special.add(path)
        return classify(paths, special)
    except (subprocess.CalledProcessError, UnicodeError, ValueError):
        return True


if __name__ == '__main__':
    is_pr = os.environ.get('EVENT_NAME') == 'pull_request'
    base = os.environ.get('PR_BASE_SHA' if is_pr else 'PUSH_BEFORE', '')
    head = os.environ.get('PR_HEAD_SHA' if is_pr else 'PUSH_SHA', '')
    code = classify_range(base, head)
    print('Full application pipeline.' if code else 'Documentation/instruction diff; focused checks remain required.')
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
        output.write('code=' + str(code).lower() + '\n')
