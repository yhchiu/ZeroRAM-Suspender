#!/bin/sh

git log --no-merges --format='%H|%s|%aN|%aI' | \
awk -F'|' '
BEGIN { print "[" }
{
  gsub(/"/, "\\\"", $2)
  gsub(/"/, "\\\"", $3)
  if (NR > 1) print ","
  printf "{\n"
  printf "  \"sha\": \"%s\",\n", $1
  printf "  \"html_url\": \"https://github.com/yhchiu/ZeroRAM-Suspender/commit/%s\",\n", $1
  printf "  \"commit\": {\n"
  printf "    \"message\": \"%s\",\n", $2
  printf "    \"author\": {\n"
  printf "      \"name\": \"%s\",\n", $3
  printf "      \"date\": \"%s\"\n", $4
  printf "    }\n"
  printf "  }\n"
  printf "}"
}
END { print "\n]" }
' > CHANGELOG.json


