const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeTranscriptForPrompt } = require('../contentScript.js');

test('sanitizeTranscriptForPrompt removes Glasp header boilerplate', () => {
  const rawTranscript = [
    '& Summary',
    'Share Video',
    'Download .srt',
    'Copy',
    'Understanding AI in 2024',
    'Understanding AI in 2024',
    'Daniel.',
    'Daniel.',
    '',
    'Daniel: Welcome back everyone.',
    'Sarah: Thanks for having me!'
  ].join('\r\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.strictEqual(
    sanitized,
    'Daniel: Welcome back everyone.\nSarah: Thanks for having me!'
  );
});

test('sanitizeTranscriptForPrompt removes metadata lines before Glasp markers', () => {
  const rawTranscript = [
    'POV: If Tag was a Video Game…🤣 @DanielLaBelle #theboys #viral #shorts #tag #videogames',
    'September 15, 2025',
    'by The Johnson Brothers',
    'Share Video',
    'Download .srt',
    'Copy',
    'Daniel: Welcome back everyone.',
    'Sarah: Thanks for having me!'
  ].join('\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.strictEqual(
    sanitized,
    'Daniel: Welcome back everyone.\nSarah: Thanks for having me!'
  );
});

test('sanitizeTranscriptForPrompt removes single-line Glasp header boilerplate', () => {
  const rawTranscript = [
    '& SummaryPOV: If Tag this to revisit later. Share VideoDownload .srtCopy',
    'Daniel: Welcome back everyone.',
    'Sarah: Thanks for having me!'
  ].join('\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.strictEqual(
    sanitized,
    'Daniel: Welcome back everyone.\nSarah: Thanks for having me!'
  );
});

test('sanitizeTranscriptForPrompt splits inline Glasp header markers', () => {
  const rawTranscript = [
    'Understanding AI in 2024 • Jan 5, 2024 • by Daniel Johnson Share VideoDownload .srtCopyDaniel.',
    'Daniel: Welcome back everyone.',
    'Sarah: Thanks for having me!'
  ].join('\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.ok(
    sanitized.startsWith('Daniel.'),
    `Expected sanitized transcript to start with "Daniel." but received: ${sanitized}`
  );
});

test('sanitizeTranscriptForPrompt splits markers following inline text', () => {
  const rawTranscript = [
    'Understanding AI in 2024 • Jan 5, 2024 • by Daniel Johnson #videogamessShare VideoDownload .srtCopyDaniel.',
    'Daniel: Welcome back everyone.',
    'Sarah: Thanks for having me!'
  ].join('\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.ok(
    sanitized.startsWith('Daniel.'),
    `Expected sanitized transcript to start with "Daniel." but received: ${sanitized}`
  );
});

test('sanitizeTranscriptForPrompt strips zero-width separator characters around markers', () => {
  const zeroWidthSeparator = '\u2060';
  const rawTranscript = [
    `Understanding AI in 2024 • Jan 5, 2024 • by Daniel Johnson Share Video${zeroWidthSeparator}Download .srt${zeroWidthSeparator}Copy${zeroWidthSeparator}Daniel.`,
    'Daniel: Welcome back everyone.',
    'Sarah: Thanks for having me!'
  ].join('\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.ok(
    sanitized.startsWith('Daniel.'),
    `Expected sanitized transcript to start with "Daniel." but received: ${sanitized}`
  );
});

test('sanitizeTranscriptForPrompt handles zero-width characters inside marker words', () => {
  const zeroWidthJoiner = '\u200d';
  const shareWord = ['S', 'h', 'a', 'r', 'e'].join(zeroWidthJoiner);
  const videoWord = ['V', 'i', 'd', 'e', 'o'].join(zeroWidthJoiner);
  const downloadWord = ['D', 'o', 'w', 'n', 'l', 'o', 'a', 'd'].join(zeroWidthJoiner);
  const copyWord = ['C', 'o', 'p', 'y'].join(zeroWidthJoiner);
  const rawTranscript = [
    `Understanding AI in 2024 • Jan 5, 2024 • by Daniel Johnson ${shareWord} ${videoWord}${zeroWidthJoiner}${downloadWord} .srt${zeroWidthJoiner}${copyWord}`,
    'Daniel: Welcome back everyone.',
    'Sarah: Thanks for having me!'
  ].join('\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.strictEqual(
    sanitized,
    'Daniel: Welcome back everyone.\nSarah: Thanks for having me!'
  );
});

test('sanitizeTranscriptForPrompt handles directional zero-width marks inside markers', () => {
  const leftToRightMark = '\u200e';
  const rightToLeftMark = '\u200f';
  const shareWord = Array.from('Share').join(rightToLeftMark);
  const videoWord = Array.from('Video').join(leftToRightMark);
  const downloadWord = Array.from('Download').join(rightToLeftMark);
  const copyWord = Array.from('Copy').join(leftToRightMark);
  const rawTranscript = [
    `Understanding AI in 2024 • Jan 5, 2024 • by Daniel Johnson ${shareWord} ${videoWord}${leftToRightMark}${downloadWord} .srt${rightToLeftMark}${copyWord}${leftToRightMark}Daniel.`,
    'Daniel: Welcome back everyone.',
    'Sarah: Thanks for having me!'
  ].join('\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.ok(
    sanitized.startsWith('Daniel.'),
    `Expected sanitized transcript to start with "Daniel." but received: ${sanitized}`
  );
});

test('sanitizeTranscriptForPrompt preserves zero-width characters in body content', () => {
  const zeroWidthNonJoiner = '\u200c';
  const zeroWidthJoiner = '\u200d';
  const bodyLineOne = `Exploring${zeroWidthNonJoiner}techniques for design`;
  const bodyLineTwo = `Collaborative${zeroWidthJoiner}planning works well.`;
  const rawTranscript = [
    '& Summary',
    'Share Video',
    'Download .txt',
    'Copy',
    bodyLineOne,
    bodyLineTwo
  ].join('\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.strictEqual(sanitized, `${bodyLineOne}\n${bodyLineTwo}`);
});

test('sanitizeTranscriptForPrompt keeps regular sentences with marketing keywords intact', () => {
  const rawTranscript = [
    'Daniel: Download the dataset and copy the results later.',
    'Sarah: Sounds good.'
  ].join('\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.strictEqual(sanitized, rawTranscript);
});

test('sanitizeTranscriptForPrompt preserves opening dialogue before early markers', () => {
  const rawTranscript = [
    'Welcome to the show.',
    'Share Video',
    'Download .srt',
    'Copy',
    'Host: Let\'s get started.'
  ].join('\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.ok(
    sanitized.startsWith('Welcome to the show.'),
    `Expected sanitized transcript to begin with the opening dialogue but received: ${sanitized}`
  );
  assert.ok(
    sanitized.includes("Host: Let's get started."),
    'Expected sanitized transcript to retain subsequent dialogue line.'
  );
});
