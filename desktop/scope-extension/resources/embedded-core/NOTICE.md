The CMake directory adapter derives from Nodu (MIT), source baseline
0f77b307bd79aada47fbf2d3fb207939eca84c84. Its freestanding runtime and
student driver dependencies retain their separate licenses in the project.
The shared service calls the versioned Nodu native implementation; it does
not reimplement the ST-LINK, ROM UART or compilation algorithms.

Distribution requires the matching native source archive and Nodu license,
and a release STM32 toolkit with its licenses and corresponding source
archives. The staging script rejects development toolkits for release.
Private development bundles are identified as development, not redistributable.
