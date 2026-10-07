# SPDX-License-Identifier: GPL-3.0-or-later
"""Adversarial tests for the data boundary; run with standard CPython."""
import copy
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from audit import GLB, GLB_BYTES, read_parameters, read_preview_parameters, verify_source, prepare_output


def fixture():
    binary=struct.pack("<9f3H",0,0,0,1,0,0,0,1,0,0,1,2)
    doc={"asset":{"version":"2.0"},"buffers":[{"byteLength":len(binary)}],
         "bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":36},
                        {"buffer":0,"byteOffset":36,"byteLength":6}],
         "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3"},
                      {"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}],
         "meshes":[{"primitives":[{"attributes":{"POSITION":0},"indices":1}]}],
         "nodes":[{"mesh":0}],"scenes":[{"nodes":[0]}],"scene":0}
    return doc,binary


def container(doc,binary):
    header=json.dumps(doc,separators=(",",":")).encode()
    header+=b" "*(-len(header)%4)
    binary+=b"\0"*(-len(binary)%4)
    return struct.pack("<4sII",b"glTF",2,28+len(header)+len(binary))+struct.pack("<II",len(header),0x4E4F534A)+header+struct.pack("<II",len(binary),0x004E4942)+binary


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        doc,binary=fixture()
        self.source=self.root/"original.glb"
        self.source.write_bytes(container(doc,binary))
        self.job={"sourcePath":str(self.source),"sourceSha256":hashlib.sha256(self.source.read_bytes()).hexdigest(),
                  "name":"Safe model","heightMeters":1,"maxTriangles":1000,"textureResolution":512,
                  "sourceKind":"model","preserveMaterials":True}
        self.path=self.root/"job.json"

    def tearDown(self):
        self.temp.cleanup()

    def parameters(self,job):
        self.path.write_text(json.dumps(job))
        return read_parameters(self.path)

    def test_exact_valid_job_and_hash(self):
        result=self.parameters(self.job)
        self.assertEqual(result["previewMode"], "cycles")
        data,glb=verify_source(result)
        self.assertEqual(glb.scene_triangles,1)
        self.assertEqual(data,self.source.read_bytes())

    def test_finishing_preview_modes_are_optional_but_bounded(self):
        for mode in ("cycles", "fast", "deferred"):
            with self.subTest(mode=mode):
                self.assertEqual(self.parameters({**self.job, "previewMode": mode})["previewMode"], mode)
        for mode in (True, [], "", "GPU", "script.py"):
            with self.subTest(invalid=mode), self.assertRaises(ValueError):
                self.parameters({**self.job, "previewMode": mode})

    def test_separate_preview_accepts_only_generated_blend_contract(self):
        job={"sourcePath":str(self.root/"source.blend"), "sourceSha256":"a"*64,
             "name":"Generated preview", "previewMode":"fast"}
        self.path.write_text(json.dumps(job))
        self.assertEqual(read_preview_parameters(self.path), job)
        variants=({**job,"previewMode":"deferred"}, {**job,"previewMode":True},
                  {**job,"sourcePath":str(self.root/"source.py")}, {**job,"sourcePath":"relative.blend"},
                  {**job,"scriptPath":"execute.py"}, {**job,"sourceSha256":"z"*64}, {**job,"name":"../escape"})
        for invalid in variants:
            with self.subTest(invalid=invalid):
                self.path.write_text(json.dumps(invalid))
                with self.assertRaises(ValueError):
                    read_preview_parameters(self.path)

    def test_json_boundary_table(self):
        cases=[("heightMeters",True),("heightMeters",float("nan")),("heightMeters",float("inf")),
               ("heightMeters",0.029),("heightMeters",100.01),("maxTriangles",True),
               ("maxTriangles",1000.0),("maxTriangles",999),("maxTriangles",100001),
               ("textureResolution",True),("textureResolution",513),("textureResolution","1024"),
               ("sourceKind",[]),("sourceKind",{}),("sourceKind","python"),("preserveMaterials",1),
               ("sourceSha256","f"*63),("sourceSha256","g"*64),("sourcePath","relative.glb"),
               ("sourcePath",str(self.root/"script.blend")),("name","../model"),
               ("name"," model "),("name","x"*81),("name",""),("name","a\nb")]
        for key,value in cases:
            with self.subTest(key=key,value=value):
                job=dict(self.job);job[key]=value
                with self.assertRaises(ValueError):
                    self.parameters(job)

    def test_duplicate_unknown_missing_and_large_json(self):
        for raw in [json.dumps(self.job)[:-1]+',"name":"duplicate"}',
                    json.dumps({**self.job,"scriptPath":"/tmp/script.py"}),
                    json.dumps({k:v for k,v in self.job.items() if k!="sourceKind"}),
                    " "*16385,"[]",'{"sourceKind":1e400}']:
            self.path.write_text(raw)
            with self.assertRaises(ValueError):
                read_parameters(self.path)

    def test_hash_mismatch_before_import(self):
        job=self.parameters({**self.job,"sourceSha256":"0"*64})
        with self.assertRaises(ValueError):
            verify_source(job)

    def test_container_headers_and_bounds(self):
        valid=self.source.read_bytes()
        for data in [b"",valid[:20],b"BLENDER"+valid[7:],valid[:-1],
                     valid[:4]+struct.pack("<I",1)+valid[8:],
                     valid[:8]+struct.pack("<I",len(valid)+4)+valid[12:],
                     valid[:12]+struct.pack("<I",0x7ffffffc)+valid[16:]]:
            with self.subTest(length=len(data)),self.assertRaises(ValueError):
                GLB(data)

    def test_glb_mutation_boundary_table(self):
        doc,binary=fixture()
        mutations=[
            lambda d:d.update(extensionsRequired=["KHR_draco_mesh_compression"]),
            lambda d:d["buffers"][0].update(uri="https://evil/mesh.bin"),
            lambda d:d.update(images=[{"uri":"data:image/png;base64,abc"}]),
            lambda d:d.update(extras={"nested":{"uri":"file:///script.py"}}),
            lambda d:d.update(animations=[{}]),
            lambda d:d.update(skins=[{}]),
            lambda d:d["nodes"][0].update(skin=0),
            lambda d:d["nodes"][0].update(children=[0]),
            lambda d:d["nodes"][0].update(translation=[0,float("inf"),0]),
            lambda d:d["accessors"][0].update(count=2000001),
            lambda d:d["accessors"][0].update(sparse={}),
            lambda d:d["accessors"][0].update(byteOffset=40),
            lambda d:d["bufferViews"][0].update(byteLength=999),
            lambda d:d["bufferViews"][0].update(byteStride=1),
            lambda d:d["meshes"][0]["primitives"][0].update(mode=1),
            lambda d:d["meshes"][0]["primitives"][0].update(targets=[{}]),
            lambda d:d["meshes"][0]["primitives"][0].update(extensions={"EXT_meshopt_compression":{}}),
            lambda d:d["meshes"][0]["primitives"][0]["attributes"].update(POSITION=999),
            lambda d:d["meshes"][0]["primitives"][0].update(material=0),
            lambda d:d["scenes"][0].update(nodes=[0,0]),
            lambda d:d.update(nodes=[{"mesh":0},{"children":[0]},{"children":[0]}]),
            lambda d:d["buffers"][0].update(byteLength=1),
            lambda d:d["asset"].update(version="1.0"),
        ]
        for index,change in enumerate(mutations):
            altered=copy.deepcopy(doc);change(altered)
            with self.subTest(mutation=index),self.assertRaises(ValueError):
                GLB(container(altered,binary))

    def test_binary_nonfinite_and_bad_indices(self):
        doc,binary=fixture()
        for altered in [struct.pack("<f",float("nan"))+binary[4:],
                        binary[:36]+struct.pack("<3H",0,1,99)]:
            with self.assertRaises(ValueError):
                GLB(container(doc,altered))

    def test_material_render_boundary(self):
        doc,binary=fixture()
        doc["meshes"][0]["primitives"][0]["material"]=0
        for material in ({}, {"alphaMode":"MASK","alphaCutoff":0.37,"doubleSided":True},
                         {"alphaMode":"BLEND","doubleSided":False}):
            doc["materials"]=[material]
            self.assertEqual(GLB(container(doc,binary)).scene_triangles,1)
        invalid=({"alphaMode":"CLIP"}, {"alphaMode":[]}, {"alphaCutoff":True},
                 {"alphaCutoff":-0.1}, {"doubleSided":"yes"},
                 {"occlusionTexture":{"index":0,"strength":1.01}},
                 {"occlusionTexture":{"index":0,"strength":True}})
        doc["textures"]=[{"source":0}]
        for material in invalid:
            doc["materials"]=[material]
            with self.subTest(material=material),self.assertRaises(ValueError):
                GLB(container(doc,binary))

    def test_no_reuse_or_original_overwrite(self):
        destination=self.root/"output"
        destination.mkdir()
        self.assertTrue(prepare_output(destination).samefile(destination.resolve()))
        sentinel=destination/"original.txt"
        sentinel.write_text("preserve this")
        with self.assertRaises(ValueError):
            prepare_output(destination)
        self.assertEqual(sentinel.read_text(),"preserve this")
        alias=self.root/"alias"
        alias.symlink_to(destination,target_is_directory=True)
        with self.assertRaises(ValueError):
            prepare_output(alias)


if __name__=="__main__":
    unittest.main()
