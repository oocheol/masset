# SPDX-License-Identifier: MIT
"""Validate one raster and normalize its existing alpha; no background model."""
import hashlib
import io
import warnings

from runtime_common import WorkerError, open_regular


def prepare_image(job):
    import numpy as np
    from PIL import Image, ImageOps
    from skimage.measure import label

    with open_regular(job["sourcePath"], 64 * 1024 ** 2) as handle:
        data = handle.read(64 * 1024 ** 2 + 1)
    if len(data) > 64 * 1024 ** 2:
        raise WorkerError("invalid_image", "Image exceeds the 64 MiB input limit")
    if hashlib.sha256(data).hexdigest() != job["sourceSha256"]:
        raise WorkerError("source_changed", "Source SHA-256 differs from the job; select the image again")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(data))
            if image.format not in {"PNG", "JPEG", "WEBP"} or getattr(image, "n_frames", 1) != 1:
                raise WorkerError("invalid_image", "Only single-frame PNG, JPEG and WebP images are supported")
            if min(image.size) < 16 or max(image.size) > 8192 or image.width * image.height > 16 * 1024 ** 2:
                raise WorkerError("invalid_image", "Image dimensions must be 16–8192 pixels with at most 16 megapixels")
            image.load()
            image = ImageOps.exif_transpose(image).convert("RGBA")
    except WorkerError:
        raise
    except Exception:
        raise WorkerError("invalid_image", "Image could not be decoded as a supported raster") from None
    original_size = list(image.size)
    # Bound segmentation/cropping memory independently of the source size.
    image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
    rgba = np.asarray(image)
    alpha = rgba[..., 3]
    visible = alpha >= 16
    transparent_fraction = float((alpha <= 8).mean())
    border = np.concatenate((alpha[0], alpha[-1], alpha[:, 0], alpha[:, -1]))
    if transparent_fraction < 0.02 or float((border <= 8).mean()) < 0.75:
        raise WorkerError("unsupported_background", "Supply a transparent PNG/WebP containing one isolated object. Opaque JPEGs and backgrounds require explicit preprocessing; automatic background removal is not installed.")
    if int(visible.sum()) < 64 or int(alpha.max()) < 128:
        raise WorkerError("empty_foreground", "Image must contain a visible, non-empty object with meaningful alpha")
    analysis = image.copy()
    analysis.thumbnail((512, 512), Image.Resampling.NEAREST)
    components = label(np.asarray(analysis)[..., 3] >= 16, connectivity=2)
    counts = np.bincount(components.ravel())[1:]
    if int((counts >= max(32, int(counts.sum() * 0.01))).sum()) > 1:
        raise WorkerError("multiple_objects", "Supply one connected foreground object; multiple separate objects are unsupported")
    y, x = np.where(visible)
    bounds = [int(x.min()), int(y.min()), int(x.max()) + 1, int(y.max()) + 1]
    cropped = image.crop(tuple(bounds))
    side = max(cropped.size)
    canvas_side = int(np.ceil(side / 0.85))
    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    canvas.paste(cropped, ((canvas_side - cropped.width) // 2, (canvas_side - cropped.height) // 2))
    canvas = canvas.resize((512, 512), Image.Resampling.LANCZOS)
    normalized = np.asarray(canvas).astype(np.float32) / 255.0
    rgb = normalized[..., :3] * normalized[..., 3:] + 0.5 * (1.0 - normalized[..., 3:])
    prepared = Image.fromarray(np.rint(rgb * 255).clip(0, 255).astype(np.uint8), "RGB")
    return prepared, {"originalDimensions": original_size, "analysisDimensions": list(image.size),
                      "foregroundBounds": bounds, "foregroundRatio": 0.85, "preparedDimensions": [512, 512],
                      "alphaCompositedBackground": [0.5, 0.5, 0.5], "backgroundRemoval": False,
                      "transparentFraction": transparent_fraction, "sourceBytes": len(data)}
