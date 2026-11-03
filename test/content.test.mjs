import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { validateContent, loadContent } from '../scripts/lib/content.mjs';
import { render } from '../src/render.mjs';

function fixture() {
  const site = { name: 'Test', title: 'Test portfolio', description: 'A test description', hero: { eyebrow: 'A test', headline: 'Sample headline', description: 'Sample introduction' }, about: { heading: 'About', paragraphs: ['A paragraph'] }, contact: { heading: 'Contact', text: 'Say hello', email: 'hello@example.com', links: [] } };
  const data = { projects: [{ slug: 'one', name: 'One', tagline: 'Test tagline', description: 'Test description', tags: ['Test'], links: { live: 'https://example.com' }, media: { type: 'image', src: '/media/one/screenshot.webp', alt: 'Test screenshot' }, order: 1 }] };
  return { site, data };
}

test('content sorting is deterministic and does not change the source array', () => {
  const { site, data } = fixture();
  data.projects.push({ ...structuredClone(data.projects[0]), slug: 'two', order: 0, media: { type: 'video', src: '/media/two/clip.mp4', poster: '/media/two/poster.webp', alt: 'Video example' } });
  const result = validateContent(site, data);
  assert.deepEqual(result.projects.map(project => project.slug), ['two', 'one']);
  assert.equal(data.projects[0].slug, 'one');
});

test('missing required copy and duplicate project identities fail with useful paths', () => {
  const { site, data } = fixture();
  site.hero.headline = ' ';
  assert.throws(() => validateContent(site, data), /site\.hero\.headline/);
  site.hero.headline = 'Heading';
  data.projects.push(structuredClone(data.projects[0]));
  assert.throws(() => validateContent(site, data), /duplicate slug: one/);
});

test('untrusted URL protocols and embedded credentials are rejected', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//example.com', 'https://user:secret@example.com']) {
    const { site, data } = fixture();
    data.projects[0].links.live = value;
    assert.throws(() => validateContent(site, data), /links\.live/);
  }
  const { site, data } = fixture();
  site.contact.email = 'test@example.com?subject=unexpected';
  assert.throws(() => validateContent(site, data), /contact\.email/);
});

test('media must stay inside its project directory and match its declared type', () => {
  for (const value of ['/media/one/../two/file.webp', '/media/one/%2e%2e/file.webp', '/media/two/file.webp', '/media/one//file.webp', '/media/one/file.mp4']) {
    const { site, data } = fixture();
    data.projects[0].media.src = value;
    assert.throws(() => validateContent(site, data), /media\.src/);
  }
});

test('the loader reports missing source JSON clearly', async () => {
  await assert.rejects(loadContent(new URL('./does-not-exist/', import.meta.url).pathname), /Cannot read content\/site\.json|Cannot read content\/projects\.json/);
});

test('rendered content stays text and project navigation is semantic', () => {
  const { site, data } = fixture();
  site.hero.headline = '<script>alert("x")</script>';
  data.projects[0].name = 'A & B';
  const html = render(validateContent(site, data), { css: '/assets/styles.css', js: '/assets/main.js' });
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /<article class="project" id="project-one" aria-labelledby="title-one">/);
  assert.match(html, /href="#project-one"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /A &amp; B/);
});

test('video output defers network loading and supplies accessible manual control', () => {
  const { site, data } = fixture();
  data.projects[0].media = { type: 'video', src: '/media/one/clip.mp4', poster: '/media/one/poster.webp', alt: 'A recording' };
  const html = render(validateContent(site, data), { css: '/assets/styles.css', js: '/assets/main.js' });
  assert.match(html, /data-src="\/media\/one\/clip.mp4"/);
  assert.match(html, /muted playsinline loop preload="none"/);
  assert.doesNotMatch(html, / autoplay[ >]/);
  assert.match(html, /aria-label="Play video for One"/);
});

test('real image and video poster dimensions reach the rendered previews', async () => {
  const content = await loadContent(fileURLToPath(new URL('../', import.meta.url)));
  for (const [slug, width, height] of [['ggo', 1280, 664], ['d2r', 1280, 720], ['ggs', 1280, 800], ['mhn', 360, 660]]) {
    assert.deepEqual(content.projects.find(project => project.slug === slug).media.dimensions, { width, height });
  }
  const html = render(content, { css: '/assets/styles.css', js: '/assets/main.js' });
  assert.match(html, /<img src="\/media\/ggo\/ggo.webp"[^>]*width="1280" height="664"/);
  assert.match(html, /<img src="\/media\/d2r\/d2r.webp"[^>]*width="1280" height="720"/);
  assert.match(html, /<figure class="project-media project-media--portrait" style="--media-ratio: 360 \/ 660">/);
  assert.match(html, /<video[^>]*poster="\/media\/mhn\/poster.webp" width="360" height="660"/);
  assert.doesNotMatch(html, /width="1440" height="900"/);
});

test('video without a poster keeps deferred loading and omits invented dimensions', () => {
  const { site, data } = fixture();
  data.projects[0].media = { type: 'video', src: '/media/one/clip.mp4', alt: 'A recording' };
  const html = render(validateContent(site, data), { css: '/assets/styles.css', js: '/assets/main.js' });
  const video = html.match(/<video[^>]*>/)[0];
  assert.match(video, /data-src="\/media\/one\/clip.mp4"/);
  assert.match(video, /preload="none"/);
  assert.doesNotMatch(video, /\s(?:poster|width|height)=/);
  assert.doesNotMatch(html, /project-media--portrait/);
});
