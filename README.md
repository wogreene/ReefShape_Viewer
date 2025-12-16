# Reef Map Viewer

Static GitHub Pages site for browsing large georeferenced coral reef
photomosaics via MapLibre and Cloud Optimized GeoTIFFs (COGs).

## Architecture
- Frontend: GitHub Pages (static)
- Map: MapLibre GL JS
- Tiles: TiTiler (COG → map tiles)
- Storage: Dropbox (HTTP range requests)

## Adding a reef
1. Convert mosaic to COG
2. Upload to Dropbox
3. Add entry to `data/sites.geojson`

## Deployment
Enable GitHub Pages → main branch → root
