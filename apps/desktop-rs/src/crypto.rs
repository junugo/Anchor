//! 上行行为数据加密（AES-256-GCM），与 TS 端 packages/utils/src/crypto.ts 同规格：
//! - key = SHA-256(passphrase)
//! - 线格式 base64(iv(12B) ‖ ciphertext ‖ tag(16B))
//! - 信封 { "enc": true, "v": 1, "data": base64 }

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};

pub const DEFAULT_DATA_KEY: &str = "anchor-dev-data-key";

/// 加密 JSON 文本为信封 JSON；失败返回 None（调用方回退明文直发）
pub fn encrypt_json(plaintext: &str, data_key: &str) -> Option<String> {
    let pass = Sha256::digest(data_key.as_bytes());
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&pass));

    let mut iv = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut iv);

    let ct = cipher
        .encrypt(Nonce::from_slice(&iv), plaintext.as_bytes())
        .ok()?;

    let mut buf = Vec::with_capacity(12 + ct.len());
    buf.extend_from_slice(&iv);
    buf.extend_from_slice(&ct);
    let data = base64::engine::general_purpose::STANDARD.encode(buf);

    Some(
        serde_json::json!({ "enc": true, "v": 1, "data": data })
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_with_default_key() {
        let msg = r#"{"type":"ingest","source":"desktop","event_type":"window_focus","payload":{"process":"code.exe"},"logged_at":1750000000}"#;
        let envelope = encrypt_json(msg, DEFAULT_DATA_KEY).expect("加密失败");
        let v: serde_json::Value = serde_json::from_str(&envelope).expect("信封非法");
        assert_eq!(v["enc"], true);
        assert_eq!(v["v"], 1);
        let data = v["data"].as_str().expect("缺 data");
        let raw = base64::engine::general_purpose::STANDARD
            .decode(data)
            .expect("base64 非法");
        assert!(raw.len() > 12 + 16, "密文长度异常");
        // 每次加密 iv 随机，密文应不同
        let envelope2 = encrypt_json(msg, DEFAULT_DATA_KEY).expect("加密失败");
        assert_ne!(envelope, envelope2);
    }

    #[test]
    fn different_key_produces_different_ciphertext() {
        let msg = "hello anchor";
        let a = encrypt_json(msg, DEFAULT_DATA_KEY).expect("加密失败");
        let b = encrypt_json(msg, "another-key").expect("加密失败");
        assert_ne!(a, b);
    }
}
