const BUTTON_ID = 'ytlm-summarize-btn';
const BUTTON_LABEL_DEFAULT = 'Summarize with ChatGPT';
const BUTTON_LABEL_LOADING = 'Fetching transcript…';
const BUTTON_LABEL_OPENING = 'Opening ChatGPT…';
const CAPTION_POLL_INTERVAL_MS = 400;
const CAPTION_POLL_TIMEOUT_MS = 8000;

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

  while (Date.now() < deadline) {
    const track = selectCaptionTrack();
    if (track) {
      return track;
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
  const playerResponseTracks = getCaptionTracksFromPlayerResponse();
  if (playerResponseTracks?.length) {
    return playerResponseTracks;
  }

  const playerOptionTracks = getCaptionTracksFromPlayerOptions();
  if (playerOptionTracks?.length) {
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
    return tracklist;
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
      return trackList.filter((track) => track && track.baseUrl);
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

  const transcriptUrl = ensureJsonTranscriptFormat(track.baseUrl);
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
      return resolved;
    }
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
