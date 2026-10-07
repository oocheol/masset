//! Optional, offline Windows/WSL2 model. A configured path is not inference proof.
use super::*;
use asset_providers::trellis2::{self as local, Trellis2RuntimeConfig};
use serde::Deserialize;

const MAX_METADATA: u64 = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigureRequest {
    action: String,
    runtime_root: String,
    distribution: String,
}

fn prepared(proof: &Value) -> bool {
    proof["prepared"] == true
        && proof["available"] == true
        && proof["hardwareEligible"] == true
        && proof["requestedModel"] == local::MODEL_ID
        // Preparation alone must not promote an unexecuted model to verified.
        && proof["ready"] == false
        && proof["hashesVerified"] == false
        && proof["inferenceVerified"] == false
        && proof["actualModel"].is_null()
        && proof["status"] == "preparedUnverified"
}

impl Backend {
    fn trellis_config_path(&self) -> PathBuf {
        self.inner
            .runtime_data
            .join("image3d/trellis2-local-v1/config.json")
    }

    pub(super) fn quality3d_trellis_config(&self) -> Result<Trellis2RuntimeConfig> {
        let path = self.trellis_config_path();
        let metadata =
            fs::symlink_metadata(&path).context("TRELLIS.2 로컬 런타임을 먼저 연결해 주세요.")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 8192 {
            bail!("TRELLIS.2 런타임 설정 파일을 확인해 주세요.");
        }
        let config: Trellis2RuntimeConfig = serde_json::from_slice(&fs::read(path)?)?;
        config.validate()?;
        Ok(config)
    }

    fn probe_trellis(&self, config: &Trellis2RuntimeConfig) -> Result<Value> {
        let mut command = local::probe(config, &self.quality3d_worker("trellis2", "worker.py")?)?;
        quality3d::process_environment(&mut command);
        let bytes = bounded_native_stdout(&mut command, Duration::from_secs(30), 64 * 1024)?;
        // Dependencies may print initialization messages. Accept one bounded final JSON line.
        let line = bytes
            .split(|b| *b == b'\n')
            .rev()
            .find(|line| line.iter().any(|b| !b.is_ascii_whitespace()))
            .context("TRELLIS.2 로컬 진단 결과가 없습니다.")?;
        let proof: Value = serde_json::from_slice(line)?;
        if !prepared(&proof) {
            bail!("TRELLIS.2 런타임의 고정 파일·CUDA·라이선스 확인이 끝나지 않았습니다.");
        }
        Ok(proof)
    }

    pub(super) fn quality3d_trellis_status(&self) -> Value {
        // UI polling never hashes multi-GiB weights and never starts WSL on a blocked host.
        let mut cached = self.inner.trellis_status.lock().unwrap();
        if let Some((at, status)) = cached.as_ref() {
            if at.elapsed() < Duration::from_secs(30) {
                return status.clone();
            }
        }
        let config = self.quality3d_trellis_config().ok();
        let host = local::local_status(config.as_ref());
        let gpu = host.gpus.iter().max_by_key(|g| g.vram_mb);
        let unsupported = !host.hardware_eligible && host.status != "runtimeMissing";
        let mut result = json!({
            "id":"trellis2_local", "name":"TRELLIS.2 · 로컬 GPU", "execution":"local",
            "available":false, "requiresImageUpload":false, "requestedModel":local::MODEL_ID,
            "state":if unsupported {"unsupported"} else {"requires_setup"},
            "reason":host.reason, "localMinimumVramMb":local::MINIMUM_VRAM_MB,
            "localMinimumMemoryMb":32768,
            "vramMb":gpu.map(|g|g.vram_mb), "gpuName":gpu.map(|g|g.name.as_str()),
            "runtimeRoot":config.as_ref().map(|c|c.runtime_root.as_str()),
            "distribution":config.as_ref().map(|c|c.distribution.as_str()),
            "hashesVerified":false, "inferenceVerified":false,
            "licensingStatus":host.licensing_status
        });
        if host.hardware_eligible {
            if let Some(config) = config.as_ref() {
                match self.probe_trellis(config) {
                    Ok(_) => {
                        result["available"] = json!(true);
                        result["state"] = json!("experimental");
                        result["reason"] = json!("로컬 CUDA 런타임을 연결했습니다. 실행 전에 모델 전체 SHA-256을 확인합니다. 실제 TRELLIS.2 생성과 Windows WSL2 경로는 미검증이며, 의존성 라이선스는 별도 조건을 따릅니다.");
                    }
                    Err(_) => {
                        result["reason"] = json!("설정한 WSL 런타임의 파일·CUDA·라이선스 확인이 실패했습니다. 다운로드나 다른 모델 실행은 하지 않았습니다.");
                    }
                }
            }
        }
        *cached = Some((Instant::now(), result.clone()));
        result
    }

    pub(super) fn quality3d_trellis_configure(&self, request: &Value) -> Result<Value> {
        let input: ConfigureRequest = serde_json::from_value(request.clone())?;
        if input.action != "quality3d_trellis_configure" {
            bail!("런타임 연결 요청을 확인해 주세요.");
        }
        let _admission = self.inner.requests.lock().unwrap();
        self.ensure_workers_idle()?;
        let config = Trellis2RuntimeConfig {
            runtime_root: input.runtime_root,
            distribution: input.distribution,
        };
        config.validate()?;
        if !local::host_gpu().hardware_eligible {
            bail!("TRELLIS.2 로컬 제작에는 NVIDIA GPU 24 GiB 이상이 필요합니다. WSL과 모델은 실행하지 않았습니다.");
        }
        self.probe_trellis(&config)?;
        let path = self.trellis_config_path();
        fs::create_dir_all(path.parent().context("런타임 설정 폴더가 없습니다.")?)?;
        let bytes = serde_json::to_vec_pretty(&config)?;
        atomic_new_replace(&path, &bytes)?;
        *self.inner.trellis_status.lock().unwrap() = None;
        Ok(self.quality3d_status())
    }

    /// Verify the actual receipt and output bytes before assigning a confirmed model.
    pub(super) fn quality3d_trellis_receipt(&self, raw: &Path, source_hash: &str) -> Result<Value> {
        let receipt_path = raw.join("generation.json");
        let metadata = fs::symlink_metadata(&receipt_path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_METADATA
        {
            bail!("TRELLIS.2 생성 증빙 파일을 확인해 주세요.");
        }
        let receipt: Value = serde_json::from_slice(&fs::read(receipt_path)?)?;
        if receipt["modelId"] != local::MODEL_ID
            || receipt["modelRevision"] != local::MODEL_REVISION
            || receipt["codeRevision"] != local::SOURCE_REVISION
            || receipt["device"] != "cuda"
            || receipt["inferenceExecuted"] != true
            || receipt["source"]["sha256"] != source_hash
            || receipt["offline"]["networkBlocked"] != true
            || receipt["offline"]["localConfigOnly"] != true
            || receipt["offline"]["safetensorsOnly"] != true
        {
            bail!("TRELLIS.2의 실제 모델·원본·오프라인 실행 증빙이 일치하지 않습니다.");
        }
        let lock: Value = serde_json::from_slice(&fs::read(
            self.quality3d_worker("trellis2", "runtime-lock.json")?,
        )?)?;
        for (group, field) in [("codeFiles", "codeFiles"), ("modelFiles", "modelFiles")] {
            let verified = receipt["runtimeVerification"][field]
                .as_array()
                .context("TRELLIS.2 전체 파일 검증 기록이 없습니다.")?;
            for expected in lock[group]
                .as_array()
                .context("TRELLIS.2 고정 파일 목록이 없습니다.")?
            {
                if !verified.iter().any(|actual| {
                    actual["path"] == expected["path"]
                        && actual["algorithm"] == expected["algorithm"]
                        && actual["digest"] == expected["digest"]
                        && actual["bytes"] == expected["bytes"]
                }) {
                    bail!("TRELLIS.2 고정 파일의 실제 해시 기록이 일치하지 않습니다.");
                }
            }
        }
        for name in ["mesh.glb", "prepared-input.png"] {
            let path = raw.join(name);
            let metadata = fs::symlink_metadata(&path)?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                bail!("TRELLIS.2 결과는 일반 파일이어야 합니다.");
            }
            let (hash, bytes) = asset_core::sha256_file(&path)?;
            let mapped_path = local::windows_to_wsl(&path)?;
            if !receipt["artifacts"]
                .as_array()
                .context("실제 결과 파일 목록이 없습니다.")?
                .iter()
                .any(|a| a["path"] == mapped_path && a["sha256"] == hash && a["bytes"] == bytes)
            {
                bail!("TRELLIS.2 결과 파일과 생성 증빙 해시가 다릅니다.");
            }
        }
        Ok(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_preparation_cannot_claim_inference() {
        let mut proof = json!({"prepared":true,"available":true,"hardwareEligible":true,
            "requestedModel":local::MODEL_ID,"ready":false,"hashesVerified":false,
            "inferenceVerified":false,"actualModel":null,"status":"preparedUnverified"});
        assert!(prepared(&proof));
        proof["inferenceVerified"] = json!(true);
        assert!(!prepared(&proof));
        proof["inferenceVerified"] = json!(false);
        proof["actualModel"] = json!(local::MODEL_ID);
        assert!(!prepared(&proof));
    }
    #[test]
    fn runtime_configuration_is_data_not_a_command() {
        let valid = json!({"action":"quality3d_trellis_configure","runtimeRoot":"/opt/trellis2","distribution":"Ubuntu"});
        assert!(serde_json::from_value::<ConfigureRequest>(valid.clone()).is_ok());
        let mut malicious = valid;
        malicious["python"] = json!("arbitrary.py");
        assert!(serde_json::from_value::<ConfigureRequest>(malicious).is_err());
    }
}
