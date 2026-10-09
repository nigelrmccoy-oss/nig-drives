# Texture & HDRI credits (v1.3.2)

All photo textures and the sky HDRI in `public/textures/` and `public/hdri/` come
from [Poly Haven](https://polyhaven.com) (https://polyhaven.com/license) and
[ambientCG](https://ambientcg.com) (https://docs.ambientcg.com/license/) and are
released under **CC0 1.0 Universal (public domain)**.
No attribution is legally required; we list the authors anyway, with thanks.

Each set was downloaded at 1K (2K for a few Poly Haven sets), resized to 1024×1024 and re-encoded as WebP
(albedo q82, OpenGL normal q86, ARM q78). `arm.webp` packs
R = ambient occlusion, G = roughness, B = metalness. No other edits.

| Folder | Poly Haven asset | Author(s) | Used for |
|---|---|---|---|
| `grass/` | [Grass 004](https://ambientcg.com/view?id=Grass004) (`Grass004`, ambientCG) | ambientCG (Lennart Demes) | terrain splat layer 0 — ARM packed from its AO + roughness maps |
| `dirt/` | [Forest Ground 04](https://polyhaven.com/a/forest_ground_04) (`forest_ground_04`) | Rob Tuytel, Rico Cilliers | terrain layer 1, road verges, dirt/sand/grass tracks |
| `rock/` | [Rock Face 03](https://polyhaven.com/a/rock_face_03) (`rock_face_03`) | Dario Barresi, Rico Cilliers | terrain layer 2 (triplanar on steep slopes) |
| `snow/` | [Snow 02](https://polyhaven.com/a/snow_02) (`snow_02`) | Rob Tuytel | terrain layer 3 (snow weather) |
| `asphalt/` | [Asphalt 01](https://polyhaven.com/a/asphalt_01) (`asphalt_01`) | Dario Barresi, Charlotte Baglioni | asphalt / untagged roads |
| `concrete/` | [Concrete Pavement](https://polyhaven.com/a/concrete_pavement) (`concrete_pavement`) | Charlotte Baglioni | concrete roads, curbs, bridge sides |
| `paving/` | [Square Concrete Pavers](https://polyhaven.com/a/square_concrete_pavers) (`square_concrete_pavers`) | Amal Kumar | paving stones / cobblestone ways |
| `gravel/` | [Rocky Trail](https://polyhaven.com/a/rocky_trail) (`rocky_trail`) | Amal Kumar | gravel / compacted ways |

| HDRI | Poly Haven asset | Author | Notes |
|---|---|---|---|
| `../hdri/sky_512.hdr` | [Kloofendal 43d Clear (Pure Sky)](https://polyhaven.com/a/kloofendal_43d_clear_puresky) | Greg Zaal | 1K .hdr downsampled to 512×256 flat RGBE; image-based lighting only |
