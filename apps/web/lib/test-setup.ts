/**
 * 全局测试前置（node --test --import 注入，每个测试文件子进程加载前执行）。
 *
 * 禁用推断管线：ingest / handlers 的立即触发是 fire-and-forget 动态导入，
 * 管线 + 决策引擎链条多分支异步，测试无法在关库前确定性排空；
 * 尾巴落在已关闭的测试库上会被 node:test 归因为「测试结束后仍在活动的异步错误」。
 */
import { disablePipelineForTest } from './inference/pipeline'

disablePipelineForTest()
