const BUTTON_ID = 'ytlm-summarize-btn';
const BUTTON_LABEL_DEFAULT = 'Summarize with ChatGPT';
const BUTTON_LABEL_LOADING = 'Fetching transcript…';
const BUTTON_LABEL_OPENING = 'Opening ChatGPT…';
const CAPTION_POLL_INTERVAL_MS = 400;
const CAPTION_POLL_TIMEOUT_MS = 12000;
const INNERTUBE_PLAYER_ENDPOINT = 'https://www.youtube.com/youtubei/v1/player';
const INNERTUBE_TRANSCRIPT_ENDPOINT = 'https://www.youtube.com/youtubei/v1/get_transcript';

let cachedCaptionTracks = null;
let cachedCaptionVideoId = null;
let pendingInnertubeCaptionPromise = null;
let pendingInnertubeVideoId = null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const addButtonIfNeeded = () => {
  if (document.getElementById(BUTTON_ID)) {
    return;
  }

  const container = document.querySelector('#top-row #actions #top-level-buttons-computed');
  const fallbackContainer = document.querySelector('#top-level-buttons-computed');
  const targetContainer = container || fallbackContainer;

  if (!targetContainer) {
    return;
  }

  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.textContent = BUTTON_LABEL_DEFAULT;

  const referenceButton =
    targetContainer.querySelector('button.yt-spec-button-shape-next') || targetContainer.querySelector('button');
  if (referenceButton) {
    button.className = referenceButton.className;
  } else {
    button.className = 'yt-spec-button-shape-next yt-spec-button-shape-next--outline yt-spec-button-shape-next--size-m';
  }

  button.setAttribute('aria-label', BUTTON_LABEL_DEFAULT);
  button.style.marginLeft = '8px';
  button.addEventListener('click', onButtonClick);
  targetContainer.appendChild(button);
};

const onButtonClick = async () => {
  const button = document.getElementById(BUTTON_ID);
  if (!button) {
    return;
  }

  button.disabled = true;
  button.textContent = BUTTON_LABEL_LOADING;

  try {
    const transcript = await fetchTranscript();
    if (!transcript) {
      alert('Transcript unavailable for this video.');
      button.textContent = BUTTON_LABEL_DEFAULT;
      button.disabled = false;
      return;
    }

    const titleElement = document.querySelector('h1.ytd-watch-metadata') || document.querySelector('h1.title');
    const title = titleElement ? titleElement.innerText.trim() : document.title;
    const prompt = buildPrompt({
      title,
      url: window.location.href,
      transcript
    });

    if (!chrome?.runtime?.sendMessage) {
      console.error('chrome.runtime.sendMessage is unavailable.');
      alert('Unable to communicate with the extension background script.');
      button.textContent = BUTTON_LABEL_DEFAULT;
      button.disabled = false;
      return;
    }

    button.textContent = BUTTON_LABEL_OPENING;
    chrome.runtime.sendMessage({ type: 'openChatGPT', prompt }, () => {
      if (chrome.runtime.lastError) {
        console.error('Failed to open ChatGPT tab', chrome.runtime.lastError);
        alert('Unable to open ChatGPT. Check extension permissions.');
      }

      button.textContent = BUTTON_LABEL_DEFAULT;
      button.disabled = false;
    });
  } catch (error) {
    console.error('Failed to fetch transcript', error);
    alert('An error occurred while fetching the transcript. See the console for details.');
    button.textContent = BUTTON_LABEL_DEFAULT;
    button.disabled = false;
  }
};

const buildPrompt = ({ title, url, transcript }) => {
  const trimmedTranscript = transcript.trim();
  return [
    'You are an expert note taker. Please summarize the following YouTube video transcript.',
    '',
    `Title: ${title}`,
    `URL: ${url}`,
    '',
    'Instructions:',
    '1. Provide a concise overview in 2-3 sentences.',
    '2. List the main takeaways as bullet points.',
    '3. Include any actionable steps separately if applicable.',
    '',
    'Transcript:',
    trimmedTranscript
  ].join('\n');
};

const waitForCaptionTrack = async () => {
  const deadline = Date.now() + CAPTION_POLL_TIMEOUT_MS;
  let attemptedInnertubeFetch = false;

  while (Date.now() < deadline) {
    const track = selectCaptionTrack();
    if (track) {
      return track;
    }

    if (!attemptedInnertubeFetch) {
      attemptedInnertubeFetch = true;
      try {
        const fetchedTracks = await ensureCaptionTracksFromInnertube();
        if (Array.isArray(fetchedTracks) && fetchedTracks.length > 0) {
          continue;
        }
      } catch (error) {
        console.debug('Failed to fetch caption tracks via InnerTube.', error);
      }
    }

    await delay(CAPTION_POLL_INTERVAL_MS);
  }

  return null;
};

const selectCaptionTrack = () => {
  const captionTracks = getCaptionTracks();
  if (!captionTracks || captionTracks.length === 0) {
    return null;
  }

  return captionTracks.find((item) => !item.kind || item.kind !== 'asr') || captionTracks[0];
};

const getCaptionTracks = () => {
  const cachedTracks = getCachedCaptionTracks();
  if (cachedTracks?.length) {
    return cachedTracks;
  }

  const playerResponseTracks = getCaptionTracksFromPlayerResponse();
  if (playerResponseTracks?.length) {
    cacheCaptionTracks(playerResponseTracks);
    return playerResponseTracks;
  }

  const playerOptionTracks = getCaptionTracksFromPlayerOptions();
  if (playerOptionTracks?.length) {
    cacheCaptionTracks(playerOptionTracks);
    return playerOptionTracks;
  }

  return null;
};

const getCaptionTracksFromPlayerResponse = () => {
  const playerResponse = getPlayerResponse();
  if (!playerResponse?.captions) {
    return null;
  }

  const tracklist =
    playerResponse.captions.playerCaptionsTracklistRenderer?.captionTracks ||
    playerResponse.captions.playerCaptionsRenderer?.captionTracks ||
    null;

  if (Array.isArray(tracklist) && tracklist.length > 0) {
    return sanitizeCaptionTracks(tracklist);
  }

  return null;
};

const getCaptionTracksFromPlayerOptions = () => {
  const playerElement = document.querySelector('ytd-player');
  const player = playerElement?.player_ || playerElement;

  if (!player?.getOption) {
    return null;
  }

  try {
    const trackList = player.getOption('captions', 'tracklist');
    if (Array.isArray(trackList) && trackList.length > 0) {
      const sanitizedTracks = sanitizeCaptionTracks(trackList);
      if (sanitizedTracks.length > 0) {
        cacheCaptionTracks(sanitizedTracks);
        return sanitizedTracks;
      }
    }
  } catch (error) {
    console.debug('Failed to read caption tracks from player options.', error);
  }

  return null;
};

const fetchTranscript = async () => {
  const track = await waitForCaptionTrack();
  if (!track) {
    return null;
  }

  if (track.baseUrl) {
    return fetchTranscriptFromBaseUrl(track.baseUrl);
  }

  if (track.params) {
    return fetchTranscriptFromParams(track.params);
  }

  return null;
};

const fetchTranscriptFromBaseUrl = async (baseUrl) => {
  const transcriptUrl = ensureJsonTranscriptFormat(baseUrl);
  const response = await fetch(transcriptUrl, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`Transcript request failed with status ${response.status}`);
  }

  const body = await response.text();

  try {
    const data = JSON.parse(body);
    const transcriptFromJson = parseJsonTranscript(data);
    if (transcriptFromJson) {
      return transcriptFromJson;
    }
  } catch (error) {
    console.debug('Transcript JSON parsing failed, attempting XML fallback.', error);
  }

  return parseXmlTranscript(body);
};

const fetchTranscriptFromParams = async (params) => {
  if (!params) {
    return null;
  }

  const apiKey = getInnertubeValue('INNERTUBE_API_KEY');
  if (!apiKey) {
    return null;
  }

  const contextPayload = buildInnertubeContext();
  if (!contextPayload) {
    return null;
  }

  try {
    const response = await fetch(`${INNERTUBE_TRANSCRIPT_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': contextPayload.clientNameHeader,
        'X-YouTube-Client-Version': contextPayload.clientVersion || ''
      },
      body: JSON.stringify({
        context: contextPayload.context,
        params
      })
    });

    if (!response.ok) {
      throw new Error(`InnerTube transcript request failed with status ${response.status}`);
    }

    const data = await response.json();
    const transcript = parseInnertubeTranscript(data);
    if (transcript) {
      return transcript;
    }
  } catch (error) {
    console.debug('Failed to load transcript from InnerTube transcript endpoint.', error);
  }

  return null;
};

const ensureJsonTranscriptFormat = (baseUrl) => {
  if (!baseUrl) {
    return baseUrl;
  }

  try {
    const url = new URL(baseUrl);
    if (!url.searchParams.has('fmt')) {
      url.searchParams.set('fmt', 'json3');
    }
    return url.toString();
  } catch (error) {
    console.debug('Falling back to string manipulation for transcript URL formatting.', error);
  }

  return baseUrl.includes('&fmt=') ? baseUrl : `${baseUrl}&fmt=json3`;
};

const parseJsonTranscript = (data) => {
  if (!data?.events) {
    return null;
  }

  const parts = [];
  for (const event of data.events) {
    if (!event.segs) {
      continue;
    }

    const text = event.segs.map((seg) => seg.utf8).join('');
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned) {
      parts.push(cleaned);
    }
  }

  return parts.join(' ');
};

const parseXmlTranscript = (xmlText) => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const textNodes = Array.from(doc.getElementsByTagName('text'));

  if (textNodes.length === 0) {
    return null;
  }

  const parts = textNodes
    .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
    .filter((value) => Boolean(value));

  return parts.join(' ');
};

const parseInnertubeTranscript = (data) => {
  const roots = [];
  const enqueue = (value) => {
    if (!value) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        enqueue(item);
      }
      return;
    }

    if (typeof value === 'object') {
      roots.push(value);
    }
  };

  enqueue(data?.actions);
  enqueue(data?.onResponseReceivedActions);
  enqueue(data?.onResponseReceivedEndpoints);
  enqueue(data?.commands);
  enqueue(data);

  const parts = [];
  const appendText = (value) => {
    if (typeof value !== 'string') {
      return;
    }

    const cleaned = value.replace(/\s+/g, ' ').trim();
    if (cleaned) {
      parts.push(cleaned);
    }
  };

  const seenCueRenderers = new WeakSet();
  const seenSegmentRenderers = new WeakSet();
  const visitedNodes = new WeakSet();

  const collectRunsText = (runs) => {
    if (!Array.isArray(runs) || runs.length === 0) {
      return '';
    }

    return runs
      .map((run) => {
        if (!run) {
          return '';
        }

        if (typeof run === 'string') {
          return run;
        }

        if (typeof run.text === 'string') {
          return run.text;
        }

        if (typeof run.simpleText === 'string') {
          return run.simpleText;
        }

        return '';
      })
      .join('');
  };

  const processCueRenderer = (renderer) => {
    if (!renderer || typeof renderer !== 'object') {
      return;
    }

    if (seenCueRenderers.has(renderer)) {
      return;
    }
    seenCueRenderers.add(renderer);

    const cue = renderer.cue || renderer;
    if (!cue || typeof cue !== 'object') {
      return;
    }

    const seenTexts = new Set();
    const registerText = (value) => {
      if (typeof value !== 'string') {
        return;
      }

      const cleaned = value.replace(/\s+/g, ' ').trim();
      if (!cleaned || seenTexts.has(cleaned)) {
        return;
      }

      seenTexts.add(cleaned);
      parts.push(cleaned);
    };

    const runSources = [
      cue.runs,
      cue.simpleRuns,
      cue.cue?.runs,
      cue.cue?.simpleRuns
    ];

    for (const runs of runSources) {
      const text = collectRunsText(runs);
      if (text) {
        registerText(text);
      }
    }

    const textFields = [
      cue.simpleText,
      cue.displayString,
      cue.text,
      cue.cue?.simpleText,
      cue.cue?.displayString,
      cue.cue?.text,
      cue.accessibilityData?.label,
      cue.cue?.accessibilityData?.label
    ];

    for (const field of textFields) {
      registerText(field);
    }
  };

  const processSegmentRenderer = (renderer) => {
    if (!renderer || typeof renderer !== 'object') {
      return;
    }

    if (seenSegmentRenderers.has(renderer)) {
      return;
    }
    seenSegmentRenderers.add(renderer);

    const textSources = [
      renderer.body?.text,
      renderer.snippet,
      renderer.title,
      renderer.subtitle
    ];

    for (const source of textSources) {
      if (!source || typeof source !== 'object') {
        continue;
      }

      const runText = collectRunsText(source.runs);
      if (runText) {
        appendText(runText);
      }

      appendText(source.simpleText);
      appendText(source.displayString);
      appendText(source.text);
    }
  };

  const processCueGroup = (group) => {
    if (!group || typeof group !== 'object') {
      return;
    }

    const cues = group.cues || group;
    if (Array.isArray(cues)) {
      for (const cue of cues) {
        if (cue?.transcriptCueRenderer) {
          processCueRenderer(cue.transcriptCueRenderer);
        } else {
          processCueRenderer(cue);
        }
      }
      return;
    }

    if (cues?.transcriptCueRenderer) {
      processCueRenderer(cues.transcriptCueRenderer);
    }
  };

  const visit = (node) => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (visitedNodes.has(node)) {
      return;
    }
    visitedNodes.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }

    if (node.transcriptCueGroupRenderer) {
      processCueGroup(node.transcriptCueGroupRenderer);
    }

    if (node.transcriptCueRenderer) {
      processCueRenderer(node.transcriptCueRenderer);
    }

    if (node.transcriptSegmentRenderer) {
      processSegmentRenderer(node.transcriptSegmentRenderer);
    }

    if (Array.isArray(node.cues)) {
      processCueGroup({ cues: node.cues });
    }

    const candidateKeys = [
      'body',
      'content',
      'contents',
      'items',
      'entries',
      'cueGroups',
      'continuationItems',
      'header',
      'footer',
      'panel',
      'sections',
      'subMenuItems'
    ];

    for (const key of candidateKeys) {
      if (node[key]) {
        visit(node[key]);
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        visit(value);
      }
    }
  };

  for (const root of roots) {
    visit(root);
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join(' ');
};

const getPlayerResponse = () => {
  const currentVideoId = getCurrentVideoId();
  const candidates = [];

  if (window.ytInitialPlayerResponse) {
    candidates.push(window.ytInitialPlayerResponse);
  }

  const watchFlexy = document.querySelector('ytd-watch-flexy');
  if (watchFlexy) {
    candidates.push(watchFlexy.playerResponse);
    candidates.push(watchFlexy.__data?.playerResponse);
    candidates.push(watchFlexy.data?.playerResponse);
  }

  const playerElement = document.querySelector('ytd-player');
  const player = playerElement?.player_ || playerElement;

  const resolvePlayerResponse = (candidate) => {
    if (!candidate) {
      return null;
    }

    const videoId = candidate?.videoDetails?.videoId;
    if (currentVideoId && videoId && videoId !== currentVideoId) {
      return null;
    }

    return candidate;
  };

  if (player?.getPlayerResponse) {
    try {
      candidates.push(player.getPlayerResponse());
    } catch (error) {
      console.warn('Failed to retrieve player response from player object.', error);
    }
  }

  if (playerElement?.getPlayerResponse) {
    try {
      candidates.push(playerElement.getPlayerResponse());
    } catch (error) {
      console.warn('Failed to retrieve player response from player element.', error);
    }
  }

  if (player) {
    candidates.push(player.playerResponse);
  }

  if (playerElement) {
    candidates.push(playerElement.playerResponse);
    candidates.push(playerElement.__data?.playerResponse);
    candidates.push(playerElement.data?.playerResponse);
  }

  if (typeof window.ytplayer !== 'undefined' && window.ytplayer?.config?.args?.player_response) {
    try {
      candidates.push(JSON.parse(window.ytplayer.config.args.player_response));
    } catch (error) {
      console.warn('Failed to parse player response from ytplayer config.', error);
    }
  }

  for (const candidate of candidates) {
    const resolved = resolvePlayerResponse(candidate);
    if (resolved) {
      if (resolved?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
        cacheCaptionTracks(resolved.captions.playerCaptionsTracklistRenderer.captionTracks);
      }
      if (resolved?.captions?.playerCaptionsRenderer?.captionTracks) {
        cacheCaptionTracks(resolved.captions.playerCaptionsRenderer.captionTracks);
      }
      return resolved;
    }
  }

  return null;
};

const cacheCaptionTracks = (tracks) => {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return;
  }

  const videoId = getCurrentVideoId();
  if (!videoId) {
    return;
  }

  const sanitizedTracks = sanitizeCaptionTracks(tracks);
  if (sanitizedTracks.length === 0) {
    return;
  }

  cachedCaptionVideoId = videoId;
  cachedCaptionTracks = sanitizedTracks;
};

const sanitizeCaptionTracks = (tracks) => {
  if (!Array.isArray(tracks)) {
    return [];
  }

  return tracks.filter((track) => track && (track.baseUrl || track.params));
};

const getCachedCaptionTracks = () => {
  const videoId = getCurrentVideoId();
  if (!videoId) {
    return null;
  }

  if (cachedCaptionVideoId !== videoId) {
    cachedCaptionVideoId = null;
    cachedCaptionTracks = null;
    return null;
  }

  return Array.isArray(cachedCaptionTracks) ? cachedCaptionTracks : null;
};

const ensureCaptionTracksFromInnertube = async () => {
  const videoId = getCurrentVideoId();
  if (!videoId) {
    return null;
  }

  const cachedTracks = getCachedCaptionTracks();
  if (cachedTracks?.length) {
    return cachedTracks;
  }

  if (pendingInnertubeCaptionPromise && pendingInnertubeVideoId === videoId) {
    return pendingInnertubeCaptionPromise;
  }

  pendingInnertubeVideoId = videoId;
  pendingInnertubeCaptionPromise = fetchCaptionTracksFromInnertube(videoId)
    .then((tracks) => {
      if (Array.isArray(tracks) && tracks.length > 0) {
        cacheCaptionTracks(tracks);
        return tracks;
      }
      return null;
    })
    .catch((error) => {
      console.debug('InnerTube caption track fetch failed.', error);
      return null;
    })
    .finally(() => {
      pendingInnertubeCaptionPromise = null;
      pendingInnertubeVideoId = null;
    });

  return pendingInnertubeCaptionPromise;
};

const fetchCaptionTracksFromInnertube = async (videoId) => {
  const apiKey = getInnertubeValue('INNERTUBE_API_KEY');
  if (!apiKey) {
    return null;
  }

  const contextPayload = buildInnertubeContext();
  if (!contextPayload) {
    return null;
  }

  try {
    const response = await fetch(`${INNERTUBE_PLAYER_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': contextPayload.clientNameHeader,
        'X-YouTube-Client-Version': contextPayload.clientVersion || ''
      },
      body: JSON.stringify({
        context: contextPayload.context,
        videoId
      })
    });

    if (!response.ok) {
      throw new Error(`InnerTube player request failed with status ${response.status}`);
    }

    const data = await response.json();
    const tracks =
      data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
      data?.captions?.playerCaptionsRenderer?.captionTracks ||
      null;

    if (Array.isArray(tracks)) {
      return sanitizeCaptionTracks(tracks);
    }
  } catch (error) {
    console.debug('Failed to load caption tracks from InnerTube player endpoint.', error);
  }

  return null;
};

const buildInnertubeContext = () => {
  const context = getInnertubeValue('INNERTUBE_CONTEXT');
  const clientName = getInnertubeValue('INNERTUBE_CLIENT_NAME') || context?.client?.clientName || 'WEB';
  const clientVersion = getInnertubeValue('INNERTUBE_CLIENT_VERSION') || context?.client?.clientVersion || '2.20210721.00.00';
  const hl = getInnertubeValue('HL') || context?.client?.hl || 'en';
  const gl = getInnertubeValue('GL') || context?.client?.gl || 'US';

  const resolvedContext = {
    ...(context || {}),
    client: {
      ...(context?.client || {}),
      clientName,
      clientVersion,
      hl,
      gl
    }
  };

  return {
    context: resolvedContext,
    clientVersion,
    clientNameHeader: mapClientNameToHeader(clientName)
  };
};

const mapClientNameToHeader = (clientName) => {
  const mapping = {
    WEB: '1',
    WEB_REMIX: '67',
    WEB_CREATOR: '62'
  };

  return mapping[clientName] || '1';
};

const getInnertubeValue = (key) => {
  try {
    if (typeof window.ytcfg?.get === 'function') {
      const value = window.ytcfg.get(key);
      if (typeof value !== 'undefined') {
        return value;
      }
    }
  } catch (error) {
    console.debug(`Failed to read ${key} from ytcfg.get`, error);
  }

  const data = window.ytcfg?.data_ || window.ytcfg?.data || null;
  if (data && typeof data === 'object' && key in data) {
    return data[key];
  }

  return null;
};

const getCurrentVideoId = () => {
  const urlVideoId = new URLSearchParams(window.location.search).get('v');
  if (urlVideoId) {
    return urlVideoId;
  }

  const playerElement = document.querySelector('ytd-player');
  const player = playerElement?.player_ || playerElement;

  if (player?.getVideoData) {
    try {
      const videoData = player.getVideoData();
      return videoData?.video_id || videoData?.videoId || null;
    } catch (error) {
      console.debug('Failed to read video data from player.', error);
    }
  }

  return playerElement?.__data?.playerResponse?.videoDetails?.videoId || null;
};

const observer = new MutationObserver(() => addButtonIfNeeded());
observer.observe(document.body, { childList: true, subtree: true });

window.addEventListener('yt-navigate-finish', () => {
  setTimeout(() => {
    addButtonIfNeeded();
  }, 1000);
});

addButtonIfNeeded();