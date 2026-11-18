//! WebSocket 客户端：复刻旧版 ws-client.ts 的重连策略
//! 前 10 次 5s 退避，之后进入 60s 心跳模式；连接成功重置。
//! v2 认证：连接建立后第一条消息发 {type:"auth",token}；收到 auth_failed 或
//! close 4401 = 配对失效，任务直接退出（不再重连），由 daemon 引导用户重新配对。

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const MAX_RETRIES: u32 = 10;
const RETRY_DELAY: Duration = Duration::from_secs(5);
const HEARTBEAT_DELAY: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub struct WsEvent {
    /// 代际号：server_url 变更重连后，core 忽略旧代事件
    pub gen: u32,
    pub kind: WsEventKind,
}

#[derive(Debug)]
pub enum WsEventKind {
    /// 认证通过（auth_ok）：可以正常收发
    Connected,
    Disconnected,
    /// 配对失效（auth_failed / close 4401）：任务退出，不再自动重连
    AuthFailed,
    Text(String),
}

/// WS 任务主循环。
/// - `token`：配对令牌；None 时不连接（防御：daemon 未配对不启动本任务）
/// - `out_rx`：待发送的 JSON 文本（core → ws）；所有 sender 被 drop 时任务退出
/// - `event_tx`：连接事件与服务器消息（ws → core）
pub async fn run(
    url: String,
    token: Option<String>,
    mut out_rx: mpsc::Receiver<String>,
    event_tx: mpsc::Sender<WsEvent>,
    gen: u32,
) {
    let Some(token) = token.filter(|t| !t.is_empty()) else {
        log::warn!("[WS] 未配对（无 token），WS 任务不启动");
        return;
    };

    let mut retry: u32 = 0;
    loop {
        match tokio_tungstenite::connect_async(&url).await {
            Ok((stream, _)) => {
                log::info!("[WS] 已连接 {url}，发送认证…");
                let (mut write, mut read) = stream.split();

                // 认证：连接建立后的第一条消息
                let auth_msg = serde_json::json!({ "type": "auth", "token": token }).to_string();
                if let Err(e) = write.send(Message::Text(auth_msg.into())).await {
                    log::warn!("[WS] 认证消息发送失败: {e}");
                    retry += 1;
                    tokio::time::sleep(RETRY_DELAY).await;
                    continue;
                }

                // 认证阶段：等待 auth_ok / auth_failed / close 4401
                let authed = loop {
                    match read.next().await {
                        Some(Ok(Message::Text(t))) => {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                                match v.get("type").and_then(|x| x.as_str()) {
                                    Some("auth_ok") => {
                                        log::info!("[WS] 认证通过");
                                        break true;
                                    }
                                    Some("auth_failed") => {
                                        log::warn!("[WS] 认证失败：配对失效");
                                        break false;
                                    }
                                    _ => {} // 认证门期间忽略其他消息（服务器也不会发）
                                }
                            }
                        }
                        Some(Ok(Message::Close(frame))) => {
                            if frame.as_ref().map(|f| f.code.into()).unwrap_or(0u16) == 4401 {
                                log::warn!("[WS] 服务器关闭连接（4401）：配对失效");
                                break false;
                            }
                            log::warn!("[WS] 连接在认证前被关闭");
                            break false;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(e)) => {
                            log::warn!("[WS] 认证阶段读错误: {e}");
                            break false;
                        }
                        None => break false,
                    }
                };

                if !authed {
                    // 配对失效：不重连，退出任务；daemon 引导用户重新配对后另起新任务
                    let _ = event_tx
                        .send(WsEvent {
                            gen,
                            kind: WsEventKind::AuthFailed,
                        })
                        .await;
                    return;
                }

                if retry > MAX_RETRIES {
                    log::info!("[WS] 服务器恢复在线，退出心跳模式");
                }
                retry = 0;
                if event_tx
                    .send(WsEvent {
                        gen,
                        kind: WsEventKind::Connected,
                    })
                    .await
                    .is_err()
                {
                    return;
                }

                loop {
                    tokio::select! {
                        msg = read.next() => {
                            match msg {
                                Some(Ok(Message::Text(t))) => {
                                    if event_tx
                                        .send(WsEvent {
                                            gen,
                                            kind: WsEventKind::Text(t.to_string()),
                                        })
                                        .await
                                        .is_err()
                                    {
                                        return;
                                    }
                                }
                                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                                Some(Ok(Message::Close(_))) | None => break,
                                Some(Err(e)) => {
                                    log::warn!("[WS] 读错误: {e}");
                                    break;
                                }
                                _ => {}
                            }
                        }
                        out = out_rx.recv() => {
                            match out {
                                Some(text) => {
                                    if let Err(e) = write.send(Message::Text(text.into())).await {
                                        log::warn!("[WS] 写错误: {e}");
                                        break;
                                    }
                                }
                                None => return,
                            }
                        }
                    }
                }

                log::warn!("[WS] 连接断开");
                if event_tx
                    .send(WsEvent {
                        gen,
                        kind: WsEventKind::Disconnected,
                    })
                    .await
                    .is_err()
                {
                    return;
                }
            }
            Err(e) => {
                log::warn!("[WS] 连接失败: {e}");
            }
        }

        retry += 1;
        let delay = if retry <= MAX_RETRIES {
            RETRY_DELAY
        } else {
            HEARTBEAT_DELAY
        };
        log::info!("[WS] {}s 后重连（第 {retry} 次）", delay.as_secs());
        tokio::time::sleep(delay).await;
    }
}
