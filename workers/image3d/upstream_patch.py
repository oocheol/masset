# SPDX-License-Identifier: MIT
"""Four exact, reviewed edits to the pinned upstream snapshot (never user code)."""


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError("Pinned upstream source differs from the audited patch")
    return text.replace(before, after)


def patch_source(relative, data):
    text = data.decode("utf-8")
    if relative == "tsr/utils.py":
        text = replace_once(text, "import rembg\n", "")
        text = replace_once(text, "image = rembg.remove(image, session=rembg_session, **rembg_kwargs)",
                            'raise RuntimeError("Background removal is not installed; supply a transparent single-object image")')
    elif relative == "tsr/models/isosurface.py":
        text = replace_once(text, "from torchmcubes import marching_cubes", "from image3d_adapter import marching_cubes")
    elif relative == "tsr/models/tokenizers/image.py":
        text = replace_once(text, "from huggingface_hub import hf_hub_download", "import os")
        text = replace_once(text, '''ViTModel.config_class.from_pretrained(
                hf_hub_download(
                    repo_id=self.cfg.pretrained_model_name_or_path,
                    filename="config.json",
                )
            )''', '''ViTModel.config_class.from_json_file(
                os.path.join(self.cfg.pretrained_model_name_or_path, "config.json")
            )''')
    elif relative == "tsr/system.py":
        text = replace_once(text, "from huggingface_hub import hf_hub_download\n", "")
        text = replace_once(text, '''            config_path = hf_hub_download(
                repo_id=pretrained_model_name_or_path, filename=config_name
            )
            weight_path = hf_hub_download(
                repo_id=pretrained_model_name_or_path, filename=weight_name
            )''', '''            raise ValueError("TripoSR requires an installed, verified local model directory")''')
        text = replace_once(text, 'torch.load(weight_path, map_location="cpu")',
                            'torch.load(weight_path, map_location="cpu", weights_only=True)')
    return text.encode("utf-8")
