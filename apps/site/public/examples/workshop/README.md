# Treeset workshop example

Developer-made example, published October 8, 2026.

Play: https://treeset.win/play/workshop/en/
Story: https://treeset.win/devlog/workshop/
Source: https://github.com/oocheol/masset/tree/master/apps/site/src/workshop

## Contents

Three actual local procedural GLBs, editable Blender sources, rendered previews, native input and verification records, a default scene JSON and SHA-256 inventory. The GLBs are Y-up, in metres, with bottom-centre pivots. No image textures or animations are included.

## Use the scene

Start the web demo, choose Arrange the scene, then Open scene JSON and select scene.json. Select a prop and tap the floor to place it. Save scene JSON creates a new file with the layout and fixed model provenance. This archive contains assets and records; the full runnable web source is in the public repository.

To run the web example locally, use Node.js 24, clone the repository, run npm ci from its root, then npm run site:dev. Open http://127.0.0.1:4174/play/workshop/en/.

In another engine, use the asset id to find its models/<id>/model.glb file, preserve metre scale, set x and z from scene.json, and rotate around Y by rotation degrees. Some engines use another up axis; convert deliberately. This package does not certify any other engine import.

The original native SHA-256 record is kept under production/verification.json. manifest.json describes files in this package. Source .blend files should be opened with script auto-execution disabled. Generated text is not executed as an asset input.

## Scope

The props were made and reopened by the Windows local Blender workflow. The web floor, robot, gameplay and placement logic are authored demo code. No Claude or image provider request was used for this example. This is not external customer evidence, texture-generation proof or new desktop/macOS verification.

Project license: Apache-2.0, included in LICENSE.txt.
