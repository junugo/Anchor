//! WebSocket 客户端：复刻旧版 ws-client.ts 的重连策略
//! 前 10 次 5s 退避，之后进入 60s 心跳模式；连接成功重置。

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
    Connected,
    Disconnected,
    Text(String),
}

/// WS 任务主循环。
/// - `out_rx`：待发送的 JSON 文本（core → ws）；所有 sender 被 drop 时任务退出
/// - `event_tx`：连接事件与服务器消息（ws → core）
pub async fn run(
    url: String,
    mut out_rx: mpsc::Receiver<String>,
    event_tx: mpsc::Sender<WsEvent>,
    gen: u32,
) {
    let mut retry: u32 = 0;
    loop {
        match tokio_tungstenite::connect_async(&url).await {
            Ok((stream, _)) => {
                log::info!("[WS] 已连接 {url}");
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

                let (mut write, mut read) = stream.split();
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
