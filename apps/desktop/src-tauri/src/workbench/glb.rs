//! Bounded, in-memory GLB import. No external resources, scripts or processes.
use super::*;
use std::{
    collections::HashSet,
    io::{Cursor, Read},
};

const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_VERTICES: u64 = 2_000_000;
type Matrix = [[f32; 4]; 4];

pub(super) fn inspect(path: &Path) -> Result<MeshInfo> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    inspect_bytes(&bytes)
}

fn inspect_bytes(bytes: &[u8]) -> Result<MeshInfo> {
    if bytes.len() > MAX_BYTES
        || bytes.len() < 20
        || &bytes[..4] != b"glTF"
        || u32::from_le_bytes(bytes[4..8].try_into()?) != 2
        || u32::from_le_bytes(bytes[8..12].try_into()?) as usize != bytes.len()
    {
        bail!("64MB 이하의 유효한 GLB 2.0 파일이 필요합니다.")
    }
    let gltf = gltf::Gltf::from_slice(bytes).context("GLB 구조 검증에 실패했습니다.")?;
    let bin = gltf
        .blob
        .as_deref()
        .context("외부 파일 없는 GLB가 필요합니다.")?;
    if gltf.buffers().count() != 1
        || gltf.nodes().count() > 4096
        || gltf.extensions_required().next().is_some()
    {
        bail!("이 GLB의 구조 또는 필수 압축 확장은 지원하지 않습니다.")
    }
    for buffer in gltf.buffers() {
        if !matches!(buffer.source(), gltf::buffer::Source::Bin) || buffer.length() > bin.len() {
            bail!("외부 버퍼를 참조하는 모델은 가져올 수 없습니다.")
        }
    }
    for view in gltf.views() {
        if view
            .offset()
            .checked_add(view.length())
            .is_none_or(|end| end > bin.len())
        {
            bail!("GLB 버퍼 범위가 올바르지 않습니다.")
        }
    }
    for accessor in gltf.accessors() {
        let view = accessor
            .view()
            .context("Sparse 또는 외부 accessor는 지원하지 않습니다.")?;
        let stride = view.stride().unwrap_or(accessor.size());
        let length = accessor
            .count()
            .checked_sub(1)
            .unwrap_or(0)
            .checked_mul(stride)
            .and_then(|n| n.checked_add(accessor.size()))
            .and_then(|n| n.checked_add(accessor.offset()));
        if accessor.sparse().is_some()
            || accessor.count() == 0
            || accessor.count() as u64 > MAX_VERTICES
            || stride < accessor.size()
            || length.is_none_or(|n| n > view.length())
        {
            bail!("GLB accessor 범위나 개수 제한을 확인해 주세요.")
        }
        if accessor.data_type() == gltf::accessor::DataType::F32 {
            let start = view.offset() + accessor.offset();
            for n in 0..accessor.count() {
                for chunk in
                    bin[start + n * stride..start + n * stride + accessor.size()].chunks_exact(4)
                {
                    if !f32::from_le_bytes(chunk.try_into()?).is_finite() {
                        bail!("모델에 유한하지 않은 좌표가 있습니다.")
                    }
                }
            }
        }
    }
    let mut texture_pixels = 0u64;
    for image in gltf.images() {
        let gltf::image::Source::View { view, mime_type } = image.source() else {
            bail!("외부 텍스처를 참조하는 모델은 가져올 수 없습니다.")
        };
        if !["image/png", "image/jpeg"].contains(&mime_type) {
            bail!("GLB 텍스처는 PNG·JPEG만 지원합니다.")
        }
        let (w, h) = image::ImageReader::new(Cursor::new(
            &bin[view.offset()..view.offset() + view.length()],
        ))
        .with_guessed_format()?
        .into_dimensions()?;
        texture_pixels += u64::from(w) * u64::from(h);
        if w == 0 || h == 0 || texture_pixels > u64::from(raster::MAX_PIXELS) {
            bail!("GLB 텍스처의 총 픽셀 제한을 초과했습니다.")
        }
    }
    let scene = gltf
        .default_scene()
        .or_else(|| gltf.scenes().next())
        .context("GLB 장면이 없습니다.")?;
    let mut vertices = 0u64;
    let mut triangles = 0u64;
    let mut lower = [f64::INFINITY; 3];
    let mut upper = [f64::NEG_INFINITY; 3];
    let mut seen = HashSet::new();
    let identity = [
        [1., 0., 0., 0.],
        [0., 1., 0., 0.],
        [0., 0., 1., 0.],
        [0., 0., 0., 1.],
    ];
    for node in scene.nodes() {
        visit(
            node,
            identity,
            bin,
            0,
            &mut seen,
            &mut vertices,
            &mut triangles,
            &mut lower,
            &mut upper,
        )?;
    }
    if vertices == 0 || triangles == 0 {
        bail!("GLB에 비어 있지 않은 삼각형 메시가 필요합니다.")
    }
    Ok(MeshInfo {
        vertices,
        triangles,
        dimensions: std::array::from_fn(|i| upper[i] - lower[i]),
        unit: "m".into(),
    })
}

fn multiply(a: Matrix, b: Matrix) -> Matrix {
    std::array::from_fn(|column| {
        std::array::from_fn(|row| (0..4).map(|k| a[k][row] * b[column][k]).sum())
    })
}

#[allow(clippy::too_many_arguments)]
fn visit(
    node: gltf::Node<'_>,
    parent: Matrix,
    bin: &[u8],
    depth: usize,
    seen: &mut HashSet<usize>,
    vertices: &mut u64,
    triangles: &mut u64,
    lower: &mut [f64; 3],
    upper: &mut [f64; 3],
) -> Result<()> {
    if depth > 64 || !seen.insert(node.index()) {
        bail!("GLB 장면의 순환·깊이 제한을 확인해 주세요.")
    }
    let world = multiply(parent, node.transform().matrix());
    if world
        .iter()
        .flatten()
        .any(|v| !v.is_finite() || v.abs() > 1.0e8)
    {
        bail!("GLB 변환 값이 올바르지 않습니다.")
    }
    if let Some(mesh) = node.mesh() {
        for primitive in mesh.primitives() {
            if primitive.mode() != gltf::mesh::Mode::Triangles {
                bail!("삼각형 GLB 메시만 지원합니다.")
            }
            let reader = primitive.reader(|buffer| (buffer.index() == 0).then_some(bin));
            let positions = reader
                .read_positions()
                .context("Float32 위치 데이터가 필요합니다.")?;
            let count = positions.len() as u64;
            *vertices += count;
            if *vertices > MAX_VERTICES {
                bail!("GLB 총 정점 제한을 초과했습니다.")
            }
            for p in positions {
                for axis in 0..3 {
                    let v = f64::from(
                        world[0][axis] * p[0]
                            + world[1][axis] * p[1]
                            + world[2][axis] * p[2]
                            + world[3][axis],
                    );
                    if !v.is_finite() {
                        bail!("GLB 좌표가 유효하지 않습니다.")
                    }
                    lower[axis] = lower[axis].min(v);
                    upper[axis] = upper[axis].max(v);
                }
            }
            let index_count = if let Some(indices) = reader.read_indices() {
                let mut total = 0u64;
                for index in indices.into_u32() {
                    if u64::from(index) >= count {
                        bail!("GLB 인덱스가 정점 범위를 벗어났습니다.")
                    }
                    total += 1;
                }
                total
            } else {
                count
            };
            if index_count % 3 != 0 {
                bail!("GLB 삼각형 인덱스 수가 올바르지 않습니다.")
            }
            *triangles += index_count / 3;
            if *triangles > MAX_VERTICES {
                bail!("GLB 총 삼각형 제한을 초과했습니다.")
            }
        }
    }
    for child in node.children() {
        visit(
            child,
            world,
            bin,
            depth + 1,
            seen,
            vertices,
            triangles,
            lower,
            upper,
        )?;
    }
    Ok(())
}

impl Backend {
    pub(super) fn import_glb(&self, path: &Path) -> Result<()> {
        inspect(path)?;
        let _guard = self.inner.io.lock().unwrap();
        let mut repo = Repository::open(&self.root()?)?;
        let mut artifact = repo.copy_in(
            path,
            "originals",
            path.file_name()
                .and_then(|s| s.to_str())
                .context("모델 파일명을 확인해 주세요.")?,
        )?;
        artifact.role = ArtifactRole::Source;
        let mesh = inspect(&repo.artifact_path(&artifact.path)?)?;
        let version_id = Uuid::new_v4().to_string();
        let validation=ValidationReport {id:Uuid::new_v4().to_string(),artifact_id:artifact.id.clone(),created_at:now(),valid:true,checks:vec![ValidationCheck {code:"glb.native-structure".into(),status:ValidationStatus::Pass,message:"내장 버퍼·텍스처, 실제 정점·인덱스·장면 치수를 검증했습니다. 외부 파일을 실행하거나 읽지 않았습니다.".into(),measured:None}]};
        let version = AssetVersion {
            id: version_id.clone(),
            number: 1,
            created_at: now(),
            prompt: String::new(),
            source: AssetSource::Import,
            requested_model: None,
            confirmed_model: None,
            provider_version: None,
            artifacts: vec![artifact],
            settings: BTreeMap::from([
                ("axis".into(), json!("Y-up")),
                ("unit".into(), json!("m")),
                ("measurementScope".into(), json!("static scene geometry")),
            ]),
            validation: Some(validation),
        };
        repo.add_asset(Asset {
            id: Uuid::new_v4().to_string(),
            name: path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("참고 모델")
                .to_owned(),
            kind: AssetKind::Model,
            folder: "가져온 모델".into(),
            tags: vec!["reference".into()],
            active_version_id: version_id,
            versions: vec![version],
            width: None,
            height: None,
            mesh: Some(mesh),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn triangle(extra: Value) -> Vec<u8> {
        let mut doc = json!({"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0,"scale":[2,3,1]}],"meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}],"buffers":[{"byteLength":36}],"bufferViews":[{"buffer":0,"byteLength":36}],"accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}]});
        for (k, v) in extra.as_object().unwrap() {
            doc[k] = v.clone();
        }
        let mut data = serde_json::to_vec(&doc).unwrap();
        while data.len() % 4 != 0 {
            data.push(b' ')
        }
        let mut bin = Vec::new();
        for p in [[0f32, 0., 0.], [1., 0., 0.], [0., 1., 0.]] {
            for n in p {
                bin.extend(n.to_le_bytes())
            }
        }
        let length = 12 + 8 + data.len() + 8 + bin.len();
        let mut out = b"glTF".to_vec();
        out.extend(2u32.to_le_bytes());
        out.extend((length as u32).to_le_bytes());
        out.extend((data.len() as u32).to_le_bytes());
        out.extend(0x4E4F534Au32.to_le_bytes());
        out.extend(data);
        out.extend((bin.len() as u32).to_le_bytes());
        out.extend(0x004E4942u32.to_le_bytes());
        out.extend(bin);
        out
    }
    #[test]
    fn measures_real_positions_and_scene_transform() {
        let m = inspect_bytes(&triangle(json!({}))).unwrap();
        assert_eq!(m.vertices, 3);
        assert_eq!(m.triangles, 1);
        assert_eq!(m.dimensions, [2., 3., 0.]);
    }
    #[test]
    fn rejects_external_buffers_and_accessor_overrun() {
        assert!(inspect_bytes(&triangle(
            json!({"buffers":[{"byteLength":36,"uri":"https://example.test/private"}]})
        ))
        .is_err());
        assert!(inspect_bytes(&triangle(json!({"accessors":[{"bufferView":0,"componentType":5126,"count":10,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}]}))).is_err());
    }
    #[test]
    fn rejects_cycles_and_nonfinite_binary_positions() {
        assert!(inspect_bytes(&triangle(json!({"nodes":[{"mesh":0,"children":[0]}]}))).is_err());
        let mut b = triangle(json!({}));
        let n = b.len();
        b[n - 4..].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(inspect_bytes(&b).is_err());
    }
}
