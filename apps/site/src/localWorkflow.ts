export interface LocalWorkflowEvidence {
  schemaVersion: 1;
  title: string;
  scenario: string;
  verifiedAt: string;
  platform: string;
  runtime: string;
  input: { brief: string; artDirection: string };
  outputs: {
    name: string;
    parameters: string;
    preview: string;
    files: { label: string; href: string; sha256: string }[];
  }[];
  checks: { label: string; result: 'passed' | 'limited'; detail: string }[];
  limitations: string[];
  artifacts: { label: string; href: string; sha256: string }[];
}

// Populated from a real local Windows run independently of any Claude status.
export const localWorkflowProof: LocalWorkflowEvidence | null = {
  "schemaVersion": 1,
  "title": "A woodland workshop, made as three local game props.",
  "scenario": "A maintainer-run production case using the Windows native CLI and existing local Blender recipes. Claude did not select or generate these models.",
  "verifiedAt": "2026-10-07T15:03:01.945Z",
  "platform": "Windows x64",
  "runtime": "Blender 5.2.1 LTS · Asset Studio native CLI",
  "input": {
    "brief": "A small isometric woodland workshop needs three separate game props: a storage crate, workbench and display shelf.",
    "artDirection": "Muted teal wood and sand trim, clean silhouettes, soft studio lighting and metre scale. The creator selects existing recipes and parameters locally."
  },
  "outputs": [
    {
      "name": "Workshop storage crate",
      "parameters": "0.8 × 0.65 × 0.7 m · 1,620 triangles · crate recipe",
      "preview": "/examples/local-prop-kit/crate/thumbnail.png",
      "files": [
        {
          "label": "model.glb",
          "href": "/examples/local-prop-kit/crate/model.glb",
          "sha256": "fd5ee84a7617c54c254528230c48f1c0e69e0c17743fe540e939623bef717a06"
        },
        {
          "label": "source.blend",
          "href": "/examples/local-prop-kit/crate/source.blend",
          "sha256": "3d84990dcfd3f2b6aa7a5cefa6e615d05c1122125fd1c18394015e15a90aba10"
        },
        {
          "label": "thumbnail.png",
          "href": "/examples/local-prop-kit/crate/thumbnail.png",
          "sha256": "c87d88cf5f9f57e3fc0b266b8298bc8c11204a481d53c0b54b2997cace868c0d"
        }
      ]
    },
    {
      "name": "Woodland workbench",
      "parameters": "1.4 × 0.7 × 0.85 m · 972 triangles · table recipe",
      "preview": "/examples/local-prop-kit/table/thumbnail.png",
      "files": [
        {
          "label": "model.glb",
          "href": "/examples/local-prop-kit/table/model.glb",
          "sha256": "d065dc4b27691fb27fcc4c4484e32beae95e3e77d52fab4f310789caddeba9da"
        },
        {
          "label": "source.blend",
          "href": "/examples/local-prop-kit/table/source.blend",
          "sha256": "e415ce9ae9d3e604ba1072b0cd36b26bff1c42a33c255e708b12c793de69e6e4"
        },
        {
          "label": "thumbnail.png",
          "href": "/examples/local-prop-kit/table/thumbnail.png",
          "sha256": "d848d455b17410a50265ea89fdfe606961222484242d660205d95a59d0845925"
        }
      ]
    },
    {
      "name": "Workshop display shelf",
      "parameters": "1.1 × 0.45 × 1.6 m · 756 triangles · shelf recipe",
      "preview": "/examples/local-prop-kit/shelf/thumbnail.png",
      "files": [
        {
          "label": "model.glb",
          "href": "/examples/local-prop-kit/shelf/model.glb",
          "sha256": "14eb7351a009262b36c423510c026cb76a459523f6ea50cbd62722d0f4b8f2ff"
        },
        {
          "label": "source.blend",
          "href": "/examples/local-prop-kit/shelf/source.blend",
          "sha256": "39c01c525a5efb7d7024fd609b7a25e17211eab56a7fb515a4e742b21b7019a3"
        },
        {
          "label": "thumbnail.png",
          "href": "/examples/local-prop-kit/shelf/thumbnail.png",
          "sha256": "3bc064be0268654fc02da4d89e2c2436b915e008b6c3ecd5c5d95845148c88b9"
        }
      ]
    }
  ],
  "checks": [
    {
      "label": "Three native model jobs",
      "result": "passed",
      "detail": "The Windows native CLI and production scheduler made three distinct parameterized Blender models. No GUI or provider request was involved."
    },
    {
      "label": "Independent file reopening",
      "result": "passed",
      "detail": "Each GLB and editable .blend source was reopened in its own Blender process with script auto-execution disabled; dimensions, pivot, UVs, normals and material assignments passed."
    },
    {
      "label": "Portable export integrity",
      "result": "passed",
      "detail": "The native export contained the same model, editable source and preview bytes; SHA-256 and file sizes matched the saved inventory."
    },
    {
      "label": "Visual and game quality",
      "result": "limited",
      "detail": "These are existing procedural recipes with simple materials. They are not Claude-generated shapes, baked textures, runtime performance measurements or a customer case study."
    }
  ],
  "limitations": [
    "Developer-written input and local parameters; no Claude or Codex generation request.",
    "Fixed procedural shapes and simple materials; no claim of baked texture quality, animation, collision meshes or runtime engine performance.",
    "Native backend and portable export checked on Windows. A browser preview does not verify the desktop GUI or a Mac build."
  ],
  "artifacts": [
    {
      "label": "Local recipe selection and parameters",
      "href": "/examples/local-prop-kit/input.json",
      "sha256": "a37d68f7aead814fb74aca3978300f93b91d4a448167e5d28bacd375b09a39d8"
    },
    {
      "label": "Native production, round-trip and export verification",
      "href": "/examples/local-prop-kit/verification.json",
      "sha256": "c8e9087e53ec7e5d615c78071daecf478cdfed7fa1cdae96ef33af4a39884f29"
    }
  ]
};
