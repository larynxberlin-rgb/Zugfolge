#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
  echo "usage: $0 FILESTORE_DIRECTORY" >&2
  exit 64
fi

# Odoo-store_fname besteht aus hexadezimalen Pfaden. Der relative Pfad ist Teil
# des Hashes, damit vertauschte Dateien nicht als identischer Filestore gelten.
(
  cd "$1"
  find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    sha256sum "$file"
  done
) | sha256sum | cut -d ' ' -f 1
