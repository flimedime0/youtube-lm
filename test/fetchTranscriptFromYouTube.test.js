const test = require('node:test');
const assert = require('node:assert/strict');

function createEventEmitter() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    hasListener(listener) {
      return listeners.has(listener);
    },
    dispatch(...args) {
      for (const listener of [...listeners]) {
        try {
          listener(...args);
        } catch (error) {
          // ignore listener errors in tests
        }
      }
    }
  };
}

function createChromeStub() {
  const onUpdated = createEventEmitter();
  const onRemoved = createEventEmitter();

  return {
    runtime: { onMessage: { addListener: () => {} } },
    tabs: {
      onUpdated,
      onRemoved,
      create: async () => ({}),
      remove: async () => {},
      get: async () => ({})
    },
    storage: {
      session: {
        async get() {
          return {};
        },
        async set() {},
        async remove() {}
      },
      local: {
        async get() {
          return {};
        },
        async set() {},
        async remove() {}
      }
    },
    scripting: {
      async executeScript() {
        return [{ result: '' }];
      }
    }
  };
}

if (typeof global.chrome === 'undefined') {
  global.chrome = createChromeStub();
}

const {
  fetchTranscriptFromYouTube,
  parseTimedTextTrackListXml,
  buildTimedTextRequestFromTrack
} = require('../background.js');

test('fetchTranscriptFromYouTube falls back to timed text track list when watch page parsing fails', async () => {
  const originalFetch = global.fetch;
  let fetchCallCount = 0;

  const trackListXml = `<?xml version="1.0" encoding="utf-8"?>
<transcript_list>
  <track lang_code="en" lang_default="true" name="English" vss_id=".en" />
  <track lang_code="es" name="Español" />
</transcript_list>`;

  const timedTextResponse = ")]}'\n{\"events\":[{\"tStartMs\":0,\"segs\":[{\"utf8\":\"Hello world\"}]}]}";

  global.fetch = async (url) => {
    fetchCallCount += 1;

    if (url.includes('/watch')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return '<!doctype html>';
        }
      };
    }

    if (url.includes('type=list')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return trackListXml;
        }
      };
    }

    if (url.includes('timedtext')) {
      if (url.includes('lang=en')) {
        return {
          ok: true,
          status: 200,
          async text() {
            return timedTextResponse;
          }
        };
      }

      return {
        ok: false,
        status: 404,
        async json() {
          throw new Error('not found');
        }
      };
    }

    return {
      ok: false,
      status: 404,
      async text() {
        return '';
      }
    };
  };

  try {
    const transcript = await fetchTranscriptFromYouTube('https://www.youtube.com/watch?v=dummy');
    assert.strictEqual(transcript, '[00:00] Hello world');
    assert.ok(fetchCallCount >= 3, `expected multiple fetch attempts, received ${fetchCallCount}`);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchTranscriptFromYouTube loads a watch tab when direct fetch fails', async () => {
  const originalFetch = global.fetch;
  const originalCreate = chrome.tabs.create;
  const originalRemove = chrome.tabs.remove;
  const originalExecute = chrome.scripting.executeScript;

  const timedTextPayload = ")]}'\n{\"events\":[{\"tStartMs\":0,\"segs\":[{\"utf8\":\"Resolved via tab\"}]}]}";
  let executeCalls = 0;
  const createdTabs = [];

  global.fetch = async (url) => {
    if (url.includes('/watch')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return '<!doctype html><html><body>Before you continue to YouTube</body></html>';
        }
      };
    }

    if (url.includes('type=list')) {
      return {
        ok: false,
        status: 404,
        async text() {
          return '';
        }
      };
    }

    if (url.includes('timedtext') && url.includes('fmt=json3')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return timedTextPayload;
        }
      };
    }

    return {
      ok: false,
      status: 404,
      async text() {
        return '';
      }
    };
  };

  let nextTabId = 600;
  chrome.tabs.create = async ({ url }) => {
    const tabId = nextTabId++;
    createdTabs.push({ url, tabId });
    setImmediate(() => {
      chrome.tabs.onUpdated.dispatch(tabId, { status: 'complete' });
    });
    return { id: tabId };
  };

  chrome.tabs.remove = async () => {};

  chrome.scripting.executeScript = async ({ target }) => {
    executeCalls += 1;
    return [
      {
        result: {
          playerResponseJson: JSON.stringify({
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  {
                    baseUrl:
                      'https://www.youtube.com/api/timedtext?v=nyB5T_qZBE8&lang=en'
                  }
                ]
              }
            }
          })
        }
      }
    ];
  };

  try {
    const transcript = await fetchTranscriptFromYouTube('https://www.youtube.com/watch?v=nyB5T_qZBE8');
    assert.strictEqual(transcript, '[00:00] Resolved via tab');
    assert.ok(executeCalls >= 1, 'Expected to evaluate the watch tab for a player response');
    assert.ok(
      createdTabs.some(({ url }) => url.includes('youtube.com/watch')),
      'Expected to open a YouTube watch tab during fallback'
    );
  } finally {
    global.fetch = originalFetch;
    chrome.tabs.create = originalCreate;
    chrome.tabs.remove = originalRemove;
    chrome.scripting.executeScript = originalExecute;
  }
});

test('parseTimedTextTrackListXml decodes HTML entities and extracts track attributes', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<transcript_list>
  <track lang_code="en" name="English &amp; captions" kind="asr" vss_id="a.en" />
  <track lang_code="fr" name="Fran&amp;ccedil;ais" />
</transcript_list>`;

  const tracks = parseTimedTextTrackListXml(xml);
  assert.equal(tracks.length, 2);
  assert.deepStrictEqual(tracks[0], {
    lang_code: 'en',
    name: 'English & captions',
    kind: 'asr',
    vss_id: 'a.en'
  });
});

test('buildTimedTextRequestFromTrack constructs URL with optional parameters', () => {
  const url = buildTimedTextRequestFromTrack('video123', {
    lang_code: 'en',
    name: 'English',
    kind: 'asr',
    vss_id: 'a.en'
  });

  assert.ok(url.includes('v=video123'));
  assert.ok(url.includes('lang=en'));
  assert.ok(url.includes('fmt=json3'));
  assert.ok(url.includes('name=English'));
  assert.ok(url.includes('kind=asr'));
  assert.ok(url.includes('vssids=a.en'));
});
