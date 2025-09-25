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
  parseTranscriptFromReaderText,
  stripLeadingGlaspMetadataLines
} = require('../background.js');

test('stripLeadingGlaspMetadataLines removes Glasp header metadata', () => {
  const lines = [
    '#philosophaire',
    'September 18, 2025',
    'by',
    'Philosophaire',
    '#philosophaires',
    'Share Video',
    'Download .srt',
    'Copy',
    'As you get older, you start seeing things differently.'
  ];

  const stripped = stripLeadingGlaspMetadataLines(lines);

  assert.deepStrictEqual(stripped, [
    'As you get older, you start seeing things differently.'
  ]);
});

test('parseTranscriptFromReaderText drops Glasp metadata headers', () => {
  const pageText = [
    'Glasp Reader',
    'YouTube Transcript & Summary',
    '#philosophaire',
    'September 18, 2025',
    'by',
    'Philosophaire',
    'YouTube video player',
    '#philosophaires',
    'Transcripts',
    'Share Video',
    'Download .srt',
    'Copy Transcript',
    'Summarize Transcript',
    'English (auto-generated)',
    'As you get older, you start seeing things differently.',
    'You notice how people affect your peace.'
  ].join('\n');

  const parsed = parseTranscriptFromReaderText(pageText);

  assert.strictEqual(
    parsed,
    [
      'As you get older, you start seeing things differently.',
      'You notice how people affect your peace.'
    ].join('\n')
  );
});

test('stripLeadingGlaspMetadataLines removes glued metadata tokens', () => {
  const lines = [
    '#creatorShare VideoDownload .srtCopy',
    'September 19, 2025',
    'by Creator Name',
    'Opening line of the transcript.'
  ];

  const stripped = stripLeadingGlaspMetadataLines(lines);

  assert.deepStrictEqual(stripped, ['Opening line of the transcript.']);
});

test('stripLeadingGlaspMetadataLines trims fused metadata and preserves transcript', () => {
  const lines = [
    '#philosophaireSeptember 23, 2025#philosophairesShare VideoDownload .srtCopyAs you get older, you start seeing things differently.'
  ];

  const stripped = stripLeadingGlaspMetadataLines(lines);

  assert.deepStrictEqual(stripped, [
    'As you get older, you start seeing things differently.'
  ]);
});

test('stripLeadingGlaspMetadataLines keeps genuine transcript lines beginning with By', () => {
  const lines = [
    'By popular demand, welcome back.',
    'Second line continues the thought.'
  ];

  const stripped = stripLeadingGlaspMetadataLines(lines);

  assert.deepStrictEqual(stripped, [
    'By popular demand, welcome back.',
    'Second line continues the thought.'
  ]);
});

test('stripLeadingGlaspMetadataLines removes fused title/date metadata before controls', () => {
  const lines = [
    'Solve Any Problem With This 1 Simple MethodApril 27, 2025byGrindBuddySolve Any Problem With This 1 Simple MethodsShare VideoDownload .srtCopygo into the silence go and sit down quietly.'
  ];

  const stripped = stripLeadingGlaspMetadataLines(lines);

  assert.deepStrictEqual(stripped, ['go into the silence go and sit down quietly.']);
});

test('parseTranscriptFromReaderText handles fused metadata header text', () => {
  const pageText = [
    'Glasp Reader',
    'YouTube Transcript & Summary',
    '#philosophaireSeptember 23, 2025#philosophairesShare VideoDownload .srtCopy',
    'As you get older, you start seeing things differently.',
    'You notice how people affect your peace.'
  ].join('\n');

  const parsed = parseTranscriptFromReaderText(pageText);

  assert.strictEqual(
    parsed,
    [
      'As you get older, you start seeing things differently.',
      'You notice how people affect your peace.'
    ].join('\n')
  );
});
