#!/bin/sh
# zugfolge:quelle=osm-pbf-mitteldeutschland-b
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: $0 OSMIUM SOURCE_DIRECTORY BOUNDARY_POLY OUTPUT_DIRECTORY" >&2
  exit 64
fi

OSMIUM=$1
SOURCE=$2
BOUNDARY=$3
OUTPUT=$4
mkdir -p "$OUTPUT"

check_md5() {
  expected=$1
  file=$2
  actual=$(md5sum "$file" | cut -d ' ' -f 1)
  if [ "$actual" != "$expected" ]; then
    echo "MD5 mismatch for $file: $actual" >&2
    exit 65
  fi
}

check_md5 58beffe884515cfdfd06ecc54743cecb "$SOURCE/sachsen-latest.osm.pbf"
check_md5 fbd617536742eb9c9128265e3e2276fe "$SOURCE/sachsen-anhalt-latest.osm.pbf"
check_md5 533bc356dfa79df75ac3eb84c855cc1f "$SOURCE/thueringen-latest.osm.pbf"

"$OSMIUM" merge --overwrite \
  -o "$OUTPUT/three-states.osm.pbf" \
  "$SOURCE/sachsen-latest.osm.pbf" \
  "$SOURCE/sachsen-anhalt-latest.osm.pbf" \
  "$SOURCE/thueringen-latest.osm.pbf"

"$OSMIUM" extract --overwrite --strategy smart \
  -p "$BOUNDARY" \
  -o "$OUTPUT/mitteldeutschland-b-clipped.osm.pbf" \
  "$OUTPUT/three-states.osm.pbf"

"$OSMIUM" tags-filter --overwrite \
  -o "$OUTPUT/mitteldeutschland-b-ebo.osm.pbf" \
  "$OUTPUT/mitteldeutschland-b-clipped.osm.pbf" \
  w/railway=rail \
  n/railway=station,halt,stop,signal,switch,buffer_stop,railway_crossing \
  n/public_transport=station,stop_position \
  r/route=train \
  r/type=route,route_master \
  r/public_transport=stop_area,stop_area_group

"$OSMIUM" fileinfo -e "$OUTPUT/mitteldeutschland-b-ebo.osm.pbf"
sha256sum "$OUTPUT"/*.osm.pbf
