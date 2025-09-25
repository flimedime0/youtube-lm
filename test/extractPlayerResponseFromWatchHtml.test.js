const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

const { extractPlayerResponseFromWatchHtml, isConsentInterstitialHtml } = require('../background.js');

test('extractPlayerResponseFromWatchHtml parses assignments with fallback expressions', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'watch-with-fallback.html');
  const html = fs.readFileSync(fixturePath, 'utf8');

  const playerResponse = extractPlayerResponseFromWatchHtml(html);

  assert.ok(playerResponse, 'Expected a player response object');
  assert.deepStrictEqual(
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0]?.baseUrl,
    'https://example.com/captions'
  );
});

test('extractPlayerResponseFromWatchHtml skips non-JSON assignments and continues scanning', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'watch-with-multi-assignments.html');
  const html = fs.readFileSync(fixturePath, 'utf8');

  const playerResponse = extractPlayerResponseFromWatchHtml(html);

  assert.ok(playerResponse, 'Expected a player response object');
  assert.deepStrictEqual(
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0]?.baseUrl,
    'https://example.com/alt-captions'
  );
});

test('extractPlayerResponseFromWatchHtml parses JSON.parse(decodeURIComponent(...)) assignments', () => {
  const encoded =
    '%7B%22captions%22%3A%7B%22playerCaptionsTracklistRenderer%22%3A%7B%22captionTracks%22%3A%5B%7B%22baseUrl%22%3A%22https%3A%2F%2Fexample.com%2Fdecode-captions%22%7D%5D%7D%7D%7D';
  const html = [
    '<!DOCTYPE html>',
    '<html>',
    '  <body>',
    '    <script>',
    `      var ytInitialPlayerResponse = JSON.parse(decodeURIComponent("${encoded}"));`,
    '    </script>',
    '  </body>',
    '</html>'
  ].join('\n');

  const playerResponse = extractPlayerResponseFromWatchHtml(html);

  assert.ok(playerResponse, 'Expected a player response object');
  assert.deepStrictEqual(
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.[0]?.baseUrl,
    'https://example.com/decode-captions'
  );
});

test('isConsentInterstitialHtml identifies consent interstitial markup', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'watch-consent.html');
  const html = fs.readFileSync(fixturePath, 'utf8');

  assert.equal(isConsentInterstitialHtml(html), true);
  assert.equal(extractPlayerResponseFromWatchHtml(html), null);
});
