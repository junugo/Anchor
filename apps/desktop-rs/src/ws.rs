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
/// 认证门超时：连接建立后服务器须在此时限内回复 auth_ok / auth_failed，
/// 否则视为僵死连接，按普通断线重连（防服务器收 auth 后不响应挂死客户端）
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);

/// 认证阶段结果
enum AuthPhase {
    /// auth_ok：进入正常收发
    Ok,
    /// auth_failed / close 4401：配对失效，不重连
    Failed,
    /// 普通 close / 读错误 / EOF / 认证超时：瞬时断线，走既有重连退避
    Retry,
}

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
    out_rx: mpsc::Receiver<String>,
    event_tx: mpsc::Sender<WsEvent>,
    gen: u32,
) {
    run_with(url, token, out_rx, event_tx, gen, AUTH_TIMEOUT, RETRY_DELAY).await
}

#[allow(clippy::too_many_arguments)]
async fn run_with(
    url: String,
    token: Option<String>,
    mut out_rx: mpsc::Receiver<String>,
    event_tx: mpsc::Sender<WsEvent>,
    gen: u32,
    auth_timeout: Duration,
    retry_delay: Duration,
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
                    tokio::time::sleep(retry_delay).await;
                    continue;
                }

                // 认证阶段：等待 auth_ok / auth_failed / close 4401（带超时防僵死）。
                // 注意：只有 auth_failed 消息与 close 4401 才算「配对失效」；
                // 普通 close / 读错误 / EOF / 超时均为瞬时断线，走既有重连路径。
                let auth_phase = loop {
                    match tokio::time::timeout(auth_timeout, read.next()).await {
                        Err(_) => {
                            log::warn!("[WS] 认证超时（{}s 未收到回复），按断线重连", auth_timeout.as_secs());
                            break AuthPhase::Retry;
                        }
                        Ok(Some(Ok(Message::Text(t)))) => {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                                match v.get("type").and_then(|x| x.as_str()) {
                                    Some("auth_ok") => {
                                        log::info!("[WS] 认证通过");
                                        break AuthPhase::Ok;
                                    }
                                    Some("auth_failed") => {
                                        log::warn!("[WS] 认证失败：配对失效");
                                        break AuthPhase::Failed;
                                    }
                                    _ => {} // 认证门期间忽略其他消息（服务器也不会发）
                                }
                            }
                        }
                        Ok(Some(Ok(Message::Close(frame)))) => {
                            if frame.as_ref().map(|f| f.code.into()).unwrap_or(0u16) == 4401 {
                                log::warn!("[WS] 服务器关闭连接（4401）：配对失效");
                                break AuthPhase::Failed;
                            }
                            log::warn!("[WS] 连接在认证前被普通关闭（code={:?}），按断线重连",
                                frame.as_ref().map(|f| u16::from(f.code)));
                            break AuthPhase::Retry;
                        }
                        Ok(Some(Ok(_))) => {}
                        Ok(Some(Err(e))) => {
                            log::warn!("[WS] 认证阶段读错误，按断线重连: {e}");
                            break AuthPhase::Retry;
                        }
                        Ok(None) => {
                            log::warn!("[WS] 认证阶段连接被对端挂断（EOF），按断线重连");
                            break AuthPhase::Retry;
                        }
                    }
                };

                match auth_phase {
                    AuthPhase::Failed => {
                        // 配对失效：不重连，退出任务；daemon 引导用户重新配对后另起新任务
                        let _ = event_tx
                            .send(WsEvent {
                                gen,
                                kind: WsEventKind::AuthFailed,
                            })
                            .await;
                        return;
                    }
                    AuthPhase::Retry => {
                        // 瞬时断线：不发事件（会话从未建立，connected 状态未变），落到下方退避重连
                    }
                    AuthPhase::Ok => {
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
                }
            }
            Err(e) => {
                log::warn!("[WS] 连接失败: {e}");
            }
        }

        retry += 1;
        let delay = if retry <= MAX_RETRIES {
            retry_delay
        } else {
            HEARTBEAT_DELAY
        };
        log::info!("[WS] {}s 后重连（第 {retry} 次）", delay.as_secs());
        tokio::time::sleep(delay).await;
    }
}




#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;

    #[derive(Debug, PartialEq, Eq)]
    enum Ev {
        Connected,
        Disconnected,
        AuthFailed,
        Text,
    }

    type WsStream = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    /// 简单 mock WS 服务器：每连接读掉 auth 消息后执行自定义行为
    struct MockServer {
        url: String,
        connects: Arc<AtomicUsize>,
        reconnect_seen: Arc<tokio::sync::Notify>,
    }

    fn start_mock<F>(on_conn: F) -> MockServer
    where
        F: Fn(WsStream, usize) -> futures_util::future::BoxFuture<'static, ()> + Send + Sync + 'static,
    {
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = std_listener.local_addr().unwrap();
        std_listener.set_nonblocking(true).unwrap();
        let listener = TcpListener::from_std(std_listener).unwrap();
        let url = format!("ws://{addr}");
        let connects = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&connects);
        let reconnect_seen = Arc::new(tokio::sync::Notify::new());
        let notify = Arc::clone(&reconnect_seen);
        let on_conn = Arc::new(on_conn);
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { break };
                let count = Arc::clone(&count);
                let notify = Arc::clone(&notify);
                let on_conn = Arc::clone(&on_conn);
                tokio::spawn(async move {
                    let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                    let n = count.fetch_add(1, Ordering::SeqCst) + 1;
                    if n >= 2 {
                        notify.notify_one();
                    }
                    // 读掉 auth 消息
                    let _ = ws.next().await;
                    on_conn(ws, n).await;
                });
            }
        });
        MockServer { url, connects, reconnect_seen }
    }

    /// 客户端起动辅助：短认证超时/短退避
    fn start_client(url: String) -> (tokio::task::JoinHandle<()>, mpsc::Receiver<WsEvent>, mpsc::Sender<String>) {
        let (out_tx, out_rx) = mpsc::channel::<String>(16);
        let (ev_tx, ev_rx) = mpsc::channel::<WsEvent>(16);
        let handle = tokio::spawn(run_with(
            url,
            Some("test-token".to_owned()),
            out_rx,
            ev_tx,
            0,
            Duration::from_millis(300),
            Duration::from_millis(50),
        ));
        (handle, ev_rx, out_tx)
    }

    async fn next_event(rx: &mut mpsc::Receiver<WsEvent>) -> Ev {
        let ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("等待事件超时")
            .expect("事件通道已关闭");
        assert_eq!(ev.gen, 0);
        match ev.kind {
            WsEventKind::Connected => Ev::Connected,
            WsEventKind::Disconnected => Ev::Disconnected,
            WsEventKind::AuthFailed => Ev::AuthFailed,
            WsEventKind::Text(_) => Ev::Text,
        }
    }

    /// 断言：给定时长内不产生任何 WS 事件（误判 AuthFailed 会被抓住）
    async fn assert_no_event(rx: &mut mpsc::Receiver<WsEvent>, window: Duration, what: &str) {
        let outcome = tokio::time::timeout(window, rx.recv()).await;
        assert!(outcome.is_err(), "{what}不应产生任何 WS 事件（实际收到 {:?}）", outcome);
    }

    /// auth_failed 消息 → AuthFailed 事件且任务退出（不重连）
    #[tokio::test]
    async fn auth_failed_message_maps_to_auth_failed() {
        let server = start_mock(|mut ws, _| {
            Box::pin(async move {
                use futures_util::SinkExt;
                // 复刻服务器帧序：先发 auth_failed 文本，再 close 4401
                ws.send(Message::Text(r#"{"type":"auth_failed"}"#.into()))
                    .await
                    .unwrap();
                ws.close(Some(CloseFrame {
                    code: 4401u16.into(),
                    reason: "unauthorized".into(),
                }))
                .await
                .ok();
            })
        });
        let (handle, mut ev_rx, _out) = start_client(server.url.clone());
        assert_eq!(next_event(&mut ev_rx).await, Ev::AuthFailed);
        // 任务应退出：join 在 2s 内完成
        tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .expect("AuthFailed 后任务未退出")
            .unwrap();
        assert_eq!(server.connects.load(Ordering::SeqCst), 1, "AuthFailed 不应重连");
    }

    /// close 4401（无 auth_failed 文本）同样映射 AuthFailed
    #[tokio::test]
    async fn close_4401_maps_to_auth_failed() {
        let server = start_mock(|mut ws, _| {
            Box::pin(async move {
                ws.close(Some(CloseFrame {
                    code: 4401u16.into(),
                    reason: "unauthorized".into(),
                }))
                .await
                .ok();
            })
        });
        let (handle, mut ev_rx, _out) = start_client(server.url.clone());
        assert_eq!(next_event(&mut ev_rx).await, Ev::AuthFailed);
        tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .expect("AuthFailed 后任务未退出")
            .unwrap();
        assert_eq!(server.connects.load(Ordering::SeqCst), 1, "close 4401 不应重连");
    }

    /// 普通 close（1000）→ 不产生 AuthFailed，客户端按退避重连
    #[tokio::test]
    async fn normal_close_during_auth_retries_instead_of_auth_failed() {
        let server = start_mock(|mut ws, _| {
            Box::pin(async move {
                ws.close(Some(CloseFrame {
                    code: 1000u16.into(),
                    reason: "restart".into(),
                }))
                .await
                .ok();
            })
        });
        let (handle, mut ev_rx, _out) = start_client(server.url.clone());
        assert_no_event(&mut ev_rx, Duration::from_millis(500), "普通 close").await;
        // 且必须发生第二次连接（重连路径）
        tokio::time::timeout(Duration::from_secs(2), server.reconnect_seen.notified())
            .await
            .expect("普通 close 后未重连");
        handle.abort();
    }

    /// 认证超时（服务器收 auth 不响应）→ 不产生 AuthFailed，按退避重连
    #[tokio::test]
    async fn auth_timeout_retries_instead_of_auth_failed() {
        let server = start_mock(|ws, _| {
            Box::pin(async move {
                // 挂起保持连接存活，但永不回复（模拟服务器收 auth 不响应）
                let _hold = ws;
                std::future::pending::<()>().await;
            })
        });
        let (handle, mut ev_rx, _out) = start_client(server.url.clone());
        assert_no_event(&mut ev_rx, Duration::from_millis(500), "认证超时").await;
        // 认证超时 300ms + 退避 50ms 后应发生第二次连接
        tokio::time::timeout(Duration::from_secs(3), server.reconnect_seen.notified())
            .await
            .expect("认证超时后未重连");
        handle.abort();
    }
}
