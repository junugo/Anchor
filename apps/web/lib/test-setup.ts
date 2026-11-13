/**
 * 全局测试前置（node --test --import 注入，每个测试文件子进程加载前执行）。
 *
 * 1) 禁用两类 fire-and-forget 尾巴，杜绝「测试关库后异步活动碰 DB」被
 *    node:test 归因为异步错误：
 *    - 推断管线（ingest / handlers 的立即触发 → runPipelineGuarded）
 *    - AI 提醒（决策引擎/睡眠引擎 → triggerAiReminder）
 * 2) 预热重模块图：生产代码的广播/分类/触发大量用动态 import()，CI 冷导入
 *    可达数秒，远超测试里的单拍等待；静态引入后动态 import 立即命中缓存，
 *    广播/分类在微任务内送达（对生产无副作用，均为惰性模块）。
 */
import { disablePipelineForTest } from './inference/pipeline'
import { disableAiReminderForTest } from './ai/reminder'

import './ws/server'
import './inference/pipeline'
import './inference/triggers'
import './inference/ingest'
import './processes/classify'
import './sunset/config'
import './sites/work'
import './decision/engine'
import './sleep/engine'
import './circadian/wakeup'
import './ai/reminder'

disablePipelineForTest()
disableAiReminderForTest()
