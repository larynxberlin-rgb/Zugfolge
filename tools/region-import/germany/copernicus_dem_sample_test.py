import argparse
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from osgeo import gdal, osr

import copernicus_dem_sample as sampler


class CopernicusDemSamplerTest(unittest.TestCase):
    def test_real_cog_is_sampled_and_short_way_remains_unresolved(self) -> None:
        with tempfile.TemporaryDirectory(prefix="zugfolge-dem-sampler-") as temporary:
            root = Path(temporary)
            cache = root / "cache"
            cache.mkdir()
            tracks = root / "tracks.geojsonseq"
            long_feature = {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[10.1000, 50.5], [10.1050, 50.5]]},
                "properties": {
                    "feature_id": "track:osm-way-7-segment-1-n1-n2",
                    "osm_way_id": 7,
                    "length_mm": 360_000,
                },
            }
            short_feature = {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[10.2000, 50.5], [10.2005, 50.5]]},
                "properties": {
                    "feature_id": "track:osm-way-8-segment-1-n3-n4",
                    "osm_way_id": 8,
                    "length_mm": 36_000,
                },
            }
            tracks.write_text(
                sampler.canonical_json(long_feature) + "\n" + sampler.canonical_json(short_feature) + "\n",
                encoding="utf-8",
            )

            tile_name = sampler.tile_file_name("N50_E010")
            raw = root / "raw.tif"
            tile = cache / tile_name
            driver = gdal.GetDriverByName("GTiff")
            dataset = driver.Create(str(raw), 2400, 3600, 1, gdal.GDT_Float32, options=["TILED=YES", "COMPRESS=DEFLATE"])
            dataset.SetGeoTransform((10 - 0.5 / 2400, 1 / 2400, 0, 51 + 0.5 / 3600, 0, -1 / 3600))
            spatial_reference = osr.SpatialReference()
            spatial_reference.ImportFromEPSG(4326)
            dataset.SetProjection(spatial_reference.ExportToWkt())
            dataset.SetMetadataItem("AREA_OR_POINT", "Point")
            row = (100 + np.arange(2400, dtype=np.float32) * (1000 / 2400)).reshape(1, 2400)
            band = dataset.GetRasterBand(1)
            for y in range(3600):
                band.WriteArray(row, 0, y)
            dataset = None
            gdal.Translate(str(tile), str(raw), format="COG", creationOptions=["COMPRESS=DEFLATE", "OVERVIEWS=IGNORE_EXISTING"])
            raw.unlink()

            tile_hash = sampler.sha256_file(tile)
            aggregate = hashlib.sha256(f"N50_E010:{tile_hash}\n".encode()).hexdigest()
            manifest = root / "capture.json"
            sampler.write_json(
                manifest,
                {
                    "schema": sampler.CAPTURE_SCHEMA,
                    "source": {
                        "rightsSourceId": "dem-hoehenmodell",
                        "product": sampler.PRODUCT,
                        "release": sampler.RELEASE,
                        "attribution": sampler.ATTRIBUTION,
                    },
                    "input": {"tracksSha256": sampler.sha256_file(tracks)},
                    "aggregateTileSha256": aggregate,
                    "tiles": [
                        {
                            "tileId": "N50_E010",
                            "file": tile_name,
                            "bytes": tile.stat().st_size,
                            "sha256": tile_hash,
                        }
                    ],
                },
            )
            output = root / "derived"
            result = sampler.run(
                argparse.Namespace(
                    tracks=str(tracks),
                    manifest=str(manifest),
                    cache=str(cache),
                    output=str(output),
                    sample_interval_mm=30_000,
                    min_baseline_mm=200_000,
                    analysis_window_mm=400_000,
                    vertical_accuracy_mm=4_000,
                    maximum_absolute_gradient_permille=70,
                    maximum_uncertainty_permille=50,
                )
            )
            self.assertEqual(result["features"], 2)
            self.assertEqual(result["derivedFeatures"], 1)
            features = [json.loads(line) for line in (output / "copernicus-dem-track-enrichment.geojsonseq").read_text(encoding="utf-8").splitlines()]
            self.assertEqual(features[0]["properties"]["gradient_status"], "derived_with_uncertainty")
            self.assertGreater(features[0]["properties"]["uncertainty_permille"], 0)
            self.assertEqual(features[1]["properties"]["unresolved_reason"], "insufficient_way_baseline")
            evidence = json.loads((output / "copernicus-dem-evidence-report.json").read_text(encoding="utf-8"))
            self.assertEqual(evidence["sampling"]["tiles_read"], 1)
            self.assertEqual(evidence["source"]["attribution"], sampler.ATTRIBUTION)


if __name__ == "__main__":
    unittest.main()
