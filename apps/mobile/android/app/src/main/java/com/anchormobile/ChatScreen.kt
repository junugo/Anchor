package com.anchormobile

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.lifecycle.viewmodel.compose.viewModel
import com.anchormobile.R
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ─── 入口 ───────────────────────────────────────────────────────────────────────────────────────────

@Composable
fun ChatScreen(
    modifier: Modifier = Modifier,
    vm: ChatViewModel = viewModel(),
) {
    val state by vm.state.collectAsState()

    val drawerWidth = 240.dp
    
    // 抽屉偏移量：关闭时在屏幕左侧外，打开时在 0 位置
    val drawerOffset: Dp by animateDpAsState(
        targetValue = if (state.drawerOpen) 0.dp else -drawerWidth,
        animationSpec = tween(durationMillis = 200, easing = FastOutSlowInEasing),
        label = "drawerOffset",
    )

    // 聊天区偏移量：抽屉打开时向右平移 drawerWidth
    val contentOffset: Dp by animateDpAsState(
        targetValue = if (state.drawerOpen) drawerWidth else 0.dp,
        animationSpec = tween(durationMillis = 200, easing = FastOutSlowInEasing),
        label = "contentOffset",
    )
    
    // 遮罩层透明度
    val scrimAlpha: Float by animateFloatAsState(
        targetValue = if (state.drawerOpen) 0.3f else 0f,
        animationSpec = tween(durationMillis = 200),
        label = "scrimAlpha",
    )

    Box(modifier = modifier.fillMaxSize()) {
        // 聊天主区域（固定宽度，通过 offset 平移）
        ChatContent(
            state = state,
            modifier = Modifier
                .fillMaxSize()
                .offset(x = contentOffset),
            onMenuClick = {
                if (state.drawerOpen) vm.closeDrawer() else vm.openDrawer()
            },
            onInputChange = { vm.setInput(it) },
            onSend = { vm.send() },
        )
        
        // 半透明遮罩（点击关闭抽屉）
        if (state.drawerOpen) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .offset(x = contentOffset)
                    .alpha(scrimAlpha)
                    .background(Color.Black)
                    .clickable(
                        indication = null,
                        interactionSource = remember { MutableInteractionSource() },
                        onClick = { vm.closeDrawer() }
                    )
                    .zIndex(1f)
            )
        }
        
        // 左侧抽屉（从屏幕外滑入，层级最高）
        SideDrawer(
            state = state,
            width = drawerWidth,
            offset = drawerOffset,
            onClose = { vm.closeDrawer() },
            onSelectSession = { vm.switchSession(it) },
            onNewSession = { vm.newSession() },
            onRenameSession = { id, title -> vm.renameSession(id, title) },
            onDeleteSession = { vm.deleteSession(it) },
            modifier = Modifier.zIndex(2f)
        )
    }
}

// ─── 左侧历史抽屉 ────────────────────────────────────────────────────────────────────────────────────

@Composable
private fun SideDrawer(
    state: ChatUiState,
    width: Dp,
    offset: Dp,
    onClose: () -> Unit,
    onSelectSession: (String) -> Unit,
    onNewSession: () -> Unit,
    onRenameSession: (String, String) -> Unit,
    onDeleteSession: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val accent = MaterialTheme.colorScheme.primary
    val surface = MaterialTheme.colorScheme.surface
    val outline = MaterialTheme.colorScheme.outline
    val textSecondary = MaterialTheme.colorScheme.secondary

    var renameTarget by remember { mutableStateOf<SessionSummary?>(null) }
    var deleteTarget by remember { mutableStateOf<SessionSummary?>(null) }
    var renameText by remember { mutableStateOf("") }

    Column(
        modifier = modifier
            .width(width)
            .offset(x = offset)
            .fillMaxHeight()
            .background(surface)
            .clip(RoundedCornerShape(topEnd = 0.dp, bottomEnd = 0.dp)),
    ) {
        // 抽屉顶栏
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                stringResource(R.string.chat_history_title),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
            )
            IconButton(onClick = onClose, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Default.Close, contentDescription = stringResource(R.string.common_close), tint = textSecondary, modifier = Modifier.size(18.dp))
            }
        }
        HorizontalDivider(color = outline, thickness = 0.5.dp)

        // 会话列表
        if (state.loadingSessions) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), color = accent, strokeWidth = 2.dp)
            }
        } else {
            LazyColumn(
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(vertical = 6.dp, horizontal = 6.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                items(state.sessions, key = { it.sessionId }) { session ->
                    val isActive = session.sessionId == state.sessionId
                    SessionRow(
                        session = session,
                        isActive = isActive,
                        accent = accent,
                        textSecondary = textSecondary,
                        outline = outline,
                        onClick = { onSelectSession(session.sessionId) },
                        onRename = {
                            renameText = session.title ?: session.preview ?: ""
                            renameTarget = session
                        },
                        onDelete = { deleteTarget = session },
                    )
                }
                if (state.sessions.isEmpty()) {
                    item {
                        Text(
                            stringResource(R.string.chat_no_history),
                            style = MaterialTheme.typography.bodySmall,
                            color = textSecondary,
                            modifier = Modifier.padding(16.dp),
                        )
                    }
                }
            }
        }

        HorizontalDivider(color = outline, thickness = 0.5.dp)

        // 底部新建会话按钮
        Button(
            onClick = onNewSession,
            modifier = Modifier
                .fillMaxWidth()
                .padding(10.dp)
                .height(38.dp),
            shape = RoundedCornerShape(8.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = accent,
                contentColor = Color.White,
            ),
            contentPadding = PaddingValues(horizontal = 12.dp),
        ) {
            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(6.dp))
            Text(stringResource(R.string.chat_new_session), fontSize = 13.sp)
        }
    }

    // 重命名对话框
    renameTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            title = { Text(stringResource(R.string.chat_rename_dialog_title)) },
            text = {
                OutlinedTextField(
                    value = renameText,
                    onValueChange = { renameText = it },
                    singleLine = true,
                    placeholder = { Text(stringResource(R.string.chat_rename_dialog_hint)) },
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        onRenameSession(target.sessionId, renameText)
                        renameTarget = null
                    },
                    enabled = renameText.isNotBlank(),
                ) { Text(stringResource(R.string.chat_rename_dialog_confirm)) }
            },
            dismissButton = {
                OutlinedButton(onClick = { renameTarget = null }) { Text(stringResource(R.string.common_cancel)) }
            },
        )
    }

    // 删除确认对话框
    deleteTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text(stringResource(R.string.chat_delete_dialog_title)) },
            text = { Text(stringResource(R.string.chat_delete_dialog_msg)) },
            confirmButton = {
                Button(
                    onClick = {
                        onDeleteSession(target.sessionId)
                        deleteTarget = null
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                ) { Text(stringResource(R.string.chat_session_delete)) }
            },
            dismissButton = {
                OutlinedButton(onClick = { deleteTarget = null }) { Text(stringResource(R.string.common_cancel)) }
            },
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(
    session: SessionSummary,
    isActive: Boolean,
    accent: Color,
    textSecondary: Color,
    outline: Color,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    val bg = if (isActive)
        MaterialTheme.colorScheme.primaryContainer
    else
        Color.Transparent
    val textColor = if (isActive) accent else MaterialTheme.colorScheme.onSurface
    var menuOpen by remember { mutableStateOf(false) }

    Box {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(6.dp))
                .background(bg)
                .combinedClickable(onClick = onClick, onLongClick = { menuOpen = true })
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = formatSessionTime(session.createdAt),
                style = MaterialTheme.typography.labelSmall,
                color = if (isActive) accent.copy(alpha = 0.7f) else textSecondary,
                fontSize = 10.sp,
            )
            Text(
                text = session.title ?: session.preview ?: stringResource(R.string.chat_empty_session),
                style = MaterialTheme.typography.bodySmall,
                color = textColor,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                lineHeight = 16.sp,
            )
        }

        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chat_session_rename)) },
                leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null, modifier = Modifier.size(16.dp)) },
                onClick = {
                    menuOpen = false
                    onRename()
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chat_session_delete), color = MaterialTheme.colorScheme.error) },
                leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.error) },
                onClick = {
                    menuOpen = false
                    onDelete()
                },
            )
        }
    }
}

// ─── 聊天主内容区 ────────────────────────────────────────────────────────────────────────────────────

@Composable
private fun ChatContent(
    state: ChatUiState,
    modifier: Modifier,
    onMenuClick: () -> Unit,
    onInputChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    val outline = MaterialTheme.colorScheme.outline
    val accent = MaterialTheme.colorScheme.primary
    val listState = rememberLazyListState()

    // 新消息到来 / 流式内容增长 / 键盘弹出导致视口变化时，滚到底部
    val msgCount = state.messages.size
    val lastMsgLen = state.messages.lastOrNull()?.content?.length ?: 0
    val density = androidx.compose.ui.platform.LocalDensity.current
    val imeBottom = WindowInsets.ime.getBottom(density)
    LaunchedEffect(msgCount, lastMsgLen, imeBottom) {
        if (msgCount > 0) {
            listState.scrollToItem(msgCount - 1)
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        // 顶栏
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .background(MaterialTheme.colorScheme.surface)
                .padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onMenuClick) {
                Icon(
                    Icons.Default.Menu,
                    contentDescription = stringResource(R.string.chat_history_title),
                    tint = if (state.drawerOpen) accent else MaterialTheme.colorScheme.secondary,
                    modifier = Modifier.size(20.dp),
                )
            }
            Text(
                stringResource(R.string.chat_tab_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
        HorizontalDivider(color = outline, thickness = 0.5.dp)

        // 消息列表（点击空白/气泡收起键盘，同微信）
        val focusManager = LocalFocusManager.current
        val keyboard = LocalSoftwareKeyboardController.current
        Box(
            modifier = Modifier
                .weight(1f)
                .pointerInput(Unit) {
                    detectTapGestures(onTap = {
                        keyboard?.hide()
                        focusManager.clearFocus()
                    })
                }
        ) {
            when {
                state.loading -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(24.dp),
                            color = accent,
                            strokeWidth = 2.dp,
                        )
                    }
                }
                state.error != null && state.messages.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(
                            state.error,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.secondary,
                        )
                    }
                }
                state.messages.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(
                            stringResource(R.string.chat_empty_hint),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.secondary,
                        )
                    }
                }
                else -> {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        items(state.messages, key = { "${it.role}_${it.createdAt}_${it.content.take(20)}" }) { msg ->
                            val isLastStreaming = state.streaming &&
                                msg == state.messages.lastOrNull() &&
                                msg.role == "assistant"

                            MessageBubble(
                                message = msg,
                                isStreaming = isLastStreaming,
                                accent = accent,
                            )
                        }
                    }
                }
            }
        }

        HorizontalDivider(color = outline, thickness = 0.5.dp)

        // 输入栏
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surface)
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .imePadding(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val inputEnabled = !state.streaming && !state.loading && state.sessionId != null
            OutlinedTextField(
                value = state.input,
                onValueChange = onInputChange,
                modifier = Modifier.weight(1f),
                placeholder = {
                    Text(
                        if (state.loading) stringResource(R.string.chat_loading) else stringResource(R.string.chat_placeholder),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                },
                enabled = inputEnabled,
                maxLines = 4,
                shape = RoundedCornerShape(10.dp),
                textStyle = MaterialTheme.typography.bodySmall.copy(
                    color = MaterialTheme.colorScheme.onSurface,
                    lineHeight = 18.sp,
                ),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = accent,
                    unfocusedBorderColor = MaterialTheme.colorScheme.outline,
                    disabledBorderColor = MaterialTheme.colorScheme.outlineVariant,
                    focusedContainerColor = MaterialTheme.colorScheme.surface,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surface,
                    disabledContainerColor = MaterialTheme.colorScheme.surface,
                ),
            )
            Surface(
                onClick = onSend,
                enabled = state.input.isNotBlank() && inputEnabled,
                modifier = Modifier.size(40.dp),
                shape = RoundedCornerShape(10.dp),
                color = if (state.input.isNotBlank() && inputEnabled) accent
                else MaterialTheme.colorScheme.outlineVariant,
                contentColor = Color.White,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Default.Send,
                        contentDescription = stringResource(R.string.common_send),
                        modifier = Modifier.size(17.dp),
                    )
                }
            }
        }
    }
}

// ─── 消息气泡 ────────────────────────────────────────────────────────────────────────────────────────

@Composable
private fun MessageBubble(
    message: ChatMessage,
    isStreaming: Boolean,
    accent: Color,
) {
    val isUser = message.role == "user"
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Box(
            modifier = Modifier
                .widthIn(max = 280.dp)
                .clip(
                    if (isUser) RoundedCornerShape(14.dp, 14.dp, 4.dp, 14.dp)
                    else RoundedCornerShape(14.dp, 14.dp, 14.dp, 4.dp)
                )
                .background(
                    if (isUser) MaterialTheme.colorScheme.primaryContainer
                    else MaterialTheme.colorScheme.surface
                )
                .then(
                    if (!isUser) Modifier.padding(1.dp).clip(
                        RoundedCornerShape(14.dp, 14.dp, 14.dp, 4.dp)
                    )
                    else Modifier
                )
                .padding(horizontal = 13.dp, vertical = 9.dp),
        ) {
            val displayText = if (isStreaming && message.content.isEmpty()) "▌" else message.content
            Text(
                text = if (isStreaming && message.content.isNotEmpty())
                    message.content + "▌"
                else
                    displayText,
                style = MaterialTheme.typography.bodySmall,
                color = if (isUser) accent else MaterialTheme.colorScheme.onSurface,
                lineHeight = 20.sp,
            )
        }
    }
}

// ─── 时间格式化 ──────────────────────────────────────────────────────────────────────────────────────

@Composable
private fun formatSessionTime(unixSec: Long): String {
    if (unixSec <= 0L) return ""
    val ms = unixSec * 1000
    val now = System.currentTimeMillis()
    val diffMs = now - ms
    val diffDays = (diffMs / 86_400_000).toInt()
    return when {
        diffDays == 0 -> SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ms))
        diffDays == 1 -> stringResource(R.string.time_yesterday)
        diffDays < 7  -> stringResource(R.string.time_days_ago, diffDays)
        else          -> SimpleDateFormat("M/d", Locale.getDefault()).format(Date(ms))
    }
}
