/**
 * 关键词视频用户采集 → 多浏览器并行私信（全自动）。
 * 采集量 = 浏览器数 × 每台私信条数。
 */
import type { WorkflowRunConfig } from './config.types';
import {
  loadWorkflowManifest,
  loadWorkflowRunConfig,
  type AutomationRunResult,
  type WorkflowContext,
  XportWorkflowClient,
} from 'xport-workflow-sdk';

const COLLECT_CMD = 'ig-sreach-keywordvideo-user';
const MESSAGE_CMD = 'ins-message';

function parseBrowserIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0);
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function splitMessageVariants(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split('==sep==')
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveImage(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw)) {
    const first = raw.find((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return first?.trim() ?? null;
  }
  return null;
}

function normalizeKeyword(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/^#+/, '');
}

function profileUrlFromRow(row: Record<string, unknown>): string | null {
  const direct = row.profileUrl;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const username = row.username;
  if (typeof username === 'string' && username.trim()) {
    return `https://www.instagram.com/${username.trim().replace(/^@/, '')}/`;
  }
  return null;
}

async function enqueueAndWaitAll(
  ctx: WorkflowContext,
  jobs: Array<{
    cmd: string;
    deviceId: number;
    target: 'browser';
    config: Record<string, unknown>;
  }>,
): Promise<Array<{ succ: boolean; msg: string; taskId: number; data: Record<string, unknown> }>> {
  const taskIds: number[] = [];
  for (const job of jobs) {
    const [ok, msg, enq] = await ctx.enqueueTask({
      cmd: job.cmd,
      deviceId: job.deviceId,
      target: job.target,
      config: job.config,
    });
    if (!ok || !enq?.taskId) {
      return [
        {
          succ: false,
          msg: msg || `enqueue ${job.cmd} failed`,
          taskId: 0,
          data: {},
        },
      ];
    }
    ctx.workflowLog(`enqueued ${job.cmd} task #${enq.taskId} device=${job.deviceId}`);
    taskIds.push(enq.taskId);
  }
  return Promise.all(taskIds.map((id) => ctx.waitForTask(id)));
}

async function runWorkflow(ctx: WorkflowContext, cfg: WorkflowRunConfig): Promise<AutomationRunResult> {
  const keyword = normalizeKeyword(cfg.keyword);
  const browserIds = parseBrowserIds(cfg.browsers);
  const messagesPerBrowser = parsePositiveInt(cfg.messages_per_browser, 4);
  const messageVariants = splitMessageVariants(cfg.message);
  const image = resolveImage(cfg.image);

  if (!keyword) return { succ: false, msg: '请填写关键词' };
  if (browserIds.length === 0) return { succ: false, msg: '请选择至少一个浏览器' };
  if (messageVariants.length === 0) return { succ: false, msg: '请填写私信文案' };

  const totalQuota = browserIds.length * messagesPerBrowser;
  const collectDeviceId = browserIds[0]!;

  ctx.workflowLog(
    `plan: keyword=${keyword} browsers=${browserIds.length} perBrowser=${messagesPerBrowser} collect_count=${totalQuota}`,
  );

  // 1) 单关键词采集：总量 = 台数 × 每台私信条数
  const collectStep = await ctx.runAutomation({
    cmd: COLLECT_CMD,
    deviceId: collectDeviceId,
    target: 'browser',
    config: {
      keyword,
      collect_count: totalQuota,
    },
  });

  if (!collectStep.succ) {
    return {
      succ: false,
      msg: collectStep.msg || '关键词用户采集失败',
      data: {
        collected: 0,
        enqueued_messages: 0,
        message_success: 0,
        message_failed: 0,
        summary: '采集失败，未发送私信',
      },
    };
  }

  // 2) 读取采集行并去重
  const [dataOk, dataMsg, all] = await ctx.fetchAllAutomationData(COLLECT_CMD, {
    taskId: collectStep.taskId,
  });
  if (!dataOk || !all) {
    return {
      succ: false,
      msg: dataMsg || '读取采集数据失败',
      data: {
        collected: 0,
        enqueued_messages: 0,
        message_success: 0,
        message_failed: 0,
        summary: '采集完成但无法读取用户列表',
      },
    };
  }

  const seen = new Set<string>();
  const profileUrls: string[] = [];
  for (const row of all.rows) {
    const url = profileUrlFromRow(row);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    profileUrls.push(url);
    if (profileUrls.length >= totalQuota) break;
  }

  if (profileUrls.length === 0) {
    return {
      succ: false,
      msg: '未采集到可用用户',
      data: {
        collected: 0,
        enqueued_messages: 0,
        message_success: 0,
        message_failed: 0,
        summary: '采集完成但无用户可发',
      },
    };
  }

  const targets = profileUrls.slice(0, totalQuota);
  ctx.workflowLog(`collected=${profileUrls.length} willMessage=${targets.length}`);

  // 3) 按浏览器切块，全部私信任务一次入队（多设备并行）
  const messageJobs: Array<{
    cmd: string;
    deviceId: number;
    target: 'browser';
    config: Record<string, unknown>;
  }> = [];
  let msgIndex = 0;
  for (let b = 0; b < browserIds.length; b++) {
    const chunk = targets.slice(b * messagesPerBrowser, (b + 1) * messagesPerBrowser);
    const deviceId = browserIds[b]!;
    for (const host of chunk) {
      const message = messageVariants[msgIndex % messageVariants.length]!;
      msgIndex += 1;
      messageJobs.push({
        cmd: MESSAGE_CMD,
        deviceId,
        target: 'browser',
        config: { host, message, image },
      });
    }
  }

  const messageResults = await enqueueAndWaitAll(ctx, messageJobs);
  const messageSuccess = messageResults.filter((r) => r.succ).length;
  const messageFailed = messageResults.filter((r) => !r.succ).length;

  const summary =
    `关键词「${keyword}」采集 ${targets.length} 人，入队私信 ${messageJobs.length}，` +
    `成功 ${messageSuccess}，失败 ${messageFailed}`;

  return {
    succ: messageFailed === 0,
    msg: summary,
    data: {
      collected: targets.length,
      enqueued_messages: messageJobs.length,
      message_success: messageSuccess,
      message_failed: messageFailed,
      summary,
    },
  };
}

const manifest = await loadWorkflowManifest();
const runConfig = await loadWorkflowRunConfig<WorkflowRunConfig>(manifest);

process.exit(
  await XportWorkflowClient.run((ctx) => runWorkflow(ctx, runConfig)),
);
