const arrow = '<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14" stroke="currentColor" stroke-width="1.5"/></svg>';
const down = '<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v16m-6-6 6 6 6-6" stroke="currentColor" stroke-width="1.5"/></svg>';
const info = '<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M12 11v6" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="7.5" r="1" fill="currentColor"/></svg>';

export function escape(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function external(url, label, className = '') {
  return `<a class="text-link ${className}" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(label)}${arrow}<span class="sr-only"> (opens in a new tab)</span></a>`;
}

function projectMap(projects) {
  const height = projects.length * 44 + 28;
  const midpoint = height / 2;
  const paths = projects.map((project, index) => {
    const endpoint = index * 44 + 36;
    const path = `M32 ${midpoint} H76 C126 ${midpoint} 126 ${endpoint} 172 ${endpoint} H198`;
    return `<g data-route="${escape(project.slug)}"><path class="map-route" d="${path}"/><path class="map-signal" d="${path}" pathLength="100"/><circle class="map-terminal" cx="198" cy="${endpoint}" r="3"/></g>`;
  }).join('');
  return `<div class="project-map" data-project-map>
    <div class="map-heading"><span class="eyebrow">A few things I've built</span><button class="motion-toggle" type="button" data-motion-toggle aria-pressed="false" hidden><span class="motion-symbol" aria-hidden="true"></span><span data-motion-label>Pause motion</span></button></div>
    <div class="map-body">
      <svg class="map-lines" viewBox="0 0 440 ${height}" preserveAspectRatio="none" fill="none" aria-hidden="true">${paths}<circle class="map-root" cx="32" cy="${midpoint}" r="5"/><circle class="map-root-ring" cx="32" cy="${midpoint}" r="12"/></svg>
      <ol class="map-projects">${projects.map((project, index) => `<li><a href="#project-${escape(project.slug)}" data-map-project="${escape(project.slug)}"><span class="map-index">${String(index + 1).padStart(2, '0')}</span><span>${escape(project.name)}</span>${arrow}</a></li>`).join('')}</ol>
    </div>
    <span class="map-caption">Follow a thread. See where it goes.</span>
  </div>`;
}

function renderMedia(project) {
  const media = project.media;
  const { width, height } = media.dimensions || {};
  const sized = [width, height].every(value => Number.isFinite(value) && value > 0);
  const dimensions = sized ? ` width="${width}" height="${height}"` : '';
  const portrait = sized && height > width;
  const ratio = sized ? ` style="--media-ratio: ${width} / ${height}"` : '';
  const frame = media.type === 'video'
    ? `<video data-lazy-video data-src="${escape(media.src)}"${media.poster ? ` poster="${escape(media.poster)}"` : ''}${dimensions} muted playsinline loop preload="none" aria-label="${escape(media.alt)}">Your browser does not support this video.</video>
       <div class="video-controls" data-video-controls hidden>
         <label class="video-speed"><span aria-hidden="true">Speed</span><select data-video-speed aria-label="Playback speed for ${escape(project.name)}"><option value="1" selected>1×</option><option value="0.5">0.5×</option><option value="0.25">0.25×</option></select></label>
         <button type="button" class="video-toggle" data-video-toggle data-project-name="${escape(project.name)}" aria-label="Play video for ${escape(project.name)}" aria-pressed="false"><span data-video-label>Play video</span><svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 5 10 7-10 7V5Z" stroke="currentColor" stroke-width="1.5"/></svg></button>
       </div>
       <noscript><a class="video-fallback" href="${escape(media.src)}">Watch the ${escape(project.name)} recording ${arrow}</a></noscript>`
    : `<img src="${escape(media.src)}" alt="${escape(media.alt)}"${dimensions} loading="lazy" decoding="async">`;
  return `<figure class="project-media${portrait ? ' project-media--portrait' : ''}"${ratio}>${frame}</figure>`;
}

function renderProject(project, index) {
  return `<article class="project" id="project-${escape(project.slug)}" aria-labelledby="title-${escape(project.slug)}">
    <div class="project-copy">
      <p class="project-meta"><span class="project-number">${String(index + 1).padStart(2, '0')}</span>${project.category ? `<span>${escape(project.category)}</span>` : ''}${project.year ? `<span class="project-year">${escape(project.year)}</span>` : ''}</p>
      <h3 id="title-${escape(project.slug)}">${escape(project.name)}</h3>
      <p class="project-tagline">${escape(project.tagline)}</p>
      <p class="project-description">${escape(project.description)}</p>
      ${project.tags.length ? `<ul class="tags" aria-label="Project topics">${project.tags.map(tag => `<li>${escape(tag)}</li>`).join('')}</ul>` : ''}
      ${project.links.live || project.links.repo ? `<div class="project-links">${project.links.live ? external(project.links.live, 'Visit website') : ''}${project.links.repo ? external(project.links.repo, 'View source') : ''}</div>` : ''}
      ${project.features?.length ? `<details class="project-info" data-project-info><summary>${info}<span>Info<span class="sr-only"> about ${escape(project.name)}</span></span><svg class="icon info-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 10 5 5 5-5" stroke="currentColor" stroke-width="1.5"/></svg></summary><ul>${project.features.map(feature => `<li>${escape(feature)}</li>`).join('')}</ul></details>` : ''}
    </div>
    ${renderMedia(project)}
  </article>`;
}

export function render({ site, projects }, assets) {
  const canonical = site.url ? `<link rel="canonical" href="${escape(site.url)}"><meta property="og:url" content="${escape(site.url)}">` : '';
  return `<!doctype html>
<html lang="en" data-motion="paused">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f6f5ef">
  <title>${escape(site.title)}</title>
  <meta name="description" content="${escape(site.description)}">
  <meta property="og:title" content="${escape(site.title)}">
  <meta property="og:description" content="${escape(site.description)}">
  <meta property="og:type" content="website">
  ${canonical}
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${escape(assets.css)}">
  <script src="${escape(assets.js)}" defer></script>
</head>
<body id="top">
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header wrap">
    <a class="wordmark" href="#top" aria-label="${escape(site.name)} — back to top">${escape(site.name)}<span class="wordmark-dot" aria-hidden="true">.</span></a>
    <nav aria-label="Primary navigation"><a href="#work">Work<span class="nav-count">${String(projects.length).padStart(2, '0')}</span></a><a href="#about">About</a><a href="#contact">Contact ${arrow}</a></nav>
  </header>
  <main id="main" class="wrap" tabindex="-1">
    <section class="hero" aria-labelledby="hero-heading">
      <div class="hero-copy"><p class="eyebrow hero-eyebrow"><span class="small-mark" aria-hidden="true"></span>${escape(site.hero.eyebrow)}</p><h1 id="hero-heading">${escape(site.hero.headline)}</h1><p class="hero-description">${escape(site.hero.description)}</p><a class="text-link explore-link" href="#work">Explore the work ${down}</a></div>
      ${projectMap(projects)}
    </section>
    <section class="work-section" id="work" aria-labelledby="work-heading"><div class="section-heading"><h2 id="work-heading">Selected work<span class="section-period">.</span></h2><span class="eyebrow">${String(projects.length).padStart(2, '0')} projects / always curious</span></div>${projects.map(renderProject).join('')}</section>
    <section class="about-section" id="about" aria-labelledby="about-heading"><div><p class="eyebrow">A little context</p><h2 id="about-heading">${escape(site.about.heading)}</h2>${site.location ? `<p class="location">${escape(site.location)}</p>` : ''}</div><div class="about-copy">${site.about.paragraphs.map(paragraph => `<p>${escape(paragraph)}</p>`).join('')}</div></section>
    <section class="contact-section" id="contact" aria-labelledby="contact-heading"><p class="eyebrow">Get in touch</p><h2 id="contact-heading">${escape(site.contact.heading)}</h2><p class="contact-description">${escape(site.contact.text)}</p><a class="contact-email" href="mailto:${escape(site.contact.email)}">${escape(site.contact.email)}${arrow}</a>${site.contact.links.length ? `<div class="contact-links">${site.contact.links.map(link => external(link.url, link.label)).join('')}</div>` : ''}</section>
  </main>
  <footer class="site-footer wrap"><span>© ${new Date().getUTCFullYear()} ${escape(site.name)}</span><span class="footer-note">Made with curiosity.</span><a href="#top">Back to top <span aria-hidden="true">↑</span></a></footer>
</body>
</html>`;
}
