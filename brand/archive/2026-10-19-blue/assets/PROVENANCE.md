# Nodu brand asset provenance

The mark, custom outlined wordmark, six explorations and identity boards are original vector artwork authored in this repository. Their exact source is `../scripts/build-assets.cjs`. PNG exports are deterministic Sharp rasterizations of the corresponding SVGs, not generated or traced pictures.

`../scripts/build-palettes.cjs` derives blue, orange and violet files from the same geometry and exports the three-column palette comparison. Blue is the user-confirmed primary palette as of 2026-10-19. Root production files use blue. `archive-green/` preserves the initial green exports with identical geometry for historical comparison.

`../scripts/package-assets.cjs` wraps the PNG sizes in a Windows ICO and macOS iconset; Apple iconutil produces ICNS. Raster files inside each `.iconset` are copies of the corresponding PNG export. Root `mark-1024.png`, logo PNGs, application icon PNGs, and board PNGs each derive from the sibling SVG with matching base name.

The separately displayed historical AI application mockup `nodu-brand-showcase.png` has its own `.prompt.txt` and `.provenance.md`. It is excluded from the production ZIP. The production ZIP contains SVG/PNG/platform icons, all palette studies, this provenance record, source scripts, the naming research, README and MIT license.
