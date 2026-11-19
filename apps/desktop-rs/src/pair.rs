//! 设备配对：POST /api/pair 兑换配对码 → { token, dataKey, serverVersion, deviceId }
//!
//! HTTP 部分保持薄壳：构造请求体与解析响应均为纯函数（可单测），
//! 网络往返只在 pair() 集成点发生（ureq 同步阻塞，调用方放 spawn_blocking）。

use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairResponse {
    pub token: String,
    pub data_key: String,
    pub server_version: String,
    pub device_id: String,
}

#[derive(Debug)]
pub enum PairError {
    /// 网络层 / 协议错误（连不上、响应非法、缺字段）
    Http(String),
    /// 服务端明确拒绝（如 401「配对码无效或已过期」、429 限频）
    Server(String),
}

impl std::fmt::Display for PairError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Http(m) => write!(f, "连接失败：{m}"),
            Self::Server(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for PairError {}

/// 构造配对请求体 JSON：code 规范化（trim + 大写），clientVersion 取 crate 版本
pub fn build_pair_body(code: &str, device_name: &str) -> String {
    serde_json::json!({
        "code": code.trim().to_uppercase(),
        "deviceName": device_name.trim(),
        "clientVersion": env!("CARGO_PKG_VERSION"),
    })
    .to_string()
}

/// 解析配对响应体：服务端错误（{error}）优先；成功须四字段齐全
pub fn parse_pair_response(body: &str) -> Result<PairResponse, PairError> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| PairError::Http(format!("响应不是合法 JSON: {e}")))?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(PairError::Server(err.to_owned()));
    }
    let need = |key: &str| -> Result<String, PairError> {
        v.get(key)
            .and_then(|x| x.as_str())
            .map(|s| s.to_owned())
            .ok_or_else(|| PairError::Http(format!("响应缺少字段 {key}")))
    };
    // deviceId 兼容数字/字符串两种形态：服务器 2.0.0 起返回 JSON 数字（如 3），
    // 统一转十进制字符串存储，下游存储格式不变
    let device_id = v
        .get("deviceId")
        .and_then(|x| {
            x.as_str()
                .map(|s| s.to_owned())
                .or_else(|| x.as_u64().map(|n| n.to_string()))
        })
        .ok_or_else(|| PairError::Http("响应缺少字段 deviceId".to_owned()))?;
    Ok(PairResponse {
        token: need("token")?,
        data_key: need("dataKey")?,
        server_version: need("serverVersion")?,
        device_id,
    })
}

/// 配对入口：同步阻塞 HTTP（ureq），调用方须置于 spawn_blocking
pub fn pair(server_url: &str, code: &str, device_name: &str) -> Result<PairResponse, PairError> {
    let url = format!("{}/api/pair", server_url.trim_end_matches('/'));
    let body = build_pair_body(code, device_name);
    match ureq::post(&url)
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(8))
        .send_string(&body)
    {
        Ok(resp) => {
            let text = resp
                .into_string()
                .map_err(|e| PairError::Http(format!("读取响应失败: {e}")))?;
            parse_pair_response(&text)
        }
        Err(ureq::Error::Status(_, resp)) => {
            // 服务端错误：尽力取出 {error} 文案（401/429/400 都走这里）
            let text = resp.into_string().unwrap_or_default();
            match parse_pair_response(&text) {
                Err(PairError::Server(m)) => Err(PairError::Server(m)),
                _ => Err(PairError::Server("配对失败，请重试".to_owned())),
            }
        }
        Err(e) => Err(PairError::Http(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_pair_body_normalizes_and_includes_version() {
        let body = build_pair_body("  ab3d-ef99 ", "  书房电脑 ");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["code"], "AB3D-EF99");
        assert_eq!(v["deviceName"], "书房电脑");
        assert_eq!(v["clientVersion"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn parse_success_response() {
        let body = r#"{"token":"t-1","dataKey":"k-1","serverVersion":"2.0.0","deviceId":"d-1"}"#;
        let r = parse_pair_response(body).unwrap();
        assert_eq!(r.token, "t-1");
        assert_eq!(r.data_key, "k-1");
        assert_eq!(r.server_version, "2.0.0");
        assert_eq!(r.device_id, "d-1");
    }

    #[test]
    fn parse_numeric_device_id() {
        // 服务器 2.0.0 实际返回数字 deviceId，须兼容（回归：此前误报「响应缺少字段 deviceId」）
        let body = r#"{"token":"t-1","dataKey":"k-1","serverVersion":"2.0.0","deviceId":3}"#;
        let r = parse_pair_response(body).unwrap();
        assert_eq!(r.device_id, "3");
    }

    #[test]
    fn parse_server_error_response() {
        let body = r#"{"error":"配对码无效或已过期"}"#;
        match parse_pair_response(body) {
            Err(PairError::Server(m)) => assert_eq!(m, "配对码无效或已过期"),
            other => panic!("应返回 Server 错误，实际 {other:?}"),
        }
    }

    #[test]
    fn parse_invalid_json() {
        assert!(matches!(
            parse_pair_response("<html>"),
            Err(PairError::Http(_))
        ));
    }

    #[test]
    fn parse_missing_field() {
        let body = r#"{"token":"t-1","dataKey":"k-1","serverVersion":"2.0.0"}"#;
        assert!(matches!(
            parse_pair_response(body),
            Err(PairError::Http(_))
        ));
    }
}
