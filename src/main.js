(() => {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  const motionButton = document.querySelector('[data-motion-toggle]');
  const states = new Map();
  let motionPaused = motion.matches;

  function updateMotion() {
    const paused = motion.matches || motionPaused;
    root.dataset.motion = paused ? 'paused' : 'running';
    for (const [video, state] of states) {
      if (paused) video.pause();
      else if (state.inView && !state.userPaused && !document.hidden) play(video);
    }
    if (!motionButton) return;
    motionButton.hidden = motion.matches;
    motionButton.setAttribute('aria-pressed', String(paused));
    motionButton.querySelector('[data-motion-label]').textContent = paused ? 'Resume motion' : 'Pause motion';
  }

  motionButton?.addEventListener('click', () => {
    motionPaused = !motionPaused;
    updateMotion();
  });
  updateMotion();

  const map = document.querySelector('[data-project-map]');
  map?.querySelectorAll('[data-map-project]').forEach(link => {
    const route = map.querySelector(`[data-route="${link.dataset.mapProject}"]`);
    const highlight = () => route?.classList.add('is-active');
    const clear = () => route?.classList.remove('is-active');
    link.addEventListener('pointerenter', highlight);
    link.addEventListener('pointerleave', () => { if (document.activeElement !== link) clear(); });
    link.addEventListener('focus', highlight);
    link.addEventListener('blur', clear);
  });

  const videos = [...document.querySelectorAll('[data-lazy-video]')];

  function load(video) {
    if (!video.getAttribute('src')) {
      video.src = video.dataset.src;
      video.load();
    }
  }

  function play(video) {
    load(video);
    video.play().catch(() => { /* The play control remains available if autoplay is denied. */ });
  }

  function syncButton(video, button) {
    const label = video.paused ? 'Play video' : 'Pause video';
    button.querySelector('[data-video-label]').textContent = label;
    button.setAttribute('aria-label', `${label} for ${button.dataset.projectName}`);
    button.setAttribute('aria-pressed', String(!video.paused));
    button.querySelector('path').setAttribute('d', video.paused ? 'm9 5 10 7-10 7V5Z' : 'M8 5v14M16 5v14');
  }

  const observer = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const video = entry.target;
      const state = states.get(video);
      state.inView = entry.isIntersecting && entry.intersectionRatio >= 0.25;
      if (state.inView && !document.hidden && !motion.matches && !motionPaused && !state.userPaused) play(video);
      else if (!state.inView) video.pause();
    }
  }, { threshold: [0, 0.25] }) : null;

  for (const video of videos) {
    const button = video.parentElement.querySelector('[data-video-toggle]');
    const state = { inView: false, userPaused: false };
    states.set(video, state);
    video.muted = true;
    button.hidden = false;
    button.addEventListener('click', () => {
      if (video.paused) { state.userPaused = false; play(video); }
      else { state.userPaused = true; video.pause(); }
    });
    video.addEventListener('play', () => syncButton(video, button));
    video.addEventListener('pause', () => syncButton(video, button));
    observer?.observe(video);
  }

  motion.addEventListener('change', () => {
    motionPaused = motion.matches;
    updateMotion();
  });

  document.addEventListener('visibilitychange', () => {
    for (const [video, state] of states) {
      if (document.hidden) video.pause();
      else if (state.inView && !state.userPaused && !motion.matches && !motionPaused) play(video);
    }
  });
})();
