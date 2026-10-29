/**
 * Instagram 私信：打开目标主页 → 主页 Message 按钮（优先）或三点菜单 Send message → 输入文案（可选附图）→ 发送。
 */
import type { TaskRunConfig } from './config.types';
import {
  type AutomationRunResult,
  automationFailWithContext,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  XportBrowserClient,
} from 'xport-browser-sdk';

const SLEEP_MS = 800;
const WAIT_MS = 20_000;

async function sleep(): Promise<void> {
  await Bun.sleep(SLEEP_MS);
}

async function failStep(
  client: XportBrowserClient,
  step: string,
  reason: string,
  code: 'ELEMENT_NOT_FOUND' | 'NAV_FAILED' | 'UNKNOWN' | 'UPLOAD_FAILED',
  labels?: Record<string, string>,
): Promise<AutomationRunResult> {
  const [, , captured] = await client.captureIncident({ step, reason, code, labels });
  return automationFailWithContext(reason, {
    code,
    step,
    incidentId: captured?.incidentId,
    labels,
  });
}

async function clickOrFail(
  client: XportBrowserClient,
  step: string,
  path: ReturnType<ReturnType<typeof nodePath>['one']>,
  labels?: Record<string, string>,
  options?: { preferClickableAncestor?: boolean },
): Promise<AutomationRunResult | null> {
  const [countOk, , count] = await client.getNodeCount(0, path);
  if (!countOk || !count || count < 1) {
    return failStep(client, step, `${step}: element not found`, 'ELEMENT_NOT_FOUND', labels);
  }
  const [clickOk, clickMsg] = await client.clickNode(
    0,
    path,
    -1,
    options?.preferClickableAncestor ? { preferClickableAncestor: true } : undefined,
  );
  if (!clickOk) {
    return failStep(client, step, clickMsg || `${step}: click failed`, 'ELEMENT_NOT_FOUND', labels);
  }
  await sleep();
  return null;
}

/** 有故事环的主页偶发进入 /stories/，挡住 Message；Escape 关掉。 */
async function dismissStoriesIfOpen(client: XportBrowserClient): Promise<boolean> {
  const [urlOk, , url] = await client.getPageUrl();
  if (!urlOk || typeof url !== 'string' || !url.includes('/stories/')) return false;
  client.taskLog(`dismiss stories url=${url}`);
  await client.pressKey(0, 'Escape');
  await Bun.sleep(1000);
  return true;
}

async function runAutomation(client: XportBrowserClient, taskConfig: TaskRunConfig): Promise<AutomationRunResult> {
  const host = String(taskConfig.host ?? '').trim();
  const message = String(taskConfig.message ?? '').trim();
  const imageMd5 = String(taskConfig.image ?? '').trim();
  const hasImage = imageMd5.length > 0;
  const labels = { host, hasImage: hasImage ? '1' : '0' };

  client.taskLog(`host=${host || '(empty)'} messageLen=${message.length} hasImage=${hasImage}`);

  if (!host) {
    return automationFailWithContext('host is required in taskRunConfig', {
      code: 'UNKNOWN',
      step: 'validate_host',
    });
  }
  if (!message && !hasImage) {
    return automationFailWithContext('message or image is required', {
      code: 'UNKNOWN',
      step: 'validate_content',
    });
  }

  try {
    const [goOk, goMsg, status] = await client.pageGoTo(0, { url: host, timeoutMs: 60_000 });
    if (!goOk) {
      return failStep(client, 'open_host', goMsg || 'pageGoTo failed', 'NAV_FAILED', labels);
    }
    client.taskLog(`pageGoTo ok status=${status ?? '?'}`);
    await sleep();
    await dismissStoriesIfOpen(client);

    // 进私信：优先主页 Message（失败现场 HTML：header 内无 canvas/svg 的 div[role=button] 文案 "Message"；
    // 三点菜单常无无 Send message）；无 Message 时回退 Options → Send message。
    // :not(:has(canvas|svg)) 避开头像故事环与 Similar accounts，防止误点进 /stories/。
    const profileMessageBtn = nodePath()
      .css('header div[role="button"]:not(:has(canvas)):not(:has(svg))')
      .pText('Message')
      .one();
    const optionsBtn = nodePath().css('header svg[aria-label="Options"]').one();
    const sendMessageMenuBtn = nodePath()
      .css('div[role="dialog"][aria-modal="true"] button')
      .pText('Send message')
      .one();

    const [optWaitOk] = await client.waitForSelector(0, {
      selector: 'header svg[aria-label="Options"]',
      timeoutMs: WAIT_MS,
      visible: true,
    });
    if (!optWaitOk) {
      return failStep(client, 'open_options_menu', 'Options button not ready', 'ELEMENT_NOT_FOUND', labels);
    }

    let openedDm = false;
    const [msgBtnOk, , msgBtnCount] = await client.getNodeCount(0, profileMessageBtn);
    if (msgBtnOk && msgBtnCount && msgBtnCount >= 1) {
      client.taskLog('open DM via profile Message button');
      const msgFail = await clickOrFail(client, 'click_send_message', profileMessageBtn, labels);
      if (msgFail) return msgFail;
      // Message 点击后按钮会转圈再出右侧私信浮窗
      await Bun.sleep(1500);
      if (await dismissStoriesIfOpen(client)) {
        client.taskLog('retry Message after accidental stories');
        const retryFail = await clickOrFail(client, 'click_send_message', profileMessageBtn, labels);
        if (retryFail) return retryFail;
        await Bun.sleep(1500);
      }
      openedDm = true;
    }

    if (!openedDm) {
      client.taskLog('open DM via Options → Send message');
      const optFail = await clickOrFail(client, 'open_options_menu', optionsBtn, labels, {
        preferClickableAncestor: true,
      });
      if (optFail) return optFail;

      let menuReady = false;
      for (let i = 0; i < 12; i++) {
        const [ok, , n] = await client.getNodeCount(0, sendMessageMenuBtn);
        if (ok && n && n >= 1) {
          menuReady = true;
          break;
        }
        await Bun.sleep(400);
      }
      if (!menuReady) {
        return failStep(
          client,
          'click_send_message',
          'Send message menu item not found (and no profile Message button)',
          'ELEMENT_NOT_FOUND',
          labels,
        );
      }
      const smFail = await clickOrFail(client, 'click_send_message', sendMessageMenuBtn, labels);
      if (smFail) return smFail;
    }

    // 私信输入框：语言无关结构 role=textbox + contenteditable（浮窗 probe count=1）
    const composer = nodePath().css('div[role="textbox"][contenteditable="true"]').one();
    let composerReady = false;
    for (let i = 0; i < 30; i++) {
      if (await dismissStoriesIfOpen(client)) {
        // 关掉故事后若曾走 Message 路径，再点一次
        const [againOk, , againN] = await client.getNodeCount(0, profileMessageBtn);
        if (againOk && againN && againN >= 1) {
          await clickOrFail(client, 'click_send_message', profileMessageBtn, labels);
          await Bun.sleep(1500);
        }
      }
      const [ok, , n] = await client.getNodeCount(0, composer);
      if (ok && n && n >= 1) {
        composerReady = true;
        break;
      }
      await Bun.sleep(800);
    }
    if (!composerReady) {
      return failStep(client, 'open_dm_composer', 'DM composer not ready', 'ELEMENT_NOT_FOUND', labels);
    }
    await sleep();

    if (hasImage) {
      const fileInput = nodePath().css('input[type="file"]').one();
      const [fileOk, , fileCount] = await client.getNodeCount(0, fileInput);
      if (!fileOk || !fileCount || fileCount < 1) {
        return failStep(client, 'attach_image', 'file input not found', 'ELEMENT_NOT_FOUND', labels);
      }
      const [upOk, upMsg] = await client.uploadFile(0, fileInput, imageMd5);
      if (!upOk) {
        return failStep(client, 'attach_image', upMsg || 'uploadFile failed', 'UPLOAD_FAILED', labels);
      }
      client.taskLog('image uploaded');
      await Bun.sleep(1500);
    }

    if (message) {
      const [typeOk, typeMsg] = await client.typeInNode(0, composer, message);
      if (!typeOk) {
        return failStep(client, 'type_message', typeMsg || 'typeInNode failed', 'ELEMENT_NOT_FOUND', labels);
      }
      client.taskLog('message typed');
      await sleep();
    }

    // 发送（HTML 证据：div[role=button]:has(svg[aria-label="Send"])）
    const sendBtn = nodePath().css('div[role="button"]:has(svg[aria-label="Send"])').one();
    let sendReady = false;
    for (let i = 0; i < 10; i++) {
      const [ok, , n] = await client.getNodeCount(0, sendBtn);
      if (ok && n && n >= 1) {
        sendReady = true;
        break;
      }
      await Bun.sleep(500);
    }
    if (!sendReady) {
      return failStep(client, 'click_send', 'Send button not found', 'ELEMENT_NOT_FOUND', labels);
    }
    const sendFail = await clickOrFail(client, 'click_send', sendBtn, labels);
    if (sendFail) return sendFail;

    await Bun.sleep(1200);
    const [urlOk, , finalUrl] = await client.getPageUrl();
    const preview = message.length > 80 ? `${message.slice(0, 80)}…` : message;

    return {
      succ: true,
      msg: 'Instagram DM sent',
      data: {
        host,
        messagePreview: preview,
        hasImage: hasImage ? 'yes' : 'no',
        finalUrl: urlOk ? finalUrl : '',
      },
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return failStep(client, 'unexpected_error', reason, 'UNKNOWN', labels);
  }
}

const manifest = await loadAutomationManifest();
const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(await XportBrowserClient.run((client) => runAutomation(client, taskConfig)));
