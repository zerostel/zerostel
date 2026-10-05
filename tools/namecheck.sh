#!/bin/bash
# Usage: namecheck.sh name1 name2 ...
# Prints availability: GitHub user/org, GitHub repos (total containing / exact / max stars),
# npm, PyPI, crates.io, and .com / .dev domains (RDAP 404 = not registered).
for n in "$@"; do
  user=$(gh api "users/$n" --jq .login 2>/dev/null); case "$user" in *message*|"") user="-";; esac
  [ -z "$user" ] && user="-"
  repos=$(gh api -X GET search/repositories -f q="$n in:name" -f per_page=100 \
    --jq "[.total_count, ([.items[] | select(.name|ascii_downcase==\"$n\")] | length), ([.items[].stargazers_count] | max // 0)] | @tsv" 2>/dev/null)
  npm=$(curl -s -o /dev/null -w "%{http_code}" "https://registry.npmjs.org/$n")
  pypi=$(curl -s -o /dev/null -w "%{http_code}" "https://pypi.org/pypi/$n/json")
  crate=$(curl -s -o /dev/null -w "%{http_code}" -A "name-check" "https://crates.io/api/v1/crates/$n")
  com=$(curl -s -o /dev/null -w "%{http_code}" "https://rdap.verisign.com/com/v1/domain/$n.com")
  dev=$(curl -s -o /dev/null -w "%{http_code}" "https://pubapi.registry.google/rdap/domain/$n.dev")
  free=0
  [ "$user" = "-" ] && free=$((free+1))
  for c in $npm $pypi $crate $com $dev; do [ "$c" = "404" ] && free=$((free+1)); done
  printf "%-10s free=%d/6 | ghuser:%-10s repos(total,exact,max★):%s | npm:%s pypi:%s crates:%s com:%s dev:%s\n" \
    "$n" "$free" "$user" "$(echo $repos | tr ' ' ',')" "$npm" "$pypi" "$crate" "$com" "$dev"
  sleep 2
done
