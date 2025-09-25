const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('isConsentInterstitialHtml identifies consent interstitial markup', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'watch-consent.html');
  const html = fs.readFileSync(fixturePath, 'utf8');

  assert.equal(isConsentInterstitialHtml(html), true);
  assert.equal(extractPlayerResponseFromWatchHtml(html), null);
});
