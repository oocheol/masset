use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;

pub const SCHEMA_VERSION: u32 = 1;

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Domain {
    #[default]
    Game,
    Product,
    Architecture,
    Education,
    Design,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    #[default]
    M,
    Cm,
    Mm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum UpAxis {
    #[default]
    #[serde(rename = "Y-up")]
    YUp,
    #[serde(rename = "Z-up")]
    ZUp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ColorSpace {
    #[default]
    #[serde(rename = "sRGB")]
    Srgb,
    #[serde(rename = "linear")]
    Linear,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum NormalConvention {
    #[default]
    #[serde(rename = "OpenGL")]
    OpenGl,
    #[serde(rename = "DirectX")]
    DirectX,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSpec {
    pub domain: Domain,
    pub width: u32,
    pub height: u32,
    pub unit: Unit,
    pub axis: UpAxis,
    pub pivot: [f64; 2],
    pub polygon_budget: u64,
    pub pixel_art: bool,
    pub color_space: ColorSpace,
    pub normal_convention: NormalConvention,
    pub naming: String,
    pub target: String,
}

impl Default for AssetSpec {
    fn default() -> Self {
        Self {
            domain: Domain::Game,
            width: 512,
            height: 512,
            unit: Unit::M,
            axis: UpAxis::YUp,
            pivot: [0.5, 0.5],
            polygon_budget: 10_000,
            pixel_art: false,
            color_space: ColorSpace::Srgb,
            normal_convention: NormalConvention::OpenGl,
            naming: "{name}_v{version}".into(),
            target: "Unity / Godot".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleGuide {
    pub id: String,
    pub name: String,
    pub palette: Vec<String>,
    pub line_weight: f64,
    pub camera: String,
    pub lighting: String,
    pub detail: String,
    pub margin: u32,
    pub reference_asset_ids: Vec<String>,
    pub approved: bool,
}

impl Default for StyleGuide {
    fn default() -> Self {
        Self {
            id: "default".into(),
            name: "차분한 판타지".into(),
            palette: ["#799993", "#d4bd8a", "#7192bc", "#c78272"]
                .iter()
                .map(|color| (*color).into())
                .collect(),
            line_weight: 2.0,
            camera: "orthographic 3/4".into(),
            lighting: "soft studio".into(),
            detail: "clean readable silhouette".into(),
            margin: 24,
            reference_asset_ids: Vec::new(),
            approved: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValidationStatus {
    Pass,
    Warn,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MeasuredValue {
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationCheck {
    pub code: String,
    pub status: ValidationStatus,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measured: Option<MeasuredValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub id: String,
    pub artifact_id: String,
    pub created_at: String,
    pub checks: Vec<ValidationCheck>,
    pub valid: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactRole {
    Source,
    Output,
    Thumbnail,
    Metadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub path: String,
    pub format: String,
    pub sha256: String,
    pub bytes: u64,
    pub role: ArtifactRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetSource {
    Import,
    Procedural,
    CodexSubscription,
    Fixture,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetVersion {
    pub id: String,
    pub number: u32,
    pub created_at: String,
    pub prompt: String,
    pub source: AssetSource,
    pub requested_model: Option<String>,
    pub confirmed_model: Option<String>,
    pub provider_version: Option<String>,
    pub artifacts: Vec<Artifact>,
    pub settings: BTreeMap<String, Value>,
    pub validation: Option<ValidationReport>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Image,
    Sprite,
    Texture,
    Model,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshInfo {
    pub vertices: u64,
    pub triangles: u64,
    pub dimensions: [f64; 3],
    pub unit: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub kind: AssetKind,
    pub folder: String,
    pub tags: Vec<String>,
    pub active_version_id: String,
    pub versions: Vec<AssetVersion>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub mesh: Option<MeshInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Pending,
    Ready,
    Running,
    RetryWait,
    WaitingUser,
    Succeeded,
    Failed,
    Cancelled,
    ExternalUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobResource {
    Cpu,
    Blender,
    External,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub stage: String,
    pub completed: Option<u64>,
    pub total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub project_id: String,
    pub asset_id: Option<String>,
    pub kind: String,
    pub label: String,
    pub status: JobStatus,
    pub dependencies: Vec<String>,
    pub resource: JobResource,
    pub attempts: u32,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    pub progress: JobProgress,
    pub payload: BTreeMap<String, Value>,
    pub cache_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderStatus {
    Verified,
    Unverified,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancellationMode {
    Remote,
    LocalOnly,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapability {
    pub id: String,
    pub name: String,
    pub status: ProviderStatus,
    pub authentication: String,
    pub requested_models: Vec<String>,
    pub confirmed_model: Option<String>,
    pub generation: bool,
    pub editing: bool,
    pub transparency: bool,
    pub masks: bool,
    pub reference_image_limit: Option<u32>,
    pub cancellation: CancellationMode,
    pub concurrency: Option<u32>,
    pub resolutions: Vec<String>,
    pub reason: String,
    pub checked_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreset {
    pub id: String,
    pub name: String,
    pub domain: Domain,
    pub formats: Vec<String>,
    pub axis: String,
    pub unit: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub schema_version: u32,
    pub created_at: String,
    pub updated_at: String,
    pub spec: AssetSpec,
    pub style_guide: StyleGuide,
    pub assets: Vec<Asset>,
    pub jobs: Vec<Job>,
}

impl Project {
    pub fn new(name: impl Into<String>) -> Self {
        let created_at = now();
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            schema_version: SCHEMA_VERSION,
            created_at: created_at.clone(),
            updated_at: created_at,
            spec: AssetSpec::default(),
            style_guide: StyleGuide::default(),
            assets: Vec::new(),
            jobs: Vec::new(),
        }
    }
}

impl Default for Project {
    fn default() -> Self {
        Self::new("새 프로젝트")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub root: String,
    pub project: Project,
    pub providers: Vec<ProviderCapability>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    pub blender_path: Option<String>,
    pub blender_version: Option<String>,
    pub platform: String,
    pub native: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MaskMode {
    Erase,
    Restore,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ImageOperation {
    Resize {
        width: u32,
        height: u32,
        #[serde(rename = "pixelArt")]
        pixel_art: bool,
    },
    Crop {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
    Trim {
        padding: u32,
    },
    Color {
        hue: f64,
        saturation: f64,
    },
    Background {
        color: String,
        tolerance: f64,
    },
    Mask {
        points: Vec<[f64; 2]>,
        radius: f64,
        mode: MaskMode,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelTemplate {
    Crate,
    Table,
    Shelf,
    Sword,
    Rifle,
    Spaceship,
    Barrel,
    Rock,
    Tree,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelParameters {
    pub template: ModelTemplate,
    pub name: String,
    pub width: f64,
    pub depth: f64,
    pub height: f64,
    pub color: String,
    pub bevel: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasOptions {
    pub width: u32,
    pub height: u32,
    pub padding: u32,
}

/// A bundle remains usable without SQLite, the app, or the original project.
/// Every path in `files` is relative to the directory containing manifest.json.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub format: String,
    pub schema_version: u32,
    pub exported_at: String,
    pub project_id: String,
    pub project_name: String,
    pub spec: AssetSpec,
    pub style_guide: StyleGuide,
    pub assets: Vec<Asset>,
    pub files: Vec<Artifact>,
}
