# Reef Map Viewer

GitHub Pages site for browsing large georeferenced coral reef
photomosaics via MapLibre and Cloud Optimized GeoTIFFs (COGs). Serves as a viewer application for data collected using our <a href="https://github.com/Perry-Institute/ReefShape">ReefShape</a> protocol and analyzed using <a href="https://github.com/cnr-isti-vclab/TagLab">TagLab</a>.

The ReefShape method has been peer-reviewed and is published open-access in the Journal of Visualized Experiments. Check out the publication <a href="https://dx.doi.org/10.3791/67343">here</a>. The article includes a comprehensive protocol section with all instructions needed to make use of ReefShape. Alongside it is a 14 minute video explaining the protocol. Reading the JoVE article is the best place to start to understand what ReefShape is and how to use it, and the github page above has the resources you need to get started and to access the processing software.

Created by Will Greene at the Perry Institute for Marine Science / ASU Center for Global Discovery and Conservation Science.

This page is a work in progress and may break unexpectedly as I build it out.

## Architecture
- Frontend: GitHub Pages
- Map: MapLibre GL JS
- Imagery Storage: on Dropbox as COG
- Overlays: in the Overlays folder in root directory
- 3D Models: Gaussian splats published on Superspl.at and embedded directly into webpage
- Data directory: links to imagery, overlays, and models are stored in a GeoJSON file within the Data folder; this file serves as the points file displayed on the splash page map and drives the available timepoints and overlays and models for each plot

## Adding a reef
1. Convert mosaic to COG
2. Upload to Dropbox
3. Convert analyzed corals shapefile into GeoJSON
4. (optionally) create and publish a 3DGS model of the reef on Superspl.at and embed it
5. Add entry to `data/sites.geojson` and point to imagery / overlays / splats

