#!/usr/bin/env bash
set -euo pipefail

# Optional documentation build. The lab does not invoke this script.
# Requires TeX Live with XeLaTeX, Latin Modern fonts, TikZ, fontspec,
# hyperref, tabularx, plus Inkscape and Poppler's pdfinfo.
repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
for tool in inkscape xelatex pdfinfo; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Missing authoring tool: %s. The lab itself needs no PDF tools.\n' "$tool" >&2
    exit 1
  fi
done

build_directory=$(mktemp -d "${TMPDIR:-/tmp}/clutta-walkthrough-XXXXXX")
printf 'Building in %s; build logs stay outside the checkout.\n' "$build_directory"
cp "$repository/docs/source/clutta-walkthrough.tex" "$build_directory/clutta-walkthrough.tex"
(
  cd "$build_directory"
  inkscape "$repository/assets/clutta-logo-light.svg" \
    --export-type=pdf --export-filename=clutta-logo.pdf \
    >logo-build.log 2>&1
  for pass in 1 2; do
    if ! xelatex -no-shell-escape -interaction=nonstopmode -halt-on-error \
      -file-line-error clutta-walkthrough.tex >"latex-pass-$pass.log" 2>&1; then
      printf 'PDF build failed; inspect %s/latex-pass-%s.log\n' "$build_directory" "$pass" >&2
      exit 1
    fi
  done
)
pages=$(pdfinfo "$build_directory/clutta-walkthrough.pdf" | awk '/^Pages:/ { print $2 }')
if [[ "$pages" != 1 ]]; then
  printf 'Expected one page, got %s. PDF was not published.\n' "$pages" >&2
  exit 1
fi
cp "$build_directory/clutta-walkthrough.pdf" "$repository/docs/clutta-walkthrough.pdf"
printf 'Built %s/docs/clutta-walkthrough.pdf\n' "$repository"
pdfinfo -url "$repository/docs/clutta-walkthrough.pdf"
