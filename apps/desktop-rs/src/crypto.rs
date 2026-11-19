//! 上行行为数据加密（AES-256-GCM），与 TS 端 packages/utils/src/crypto.ts 同规格：
//! - key = SHA-256(passphrase)
//! - 线格式 base64(iv(12B) ‖ ciphertext ‖ tag(16B))
//! - 信封 { "enc": true, "v": 1, "data": base64 }

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptoError {
    /// 未配对且未手动配置密钥：上行数据无法加密，调用方应跳过发送
    MissingKey,
    /// 加密失败（内部错误）
    Aead,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingKey => write!(f, "未配置数据密钥（未配对）"),
            Self::Aead => write!(f, "AES-GCM 加密失败"),
        }
    }
}

impl std::error::Error for CryptoError {}

/// 加密 JSON 文本为信封 JSON。
/// data_key 为 None（未配对且未手动配置）时返回 Err(MissingKey)，调用方须跳过发送
pub fn encrypt_json(plaintext: &str, data_key: Option<&str>) -> Result<String, CryptoError> {
    let pass = Sha256::digest(
        data_key
            .filter(|k| !k.is_empty())
            .ok_or(CryptoError::MissingKey)?
            .as_bytes(),
    );
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&pass));

    let mut iv = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut iv);

    let ct = cipher
        .encrypt(Nonce::from_slice(&iv), plaintext.as_bytes())
        .map_err(|_| CryptoError::Aead)?;

    let mut buf = Vec::with_capacity(12 + ct.len());
    buf.extend_from_slice(&iv);
    buf.extend_from_slice(&ct);
    let data = base64::engine::general_purpose::STANDARD.encode(buf);

    Ok(
        serde_json::json!({ "enc": true, "v": 1, "data": data })
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_without_key_returns_err() {
        let msg = r#"{"type":"ingest","source":"desktop"}"#;
        assert_eq!(
            encrypt_json(msg, None),
            Err(CryptoError::MissingKey),
            "无密钥时必须返回 Err，不允许回退明文"
        );
        assert_eq!(
            encrypt_json(msg, Some("")),
            Err(CryptoError::MissingKey),
            "空密钥同样视为未配置"
        );
    }

    #[test]
    fn roundtrip_with_key() {
        let msg = r#"{"type":"ingest","source":"desktop","event_type":"window_focus","payload":{"process":"code.exe"},"logged_at":1750000000}"#;
        let envelope = encrypt_json(msg, Some("test-key")).expect("加密失败");
        let v: serde_json::Value = serde_json::from_str(&envelope).expect("信封非法");
        assert_eq!(v["enc"], true);
        assert_eq!(v["v"], 1);
        let data = v["data"].as_str().expect("缺 data");
        let raw = base64::engine::general_purpose::STANDARD
            .decode(data)
            .expect("base64 非法");
        assert!(raw.len() > 12 + 16, "密文长度异常");
        // 每次加密 iv 随机，密文应不同
        let envelope2 = encrypt_json(msg, Some("test-key")).expect("加密失败");
        assert_ne!(envelope, envelope2);
    }

    #[test]
    fn different_key_produces_different_ciphertext() {
        let msg = "hello anchor";
        let a = encrypt_json(msg, Some("key-a")).expect("加密失败");
        let b = encrypt_json(msg, Some("key-b")).expect("加密失败");
        assert_ne!(a, b);
    }
}
