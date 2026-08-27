'use client';

import { useEffect } from 'react';

/**
 * Marks the nav link for whichever section is currently on screen.
 *
 * The rail's items are in-page anchors, so "where am I" is a scroll position
 * rather than a route. Without this, every item looks equally inactive and the
 * rail stops telling you anything — `aria-current` would be a static lie or
 * absent entirely.
 *
 * Implemented with IntersectionObserver rather than a scroll handler: the
 * browser does the geometry, and nothing runs on frames where nothing crossed a
 * boundary. It writes `aria-current` on the anchors directly instead of lifting
 * scroll position into React state, because re-rendering the whole shell on
 * every scroll to change one attribute is a lot of work to move one attribute.
 *
 * Degrades to nothing if the API is unavailable: links still navigate, they
 * simply do not highlight.
 */
export function ActiveSection() {
  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return undefined;

    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[data-nav-target]')];
    if (links.length === 0) return undefined;

    /** Targets that genuinely exist, so a missing section cannot break the rest. */
    const targets = new Map<Element, string>();
    for (const link of links) {
      const href = link.dataset['navTarget'];
      if (!href?.startsWith('#')) continue;
      const element = document.getElementById(href.slice(1));
      if (element) targets.set(element, href);
    }
    if (targets.size === 0) return undefined;

    const visible = new Map<string, number>();

    const paint = (): void => {
      // The most-visible section wins. Ties go to the earlier one in document
      // order, which is what a reader scrolling down expects.
      let best: string | null = null;
      let bestRatio = 0;
      for (const [href, ratio] of visible) {
        if (ratio > bestRatio) {
          bestRatio = ratio;
          best = href;
        }
      }
      for (const link of links) {
        const isCurrent = best !== null && link.dataset['navTarget'] === best;
        if (isCurrent) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const href = targets.get(entry.target);
          if (href === undefined) continue;
          if (entry.isIntersecting) visible.set(href, entry.intersectionRatio);
          else visible.delete(href);
        }
        paint();
      },
      {
        // Discount the sticky command bar at the top so a section is not
        // considered visible while it is hidden behind it.
        rootMargin: '-80px 0px -55% 0px',
        threshold: [0, 0.15, 0.35, 0.6, 1],
      },
    );

    for (const element of targets.keys()) observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return null;
}
