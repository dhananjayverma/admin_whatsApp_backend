const crypto = require('crypto');

const WIDTH = 140;
const HEIGHT = 48;
const FONT_SIZE = 28;

/**
 * Generate a 5-digit numeric code for captcha.
 */
function generateCode() {
  return String(crypto.randomInt(10000, 99999));
}

/**
 * Create an SVG captcha image for the given text (e.g. "38791").
 * Distorted text and noise lines similar to classic captchas.
 */
function createSvg(text) {
  const chars = String(text).split('');
  const noiseLines = 4;
  let paths = [];

  // Noise lines
  for (let i = 0; i < noiseLines; i++) {
    const x1 = Math.random() * WIDTH;
    const y1 = Math.random() * HEIGHT;
    const x2 = Math.random() * WIDTH;
    const y2 = Math.random() * HEIGHT;
    const gray = 180 + Math.floor(Math.random() * 40);
    paths.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgb(${gray},${gray},${gray})" stroke-width="1"/>`);
  }

  // Text with slight random offset and rotation per character
  const spacing = WIDTH / (chars.length + 1);
  chars.forEach((char, i) => {
    const x = spacing * (i + 1) - FONT_SIZE / 3;
    const y = HEIGHT / 2 + FONT_SIZE / 3;
    const offsetX = (Math.random() - 0.5) * 8;
    const offsetY = (Math.random() - 0.5) * 6;
    const rotate = (Math.random() - 0.5) * 24;
    paths.push(
      `<text x="${x + offsetX}" y="${y + offsetY}" font-family="Arial, sans-serif" font-size="${FONT_SIZE}" font-weight="bold" fill="#333" transform="rotate(${rotate} ${x + offsetX} ${y + offsetY})">${escapeXml(char)}</text>`
    );
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="100%" height="100%" fill="#e8e8e8"/>
  ${paths.join('\n  ')}
</svg>`;
}

function escapeXml(c) {
  return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : c;
}

module.exports = { generateCode, createSvg };
