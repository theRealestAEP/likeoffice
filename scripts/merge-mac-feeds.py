#!/usr/bin/env python3
"""Merge the per-architecture macOS update feeds into one.

Since #142 the two macOS arches build on separate runners, and each
electron-builder run writes a latest-mac.yml listing only the files IT
produced. Publishing either one alone would offer Intel users the arm64
download, or the reverse. This concatenates their `files:` lists back into the
single feed a both-arches-on-one-runner build used to emit.

NO YAML LIBRARY ON PURPOSE. Current ubuntu-latest images mark the system
Python as externally managed (PEP 668), so a bare `pip install pyyaml` in the
publish job fails with "externally-managed-environment" — and the publish job
is the worst place to discover a missing dependency, because the build legs
have already succeeded and their artifacts are waiting. electron-builder's feed
is machine-generated and flat, so a line-level splice is both sufficient and
safer than adding a network install to the release path.

Usage: merge-mac-feeds.py OUT.yml SEARCH_DIR
       merge-mac-feeds.py OUT.yml IN1.yml [IN2.yml ...]

Given a directory it finds every latest-mac.yml beneath it, so the caller needs
no shell array handling (`mapfile` is bash 4+, which a macOS shell does not
have, and an untestable CI step is how bugs reach the release path).
"""
import sys
from pathlib import Path


def split_feed(lines):
    """(head through 'files:', the entry lines, everything after)."""
    try:
        start = next(i for i, l in enumerate(lines) if l.rstrip() == "files:")
    except StopIteration:
        raise SystemExit(f"merge-mac-feeds: no 'files:' key found")
    end = start + 1
    # The list runs until the next line at column 0 (the next top-level key).
    while end < len(lines) and (lines[end].startswith(" ") or not lines[end].strip()):
        end += 1
    return lines[: start + 1], lines[start + 1 : end], lines[end:]


def entries(block):
    """Group the indented lines into one list per '  - url:' entry."""
    out = []
    for line in block:
        if line.lstrip().startswith("- "):
            out.append([line])
        elif out and line.strip():
            out[-1].append(line)
    return out


def url_of(entry):
    for line in entry:
        stripped = line.strip().lstrip("- ").strip()
        if stripped.startswith("url:"):
            return stripped[len("url:") :].strip()
    return None


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    out_path, args = sys.argv[1], sys.argv[2:]
    if len(args) == 1 and Path(args[0]).is_dir():
        in_paths = sorted(str(p) for p in Path(args[0]).rglob("latest-mac.yml"))
        if not in_paths:
            print(f"merge-mac-feeds: no latest-mac.yml under {args[0]}; nothing to merge")
            return
    else:
        in_paths = args

    head, block, tail = None, [], []
    seen, merged = set(), []
    for path in in_paths:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        h, b, t = split_feed(lines)
        # The first feed supplies version/path/sha512/releaseDate; the rest
        # contribute only their files.
        if head is None:
            head, tail = h, t
        for entry in entries(b):
            url = url_of(entry)
            if url is None:
                raise SystemExit(f"merge-mac-feeds: entry with no url in {path}")
            if url in seen:
                continue
            seen.add(url)
            merged.append(entry)

    if not merged:
        raise SystemExit("merge-mac-feeds: no file entries found in any feed")

    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(head + [l for e in merged for l in e] + tail) + "\n")
    print(f"merged {len(in_paths)} feed(s) -> {len(merged)} files")
    for entry in merged:
        print("  ", url_of(entry))


if __name__ == "__main__":
    main()
