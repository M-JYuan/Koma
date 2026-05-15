/**
 * media:tti / media:itv / media:tts —— 主进程主导的媒体轮询 handler
 *
 * 设计：
 *  - 主进程持有 polling loop，所以"切窗口/切项目"都不再丢轮询
 *  - 通过 delegateToRenderer 让 renderer 的 provider 代码原地工作（无需迁移 11k 行 provider）
 *  - 委托两件事到 renderer：
 *      'media:snapshot' → 调原 TaskHandler.getSnapshot 拿快照
 *      'media:persist'  → 下载 + 写资产 + bindOwnerRefMedia（fs/ProjectDB 仍由 renderer 触发，
 *                          但走 ipc 到 main 的 fs/projectService —— 这块短路一步是 Phase 5 的工作）
 *
 * 任务恢复：handler 标 recoverable=true；含 remoteTaskId 的任务在 boot 时由
 * TaskService.reconcileOnBoot + TaskRunner.resumeFromBoot 重新入队。
 */
import { taskRunner } from '../TaskRunner';
import { delegateToRenderer } from '../delegate';

interface MediaPollInput {
  kind: 'image' | 'video' | 'audio';
  remoteTaskId: string;
  /** 业务对应的 task type（'tti'|'itv'|'tts'）；renderer 端按此查 taskHandlerRegistry */
  rendererHandlerType: string;
  channelId?: string;
  modelId?: string;
  capability?: string;
  /** 用户选定的渠道/模型 selection key */
  selection?: string;
  ownerRef?: unknown;
  projectId: string;
  /** 业务自定义额外字段，原样回传给 persist */
  extra?: Record<string, unknown>;
}

interface SnapshotResult {
  state: 'pending' | 'processing' | 'succeeded' | 'failed';
  progress?: number;
  output?: unknown;
  error?: string;
}

interface PersistResult {
  asset: unknown;
}

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MS = 30 * 60 * 1_000;
const PERSIST_TIMEOUT_MS = 15 * 60 * 1_000;

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('aborted');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function makePollHandler(taskType: 'tti' | 'itv' | 'tts'): Parameters<typeof taskRunner.registerHandler>[0] {
  return {
    type: taskType,
    concurrency: taskType === 'tti' ? 6 : taskType === 'itv' ? 4 : 8,
    recoverable: true,
    async run(ctx) {
      const input = ctx.input as MediaPollInput;
      const { signal, onProgress, patch } = ctx;

      patch({ remoteTaskId: input.remoteTaskId });

      const start = Date.now();
      while (Date.now() - start < MAX_POLL_MS) {
        if (signal.aborted) throw new Error('aborted');

        const snapshot = await delegateToRenderer<SnapshotResult>({
          type: 'media:snapshot',
          args: {
            rendererHandlerType: input.rendererHandlerType,
            remoteTaskId: input.remoteTaskId,
            channelId: input.channelId,
            modelId: input.modelId,
            capability: input.capability,
            selection: input.selection,
          },
          signal,
          timeoutMs: 30_000,
        });

        if (typeof snapshot.progress === 'number') {
          onProgress(snapshot.progress);
        }

        if (snapshot.state === 'failed') {
          throw new Error(snapshot.error || '生成失败');
        }
        if (snapshot.state === 'succeeded') {
          // 委托 renderer 持久化资产并绑定到 ownerRef
          const persisted = await delegateToRenderer<PersistResult>({
            type: 'media:persist',
            args: {
              kind: input.kind,
              snapshotOutput: snapshot.output,
              projectId: input.projectId,
              ownerRef: input.ownerRef,
              providerTaskId: input.remoteTaskId,
              channelId: input.channelId,
              modelId: input.modelId,
              capability: input.capability,
              extra: input.extra,
            },
            signal,
            timeoutMs: PERSIST_TIMEOUT_MS, // 大文件下载/写盘可能比较慢，不能早于真实落盘完成
          });
          return persisted.asset;
        }

        await sleepWithSignal(POLL_INTERVAL_MS, signal);
      }

      throw new Error('任务超时');
    },
  };
}

let registered = false;
export function registerMediaPollHandlers(): void {
  if (registered) return;
  registered = true;
  taskRunner.registerHandler(makePollHandler('tti'));
  taskRunner.registerHandler(makePollHandler('itv'));
  taskRunner.registerHandler(makePollHandler('tts'));
}
