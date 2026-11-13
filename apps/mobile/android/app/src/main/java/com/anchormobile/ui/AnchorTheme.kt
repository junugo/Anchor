package com.anchormobile.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// ─── 设计令牌色值 ─────────────────────────────────────────────────────────────

private val BgLight          = Color(0xFFF5F0EB)
private val SurfaceLight     = Color(0xFFFFFFFF)
private val SurfaceRaisedL   = Color(0xFFFAF7F4)
private val OutlineLight     = Color(0xFFE0D9D0)
private val OutlineSubtleL   = Color(0xFFEDE8E2)
private val TextPrimaryL     = Color(0xFF1A1410)
private val TextSecondaryL   = Color(0xFF6B6560)
private val TextDisabledL    = Color(0xFFB0A89E)
private val AccentL          = Color(0xFFC0622A)
private val AccentHoverL     = Color(0xFFA8531F)
private val AccentMutedL     = Color(0xFFF0E4DA)

private val BgDark           = Color(0xFF1C1814)
private val SurfaceDark      = Color(0xFF252018)
private val SurfaceRaisedD   = Color(0xFF2E2820)
private val OutlineDark      = Color(0xFF3A3228)
private val OutlineSubtleD   = Color(0xFF302820)
private val TextPrimaryD     = Color(0xFFF0EBE4)
private val TextSecondaryD   = Color(0xFF9E978E)
private val TextDisabledD    = Color(0xFF5A5550)
private val AccentD          = Color(0xFFC0622A)
private val AccentHoverD     = Color(0xFFD4703A)
private val AccentMutedD     = Color(0xFF3A2218)

// ─── Material3 色槽映射 ────────────────────────────────────────────────────────

private val LightColors = lightColorScheme(
    primary          = AccentL,
    onPrimary        = Color.White,
    primaryContainer = AccentMutedL,
    onPrimaryContainer = AccentHoverL,
    secondary        = TextSecondaryL,
    onSecondary      = Color.White,
    secondaryContainer = SurfaceRaisedL,
    onSecondaryContainer = TextPrimaryL,
    background       = BgLight,
    onBackground     = TextPrimaryL,
    surface          = SurfaceLight,
    onSurface        = TextPrimaryL,
    surfaceVariant   = SurfaceRaisedL,
    onSurfaceVariant = TextSecondaryL,
    outline          = OutlineLight,
    outlineVariant   = OutlineSubtleL,
    error            = Color(0xFFCF222E),
    onError          = Color.White,
)

private val DarkColors = darkColorScheme(
    primary          = AccentD,
    onPrimary        = Color.White,
    primaryContainer = AccentMutedD,
    onPrimaryContainer = AccentHoverD,
    secondary        = TextSecondaryD,
    onSecondary      = Color.White,
    secondaryContainer = SurfaceRaisedD,
    onSecondaryContainer = TextPrimaryD,
    background       = BgDark,
    onBackground     = TextPrimaryD,
    surface          = SurfaceDark,
    onSurface        = TextPrimaryD,
    surfaceVariant   = SurfaceRaisedD,
    onSurfaceVariant = TextSecondaryD,
    outline          = OutlineDark,
    outlineVariant   = OutlineSubtleD,
    error            = Color(0xFFFF7B72),
    onError          = Color.White,
)

// ─── 干预语义色 ───────────────────────────────────────────────────────────────
// 色值唯一真源：packages/ui/src/tokens/index.ts（手动同步，勿改）；
// 状态→token 映射见 packages/utils/src/state.ts `STATE_COLOR_TOKENS`（working=passive、
// resting=soft、entertaining=hard、dissociating=curfew、sleeping=sleep、transitioning=无→textDisabled）

object InterventionColor {
    /** 被动感知：状态符合预期，系统沉默 */
    val Passive = Color(0xFF22863A)
    /** 轻干预：轻微偏离，柔和提醒 */
    val Light   = Color(0xFFB08800)
    /** 强干预：明显偏离，积极干预 */
    val Strong  = Color(0xFFC0622A)
    /** 硬宵禁：宵禁时间，强制执行 */
    val Curfew  = Color(0xFFCF222E)
    /** 睡眠中：静默安睡 */
    val Sleep   = Color(0xFF1E3A8A)
    /** 在校：日程决定的预期空白，无语义干预 */
    val Away    = Color(0xFF6E7681)

    // 深色模式变体（设计规范 §2.3）
    private val PassiveDark = Color(0xFF3FB950)
    private val LightDark   = Color(0xFFE3B341)
    private val StrongDark  = Color(0xFFD4703A)
    private val CurfewDark  = Color(0xFFFF7B72)
    private val SleepDark   = Color(0xFF60A5FA)
    private val AwayDark    = Color(0xFF8B949E)

    /** 随深浅色模式切换的干预色 */
    val passive: Color @Composable get() = if (isSystemInDarkTheme()) PassiveDark else Passive
    val light: Color   @Composable get() = if (isSystemInDarkTheme()) LightDark else Light
    val strong: Color  @Composable get() = if (isSystemInDarkTheme()) StrongDark else Strong
    val curfew: Color  @Composable get() = if (isSystemInDarkTheme()) CurfewDark else Curfew
    val sleep: Color   @Composable get() = if (isSystemInDarkTheme()) SleepDark else Sleep
    val away: Color    @Composable get() = if (isSystemInDarkTheme()) AwayDark else Away

    private val textDisabled: Color @Composable get() = if (isSystemInDarkTheme()) TextDisabledD else TextDisabledL

    /** 根据 userState 字符串返回对应颜色 */
    @Composable
    fun forState(state: String?): Color = when (state) {
        "working"      -> passive
        "resting"      -> light
        "entertaining" -> strong
        "dissociating" -> curfew
        "sleeping"     -> sleep
        "away"         -> away
        else           -> textDisabled // 未知状态
    }

    /** 根据 interventionLevel 字符串返回对应颜色 */
    @Composable
    fun forLevel(level: String?): Color = when (level) {
        "passive"  -> passive
        "light"    -> light
        "strong"   -> strong
        "curfew"   -> curfew
        else       -> strong // 默认强干预
    }
}

// ─── 主题入口 ─────────────────────────────────────────────────────────────────

@Composable
fun AnchorTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}
