const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPrompt } = require('../contentScript.js');

const baseSettings = {
  overviewSentences: 2,
  includeTakeaways: true,
  includeActionSteps: true,
  responseLanguage: 'English',
  customInstructions: 'Focus on clarity.\nKeep it short.',
  autoSendPrompt: true
};

test('buildPrompt returns a markdown-formatted message', () => {
  const prompt = buildPrompt({
    title: 'Demo Video',
    url: 'https://example.com/watch?v=123',
    transcript: ['Line one of the transcript.', 'Line two of the transcript.'].join('\n'),
    settings: baseSettings,
    creator: 'Demo Creator',
    uploadDate: new Date('2024-02-15T00:00:00Z'),
    referenceDate: new Date('2024-02-16T00:00:00Z')
  });

  assert.ok(prompt.includes('## Video details'));
  assert.ok(prompt.includes('- **Link:** <https://example.com/watch?v=123>'));
  assert.ok(prompt.includes('- **Title:** Demo Video'));
  assert.ok(prompt.includes('- **Creator:** Demo Creator'));
  assert.ok(prompt.includes('## Instructions'));
  assert.ok(prompt.includes('- Focus on clarity.'));
  assert.ok(prompt.includes('- Keep it short.'));
  assert.ok(prompt.includes('- Please give me a concise overview in 2 sentences.'));
  assert.ok(prompt.includes('- After that, add a bulleted list of the main takeaways.'));
  assert.ok(prompt.includes('- Call out any actionable steps or recommendations in their own short section.'));
  assert.ok(prompt.includes('- Write the entire response in English.'));
  assert.ok(prompt.includes('- Use the transcript below as your source material.'));
  assert.ok(prompt.includes('## Transcript'));
  assert.ok(prompt.includes('Line one of the transcript.'));
  assert.ok(prompt.includes('Line two of the transcript.'));
});

test('buildPrompt uses an alternate fence when transcript contains triple backticks', () => {
  const prompt = buildPrompt({
    title: 'Code Sample',
    url: 'https://example.com',
    transcript: ['```', 'console.log("test");', '```'].join('\n'),
    settings: {
      overviewSentences: 1,
      includeTakeaways: false,
      includeActionSteps: false,
      responseLanguage: 'English',
      customInstructions: '',
      autoSendPrompt: false
    },
    creator: 'Coder',
    uploadDate: null,
    referenceDate: new Date('2024-01-01T00:00:00Z')
  });

  const transcriptSection = prompt.slice(prompt.indexOf('## Transcript'));
  const lines = transcriptSection.trim().split('\n');
  assert.strictEqual(lines[0], '## Transcript');
  assert.strictEqual(lines[1], '~~~');
  assert.ok(lines.includes('```'));
  assert.strictEqual(lines[lines.length - 1], '~~~');
});
