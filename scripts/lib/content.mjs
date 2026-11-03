import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { imageDimensions } from './media.mjs';

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
}

function text(value, path) {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'expected a non-empty string');
}

function list(value, path, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) fail(path, `expected an array with at least ${minimum} item(s)`);
}

function url(value, path) {
  text(value, path);
  let parsed;
  try { parsed = new URL(value); } catch { fail(path, 'expected an absolute HTTP(S) URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail(path, 'expected an HTTP(S) URL without credentials');
  }
}

function mediaPath(value, slug, path) {
  text(value, path);
  const segments = value.slice(1).split('/');
  if (!value.startsWith(`/media/${slug}/`) || !/^\/media\/[a-z0-9-]+\/[a-zA-Z0-9/_.-]+$/.test(value)
    || segments.some(part => !part || part === '..' || part === '.')) {
    fail(path, `expected a local file beneath /media/${slug}/ without traversal or URL encoding`);
  }
}

export function validateContent(site, data) {
  object(site, 'site');
  for (const field of ['name', 'title', 'description']) text(site[field], `site.${field}`);
  if (site.url !== undefined) url(site.url, 'site.url');
  if (site.location !== undefined) text(site.location, 'site.location');
  object(site.hero, 'site.hero');
  for (const field of ['eyebrow', 'headline', 'description']) text(site.hero[field], `site.hero.${field}`);
  object(site.about, 'site.about');
  text(site.about.heading, 'site.about.heading');
  list(site.about.paragraphs, 'site.about.paragraphs', 1);
  site.about.paragraphs.forEach((paragraph, index) => text(paragraph, `site.about.paragraphs[${index}]`));
  object(site.contact, 'site.contact');
  for (const field of ['heading', 'text', 'email']) text(site.contact[field], `site.contact.${field}`);
  if (!/^[^\s@<>"?&#]+@[^\s@<>"?&#]+\.[^\s@<>"?&#]+$/.test(site.contact.email)) fail('site.contact.email', 'expected an email address');
  list(site.contact.links, 'site.contact.links');
  site.contact.links.forEach((link, index) => {
    const path = `site.contact.links[${index}]`;
    object(link, path);
    text(link.label, `${path}.label`);
    url(link.url, `${path}.url`);
  });
  object(data, 'projects');
  list(data.projects, 'projects.projects', 1);
  const slugs = new Set();
  data.projects.forEach((project, index) => {
    const path = `projects.projects[${index}]`;
    object(project, path);
    for (const field of ['slug', 'name', 'tagline', 'description']) text(project[field], `${path}.${field}`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.slug)) fail(`${path}.slug`, 'use lowercase letters, numbers and single hyphens');
    if (slugs.has(project.slug)) fail(`${path}.slug`, `duplicate slug: ${project.slug}`);
    slugs.add(project.slug);
    for (const field of ['year', 'category']) if (project[field] !== undefined) text(project[field], `${path}.${field}`);
    if (typeof project.order !== 'number' || !Number.isFinite(project.order)) fail(`${path}.order`, 'expected a finite number');
    if (project.features !== undefined) {
      list(project.features, `${path}.features`);
      project.features.forEach((feature, index) => text(feature, `${path}.features[${index}]`));
    }
    list(project.tags, `${path}.tags`);
    project.tags.forEach((tag, index) => text(tag, `${path}.tags[${index}]`));
    if (new Set(project.tags).size !== project.tags.length) fail(`${path}.tags`, 'tags must be unique');
    object(project.links, `${path}.links`);
    for (const field of ['live', 'repo']) if (project.links[field] !== undefined) url(project.links[field], `${path}.links.${field}`);
    object(project.media, `${path}.media`);
    if (!['image', 'video'].includes(project.media.type)) fail(`${path}.media.type`, 'expected image or video');
    text(project.media.alt, `${path}.media.alt`);
    mediaPath(project.media.src, project.slug, `${path}.media.src`);
    const imageTypes = /\.(avif|gif|jpe?g|png|svg|webp)$/i;
    const videoTypes = /\.(mp4|webm|ogv)$/i;
    if (!(project.media.type === 'image' ? imageTypes : videoTypes).test(project.media.src)) {
      fail(`${path}.media.src`, 'file extension must match the media type');
    }
    if (project.media.poster !== undefined) {
      mediaPath(project.media.poster, project.slug, `${path}.media.poster`);
      if (!imageTypes.test(project.media.poster)) fail(`${path}.media.poster`, 'expected an image file');
    }
  });
  return { site, projects: [...data.projects].sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug)) };
}

export async function loadContent(root) {
  async function json(file) {
    try { return JSON.parse(await readFile(resolve(root, 'content', file), 'utf8')); }
    catch (error) { throw new Error(`Cannot read content/${file}: ${error.message}`); }
  }
  const [site, data] = await Promise.all([json('site.json'), json('projects.json')]);
  const content = validateContent(site, data);
  for (const project of content.projects) {
    for (const asset of [project.media.src, project.media.poster].filter(Boolean)) {
      const file = resolve(root, 'public', asset.slice(1));
      try {
        if (!(await stat(file)).isFile()) throw new Error('not a file');
      } catch { throw new Error(`Missing media for ${project.slug}: public${asset}`); }
    }
    const preview = project.media.type === 'image' ? project.media.src : project.media.poster;
    project.media.dimensions = preview
      ? await imageDimensions(resolve(root, 'public', preview.slice(1)))
      : undefined;
  }
  return content;
}
