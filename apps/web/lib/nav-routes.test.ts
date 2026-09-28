import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { SCHOOL_SECTIONS, visibleSections } from './nav';

/**
 * The navigation catalog and the route tree are kept in two different places - a
 * `href` string in a pure module, and a `page.tsx` under `app` on disk - and nothing
 * tied them together. That is how a nav entry can name a page that was never
 * recovered and render a dead link for every user who is granted the permission.
 *
 * This suite closes that gap by resolving every href against the real route tree on
 * disk, so a missing page fails the test instead of shipping.
 *
 * Route resolution mirrors the App Router: a href `/a/b` is served by
 * `app/a/b/page.tsx`, a dynamic segment `[id]` matches any single segment, and a
 * catch-all `[...slug]` matches the rest. Anything else - a layout-only directory, a
 * route group `(group)`, or a path with no `page.tsx` at all - is deliberately NOT a
 * match, so adding a nav entry pointing at a folder that holds no page still fails.
 */

/** Convert a route-tree directory path to the URL Next.js serves from it. */
const dirToUrl = (appRelative: string): string => {
  const segs = appRelative
    .split(path.sep)
    .filter(Boolean)
    // Route groups `(marketing)` do not appear in the URL.
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')));
  return `/${segs.join('/')}`;
};

/** Every URL the App Router can actually serve, derived from the `page.tsx` files under `app`. */
const realRoutes = (): string[] => {
  const appDir = path.resolve(import.meta.dirname, '..', 'app');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'page.tsx') {
        out.push(dirToUrl(path.relative(appDir, path.dirname(full))));
      }
    }
  };
  walk(appDir);
  return [...new Set(out)].sort();
};

const DYNAMIC = /^\[[^\]]+\]$/;

/** True when `url` is served by `route`, honouring one dynamic segment per position. */
const routeMatches = (route: string, url: string): boolean => {
  if (route === url) return true;
  const r = route.split('/').filter(Boolean);
  const u = url.split('/').filter(Boolean);
  if (r.length !== u.length) return false;
  return r.every((seg, i) => DYNAMIC.test(seg) || seg === u[i]);
};

const resolves = (url: string, routes: readonly string[]): boolean =>
  routes.some((route) => routeMatches(route, url));

describe('navigation catalog resolves to real pages', () => {
  const routes = realRoutes();

  it('found the App Router route tree (guards the test itself)', () => {
    // If the walk silently returned nothing, every assertion below would pass
    // vacuously. Pin a handful of routes that must exist for the app to be usable.
    expect(routes.length).toBeGreaterThan(10);
    for (const required of ['/', '/login', '/school', '/school/students', '/parent/results']) {
      expect(routes, `expected the route tree to contain ${required}`).toContain(required);
    }
  });

  it('every nav href is served by a real page - no dead links', () => {
    const dead = SCHOOL_SECTIONS.filter((s) => !resolves(s.href, routes)).map((s) => s.href);
    expect(
      dead,
      'these nav entries point at pages that do not exist, so a user granted the ' +
        'permission gets a dead link. Either recover the page or drop the entry.',
    ).toEqual([]);
  });

  it('the catalog is not silently empty (guards against a vacuous pass)', () => {
    expect(SCHOOL_SECTIONS.length).toBeGreaterThan(0);
    for (const section of SCHOOL_SECTIONS) {
      expect(section.href, 'a nav section has no href').toMatch(/^\//);
      expect(section.permission, `${section.href} has no permission gate`).toBeTruthy();
      expect(section.title, `${section.href} has no title`).toBeTruthy();
    }
  });

  it('a school_owner sees exactly the sections that all resolve', () => {
    // Mirrors the count pinned in nav.test.ts, but asserts the visible set is real
    // routes rather than only that the number matches.
    const owner = SCHOOL_SECTIONS.map((s) => s.permission);
    const visible = visibleSections(owner);
    expect(visible.length).toBe(SCHOOL_SECTIONS.length);
    for (const section of visible) {
      expect(resolves(section.href, routes), `${section.href} is visible but not a real route`).toBe(true);
    }
  });

  it('the parent/student portal routes referenced by the nav surfaces exist', () => {
    // These are reachable from the portal shells rather than from SCHOOL_SECTIONS, so
    // the loop above cannot cover them. Named explicitly so a removed portal page is
    // caught here.
    for (const url of ['/parent/attendance', '/parent/homework', '/parent/results', '/student/attendance', '/student/homework']) {
      expect(existsSync(path.resolve(import.meta.dirname, '..', 'app', ...url.split('/'), 'page.tsx')),
        `${url} is linked from a portal surface but has no page`).toBe(true);
    }
  });
});
