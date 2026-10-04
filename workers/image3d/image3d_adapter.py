# SPDX-License-Identifier: MIT
"""CPU-only torchmcubes API adapter. Inputs are trusted model density tensors.

Upstream torchmcubes returns x/y/z coordinates for a z/y/x volume. skimage
returns volume-axis coordinates; reversing here lets upstream's own reversal
recover its x/y/z grid. Faces remain in volume order (no spatial reflection of
the final mesh). The asymmetric ellipsoid test checks axes and outward winding.
"""


def marching_cubes(volume, level):
    import numpy as np
    import torch
    from skimage.measure import marching_cubes as extract

    if volume.device.type != "cpu":
        raise ValueError("Image3D mesh extraction requires CPU tensors")
    values = volume.detach().numpy().astype(np.float32, copy=False)
    if values.ndim != 3 or not np.isfinite(values).all():
        raise ValueError("Model density must be a finite three-dimensional grid")
    if not float(values.min()) < level < float(values.max()):
        raise ValueError("No surface at the model density threshold; try another single-object image")
    vertices, faces, _, _ = extract(values, level=level, gradient_direction="descent",
                                   allow_degenerate=False, method="lewiner")
    # skimage descent faces have inward mathematical winding for positive-inside
    # densities. Reverse the winding once so GLB normals point outwards.
    faces = np.ascontiguousarray(faces[:, ::-1], dtype=np.int64)
    vertices = np.ascontiguousarray(vertices[:, ::-1], dtype=np.float32)
    return torch.from_numpy(vertices), torch.from_numpy(faces)
