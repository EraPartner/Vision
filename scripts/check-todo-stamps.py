#!/usr/bin/env python3
"""Audits TODO.md's legacy inline commit stamps for pre-squash rot.

Why this exists
---------------
Older TODO.md entries used commit stamps such as
`- [x] ... ✅ YYYY-MM-DD · <sha> [optional (#NN)]`. New completions rely on the checked box and
merged pull-request history instead, but the historical annotations remain useful when their SHAs
resolve. A feature-branch SHA can become a dangling pointer when its pull request squash-merges.

That has now happened three times. `1240a95` (#147) re-pointed all 167 stamp citations and
wrote the convention into the status-markers section; four sessions later 37 fresh danglers
had appeared; by 2026-08-13 it was 85. A convention that rots twice needs a mechanical guard,
not a third sweep. This optional tool remains available for legacy maintenance; it is not a normal
backlog-delivery gate.

What it checks
--------------
Every existing `· <sha>` and `partial-<sha>` token in TODO.md is classified against the base branch
(`origin/main`):

  OK        the SHA is reachable from the base branch -- `git show` works for any reader.

  ROT       the SHA is NOT on the base branch, but its `(#NN)` names a PR whose squash-merge
            commit IS on the base branch. The branch SHA died in that squash. Recoverable and
            unambiguous: the error names the exact merge commit to re-point at. Exit 1.

  OPEN      the SHA is NOT on the base branch and its `(#NN)` has no squash-merge commit on
            the base branch -- i.e. that historical annotation points at an unmerged PR.
            Reported, never failed.

  PENDING   the SHA is NOT on the base branch, carries NO `(#NN)`, but IS reachable from HEAD.
            Warning; `--strict` makes it fatal.

  ORPHAN    the SHA is on neither the base branch nor HEAD and carries no `(#NN)`. Nothing
            names the change, so nothing can recover it. Exit 1.

Network
-------
**The check is entirely offline.** Knowing which PRs are still open would normally need an
API call; it does not here, because "has PR #NN landed?" is answerable from the base branch
itself -- a landed PR leaves a squash commit whose *subject line* ends in `(#NN)`. That proxy
is what separates ROT from OPEN without a token, network access, or nondeterministic API state.

`--verify-open` upgrades the proxy to a confirmation via the GitHub API (a PR that is neither
merged nor open is dead, and its stamp is unrecoverable). It **degrades gracefully**: with no
network, no token, or any API error it prints a notice, keeps the offline verdict, and does
not change the exit code. It is a local convenience, not a gate.

Shallow clones
--------------
Ancestry answers on a shallow clone are *false* (see the ⚠️ at the top of TODO.md: the
2026-08-05 sweep was corrupted by exactly this). On a shallow repository the check prints a
loud warning and exits 0 rather than emit invented verdicts. `--require-full-history` turns that
into a hard failure for an intentional full-history audit.

Usage
-----
    python3 scripts/check-todo-stamps.py                     # scan; exit 1 on ROT/ORPHAN
    python3 scripts/check-todo-stamps.py --list              # inventory, always exit 0
    python3 scripts/check-todo-stamps.py --strict            # PENDING warnings become fatal
    python3 scripts/check-todo-stamps.py --require-full-history
    python3 scripts/check-todo-stamps.py --verify-open       # optional GitHub cross-check
    python3 scripts/check-todo-stamps.py --self-test
    python3 scripts/check-todo-stamps.py --file <path> --base <ref>
"""

from __future__ import annotations

import collections
import json
import os
import re
import subprocess
import sys
from pathlib import Path

TAG = "[check-todo-stamps]"

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FILE = REPO_ROOT / "TODO.md"
BASE_CANDIDATES = ("origin/main", "refs/remotes/origin/main", "main", "refs/heads/main")
GITHUB_REPO = "EraPartner/Vision"

# `✅ 2026-08-13 · <sha> (#NN)` and `🔎 partial-<sha> (#NN)`. The `(#NN)` is optional here so
# that a legacy annotation missing it can be reported rather than silently skipped.
TOKEN_RE = re.compile(
    r"(?:·\s+|partial-)(?P<sha>[0-9a-f]{7,40})\b(?:\s*\(#(?P<pr>\d+)\))?"
)

# A squash-merge commit's subject ends in `(#NN)`. Matching the SUBJECT only is load-bearing:
# commit *bodies* cite PR numbers too, so `git log --grep="(#157)"` over-matches.
SUBJECT_PR_RE = re.compile(r"\(#(\d+)\)\s*$")

OK, ROT, OPEN, PENDING, ORPHAN = "OK", "ROT", "OPEN", "PENDING", "ORPHAN"
FATAL = (ROT, ORPHAN)


class Token:
    __slots__ = ("line", "col", "sha", "pr", "verdict", "detail")

    def __init__(self, line: int, col: int, sha: str, pr: int | None):
        self.line, self.col, self.sha, self.pr = line, col, sha, pr
        self.verdict, self.detail = OK, ""

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Token(L{self.line} {self.sha} #{self.pr} {self.verdict})"


def parse(text: str) -> list[Token]:
    out = []
    for lineno, line in enumerate(text.split("\n"), 1):
        for m in TOKEN_RE.finditer(line):
            pr = m.group("pr")
            out.append(
                Token(
                    lineno, m.start("sha") + 1, m.group("sha"), int(pr) if pr else None
                )
            )
    return out


# ── Git access, isolated behind a resolver so the classifier can be tested without a repo ────


class GitResolver:
    """Three git calls total, then everything is answered in-process.

    Naively asking git per SHA (`git merge-base --is-ancestor` x N) costs ~0.7 s each and put
    the first draft of this check at 100 s -- far too slow for a pre-push hook. Listing the
    reachable commits once and matching abbreviations by prefix makes it ~1 s.
    """

    def __init__(self, repo: Path, base: str, head: str = "HEAD"):
        self.repo = repo
        self.base = base
        self._base_by7 = self._prefix_index(self._rev_list(base))
        self._head_by7 = self._prefix_index(self._rev_list(head))
        self._merges = self._merge_commits(base)

    def _git(self, *args: str) -> str:
        r = subprocess.run(
            ["git", *args], cwd=self.repo, capture_output=True, text=True
        )
        if r.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()}")
        return r.stdout

    def _rev_list(self, ref: str) -> list[str]:
        return self._git("rev-list", ref).split()

    @staticmethod
    def _prefix_index(shas) -> dict:
        idx = collections.defaultdict(list)
        for s in shas:
            idx[s[:7]].append(s)
        return idx

    def _merge_commits(self, ref: str) -> dict:
        merges: dict[int, list[tuple[str, str]]] = collections.defaultdict(list)
        for line in self._git("log", "--format=%H%x09%s", ref).split("\n"):
            sha, _, subject = line.partition("\t")
            if not sha:
                continue
            m = SUBJECT_PR_RE.search(subject)
            if m:
                merges[int(m.group(1))].append((sha, subject))
        return merges

    @staticmethod
    def _hit(index: dict, abbrev: str) -> bool:
        return any(c.startswith(abbrev) for c in index.get(abbrev[:7], ()))

    def on_base(self, sha: str) -> bool:
        return self._hit(self._base_by7, sha)

    def on_head(self, sha: str) -> bool:
        return self._hit(self._head_by7, sha)

    def merge_for_pr(self, pr: int):
        """The squash-merge commit for PR #pr on the base branch, or None if it has not landed.

        A PR number appearing on more than one subject line would make the mapping ambiguous;
        return None rather than guess, which downgrades the token to OPEN (reported, not
        failed) instead of naming a possibly-wrong commit.
        """
        hits = self._merges.get(pr) or []
        return hits[0][0] if len(hits) == 1 else None


def classify(tokens: list[Token], resolver) -> list[Token]:
    for t in tokens:
        if resolver.on_base(t.sha):
            t.verdict, t.detail = OK, "resolves on the base branch"
        elif t.pr is not None:
            merge = resolver.merge_for_pr(t.pr)
            if merge:
                t.verdict = ROT
                t.detail = f"pre-squash branch SHA; PR #{t.pr} landed as {merge[:8]}"
            else:
                t.verdict = OPEN
                t.detail = f"PR #{t.pr} has not landed on the base branch yet"
        elif resolver.on_head(t.sha):
            t.verdict = PENDING
            t.detail = (
                "reachable from HEAD but not the base, with no (#NN); direct-to-main publication "
                "must finish its push, otherwise a feature branch must add its PR number"
            )
        else:
            t.verdict = ORPHAN
            t.detail = (
                "on neither the base branch nor this branch, and carries no (#NN)"
            )
    return tokens


# ── Optional GitHub cross-check (never a gate; see the module docstring) ─────────────────────


def verify_open(tokens: list[Token]) -> list[str]:
    """Confirm that PRs the offline pass presumed open really are. Best-effort by design."""
    import urllib.error
    import urllib.request

    prs = sorted({t.pr for t in tokens if t.verdict == OPEN and t.pr})
    if not prs:
        return []
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    notes = []
    for pr in prs:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{GITHUB_REPO}/pulls/{pr}",
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "vision-check-todo-stamps",
            },
        )
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.load(resp)
        except (urllib.error.URLError, OSError, ValueError) as exc:
            return [
                f"--verify-open: GitHub unreachable ({type(exc).__name__}) -- keeping the offline "
                f"verdicts. Exit code unaffected.",
            ]
        if data.get("state") == "open":
            notes.append(f"PR #{pr} confirmed open.")
        elif data.get("merged"):
            notes.append(
                f"PR #{pr} reports MERGED but no squash commit for it is on the base branch -- "
                f"the local base ref may be stale; run `git fetch origin main`."
            )
        else:
            notes.append(
                f"PR #{pr} is CLOSED WITHOUT MERGING -- its stamps name work that never landed. "
                f"Un-stamp them or re-point at the PR that did land."
            )
    return notes


# ── Self-test ────────────────────────────────────────────────────────────────────────────────


class FakeResolver:
    def __init__(self, base_shas, head_shas, merges):
        self.base_shas, self.head_shas, self.merges = base_shas, head_shas, merges

    def on_base(self, sha):
        return any(s.startswith(sha) for s in self.base_shas)

    def on_head(self, sha):
        return any(s.startswith(sha) for s in self.head_shas)

    def merge_for_pr(self, pr):
        return self.merges.get(pr)


BASE = [
    "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
]
HEAD_ONLY = ["3333333ccccccccccccccccccccccccccccccccc"]
MERGES = {147: "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}

SELF_TEST_CASES = [
    # (name, markdown, expected verdicts in order)
    (
        "a stamp that resolves on main is clean",
        "- [x] done ✅ 2026-01-01 · 1111111 (#147)",
        [OK],
    ),
    (
        "a direct-to-main stamp on the base is clean without a PR number",
        "- [x] done ✅ 2026-01-01 · 1111111",
        [OK],
    ),
    (
        "a full 40-char stamp resolves too",
        "- [x] x ✅ · 1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (#147)",
        [OK],
    ),
    (
        "a dead branch SHA whose PR landed is ROT",
        "- [x] x ✅ 2026-01-01 · 9999999 (#147)",
        [ROT],
    ),
    (
        "a dead branch SHA whose PR is unlanded is OPEN",
        "- [x] x ✅ · 9999999 (#166)",
        [OPEN],
    ),
    (
        "partial- stamps are checked identically",
        "- [ ] x 🔎 partial-9999999 (#147) 2026-01-01",
        [ROT],
    ),
    ("a clean partial- stamp passes", "- [ ] x 🔎 partial-2222222 (#147)", [OK]),
    (
        "a HEAD-only SHA with no (#NN) is a PENDING warning",
        "- [x] x ✅ · 3333333",
        [PENDING],
    ),
    ("a SHA on no branch and no (#NN) is an ORPHAN", "- [x] x ✅ · 8888888", [ORPHAN]),
    (
        "several tokens on one line are all classified",
        "✅ · 1111111 (#147) ✅ · 9999999 (#147)",
        [OK, ROT],
    ),
    (
        "a prose SHA with no `·`/`partial-` prefix is not a token",
        "- [ ] the `9999999` pass left residue",
        [],
    ),
    (
        "this file's own list of dead SHAs is prose, not stamps",
        "  - **#154 (9):** `0e8d7c34` `1eebf923` · **#155 (14):** `0467b53c` `1d3e3b1c`",
        [],
    ),
    (
        "`partial-#82` (the pre-SHA spelling) is not a token",
        "- [ ] x 🔎 partial-#82 2026-07-11",
        [],
    ),
    ("a date after `·` is not mistaken for a SHA", "- [x] x ✅ 2026-01-01 · done", []),
    ("a 6-char hex word is too short to be a stamp", "- [x] x ✅ · abcdef", []),
    ("the ROT message names the merge commit to use", "✅ · 9999999 (#147)", [ROT]),
]


def run_self_test() -> int:
    passed = failed = 0
    resolver = FakeResolver(BASE, HEAD_ONLY, MERGES)
    for name, md, expected in SELF_TEST_CASES:
        got = [t.verdict for t in classify(parse(md), resolver)]
        if got == expected:
            passed += 1
            print(f"{TAG}   ok   {name}")
        else:
            failed += 1
            print(f"{TAG}   FAIL {name}: expected {expected}, got {got}")

    # The ROT detail must carry the recovery target, or the error is not actionable.
    rot = classify(parse("✅ · 9999999 (#147)"), resolver)[0]
    if MERGES[147][:8] in rot.detail:
        passed += 1
        print(f"{TAG}   ok   the ROT detail carries the merge commit to re-point at")
    else:
        failed += 1
        print(f"{TAG}   FAIL ROT detail lacks the merge commit: {rot.detail!r}")

    # An ambiguous PR->merge mapping must not invent a target.
    amb = classify(
        parse("✅ · 9999999 (#147)"), FakeResolver(BASE, HEAD_ONLY, {147: None})
    )[0]
    if amb.verdict == OPEN:
        passed += 1
        print(
            f"{TAG}   ok   an unresolvable PR->merge mapping degrades to OPEN, not a guess"
        )
    else:
        failed += 1
        print(f"{TAG}   FAIL ambiguous mapping produced {amb.verdict}")

    print(f"{TAG} self-test: {passed} passed, {failed} failed.")
    return 1 if failed else 0


# ── Entry point ──────────────────────────────────────────────────────────────────────────────


def resolve_base(repo: Path, explicit: str | None) -> str:
    candidates = (explicit,) if explicit else BASE_CANDIDATES
    for ref in candidates:
        r = subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        if r.returncode == 0:
            return ref
    raise SystemExit(
        f"{TAG} ERROR: no base ref found (tried: {', '.join(c for c in candidates if c)}).\n"
        f"{TAG}   Fetch it (`git fetch origin main`) or pass --base <ref>."
    )


def arg_value(argv: list[str], flag: str):
    return (
        argv[argv.index(flag) + 1]
        if flag in argv and argv.index(flag) + 1 < len(argv)
        else None
    )


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return run_self_test()

    path = Path(arg_value(argv, "--file") or DEFAULT_FILE)
    if not path.is_file():
        print(f"{TAG} ERROR: {path} not found.", file=sys.stderr)
        return 1

    repo = REPO_ROOT
    shallow = (
        subprocess.run(
            ["git", "rev-parse", "--is-shallow-repository"],
            cwd=repo,
            capture_output=True,
            text=True,
        ).stdout.strip()
        == "true"
    )
    if shallow:
        msg = (
            f"{TAG} SHALLOW CLONE -- ancestry answers here are FALSE, not just incomplete\n"
            f"{TAG}   (TODO.md's own ⚠️ records a sweep corrupted by exactly this).\n"
            f"{TAG}   Run `git fetch --unshallow` to make this check meaningful."
        )
        if "--require-full-history" in argv:
            print(
                f"{msg}\n{TAG} ERROR: --require-full-history was passed.",
                file=sys.stderr,
            )
            return 1
        print(f"{msg}\n{TAG} SKIPPED (exit 0): refusing to emit invented verdicts.")
        return 0

    base = resolve_base(repo, arg_value(argv, "--base"))
    tokens = classify(parse(path.read_text(encoding="utf-8")), GitResolver(repo, base))

    by = collections.Counter(t.verdict for t in tokens)
    rel = (
        path.relative_to(repo) if path.is_absolute() and repo in path.parents else path
    )

    if "--list" in argv:
        for t in tokens:
            print(
                f"{rel}:{t.line}:{t.col}: {t.verdict:<7} {t.sha} "
                f"{'(#%d) ' % t.pr if t.pr else ''}-- {t.detail}"
            )

    for verdict, header in (
        (
            ROT,
            "stamp SHAs that died in a squash-merge (re-point them at the merge commit)",
        ),
        (ORPHAN, "stamp SHAs that exist nowhere and carry no (#NN) to recover them"),
    ):
        hits = [t for t in tokens if t.verdict == verdict]
        if hits:
            print(f"\n{TAG} ERROR: {header}:", file=sys.stderr)
            for t in hits:
                print(
                    f"  {rel}:{t.line}: {t.sha}"
                    f"{' (#%d)' % t.pr if t.pr else ''} -- {t.detail}",
                    file=sys.stderr,
                )

    pending = [t for t in tokens if t.verdict == PENDING]
    if pending:
        stream = sys.stderr if "--strict" in argv else sys.stdout
        print(
            f"\n{TAG} {'ERROR' if '--strict' in argv else 'WARNING'}: stamps reachable only "
            f"from HEAD -- inspect whether each legacy annotation needs a merged-PR SHA:",
            file=stream,
        )
        for t in pending:
            print(f"  {rel}:{t.line}: {t.sha} -- {t.detail}", file=stream)

    if "--verify-open" in argv:
        for note in verify_open(tokens):
            print(f"{TAG} {note}")

    fatal = sum(by[v] for v in FATAL) + (by[PENDING] if "--strict" in argv else 0)
    summary = (
        f"{len(tokens)} stamp token(s) in {rel} vs {base}: "
        f"{by[OK]} ok, {by[ROT]} rot, {by[OPEN]} awaiting-merge, "
        f"{by[PENDING]} pending-on-head, {by[ORPHAN]} orphaned"
    )

    if fatal:
        print(
            f"\n{TAG} A legacy inline SHA should resolve for the next reader.\n"
            f"{TAG} Re-point each SHA above at the squash-merge commit named beside it, keeping\n"
            f"{TAG} its `(#NN)`. Derive any mapping you are unsure of from git rather than by\n"
            f"{TAG} position -- fetch `+refs/pull/*/head:refs/remotes/origin/pr/*`, then\n"
            f"{TAG} `git branch -r --contains <sha>` names the owning PR.\n"
            f"{TAG} See TODO.md -> 'Status markers' and docs/reference/scripts.md.\n"
            f"{TAG} FAIL: {summary}.",
            file=sys.stderr,
        )
        return 1

    print(f"{TAG} OK: {summary}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
