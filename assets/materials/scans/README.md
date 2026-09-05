# Photographic material sources

These are normalized derivatives of the following Poly Haven assets, released
under [CC0 1.0](https://polyhaven.com/license). The repository's MIT license does
not replace their public-domain dedication.

| Atlas region | Source |
| --- | --- |
| Red brick | [Red Brick 03](https://polyhaven.com/a/red_brick_03) |
| Brown brick | [Brown Brick 02](https://polyhaven.com/a/brown_brick_02) |
| Aged concrete | [Concrete Floor 02](https://polyhaven.com/a/concrete_floor_02) |
| Worn asphalt | [Asphalt 02](https://polyhaven.com/a/asphalt_02) |
| Warm dressed stone | [Sandstone Blocks 05](https://polyhaven.com/a/sandstone_blocks_05) |
| Roof ballast | [Gravel Floor](https://polyhaven.com/a/gravel_floor) |

These are representative physical surfaces, not photographs of the game's
individual NYC buildings. The warm dressed-stone scan occupies the legacy
`limestone` atlas slot. Authored landmark colors and source building materials
continue to determine the architectural palette.

`node scripts/materials/import-scans.mjs` imports the six explicit 1K sources,
checks provider MD5 checksums, area-filters albedo in linear light, normalizes
normal vectors, and writes 496×496 PNGs. `manifest.json` records source URLs,
source SHA-256 checksums and normalized file checksums.

`npm run materials:build` validates these committed sources, wraps their gutters
and encodes the existing 2048×2048 color/normal/ORM KTX2 atlases. Source PNGs are
not under `public/` and are never downloaded by players. There are no runtime
requests to Poly Haven.
