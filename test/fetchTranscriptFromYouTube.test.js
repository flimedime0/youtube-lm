const test = require('node:test');
const assert = require('node:assert/strict');

function createChromeStub() {
  return {
    runtime: { onMessage: { addListener: () => {} } },
    tabs: {
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onRemoved: { addListener: () => {}, removeListener: () => {} },
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
