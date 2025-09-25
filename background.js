const GLASP_READER_BASE_URL = 'https://glasp.co/reader?url=';
const GLASP_READER_LOAD_TIMEOUT_MS = 20000;
const PENDING_STORAGE_KEY = 'pendingPromptsV2';
const MAX_INJECTION_ATTEMPTS = 12;
const RETRY_DELAY_MS = 1000;

const activeInjections = new Set();
let pendingPrompts = new Map();
let pendingLoaded = false;
let pendingLoadingPromise = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'fetchTranscriptFromGlasp' && typeof message.videoUrl === 'string') {
    (async () => {
      try {
        const transcript = await fetchTranscriptForVideo(message.videoUrl);
        sendResponse({ status: 'success', transcript });
      } catch (error) {
        console.error('Failed to fetch transcript from Glasp:', error);
        sendResponse({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unable to retrieve transcript from Glasp.'
        });
      }
    })();
    return true;
  }

  if (message?.type === 'openChatGPT' && typeof message.prompt === 'string') {
    (async () => {
      try {
        const response = await openChatGPTTab(message.prompt, message.preferredHost, message.autoSend);
        sendResponse(response);
      } catch (error) {
        console.error('Failed to open ChatGPT tab:', error);
        sendResponse({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unable to open ChatGPT.'
        });
      }
    })();
    return true;
  }

  return false;
});

async function fetchTranscriptForVideo(videoUrl) {
  if (typeof videoUrl !== 'string' || !videoUrl.trim()) {
    throw new Error('Invalid video URL provided.');
  }

  try {
    const youtubeTranscript = await fetchTranscriptFromYouTube(videoUrl);
    if (typeof youtubeTranscript === 'string' && youtubeTranscript.trim()) {
      return youtubeTranscript;
    }
  } catch (error) {
    console.debug('Timed YouTube transcript fetch failed', error);
  }

  return fetchTranscriptFromGlasp(videoUrl);
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    await ensurePendingPromptsLoaded();
  } catch (error) {
    console.error('Unable to load pending prompts from storage.', error);
    return;
  }

  if (!pendingPrompts.has(tabId)) {
    return;
  }

  const updatedUrl = changeInfo.url || tab?.url || '';
  if (!isChatUrl(updatedUrl)) {
    return;
  }

  if (changeInfo.status === 'complete' || changeInfo.url) {
    scheduleInjectionAttempt(tabId, 0);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  activeInjections.delete(tabId);
  try {
    await removePendingPrompt(tabId);
  } catch (error) {
    console.error('Failed to clean up pending prompt for closed tab', tabId, error);
  }
});

(async () => {
  try {
    await ensurePendingPromptsLoaded();
  } catch (error) {
    console.error('Failed to load pending prompts during startup.', error);
    return;
  }

  for (const tabId of pendingPrompts.keys()) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url && isChatUrl(tab.url)) {
        scheduleInjectionAttempt(tabId, RETRY_DELAY_MS);
      } else {
        await removePendingPrompt(tabId);
      }
    } catch (error) {
      await removePendingPrompt(tabId);
    }
  }
})();

async function fetchTranscriptFromGlasp(videoUrl) {
  const targetUrl = `${GLASP_READER_BASE_URL}${encodeURIComponent(videoUrl)}`;
  const readerTab = await chrome.tabs.create({ url: targetUrl, active: false });
  if (!readerTab?.id) {
    throw new Error('Unable to open Glasp reader.');
  }

  let tabClosed = false;
  const tabId = readerTab.id;

  const cleanup = async () => {
    if (tabClosed) {
      return;
    }
    tabClosed = true;
    try {
      await chrome.tabs.remove(tabId);
    } catch (error) {
      if (error && typeof error.message === 'string' && /No tab with id/.test(error.message)) {
        return;
      }
      console.debug('Failed to close Glasp reader tab', error);
    }
  };

  try {
    await waitForTabComplete(tabId, GLASP_READER_LOAD_TIMEOUT_MS);
    const pageText = await getTabInnerText(tabId);
    const parsedTranscript = parseTranscriptFromReaderText(pageText);
    const transcript = await ensureTranscriptHasTimestamps(parsedTranscript, videoUrl);
    await cleanup();
    if (!isTranscriptMeaningful(transcript)) {
      throw new Error('Transcript data not found on Glasp for this video.');
    }
    return transcript;
  } catch (error) {
    await cleanup();
    throw error instanceof Error ? error : new Error('Unable to read transcript from Glasp.');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseTranscriptFromReaderText,
    stripLeadingGlaspMetadataLines,
    extractPlayerResponseFromWatchHtml,
    extractJsonObjectFromAssignment,
    isConsentInterstitialHtml,
    buildWatchPageUrl
  };
}

async function openChatGPTTab(prompt, preferredHost, autoSend) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Invalid prompt supplied.');
  }

  const host = normalizeChatHost(preferredHost);
  const url = `https://${host}/`;
  const tab = await chrome.tabs.create({ url, active: true });

  if (!tab?.id) {
    throw new Error('Failed to open ChatGPT tab.');
  }

  const shouldAutoSend = autoSend !== false;
  await setPendingPrompt(tab.id, { prompt, attempts: 0, host, autoSend: shouldAutoSend });
  scheduleInjectionAttempt(tab.id, 1500);
  return { status: 'opening', tabId: tab.id };
}

function scheduleInjectionAttempt(tabId, delay) {
  if (activeInjections.has(tabId)) {
    return;
  }

  setTimeout(() => {
    void attemptPromptInjection(tabId);
  }, Math.max(0, delay));
}

async function attemptPromptInjection(tabId) {
  if (activeInjections.has(tabId)) {
    return;
  }
  activeInjections.add(tabId);

  try {
    await ensurePendingPromptsLoaded();
    const pending = pendingPrompts.get(tabId);
    if (!pending) {
      return;
    }

    if ((pending.attempts ?? 0) >= MAX_INJECTION_ATTEMPTS) {
      console.warn('Maximum prompt injection attempts reached for tab', tabId);
      await removePendingPrompt(tabId);
      return;
    }

    pending.attempts = (pending.attempts ?? 0) + 1;
    await persistPendingPrompts();

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: injectPromptAndSend,
      args: [pending.prompt, pending.autoSend !== false, pending.hasInjected === true]
    });

    const status = result?.status || (result === true ? 'success' : 'retry');

    if (result && typeof result.hasInjected === 'boolean' && result.hasInjected && !pending.hasInjected) {
      pending.hasInjected = true;
      if (status !== 'success' && status !== 'manual-complete') {
        await persistPendingPrompts();
      }
    }

    if (status === 'success' || status === 'manual-complete') {
      await removePendingPrompt(tabId);
      return;
    }

    if (status === 'permanent-failure') {
      console.warn('Prompt injection reported a permanent failure for tab', tabId, result?.reason);
      await removePendingPrompt(tabId);
      return;
    }

    if ((pending.attempts ?? 0) < MAX_INJECTION_ATTEMPTS) {
      scheduleInjectionAttempt(tabId, RETRY_DELAY_MS);
    } else {
      await removePendingPrompt(tabId);
    }
  } catch (error) {
    console.error('Prompt injection failed for tab', tabId, error);
    await removePendingPrompt(tabId);
  } finally {
    activeInjections.delete(tabId);
  }
}

async function waitForTabComplete(tabId, timeoutMs) {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out while waiting for Glasp to load.'));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) {
        return;
      }

      if (changeInfo.status === 'complete') {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }

      if (changeInfo.status === 'loading' && Date.now() - startTime > timeoutMs) {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Glasp took too long to load.'));
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function getTabInnerText(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => document?.body?.innerText || ''
    });
    if (typeof result !== 'string') {
      throw new Error('Unable to read transcript content from Glasp.');
    }
    return result;
  } catch (error) {
    throw error instanceof Error ? error : new Error('Failed to read transcript from Glasp.');
  }
}

const GLASP_MARKETING_LINES = [
  'Share This Page',
  'Get YouTube Video Transcript',
  'Download browser extensions',
  'Apps & Extensions',
  'Key Features',
  'More Features',
  'Glasp Reader',
  'Kindle Highlight Export',
  'Idea Hatch',
  'Integrations',
  'Obsidian Plugin',
  'Notion Integration',
  'Pocket Integration',
  'Instapaper Integration',
  'Medium Integration',
  'Readwise Integration',
  'Snipd Integration',
  'Hypothesis Integration',
  'APIs',
  'Blog & Post',
  'Embed Links',
  'Image Highlight',
  'Personality Test',
  'Quote Shots',
  'Products Discover About',
  'ProductsDiscoverAbout',
  'Company',
  'About us',
  'Blog',
  'Community',
  'FAQs',
  'Job Board',
  'Newsletter',
  'Pricing',
  'Terms',
  'Privacy',
  'Guidelines'
];

const GLASP_MARKETING_LINE_SET = new Set(
  GLASP_MARKETING_LINES.map((value) => value.trim().toLowerCase())
);

const GLASP_STRONG_MARKETING_PATTERNS = [
  /^©\s*\d{4}\s+glasp/i,
  /\bglasp\s+inc\./i
];

function isTranscriptMeaningful(transcript) {
  if (typeof transcript !== 'string') {
    return false;
  }

  const trimmed = transcript.trim();
  if (!trimmed) {
    return false;
  }

  const trailingLines = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const marketingFooterPresent = trailingLines.slice(-5).some((line) => {
    if (isStrongMarketingLine(line)) {
      return true;
    }

    const normalized = normalizeMarketingLine(line);
    return normalized ? GLASP_MARKETING_LINE_SET.has(normalized) : false;
  });

  if (marketingFooterPresent) {
    return false;
  }

  const hasStructure = /[\[\n]/.test(trimmed);
  if (!hasStructure && trimmed.length < 64) {
    return false;
  }

  return true;
}

function normalizeMarketingLine(line) {
  return line.trim().toLowerCase().replace(/[|:]+$/g, '').trim();
}

function isStrongMarketingLine(line) {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  if (!trimmed) {
    return false;
  }
  return GLASP_STRONG_MARKETING_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function isMarketingFooterLine(line) {
  if (typeof line !== 'string') {
    return false;
  }

  const normalized = normalizeMarketingLine(line);
  if (!normalized) {
    return false;
  }

  if (GLASP_MARKETING_LINE_SET.has(normalized)) {
    return true;
  }

  return isStrongMarketingLine(line);
}

function stripLeadingGlaspMetadataLines(lines) {
  if (!Array.isArray(lines)) {
    return [];
  }

  const monthPattern =
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

  const shouldDropLine = (line, metadataSeen) => {
    if (typeof line !== 'string') {
      return true;
    }

    const normalized = line.replace(/\u00a0/g, ' ').trim();
    if (!normalized) {
      return true;
    }

    if (/^#[\p{L}\p{N}_-]+/u.test(normalized)) {
      return true;
    }

    if (monthPattern.test(normalized)) {
      return true;
    }

    if (/^(?:\d{1,2}[\/-]){2}\d{2,4}$/.test(normalized)) {
      return true;
    }

    if (/^\d{4}$/.test(normalized)) {
      return true;
    }

    if (/^by\s*[:|]*$/i.test(normalized)) {
      return true;
    }

    if (/^by\b/i.test(normalized)) {
      const remainder = normalized.slice(2).trim();
      if (!remainder) {
        return true;
      }

      const firstWord = remainder.split(/\s+/)[0];
      if (/^@[\w.-]+/.test(firstWord)) {
        return true;
      }

      if (metadataSeen && (/^[A-Z#]/.test(firstWord) || /^[a-z]/.test(firstWord) === false)) {
        return true;
      }
    }

    if ((normalized.includes('#') || normalized.includes('@') || normalized.includes('•')) && metadataSeen) {
      return true;
    }

    if (metadataSeen && /^[A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*)*$/.test(normalized)) {
      return true;
    }

    return false;
  };

  let dropCount = 0;
  let metadataSeen = false;
  let dropNextAuthorLine = false;

  for (const line of lines) {
    if (dropNextAuthorLine) {
      dropCount += 1;
      metadataSeen = true;
      dropNextAuthorLine = false;
      continue;
    }

    if (!shouldDropLine(line, metadataSeen)) {
      break;
    }

    const normalized = typeof line === 'string' ? line.replace(/\u00a0/g, ' ').trim() : '';
    dropCount += 1;
    metadataSeen = true;
    if (/^by\s*[:|]*$/i.test(normalized)) {
      dropNextAuthorLine = true;
    }
  }

  return lines.slice(dropCount);
}

function parseTranscriptFromReaderText(pageText) {
  if (typeof pageText !== 'string' || pageText.trim().length === 0) {
    throw new Error('Empty response received from Glasp.');
  }

  if (/Attention Required! \| Cloudflare/i.test(pageText)) {
    throw new Error('Glasp is requesting additional verification. Open glasp.co in your browser and retry.');
  }

  if (/Please\s+(?:sign\s+in|log\s+in)/i.test(pageText)) {
    throw new Error('Please sign in to Glasp in this browser to access transcripts.');
  }

  const sanitized = pageText.replace(/\r/g, '\n').replace(/\u00a0/g, ' ');
  const transcriptCandidate = extractTranscriptSection(sanitized);
  const transcriptSection = truncateMarketingContent(transcriptCandidate).trim();

  if (!transcriptSection) {
    throw new Error('Transcript data not found on Glasp for this video.');
  }

  const segments = extractSegmentsFromPlainText(transcriptSection);
  if (segments.length > 0) {
    return segments.join('\n');
  }

  const headerPattern = /^(?:Summarize\s+)?Transcript(?:\s*English\s*\(auto-generated\))?$/i;

  const fallbackLines = transcriptSection
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !isMarketingFooterLine(line) &&
        !headerPattern.test(line) &&
        !/^English\s*\(auto-generated\)$/i.test(line)
    );

  const strippedFallbackLines = stripLeadingGlaspMetadataLines(fallbackLines);
  const fallbackTranscript = strippedFallbackLines.join('\n').trim();
  if (!fallbackTranscript) {
    throw new Error('Transcript data not found on Glasp for this video.');
  }

  return fallbackTranscript;
}

function stripLeadingGlaspMetadataLines(lines) {
  if (!Array.isArray(lines)) {
    return [];
  }

  const metadataKeywords = [
    'youtube transcript & summary',
    '& summary',
    'summary',
    'transcripts',
    'youtube video player',
    'share video',
    'download .srt',
    'copy transcript',
    'copy',
    'summarize transcript',
    'get transcript & summary'
  ];

  const keywordSet = new Set(metadataKeywords.map((value) => value.toLowerCase()));
  const combinedKeywordPatterns = metadataKeywords.map((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped.replace(/\s+/g, '\\s*'), 'i');
  });

  const monthNames = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december'
  ];

  const datePattern = new RegExp(
    `^(?:${monthNames.join('|')})\\s+\\d{1,2},\\s*\\d{4}$`,
    'i'
  );

  let index = 0;
  let removedAny = false;
  let skipNext = false;

  while (index < lines.length) {
    if (skipNext) {
      skipNext = false;
      removedAny = true;
      index += 1;
      continue;
    }

    const current = lines[index];
    const trimmed = typeof current === 'string' ? current.trim() : '';
    if (!trimmed) {
      removedAny = true;
      index += 1;
      continue;
    }

    const lower = trimmed.toLowerCase();

    if (/^#\S+/.test(trimmed)) {
      removedAny = true;
      index += 1;
      continue;
    }

    if (keywordSet.has(lower) || combinedKeywordPatterns.some((pattern) => pattern.test(trimmed))) {
      removedAny = true;
      index += 1;
      continue;
    }

    if (lower === 'by') {
      skipNext = true;
      index += 1;
      continue;
    }

    if (lower.startsWith('by ')) {
      removedAny = true;
      index += 1;
      continue;
    }

    const nextLine = typeof lines[index + 1] === 'string' ? lines[index + 1].trim() : '';
    if (
      datePattern.test(trimmed) &&
      (removedAny || /^(?:by\b|#|share\b|download\b|copy\b|summarize\b)/i.test(nextLine))
    ) {
      removedAny = true;
      index += 1;
      continue;
    }

    if (trimmed === 's' && removedAny) {
      removedAny = true;
      index += 1;
      continue;
    }

    break;
  }

  return lines.slice(index);
}

function truncateMarketingContent(text) {
  if (!text) {
    return text;
  }

  const lines = text.split('\n');
  const lineStartIndices = [];
  let offset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    lineStartIndices.push(offset);
    offset += lines[index].length + 1;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalized = normalizeMarketingLine(line);
    if (!normalized) {
      continue;
    }

    const isKnownFooter = GLASP_MARKETING_LINE_SET.has(normalized);
    const isStrongFooter = isStrongMarketingLine(line);
    if (!isKnownFooter && !isStrongFooter) {
      continue;
    }

    const cutIndex = lineStartIndices[index];
    return text.slice(0, cutIndex).trimEnd();
  }

  return text;
}

function extractTranscriptSection(text) {
  if (!text) {
    return '';
  }

  const timestampPattern = /((?:\d{1,2}:)?\d{1,2}:\d{2})/;
  const headerPattern = /(?:Summarize\s+)?Transcript(?:\s*English\s*\(auto-generated\))?/i;

  const timestampMatch = timestampPattern.exec(text);
  if (timestampMatch) {
    return text.slice(timestampMatch.index);
  }

  const headerMatch = headerPattern.exec(text);
  let working = headerMatch ? text.slice(headerMatch.index + headerMatch[0].length) : text;

  working = working.replace(/Summarize\s+Transcript/gi, ' ');
  working = working.replace(/Transcript:?/gi, ' ');
  working = working.replace(/English\s*\(auto-generated\)/gi, ' ');
  working = working.replace(/Language\s*:?.*?English.*?(?:\n|$)/gi, ' ');

  return working;
}

function extractSegmentsFromPlainText(text) {
  const cleaned = truncateMarketingContent(text)
    .replace(/Summarize\s+Transcript/gi, ' ')
    .replace(/Transcript:?/gi, ' ')
    .replace(/English\s*\(auto-generated\)/gi, ' ')
    .replace(/Language\s*:?.*?English/gi, ' ');

  const normalized = cleaned.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return [];
  }

  const timestampPattern = /((?:\d{1,2}:)?\d{1,2}:\d{2})(?:\s*[-–:\u2013]\s*|\s+)?/g;
  const matches = [];
  let match;
  while ((match = timestampPattern.exec(normalized)) !== null) {
    matches.push({ index: match.index, raw: match[0], timestamp: match[1] });
  }

  if (matches.length === 0) {
    return [];
  }

  const segments = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const next = matches[i + 1];
    const start = current.index + current.raw.length;
    const end = next ? next.index : normalized.length;
    const segmentText = normalized.slice(start, end).trim();
    if (!segmentText) {
      continue;
    }
    segments.push(formatTranscriptSegment(current.timestamp, segmentText));
  }

  return segments;
}

async function ensureTranscriptHasTimestamps(transcript, videoUrl) {
  if (transcriptHasTimestamps(transcript)) {
    return transcript;
  }

  try {
    const fallback = await fetchTranscriptFromYouTube(videoUrl);
    if (fallback) {
      return fallback;
    }
  } catch (error) {
    console.warn('Timed transcript fallback failed', error);
  }

  return transcript;
}

function transcriptHasTimestamps(transcript) {
  if (typeof transcript !== 'string') {
    return false;
  }
  return /\[(?:\d{1,2}:)?\d{1,2}:\d{2}\]/.test(transcript);
}

async function fetchTranscriptFromYouTube(videoUrl) {
  const videoId = extractVideoIdFromUrl(videoUrl);
  if (!videoId) {
    throw new Error('Unable to determine video ID for transcript fallback.');
  }

  try {
    const transcriptFromWatchPage = await fetchTranscriptFromWatchPage(videoId);
    if (transcriptFromWatchPage) {
      return transcriptFromWatchPage;
    }
  } catch (error) {
    console.debug('Failed to fetch transcript from watch page', error);
  }

  const paramVariants = ['lang=en&fmt=json3', 'lang=en&kind=asr&fmt=json3', 'lang=en-US&fmt=json3', 'lang=en-US&kind=asr&fmt=json3'];

  for (const params of paramVariants) {
    const requestUrl = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&${params}`;
    try {
      const response = await fetch(requestUrl, { credentials: 'include' });
      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      const formatted = parseTimedTextJson(data);
      if (formatted) {
        return formatted;
      }
    } catch (error) {
      console.debug('Failed to fetch YouTube timed transcript with params', params, error);
    }
  }

  throw new Error('Timed YouTube transcript unavailable.');
}

async function fetchTranscriptFromWatchPage(videoId) {
  const watchUrlCandidates = Array.from(
    new Set(
      [
        buildWatchPageUrl(videoId),
        buildWatchPageUrl(videoId, {
          app: 'desktop',
          persist_app: '1',
          has_verified: '1',
          hl: 'en',
          gl: 'US',
          persist_hl: '1',
          persist_gl: '1',
          bpctr: String(Math.max(1, Math.floor(Date.now() / 1000)))
        })
      ].filter(Boolean)
    )
  );

  let lastError = null;
  let playerResponse = null;

  for (const watchUrl of watchUrlCandidates) {
    if (!watchUrl) {
      continue;
    }

    let response;
    try {
      response = await fetch(watchUrl, { credentials: 'include', redirect: 'follow' });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Watch page request failed.');
      continue;
    }

    if (!response.ok) {
      lastError = new Error(`Watch page request failed with status ${response.status}`);
      continue;
    }

    const html = await response.text();
    if (isConsentInterstitialHtml(html)) {
      lastError = new Error('Watch page request returned a consent interstitial.');
      continue;
    }

    const parsed = extractPlayerResponseFromWatchHtml(html);
    if (!parsed) {
      lastError = new Error('Unable to locate player response in watch page HTML.');
      continue;
    }

    playerResponse = parsed;
    break;
  }

  if (!playerResponse) {
    throw lastError || new Error('Unable to locate player response in watch page HTML.');
  }

  const captionTrack = selectBestCaptionTrack(playerResponse);
  if (!captionTrack || typeof captionTrack.baseUrl !== 'string') {
    throw new Error('No caption track with a valid base URL was found in the player response.');
  }

  const requestUrl = buildTimedTextRequestUrl(captionTrack.baseUrl);
  if (!requestUrl) {
    throw new Error('Unable to normalize the caption track URL for transcript retrieval.');
  }

  const timedTextData = await fetchTimedTextJson(requestUrl);
  if (!timedTextData) {
    throw new Error('Timed text response from YouTube was empty.');
  }

  const formatted = parseTimedTextJson(timedTextData);
  if (!formatted) {
    throw new Error('Unable to format timed text transcript from YouTube watch page.');
  }

  return formatted;
}

function buildWatchPageUrl(videoId, queryOverrides = null, baseUrl = 'https://www.youtube.com/watch') {
  if (!videoId) {
    return null;
  }

  try {
    const url = new URL(baseUrl);
    url.searchParams.set('v', videoId);

    if (queryOverrides && typeof queryOverrides === 'object') {
      for (const [key, value] of Object.entries(queryOverrides)) {
        if (value === undefined || value === null) {
          continue;
        }
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  } catch (error) {
    return null;
  }
}

function extractPlayerResponseFromWatchHtml(html) {
  if (typeof html !== 'string' || !html) {
    return null;
  }

  const assignmentMarkers = ['ytInitialPlayerResponse =', 'window["ytInitialPlayerResponse"] ='];
  for (const marker of assignmentMarkers) {
    const parsed = extractJsonObjectFromAssignment(html, marker);
    if (parsed) {
      return parsed;
    }
  }

  const inlineMatch = html.match(/"playerResponse":\s*(\{.*?\})\s*,\s*"responseContext"/s);
  if (inlineMatch) {
    try {
      return JSON.parse(inlineMatch[1]);
    } catch (error) {
      return null;
    }
  }

  return null;
}

function isConsentInterstitialHtml(html) {
  if (typeof html !== 'string' || !html) {
    return false;
  }

  const lower = html.slice(0, 50000).toLowerCase();
  if (!lower.includes('consent.youtube.com') && !lower.includes('consent.google.com')) {
    return false;
  }

  if (lower.includes('before you continue to youtube')) {
    return true;
  }

  if (/<form[^>]+action="https:\/\/consent\.youtube\.com\//i.test(html)) {
    return true;
  }

  return false;
}

function extractJsonObjectFromAssignment(source, marker) {
  const index = source.indexOf(marker);
  if (index === -1) {
    return null;
  }

  let cursor = index + marker.length;

  while (cursor < source.length) {
    const current = source[cursor];

    if (/\s/.test(current) || current === '=') {
      cursor += 1;
      continue;
    }

    if (current === '(' || current === '!' || current === ')') {
      cursor += 1;
      continue;
    }

    if (current === '{') {
      const jsonText = extractBalancedJson(source, cursor);
      if (!jsonText) {
        return null;
      }
      try {
        return JSON.parse(jsonText);
      } catch (error) {
        return null;
      }
    }

    if (current === '"' || current === '\'') {
      const literal = extractJsStringLiteral(source, cursor);
      if (!literal) {
        return null;
      }
      const decoded = decodeJsStringLiteral(literal);
      if (decoded === null) {
        return null;
      }
      try {
        return JSON.parse(decoded);
      } catch (error) {
        return null;
      }
    }

    if (source.startsWith('JSON.parse', cursor)) {
      const openParenIndex = source.indexOf('(', cursor);
      if (openParenIndex === -1) {
        return null;
      }

      let argumentIndex = openParenIndex + 1;
      while (argumentIndex < source.length && /\s/.test(source[argumentIndex])) {
        argumentIndex += 1;
      }

      if (argumentIndex >= source.length) {
        return null;
      }

      const argumentStart = source[argumentIndex];
      if (argumentStart === '"' || argumentStart === '\'') {
        const literal = extractJsStringLiteral(source, argumentIndex);
        if (!literal) {
          return null;
        }
        const decoded = decodeJsStringLiteral(literal);
        if (decoded === null) {
          return null;
        }
        try {
          return JSON.parse(decoded);
        } catch (error) {
          return null;
        }
      }
    }

    if (/[A-Za-z0-9_$.[\]]/.test(current)) {
      cursor = advancePastIdentifierChain(source, cursor);
      continue;
    }

    if (current === '|' || current === '&' || current === '?' || current === ':' || current === '+') {
      cursor += 1;
      continue;
    }

    cursor += 1;
  }

  return null;
}

function advancePastIdentifierChain(source, startIndex) {
  let cursor = startIndex;
  while (cursor < source.length) {
    const character = source[cursor];
    if (/[A-Za-z0-9_$]/.test(character)) {
      cursor += 1;
      continue;
    }

    if (character === '.') {
      cursor += 1;
      continue;
    }

    if (character === '[') {
      cursor += 1;
      while (cursor < source.length && /\s/.test(source[cursor])) {
        cursor += 1;
      }

      if (cursor >= source.length) {
        return cursor;
      }

      const bracketStart = source[cursor];
      if (bracketStart === '"' || bracketStart === '\'') {
        const literal = extractJsStringLiteral(source, cursor);
        if (!literal) {
          return cursor;
        }
        cursor += literal.length;
        while (cursor < source.length && /\s/.test(source[cursor])) {
          cursor += 1;
        }
        if (source[cursor] === ']') {
          cursor += 1;
          continue;
        }
        return cursor;
      }

      while (cursor < source.length && source[cursor] !== ']') {
        cursor += 1;
      }
      if (source[cursor] === ']') {
        cursor += 1;
      }
      continue;
    }

    if (character === ']') {
      cursor += 1;
      continue;
    }

    break;
  }

  return cursor;
}

function extractBalancedJson(source, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === '\\') {
      escaped = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function extractJsStringLiteral(source, startIndex) {
  const quote = source[startIndex];
  let cursor = startIndex + 1;
  let escaped = false;

  while (cursor < source.length) {
    const character = source[cursor];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === quote) {
      return source.slice(startIndex, cursor + 1);
    }
    cursor += 1;
  }

  return null;
}

function decodeJsStringLiteral(literal) {
  if (typeof literal !== 'string' || literal.length < 2) {
    return null;
  }

  const quote = literal[0];
  if ((quote !== '"' && quote !== '\'') || literal[literal.length - 1] !== quote) {
    return null;
  }

  let result = '';
  for (let index = 1; index < literal.length - 1; index += 1) {
    const character = literal[index];
    if (character === '\\') {
      index += 1;
      if (index >= literal.length - 1) {
        break;
      }

      const next = literal[index];
      switch (next) {
        case 'n':
          result += '\n';
          break;
        case 'r':
          result += '\r';
          break;
        case 't':
          result += '\t';
          break;
        case 'b':
          result += '\b';
          break;
        case 'f':
          result += '\f';
          break;
        case 'v':
          result += '\v';
          break;
        case '0':
          result += '\0';
          break;
        case '\\':
          result += '\\';
          break;
        case '\'':
          result += '\'';
          break;
        case '"':
          result += '"';
          break;
        case 'x': {
          const hex = literal.slice(index + 1, index + 3);
          if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
            result += String.fromCharCode(Number.parseInt(hex, 16));
            index += 2;
          } else {
            result += next;
          }
          break;
        }
        case 'u': {
          const hex = literal.slice(index + 1, index + 5);
          if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
            result += String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
          } else {
            result += next;
          }
          break;
        }
        default:
          result += next;
          break;
      }
    } else {
      result += character;
    }
  }

  return result;
}

function selectBestCaptionTrack(playerResponse) {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return null;
  }

  const viableTracks = tracks.filter((track) => track && typeof track.baseUrl === 'string' && track.baseUrl.trim().length > 0);
  if (viableTracks.length === 0) {
    return null;
  }

  const scored = viableTracks
    .map((track, index) => ({ track, index, score: scoreCaptionTrack(track) }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.index - b.index;
    });

  return scored[0]?.track ?? null;
}

function scoreCaptionTrack(track) {
  if (!track || typeof track !== 'object') {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;
  const languageCode = typeof track.languageCode === 'string' ? track.languageCode.toLowerCase() : '';
  const vssId = typeof track.vssId === 'string' ? track.vssId.toLowerCase() : '';
  const trackKind = typeof track.kind === 'string' ? track.kind.toLowerCase() : '';

  if (languageCode === 'en') {
    score += 30;
  } else if (languageCode.startsWith('en')) {
    score += 25;
  } else if (languageCode) {
    score += 10;
  }

  if (!trackKind) {
    score += 5;
  } else if (trackKind === 'asr') {
    score -= 5;
  }

  if (vssId.startsWith('a.')) {
    score -= 2;
  }

  if (track.isTranslatable) {
    score += 1;
  }

  return score;
}

function buildTimedTextRequestUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return null;
  }

  try {
    const url = new URL(baseUrl);
    url.searchParams.set('fmt', 'json3');
    return url.toString();
  } catch (error) {
    return null;
  }
}

async function fetchTimedTextJson(requestUrl) {
  if (typeof requestUrl !== 'string' || !requestUrl) {
    return null;
  }

  const response = await fetch(requestUrl, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Timed text request failed with status ${response.status}`);
  }

  const rawText = await response.text();
  const sanitized = stripXssiPrefix(rawText).trim();
  if (!sanitized) {
    return null;
  }

  try {
    return JSON.parse(sanitized);
  } catch (error) {
    throw new Error('Unable to parse timed text response as JSON.');
  }
}

function stripXssiPrefix(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return text.replace(/^\)\]\}'\s*/u, '');
}

function extractVideoIdFromUrl(videoUrl) {
  if (typeof videoUrl !== 'string') {
    return null;
  }

  try {
    const url = new URL(videoUrl);
    if (url.hostname === 'youtu.be') {
      return url.pathname.slice(1) || null;
    }
    if (url.searchParams.has('v')) {
      return url.searchParams.get('v');
    }
    const shortsMatch = url.pathname.match(/\/shorts\/([\w-]{11})/);
    if (shortsMatch) {
      return shortsMatch[1];
    }
  } catch (error) {
    return null;
  }

  const fallbackMatch = videoUrl.match(/(?:v=|\/)([\w-]{11})(?:[&?/]|$)/);
  if (fallbackMatch) {
    return fallbackMatch[1];
  }

  return null;
}

function parseTimedTextJson(json) {
  if (!json || !Array.isArray(json.events)) {
    return '';
  }

  const segments = [];
  for (const event of json.events) {
    if (!event || !Array.isArray(event.segs) || event.segs.length === 0) {
      continue;
    }

    const text = event.segs
      .map((segment) => (typeof segment?.utf8 === 'string' ? segment.utf8 : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .replace(/\s*\n\s*/g, ' ')
      .trim();

    if (!text) {
      continue;
    }

    const timestamp = formatMillisecondsToTimestamp(event.tStartMs ?? 0);
    segments.push(`[${timestamp}] ${text}`);
  }

  return segments.join('\n');
}

function formatMillisecondsToTimestamp(ms) {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

function formatTranscriptSegment(timestamp, text) {
  const normalizedText = (text || '').replace(/\s+/g, ' ').trim();
  const normalizedTimestamp = normalizeTimestamp(timestamp);
  if (normalizedText) {
    return `[${normalizedTimestamp}] ${normalizedText}`;
  }
  return `[${normalizedTimestamp}]`;
}

function normalizeTimestamp(raw) {
  if (typeof raw !== 'string') {
    return '00:00';
  }
  const cleaned = raw.replace(/[^0-9:]/g, '');
  if (!cleaned) {
    return '00:00';
  }

  const parts = cleaned.split(':').map((part) => Number.parseInt(part, 10)).filter((value) => !Number.isNaN(value));
  if (parts.length === 0) {
    return cleaned;
  }

  let totalSeconds = 0;
  for (const part of parts) {
    totalSeconds = totalSeconds * 60 + part;
  }

  if (!Number.isFinite(totalSeconds)) {
    return cleaned;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

function isChatUrl(url) {
  if (typeof url !== 'string') {
    return false;
  }
  return url.startsWith('https://chatgpt.com');
}

function normalizeChatHost(host) {
  if (typeof host === 'string') {
    const normalized = host
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*/, '');
    if (normalized === 'chatgpt.com') {
      return 'chatgpt.com';
    }
  }
  return 'chatgpt.com';
}

async function ensurePendingPromptsLoaded() {
  if (pendingLoaded) {
    return;
  }
  if (pendingLoadingPromise) {
    await pendingLoadingPromise;
    return;
  }

  pendingLoadingPromise = (async () => {
    try {
      const stored = await chrome.storage.session.get(PENDING_STORAGE_KEY);
      const rawEntries = stored?.[PENDING_STORAGE_KEY];
      if (rawEntries && typeof rawEntries === 'object') {
        const restored = new Map();
        for (const [key, value] of Object.entries(rawEntries)) {
          const numericKey = Number.parseInt(key, 10);
          if (Number.isNaN(numericKey)) {
            continue;
          }
          if (value && typeof value.prompt === 'string') {
            restored.set(numericKey, {
              prompt: value.prompt,
              attempts: Number.isFinite(value.attempts) ? value.attempts : 0,
              host: typeof value.host === 'string' ? value.host : undefined,
              autoSend: value.autoSend !== false,
              hasInjected: value.hasInjected === true
            });
          }
        }
        pendingPrompts = restored;
      } else {
        pendingPrompts = new Map();
      }
    } finally {
      pendingLoaded = true;
      pendingLoadingPromise = null;
    }
  })();

  await pendingLoadingPromise;
}

async function persistPendingPrompts() {
  await ensurePendingPromptsLoaded();
  if (pendingPrompts.size === 0) {
    await chrome.storage.session.remove(PENDING_STORAGE_KEY);
    return;
  }

  const serialized = {};
  for (const [tabId, value] of pendingPrompts.entries()) {
    serialized[String(tabId)] = {
      prompt: value.prompt,
      attempts: value.attempts ?? 0,
      host: value.host,
      autoSend: value.autoSend !== false,
      hasInjected: value.hasInjected === true
    };
  }

  await chrome.storage.session.set({ [PENDING_STORAGE_KEY]: serialized });
}

async function setPendingPrompt(tabId, data) {
  await ensurePendingPromptsLoaded();
  pendingPrompts.set(tabId, {
    ...data,
    attempts: data.attempts ?? 0,
    autoSend: data.autoSend !== false,
    hasInjected: data.hasInjected === true
  });
  await persistPendingPrompts();
}

async function removePendingPrompt(tabId) {
  await ensurePendingPromptsLoaded();
  if (!pendingPrompts.has(tabId)) {
    return;
  }
  pendingPrompts.delete(tabId);
  await persistPendingPrompts();
}

async function injectPromptAndSend(prompt, autoSend = true, hasInjected = false) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { status: 'permanent-failure', reason: 'Invalid prompt provided.' };
  }

  const shouldAutoSend = autoSend !== false;
  const normalizedPrompt = normalizeText(prompt);

  const preferredSelectors = [
    'textarea#prompt-textarea',
    'textarea[data-id="root"]',
    'textarea[data-id="prompt-textarea"]',
    'textarea[placeholder*="Send a message"]',
    '[contenteditable="true"]',
    '[role="textbox"]'
  ];

  const composer = findEditor(preferredSelectors);
  if (!composer) {
    return { status: 'retry', reason: 'Composer not found yet.', hasInjected: hasInjected === true };
  }

  const composerText = getComposerText(composer);
  const normalizedComposer = normalizeText(composerText);
  const promptAlreadyApplied = normalizedComposer === normalizedPrompt && normalizedPrompt.length > 0;

  if (hasInjected && !promptAlreadyApplied) {
    const lastTurnMatches = lastUserMessageMatchesPrompt(normalizedPrompt);
    const reason = !normalizedComposer
      ? 'Composer cleared after injection.'
      : lastTurnMatches
        ? 'Prompt already present in conversation.'
        : 'Composer content changed after injection.';
    return { status: 'manual-complete', reason, hasInjected: true, mode: 'manual' };
  }

  let didInject = hasInjected === true || promptAlreadyApplied;

  let composerReadyForSend = true;

  if (!promptAlreadyApplied) {
    if (!applyPromptToComposer(composer, prompt)) {
      return { status: 'permanent-failure', reason: 'Unable to write prompt into composer.', hasInjected: hasInjected === true };
    }
    didInject = true;

    if (shouldAutoSend) {
      composerReadyForSend = await ensureComposerReflectsPrompt(composer, normalizedPrompt);
    }
  }

  if (!shouldAutoSend) {
    focusComposer(composer);
    placeCaretAtEnd(composer);
    return { status: 'success', mode: 'manual', hasInjected: didInject };
  }

  if (!composerReadyForSend) {
    focusComposer(composer);
    placeCaretAtEnd(composer);
    return { status: 'manual-complete', reason: 'Composer did not stabilize before auto-send.', hasInjected: didInject, mode: 'manual' };
  }

  const sendSucceeded = await attemptAutoSend(composer, 5, 200);
  if (sendSucceeded) {
    return { status: 'success', hasInjected: didInject };
  }

  focusComposer(composer);
  placeCaretAtEnd(composer);
  return { status: 'retry', reason: 'Send button not ready.', hasInjected: didInject };

  function findEditor(selectors) {
    for (const selector of selectors) {
      const element = deepQuerySelector(selector);
      if (element && isEditable(element)) {
        return element;
      }
    }

    const matches = [];
    traverse(document, (node) => {
      if (node instanceof HTMLElement && isEditable(node)) {
        matches.push(node);
      }
    });

    if (matches.length === 0) {
      return null;
    }

    matches.sort((a, b) => getElementScore(b) - getElementScore(a));
    return matches[0];
  }

  function deepQuerySelector(selector) {
    const queue = [document.documentElement];
    const visited = new Set();

    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || visited.has(node)) {
        continue;
      }
      visited.add(node);

      if (node instanceof Element) {
        const found = node.querySelector(selector);
        if (found) {
          return found;
        }

        if (node.shadowRoot) {
          queue.push(node.shadowRoot);
        }
      }

      if (node instanceof ShadowRoot || node instanceof DocumentFragment) {
        queue.push(...node.children);
      }
    }

    return null;
  }

  function traverse(root, visitor) {
    const stack = [root];
    const seen = new Set();

    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || seen.has(node)) {
        continue;
      }
      seen.add(node);
      visitor(node);

      if (node instanceof Element) {
        if (node.shadowRoot) {
          stack.push(node.shadowRoot);
        }
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
          stack.push(node.children[i]);
        }
      } else if (node instanceof ShadowRoot || node instanceof DocumentFragment) {
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
          stack.push(node.children[i]);
        }
      }
    }
  }

  function isEditable(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.tagName === 'TEXTAREA') {
      return isVisible(element);
    }

    if (isContentEditableElement(element)) {
      return isVisible(element);
    }

    return false;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function getComposerText(element) {
    if (!element) {
      return '';
    }
    if ('value' in element && typeof element.value === 'string') {
      return element.value;
    }
    if (isContentEditableElement(element)) {
      return element.innerText || element.textContent || '';
    }
    return '';
  }

  function getElementScore(element) {
    const rect = element.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function applyPromptToComposer(element, value) {
    focusComposer(element);

    if ('value' in element) {
      setNativeValue(element, value);
      dispatchInputEvents(element, value);
      element.scrollTop = element.scrollHeight;
      placeCaretAtEnd(element);
      return true;
    }

    if (isContentEditableElement(element)) {
      clearEditableContent(element);
      const success = document.execCommand('insertText', false, value);
      if (!success || element.innerText.trim() !== value.trim()) {
        element.innerText = value;
      }
      dispatchInputEvents(element, value);
      element.scrollTop = element.scrollHeight;
      placeCaretAtEnd(element);
      return true;
    }

    return false;
  }

  function focusComposer(element) {
    if (!element || typeof element.focus !== 'function') {
      return;
    }
    try {
      element.focus({ preventScroll: false });
    } catch (error) {
      element.focus();
    }
  }

  function placeCaretAtEnd(element) {
    if (!element) {
      return;
    }

    if (typeof element.selectionStart === 'number' && typeof element.selectionEnd === 'number') {
      const length = element.value?.length ?? 0;
      element.selectionStart = length;
      element.selectionEnd = length;
      return;
    }

    if (isContentEditableElement(element)) {
      const selection = window.getSelection();
      if (!selection) {
        return;
      }
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection.addRange(range);
    }
  }

  function clearEditableContent(element) {
    const selection = window.getSelection();
    if (!selection) {
      element.innerHTML = '';
      return;
    }

    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.addRange(range);
    selection.deleteFromDocument();
  }

  function setNativeValue(element, value) {
    const { set: valueSetter } = Object.getOwnPropertyDescriptor(element, 'value') || {};
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLElement.prototype;
    const { set: prototypeSetter } = Object.getOwnPropertyDescriptor(prototype, 'value') || {};

    if (prototypeSetter && valueSetter !== prototypeSetter) {
      prototypeSetter.call(element, value);
    } else if (valueSetter) {
      valueSetter.call(element, value);
    } else {
      element.value = value;
    }
  }

  function dispatchInputEvents(element, value) {
    element.dispatchEvent(new Event('input', { bubbles: true }));
    try {
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: value,
          inputType: 'insertText'
        })
      );
    } catch (error) {
      // Ignore environments where InputEvent is not supported.
    }
  }

  function sendMessage(element) {
    const sendButton = findSendButton(element);
    if (sendButton) {
      if (!isSendButtonEnabled(sendButton)) {
        return false;
      }
      sendButton.click();
      clearComposer(element);
      return true;
    }

    if (!simulateEnterKey(element)) {
      return false;
    }

    clearComposer(element);
    return true;
  }

  function simulateEnterKey(element) {
    try {
      focusComposer(element);
      const keyDown = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      });
      const accepted = element.dispatchEvent(keyDown);
      if (!accepted) {
        return false;
      }

      const keyPress = new KeyboardEvent('keypress', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      });
      element.dispatchEvent(keyPress);

      const keyUp = new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      });
      element.dispatchEvent(keyUp);
      return true;
    } catch (error) {
      console.warn('Failed to simulate Enter key press', error);
      return false;
    }
  }

  function clearComposer(element) {
    if (!element) {
      return;
    }

    if ('value' in element) {
      setNativeValue(element, '');
      dispatchInputEvents(element, '');
      return;
    }

    if (isContentEditableElement(element)) {
      element.innerHTML = '';
      dispatchInputEvents(element, '');
      placeCaretAtEnd(element);
    }
  }

  function findSendButton(contextElement) {
    const candidates = [];
    traverse(document, (node) => {
      if (!(node instanceof HTMLElement)) {
        return;
      }

      if (!isPotentialSendButton(node)) {
        return;
      }

      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return;
      }

      candidates.push({ node, distance: distanceTo(contextElement, node) });
    });

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0].node;
  }

  function isSendButtonEnabled(button) {
    if (!(button instanceof HTMLElement)) {
      return false;
    }

    if (button.disabled) {
      return false;
    }

    const ariaDisabled = button.getAttribute('aria-disabled');
    if (ariaDisabled && ariaDisabled.toLowerCase() === 'true') {
      return false;
    }

    const dataDisabled = button.getAttribute('data-disabled') || button.dataset?.disabled;
    if (typeof dataDisabled === 'string' && dataDisabled.toLowerCase() === 'true') {
      return false;
    }

    try {
      const style = window.getComputedStyle(button);
      if (style.pointerEvents === 'none') {
        return false;
      }
      if (style.opacity && Number.parseFloat(style.opacity) < 0.2) {
        return false;
      }
    } catch (error) {
      // Ignore style lookup errors.
    }

    return true;
  }

  function isContentEditableElement(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    if (element.isContentEditable) {
      return true;
    }
    const contentEditable = element.getAttribute('contenteditable');
    if (contentEditable && contentEditable.toLowerCase() === 'true') {
      return true;
    }
    const role = element.getAttribute('role');
    return Boolean(role && role.toLowerCase() === 'textbox');
  }

  function isPotentialSendButton(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const role = element.getAttribute('role');
    if (element.tagName !== 'BUTTON' && role !== 'button') {
      return false;
    }

    const labelSources = [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.dataset?.testid,
      element.textContent
    ];

    const normalizedLabel = labelSources
      .filter(Boolean)
      .map((value) => value.trim().toLowerCase())
      .find((value) => value.includes('send') || value.includes('submit') || value.includes('enter'));

    if (normalizedLabel) {
      return true;
    }

    const datasetTestId = element.dataset?.testid || element.getAttribute('data-testid');
    if (datasetTestId && datasetTestId.toLowerCase().includes('send')) {
      return true;
    }

    return false;
  }

  function distanceTo(from, to) {
    try {
      const rectA = from.getBoundingClientRect();
      const rectB = to.getBoundingClientRect();
      const dx = rectB.left - rectA.left;
      const dy = rectB.top - rectA.top;
      return Math.sqrt(dx * dx + dy * dy);
    } catch (error) {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  async function attemptAutoSend(element, attempts, delayMs) {
    const maxAttempts = Math.max(1, attempts);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (sendMessage(element)) {
        return true;
      }
      if (attempt < maxAttempts - 1) {
        await wait(delayMs);
      }
    }
    return false;
  }

  async function ensureComposerReflectsPrompt(element, expectedValue) {
    const normalizedExpected = normalizeText(expectedValue);
    if (!normalizedExpected) {
      return false;
    }

    let confirmed = false;
    const maxChecks = 5;
    for (let check = 0; check < maxChecks; check += 1) {
      await wait(check === 0 ? 50 : 25);
      if (!element || !element.isConnected) {
        break;
      }

      const current = normalizeText(getComposerText(element));
      if (current !== normalizedExpected) {
        confirmed = false;
        continue;
      }

      if (confirmed) {
        return true;
      }
      confirmed = true;
    }

    return confirmed;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
  }

  function normalizeText(value) {
    if (typeof value !== 'string') {
      return '';
    }
    return value.replace(/\s+/g, ' ').trim();
  }

  function lastUserMessageMatchesPrompt(normalizedTarget) {
    if (!normalizedTarget) {
      return false;
    }

    const selectors = [
      '[data-message-author-role="user"]',
      '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
      '[data-testid^="conversation-turn-"] [data-message-author-role="user"]',
      'article[data-testid^="conversation-turn-"][data-role="user"]'
    ];

    const collected = [];
    const seen = new Set();
    for (const selector of selectors) {
      const matches = document.querySelectorAll(selector);
      for (const node of matches) {
        if (!(node instanceof HTMLElement) || seen.has(node)) {
          continue;
        }
        seen.add(node);
        collected.push(node);
      }
    }

    for (let index = collected.length - 1; index >= 0; index -= 1) {
      const node = collected[index];
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      const text = node.innerText || node.textContent || '';
      const normalizedText = normalizeText(text);
      if (normalizedText) {
        return normalizedText === normalizedTarget;
      }
    }
    return false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractPlayerResponseFromWatchHtml,
    extractJsonObjectFromAssignment,
    parseTranscriptFromReaderText,
    stripLeadingGlaspMetadataLines
  };
}
