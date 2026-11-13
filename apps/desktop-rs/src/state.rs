//! 服务器消息状态机：对齐旧版 index.ts handleServerMessage
//! 并补齐旧版缺口：capsule:play 播放、intervention_result 回执

use crate::shared::{PendingNotification, PromptDialogState, SharedState, SunsetPhase};

/// 是否应对干预动作回执 executed：desktop 只对自己负责执行的动作（desktop:* 前缀）
/// 回执；chrome:/android: 等前缀由浏览器/手机端执行并回执，desktop 未执行就不该确认，
/// 否则会被服务器视为已执行，污染干预接受率统计。未知/空前缀按非 desktop 处理。
fn should_ack(action: &str) -> bool {
    action.starts_with("desktop:")
}

/// 处理一条服务器消息，更新共享状态；返回需要回发给服务器的客户端消息
pub fn handle_server_message(text: &str, shared: &mut SharedState) -> Vec<serde_json::Value> {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match ty {
        "sunset:config" => {
            if let Some(t) = v
                .pointer("/config/target_bedtime_minutes")
                .and_then(|x| x.as_i64())
            {
                shared.target_bedtime_minutes = t;
            }
        }

        "sunset:phase" | "sunset:stage" => {
            let phase_str = if ty == "sunset:stage" {
                v.get("stage").and_then(|p| p.as_str()).unwrap_or("off")
            } else {
                v.get("phase").and_then(|p| p.as_str()).unwrap_or("off")
            };
            if let Some(t) = v
                .get("target_bedtime_minutes")
                .and_then(|x| x.as_i64())
            {
                shared.target_bedtime_minutes = t;
            }
            let phase = SunsetPhase::parse(phase_str);
            if phase != shared.sunset_phase {
                log::info!("[state] 宵禁阶段: {:?} → {:?}", shared.sunset_phase, phase);
            }
            shared.sunset_phase = phase;
            // expires_at 断线兜底：服务器未下发时按阶段边界估算（对齐 Android 端语义）
            shared.sunset_expires_at = if phase == SunsetPhase::Off {
                0
            } else {
                v.get("expires_at").and_then(|x| x.as_i64()).unwrap_or_else(|| {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    if phase == SunsetPhase::T0 {
                        now + 8 * 60 * 60
                    } else {
                        let minutes = match phase {
                            SunsetPhase::T60 => 60,
                            SunsetPhase::T30 => 30,
                            _ => 15,
                        };
                        now + minutes * 60
                    }
                })
            };
        }

        "intervention" => {
            let level = v.get("level").and_then(|l| l.as_str()).unwrap_or("");
            let message = v
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_owned();

            // notify 级静默忽略（对齐旧版）
            if level != "notify" && !message.is_empty() {
                if level == "hard" || level == "strong" {
                    shared.pending_notifications.push(PendingNotification {
                        title: "Anchor".to_owned(),
                        body: message.clone(),
                        silent: false,
                    });
                }

                // 回执 intervention_result（旧版缺失，干预接受率统计依赖）
                if let Some(id) = v.get("intervention_id").and_then(|i| i.as_str()) {
                    let action = v
                        .get("action")
                        .and_then(|a| a.as_str())
                        .map(|s| serde_json::Value::String(s.to_owned()))
                        .unwrap_or(serde_json::Value::Null);
                    // 仅 desktop:* 动作回执 executed；chrome:/android:/其他前缀由浏览器/手机端
                    // 执行并各自回执，desktop 未执行就不该确认，否则向服务器谎报成功
                    if !action.as_str().map(should_ack).unwrap_or(false) {
                        return Vec::new();
                    }
                    return vec![serde_json::json!({
                        "type": "intervention_result",
                        "source": "desktop",
                        "intervention_id": id,
                        "action": action,
                        "result": "executed",
                        "dismissed_by_user": false,
                    })];
                }
            }
        }

        "notify:ai" => {
            let message = v.get("message").and_then(|m| m.as_str()).unwrap_or("");
            if !message.is_empty() {
                shared.last_ai_message = Some(message.to_owned());
                shared.pending_notifications.push(PendingNotification {
                    title: "Anchor AI".to_owned(),
                    body: message.to_owned(),
                    silent: false,
                });
            }
        }

        "time:anchor" => {
            let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
            if !text.is_empty() {
                shared.pending_notifications.push(PendingNotification {
                    title: "Anchor".to_owned(),
                    body: text.to_owned(),
                    silent: true,
                });
            }
        }

        // 睡前意图采集：弹窗 60s 自动关闭（auto_skip 上报），可稍后从托盘重开
        "intent:capture" => {
            let prompt_id = v.get("prompt_id").and_then(|x| x.as_str()).unwrap_or("");
            let prompt = v
                .get("prompt")
                .and_then(|x| x.as_str())
                .unwrap_or("明天最重要的一件事是什么？")
                .to_owned();
            let timeout = v.get("timeoutSeconds").and_then(|x| x.as_i64()).unwrap_or(60);
            if !prompt_id.is_empty() {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                log::info!("[state] 睡前意图弹窗: {prompt_id}");
                shared.intent_input_sent = false;
                shared.intent_capture = Some(PromptDialogState {
                    prompt_id: prompt_id.to_owned(),
                    text: prompt.clone(),
                    deadline: now + timeout,
                });
                shared.intent_reopen = Some(prompt);
                shared.pending_notifications.push(PendingNotification {
                    title: "Anchor 睡前意图".to_owned(),
                    body: "记录明天最重要的一件事（点击可重开弹窗）".to_owned(),
                    silent: false,
                });
            }
        }

        // 意图接管：其他端开始输入。本端未输入则关闭弹窗（重开入口保留，可反复重开编辑）；
        // 本端已上报 input（正在输入）则忽略自身广播，保留状态等待手动提交/跳过
        "intent:typing" => {
            let prompt_id = v.get("prompt_id").and_then(|x| x.as_str()).unwrap_or("");
            if shared.intent_input_sent {
                log::info!("[state] intent typing（本端输入中，忽略）: {prompt_id}");
            } else if matches!(&shared.intent_capture, Some(p) if p.prompt_id == prompt_id) {
                log::info!("[state] 意图弹窗被其他端接管，本端关闭: {prompt_id}");
                shared.intent_capture = None;
            }
        }

        // 意图 dismiss：answered 清除重开入口；skipped/expired 仅关弹窗，保留重开
        "intent:dismiss" => {
            let reason = v.get("reason").and_then(|x| x.as_str()).unwrap_or("");
            if shared.intent_capture.is_some() {
                log::info!("[state] 睡前意图弹窗关闭（reason={reason}）");
            }
            shared.intent_capture = None;
            if reason == "answered" {
                shared.intent_reopen = None;
            }
        }

        // 晨起确认：展示昨日意图（非静默，不再一闪而过）
        "intent:confirm" => {
            let date = v.get("date").and_then(|x| x.as_str()).unwrap_or("");
            let content = v.get("content").and_then(|x| x.as_str()).unwrap_or("");
            if !content.is_empty() {
                shared.pending_notifications.push(PendingNotification {
                    title: "Anchor 昨日意图".to_owned(),
                    body: format!("你在 {date} 记录的意图：{content}"),
                    silent: false,
                });
            }
        }

        "state:update" => {
            if let Some(s) = v.get("state").and_then(|s| s.as_str()) {
                shared.user_state = Some(s.to_owned());
            }
        }

        "ping" => {}

        "error" => {
            let code = v.get("code").and_then(|c| c.as_str()).unwrap_or("");
            let message = v.get("message").and_then(|m| m.as_str()).unwrap_or("");
            if code == "DECRYPT_FAILED" {
                log::warn!("[state] 密钥错误: {message}");
                shared.config_error = Some(message.to_owned());
                shared.connected = false;
                shared.pending_notifications.push(PendingNotification {
                    title: "Anchor 配置错误".to_owned(),
                    body: message.to_owned(),
                    silent: false,
                });
            }
        }

        "sleep:confirm-request" => {
            let until = v.get("confirm_until").and_then(|x| x.as_i64()).unwrap_or(0);
            log::info!("[state] 入睡确认请求，截止 {until}");
            shared.sleep_confirm_until = Some(until);
        }

        "sleep:confirm-cancel" => {
            log::info!("[state] 入睡确认取消");
            shared.sleep_confirm_until = None;
        }

        "context_switch:prompt" => {
            let prompt_id = v.get("prompt_id").and_then(|x| x.as_str()).unwrap_or("");
            let timeout = v.get("timeoutSeconds").and_then(|x| x.as_i64()).unwrap_or(15);
            let placeholder = v
                .get("placeholder")
                .and_then(|x| x.as_str())
                .unwrap_or("上一件事停在哪里？")
                .to_owned();
            if !prompt_id.is_empty() {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                log::info!("[state] 状态切换弹窗: {prompt_id}");
                shared.context_switch_input_sent = false;
                shared.context_switch = Some(PromptDialogState {
                    prompt_id: prompt_id.to_owned(),
                    text: placeholder,
                    deadline: now + timeout,
                });
            }
        }

        // 状态切换接管：其他端开始输入。本端未输入则关闭弹窗；本端输入中则忽略自身广播
        "context_switch:typing" => {
            let prompt_id = v.get("prompt_id").and_then(|x| x.as_str()).unwrap_or("");
            if shared.context_switch_input_sent {
                log::info!("[state] context_switch typing（本端输入中，忽略）: {prompt_id}");
            } else if matches!(&shared.context_switch, Some(p) if p.prompt_id == prompt_id) {
                log::info!("[state] 状态切换弹窗被其他端接管，本端关闭: {prompt_id}");
                shared.context_switch = None;
            }
        }

        "context_switch:dismiss" => {
            let prompt_id = v.get("prompt_id").and_then(|x| x.as_str()).unwrap_or("");
            if matches!(&shared.context_switch, Some(p) if p.prompt_id == prompt_id) {
                log::info!("[state] 状态切换弹窗关闭（其他端已响应）: {prompt_id}");
                shared.context_switch = None;
            }
        }

        _ => {
            log::debug!("[state] 未处理的消息类型: {ty}");
        }
    }

    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intervention_msg(action: &str, level: &str) -> String {
        serde_json::json!({
            "type": "intervention",
            "level": level,
            "message": "测试干预",
            "intervention_id": "i-1",
            "action": action,
        })
        .to_string()
    }

    #[test]
    fn should_ack_only_desktop_actions() {
        assert!(should_ack("desktop:toast_notify"));
        assert!(!should_ack("chrome:hard_block"));
        assert!(!should_ack("android:fullscreen_block"));
        assert!(!should_ack("notify:bedtime"));
        assert!(!should_ack("unknown:xxx"));
        assert!(!should_ack(""));
    }

    #[test]
    fn desktop_action_receives_executed_ack() {
        let out = handle_server_message(
            &intervention_msg("desktop:force_lock", "hard"),
            &mut SharedState::new(),
        );
        assert_eq!(out.len(), 1);
        let v = &out[0];
        assert_eq!(v["type"], "intervention_result");
        assert_eq!(v["source"], "desktop");
        assert_eq!(v["intervention_id"], "i-1");
        assert_eq!(v["action"], "desktop:force_lock");
        assert_eq!(v["result"], "executed");
        assert_eq!(v["dismissed_by_user"], false);
    }

    #[test]
    fn foreign_actions_are_not_acked() {
        for action in [
            "chrome:hard_block",
            "android:fullscreen_block",
            "notify:bedtime",
            "web:open",
            "",
        ] {
            let out = handle_server_message(
                &intervention_msg(action, "hard"),
                &mut SharedState::new(),
            );
            assert!(out.is_empty(), "action {action:?} 不应回执 executed");
        }
    }

    #[test]
    fn notify_level_never_acks() {
        // notify 级静默忽略是既有行为：不弹窗、不回执
        let out = handle_server_message(
            &intervention_msg("desktop:toast_notify", "notify"),
            &mut SharedState::new(),
        );
        assert!(out.is_empty());
    }
}
