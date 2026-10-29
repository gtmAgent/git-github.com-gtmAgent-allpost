/**
 * Instagram：按关键词搜索 → 选中第一个标签建议 → 采集视频作者主页链接。
 * 定位优先 href / 结构属性，避免依赖界面语言文案。
 */
import type { IntermediateDataRow, TaskRunConfig } from './config.types';
import {
  type AutomationRunResult,
  automationFailWithContext,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  prepareIntermediateStorage,
  XportBrowserClient,
} from 'xport-browser-sdk';

const RESERVED_PATHS = new Set([
  'explore',
  'reels',
  'direct',
  'accounts',
  'stories',
  'about',
  'legal',
  'privacy',
  'help',
  'popular',
  'web',
  'lite',
  'nametag',
  'directory',
  'p',
  'reel',
  'tags',
  'locations',
]);

function socialHome(): string {
  const raw = (Bun.env.SOCIAL_HOME || 'https://www.instagram.com').trim().replace(/\/+$/, '');
  return raw || 'https://www.instagram.com';
}

function normalizeKeyword(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim();
}

function parseCollectCount(raw: unknown, fallback = 20): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 500);
}

function profileFromReelHref(href: string): { username: string; profileUrl: string } | null {
  const m = href.match(/^\/([A-Za-z0-9._]+)\/reel\//);
  if (!m) return null;
  const username = m[1]!;
  if (RESERVED_PATHS.has(username.toLowerCase())) return null;
  return { username, profileUrl: `${socialHome()}/${username}/` };
}

function profileFromUserHref(href: string): { username: string; profileUrl: string } | null {
  const m = href.match(/^\/([A-Za-z0-9._]+)\/?$/);
  if (!m) return null;
  const username = m[1]!;
  if (RESERVED_PATHS.has(username.toLowerCase())) return null;
  return { username, profileUrl: `${socialHome()}/${username}/` };
}

async function failStep(
  client: XportBrowserClient,
  step: string,
  reason: string,
  code: string,
  labels?: Record<string, string | number | boolean | null | undefined>,
): Promise<AutomationRunResult> {
  const [, , captured] = await client.captureIncident({ step, reason, code, labels });
  return automationFailWithContext(reason, {
    code,
    step,
    incidentId: captured?.incidentId,
    labels,
  });
}

async function extractVideoAuthor(
  client: XportBrowserClient,
): Promise<{ username: string; profileUrl: string } | null> {
  const reelPath = nodePath().css('a[href*="/reel/"]').many();
  const [reelOk, , reelData] = await client.getNodeData(0, reelPath, ['attribute:href']);
  if (reelOk && reelData) {
    for (const href of reelData['attribute:href'] ?? []) {
      const hit = profileFromReelHref(String(href || ''));
      if (hit) return hit;
    }
  }

  const [videoOk, , videoCount] = await client.getNodeCount(0, nodePath().css('video').many());
  if (!videoOk || !videoCount || videoCount < 1) return null;

  const headerPath = nodePath().css('header a[href^="/"]').many();
  const [hOk, , hData] = await client.getNodeData(0, headerPath, ['attribute:href']);
  if (hOk && hData) {
    for (const href of hData['attribute:href'] ?? []) {
      const hit = profileFromUserHref(String(href || ''));
      if (hit) return hit;
    }
  }
  return null;
}

async function listPostHrefs(client: XportBrowserClient): Promise<string[]> {
  const path = nodePath().css('a[href^="/p/"]').many();
  const [ok, , data] = await client.getNodeData(0, path, ['attribute:href']);
  if (!ok || !data) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const href of data['attribute:href'] ?? []) {
    const h = String(href || '').trim();
    if (!h.startsWith('/p/') || seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  return out;
}

async function scrollResults(client: XportBrowserClient): Promise<void> {
  const lastVisible = nodePath().css('a[href^="/p/"]').inViewport().last();
  const [countOk, , count] = await client.getNodeCount(0, lastVisible);
  if (countOk && count && count > 0) {
    await client.hoverNode(0, lastVisible);
    await Bun.sleep(300);
    await client.mouseWheel(0, lastVisible, { deltaY: 900 });
  } else {
    await client.mouseWheel(0, nodePath().css('body').one(), { deltaY: 900 });
  }
  await Bun.sleep(700);
}

async function runAutomation(client: XportBrowserClient, taskConfig: TaskRunConfig): Promise<AutomationRunResult> {
  const keyword = normalizeKeyword(String(taskConfig.keyword ?? ''));
  const collectCount = parseCollectCount(taskConfig.collect_count, 20);
  client.taskLog(`keyword=${keyword || '(empty)'} collect_count=${collectCount}`);

  if (!keyword) {
    return automationFailWithContext('keyword is required in taskRunConfig', {
      code: 'UNKNOWN',
      step: 'validate_keyword',
    });
  }

  const home = socialHome();
  const exploreUrl = `${home}/explore/`;

  const [goOk, goMsg] = await client.pageGoTo(0, { url: exploreUrl, timeoutMs: 60_000 });
  if (!goOk) {
    return failStep(client, 'open_explore', goMsg || 'pageGoTo explore failed', 'NAV_FAILED', { exploreUrl });
  }
  await Bun.sleep(800);

  // Explore 空壳时搜索框可能未挂载；侧栏 Search 为 a[href="/explore/"]（语言无关）
  const searchInputSel = 'input[type="text"][autocapitalize="none"]';
  const searchInput = nodePath().css(searchInputSel).one();
  let [searchWaitOk] = await client.waitForSelector(0, { selector: searchInputSel, timeoutMs: 12_000 });
  if (!searchWaitOk) {
    client.taskLog('search input missing; open via a[href="/explore/"]');
    const searchNav = nodePath().css('a[href="/explore/"]').one();
    const [navOk, navMsg] = await client.clickNode(0, searchNav);
    if (!navOk) {
      return failStep(client, 'open_search_nav', navMsg || 'click search nav failed', 'ELEMENT_NOT_FOUND', {
        keyword,
      });
    }
    await Bun.sleep(800);
    [searchWaitOk] = await client.waitForSelector(0, { selector: searchInputSel, timeoutMs: 15_000 });
  }
  if (!searchWaitOk) {
    return failStep(client, 'locate_search', 'search input not found', 'ELEMENT_NOT_FOUND', { keyword });
  }
  await Bun.sleep(400);

  const [focusOk] = await client.clickNode(0, searchInput);
  if (!focusOk) {
    client.taskLog('search input click skipped; try typeInNode directly');
  }
  await Bun.sleep(400);

  const [typeOk, typeMsg] = await client.typeInNode(0, searchInput, `#${keyword}`);
  if (!typeOk) {
    return failStep(client, 'type_keyword', typeMsg || 'typeInNode failed', 'UNKNOWN', { keyword });
  }
  await Bun.sleep(1000);

  const suggestSel = 'a[href*="/explore/tags/"]';
  const [suggestWaitOk, suggestWaitMsg] = await client.waitForSelector(0, {
    selector: suggestSel,
    timeoutMs: 20_000,
  });
  if (!suggestWaitOk) {
    return failStep(client, 'wait_suggest', suggestWaitMsg || 'keyword suggestion not found', 'ELEMENT_NOT_FOUND', {
      keyword,
    });
  }
  await Bun.sleep(400);

  const firstSuggest = nodePath().css(suggestSel).one(0);
  const [clickSuggestOk, clickSuggestMsg] = await client.clickNode(0, firstSuggest);
  if (!clickSuggestOk) {
    return failStep(client, 'click_suggest', clickSuggestMsg || 'click first suggestion failed', 'ELEMENT_NOT_FOUND', {
      keyword,
    });
  }
  await Bun.sleep(1200);

  const [postsWaitOk, postsWaitMsg] = await client.waitForSelector(0, {
    selector: 'a[href^="/p/"]',
    timeoutMs: 25_000,
  });
  if (!postsWaitOk) {
    return failStep(client, 'wait_results', postsWaitMsg || 'result posts not found', 'ELEMENT_NOT_FOUND', { keyword });
  }

  const [urlOk, urlMsg, resultsUrlRaw] = await client.getPageUrl();
  if (!urlOk || !resultsUrlRaw) {
    return failStep(client, 'results_url', urlMsg || 'getPageUrl failed', 'UNKNOWN', { keyword });
  }
  const resultsUrl = resultsUrlRaw;
  client.taskLog(`resultsUrl=${resultsUrl}`);

  const seenPosts = new Set<string>();
  const seenUsers = new Set<string>();
  const collected: IntermediateDataRow[] = [];
  let emptyRounds = 0;
  const maxEmptyRounds = 6;

  while (seenUsers.size < collectCount && emptyRounds < maxEmptyRounds) {
    const hrefs = await listPostHrefs(client);
    let addedThisRound = 0;

    for (const href of hrefs) {
      if (seenUsers.size >= collectCount) break;
      if (seenPosts.has(href)) continue;
      seenPosts.add(href);

      const postPath = nodePath().css(`a[href="${href}"]`).one();
      const [clickOk] = await client.clickNode(0, postPath);
      if (!clickOk) {
        client.taskLog(`skip click fail post=${href}`);
        continue;
      }
      await Bun.sleep(700);

      const author = await extractVideoAuthor(client);
      const [, , postUrl] = await client.getPageUrl();
      if (author && !seenUsers.has(author.username)) {
        seenUsers.add(author.username);
        const row: IntermediateDataRow = {
          keyword,
          username: author.username,
          profileUrl: author.profileUrl,
          sourcePostUrl: postUrl || `${home}${href}`,
        };
        collected.push(row);
        addedThisRound += 1;

        const [ingOk, ingMsg] = await client.ingestIntermediate([row]);
        if (!ingOk) {
          return failStep(client, 'ingest_row', ingMsg || 'ingestIntermediate failed', 'UNKNOWN', {
            keyword,
            username: author.username,
          });
        }
        client.taskLog(`collected ${seenUsers.size}/${collectCount} @${author.username}`);
      }

      const [backOk] = await client.pageGoTo(0, { url: resultsUrl, timeoutMs: 60_000 });
      if (!backOk) {
        return failStep(client, 'return_results', 'failed to return to results page', 'NAV_FAILED', {
          keyword,
          resultsUrl,
        });
      }
      await Bun.sleep(500);
      const [backPostsOk] = await client.waitForSelector(0, { selector: 'a[href^="/p/"]', timeoutMs: 20_000 });
      if (!backPostsOk) {
        return failStep(client, 'return_results_posts', 'posts missing after return', 'ELEMENT_NOT_FOUND', {
          keyword,
        });
      }
    }

    if (seenUsers.size >= collectCount) break;

    if (addedThisRound === 0) {
      emptyRounds += 1;
      await scrollResults(client);
    } else {
      emptyRounds = 0;
      if (hrefs.length < 3) await scrollResults(client);
    }
  }

  const sampleProfiles = collected
    .slice(0, 5)
    .map((r) => String(r.profileUrl || ''))
    .filter(Boolean)
    .join('\n');

  return {
    succ: true,
    msg: `collected ${collected.length} video users for #${keyword}`,
    data: {
      keyword,
      collectedCount: collected.length,
      sampleProfiles,
    },
  };
}

const manifest = await loadAutomationManifest();
if (manifest.intermediateDataSchema) {
  const [prepOk, prepMsg] = await prepareIntermediateStorage(manifest);
  if (!prepOk) {
    process.exit(
      await XportBrowserClient.run(async () =>
        automationFailWithContext(prepMsg || 'prepareIntermediateStorage failed', {
          code: 'UNKNOWN',
          step: 'prepare_storage',
        }),
      ),
    );
  }
}

const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(
  await XportBrowserClient.run(async (client) => {
    try {
      return await runAutomation(client, taskConfig);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const [, , captured] = await client.captureIncident({
        step: 'uncaught',
        reason,
        code: 'UNKNOWN',
      });
      return automationFailWithContext(reason, {
        code: 'UNKNOWN',
        step: 'uncaught',
        incidentId: captured?.incidentId,
      });
    }
  }),
);
