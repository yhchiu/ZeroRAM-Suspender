#!/bin/sh

c="`git log --no-merges --pretty=format:'{%n  "sha": "%H",%n  "html_url": "https://github.com/yhchiu/ZeroRAM-Suspender/commit/%H",%n  "commit": {%n    "message": "%s",%n    "author": {%n      "name": "%aN",%n      "date": "%aI"%n    }%n  }%n},' | head -c -1`" ; echo -e "[\n$c\n]" > CHANGELOG.json


