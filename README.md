# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/androbuddiesgit/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/androbuddiesgit/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It applies the edits AI models write to a tree of text files: unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls. It finds the lines each edit names even when the model drifted their whitespace or indentation, and it changes every file or none — a failed edit reports why and nothing is written.

## Run it

```sh
node main.ts [options] [PATCH]
```

Node 22 and its standard library alone; no dependencies to install. `PATCH` is the path of the patch file, or `-` (or absent) to read it from standard input. Options: `--format=unified|search-replace|v4a|json|auto` (default `auto`, which detects the format), `--check` (dry run: same output and exit code, no files written), `--strict` (match lines exactly, tier 0 only).

```sh
node main.ts fix.patch
node main.ts --check --format=v4a patch.txt
cat edit.diff | node main.ts -
```

Exit 0 lists what changed (`A` created, `D` deleted, `M` modified, `R old -> new` moved) and ends with `ok: <n> files`. Exit 1 lists one `error: <code> <path>` per failed edit (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`) and `failed: <k> of <n> edits`. Exit 2 is one line for a usage, patch-read, format-detection or parse error.

## The files

- `main.ts`: the CLI. It implements all ten sections of `SPEC.md`: the command line, output and exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits and the all-or-nothing write. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did (its exit code, its stdout and the files left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification — the whole contract.
- `LICENSE`: MIT.

## How it matches

Each edit's old lines are found at the first of three tiers where they occur: tier 0 exactly, tier 1 ignoring trailing spaces and tabs, tier 2 ignoring leading and trailing spaces and tabs. A unified hunk takes the occurrence nearest its (possibly wrong) line number; a SEARCH/REPLACE block fails `ambiguous` when its old lines occur more than once; a V4A chunk takes the first occurrence at or after its cursor, or the one ending at the file's last line when `*** End of File` anchors it. Context lines are written as the file's own lines, and at tier 2 the other new lines are re-indented to the file's indentation. CRLF files are written back CRLF; a file without a final line break stays without one unless a `\ No newline at end of file` line says otherwise.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9db5byq5&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
