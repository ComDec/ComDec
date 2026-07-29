#!/usr/bin/env node
/**
 * Renders the "at a glance" card for the profile README.
 *
 * The usual hosted card services (github-readme-stats and friends) are either paused
 * or off-palette, so the card is generated here instead: same colours and proportions
 * as comdec.github.io, committed as SVG, refreshed by .github/workflows/stats.yml.
 *
 *   GITHUB_TOKEN=... node scripts/generate-stats.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOGIN = process.env.PROFILE_LOGIN || "ComDec";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets");

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required (repo-scoped or the workflow's default token).");
  process.exit(1);
}

/* ------------------------------------------------------------------ palette */

const THEMES = {
  light: {
    bg: "#f4f5f2",
    surface: "#fbfcfa",
    ink: "#1d2423",
    inkSoft: "#414b49",
    muted: "#6c7674",
    faint: "#929a97",
    line: "#d8ded9",
    accent: "#bd6543",
    accentStrong: "#98492f",
    secondary: "#2f6e67",
  },
  dark: {
    bg: "#151817",
    surface: "#1b1f1d",
    ink: "#f0efe9",
    inkSoft: "#c4c8c2",
    muted: "#929b96",
    faint: "#707873",
    line: "#323835",
    accent: "#df8b68",
    accentStrong: "#f0a483",
    secondary: "#78b3aa",
  },
};

/* --------------------------------------------------------------- data layer */

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": `${LOGIN}-profile-stats`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const QUERY = `
query($login: String!, $cursor: String) {
  user(login: $login) {
    followers { totalCount }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount weekday } }
      }
    }
    repositories(
      first: 100
      after: $cursor
      ownerAffiliations: OWNER
      isFork: false
      orderBy: { field: STARGAZERS, direction: DESC }
    ) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        stargazerCount
        languages(first: 12, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

async function collect() {
  let cursor = null;
  let user = null;
  const repos = [];
  do {
    const data = await graphql(QUERY, { login: LOGIN, cursor });
    user = data.user;
    repos.push(...user.repositories.nodes);
    cursor = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null;
  } while (cursor);

  const stars = repos.reduce((sum, r) => sum + r.stargazerCount, 0);

  // Raw byte counts are dominated by whichever repo happens to contain generated HTML or
  // large notebooks, which says nothing about what the work actually is. Each repo's own
  // language mix is therefore weighted by sqrt(size), so big repos still count for more
  // but cannot drown out a dozen smaller ones.
  const bytes = new Map();
  for (const repo of repos) {
    const repoTotal = repo.languages.edges.reduce((sum, e) => sum + e.size, 0);
    if (!repoTotal) continue;
    const weight = Math.sqrt(repoTotal);
    for (const edge of repo.languages.edges) {
      const key = edge.node.name;
      const prev = bytes.get(key) || { size: 0, color: edge.node.color };
      bytes.set(key, {
        size: prev.size + (edge.size / repoTotal) * weight,
        color: prev.color || edge.node.color,
      });
    }
  }
  const total = [...bytes.values()].reduce((sum, v) => sum + v.size, 0) || 1;
  const languages = [...bytes.entries()]
    .map(([name, v]) => ({ name, share: v.size / total, color: v.color }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 5);
  const shown = languages.reduce((sum, l) => sum + l.share, 0);
  if (shown < 0.999) languages.push({ name: "Other", share: 1 - shown, color: null });

  const calendar = user.contributionsCollection.contributionCalendar;

  return {
    stars,
    repos: user.repositories.totalCount,
    followers: user.followers.totalCount,
    contributions: calendar.totalContributions,
    weeks: calendar.weeks,
    languages,
  };
}

/* ------------------------------------------------------------------- render */

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const SERIF = "Instrument Serif, Iowan Old Style, Palatino, Georgia, serif";
const SANS = "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif";

const W = 880;
const H = 232;
const PAD = 34;

function card(stats, theme, updated) {
  const c = THEMES[theme];
  const metrics = [
    { value: stats.stars.toLocaleString("en-US"), label: "Stars earned" },
    { value: stats.repos.toLocaleString("en-US"), label: "Public repositories" },
    { value: stats.contributions.toLocaleString("en-US"), label: "Contributions (12 mo)" },
    { value: stats.followers.toLocaleString("en-US"), label: "Followers" },
  ];

  const colW = (W - PAD * 2) / metrics.length;
  const metricRow = metrics
    .map((m, i) => {
      const x = PAD + colW * i;
      return `
    <text x="${x}" y="112" font-family="${SERIF}" font-size="42" fill="${c.ink}">${esc(m.value)}</text>
    <text x="${x}" y="134" font-family="${SANS}" font-size="11" font-weight="500" letter-spacing="0.9" fill="${c.muted}">${esc(
        m.label.toUpperCase()
      )}</text>`;
    })
    .join("");

  // stacked language bar
  const barY = 168;
  const barW = W - PAD * 2;
  let cursor = PAD;
  const fallback = [c.accent, c.secondary, c.accentStrong, c.faint, c.line];
  const segments = stats.languages
    .map((lang, i) => {
      const w = Math.max(2, barW * lang.share);
      const fill = lang.color || fallback[i % fallback.length];
      const seg = `<rect x="${cursor.toFixed(2)}" y="${barY}" width="${w.toFixed(
        2
      )}" height="9" rx="4.5" fill="${fill}" opacity="0.9"/>`;
      cursor += w + 2;
      return seg;
    })
    .join("\n    ");

  let legendX = PAD;
  const legend = stats.languages
    .map((lang, i) => {
      const label = `${lang.name} ${(lang.share * 100).toFixed(1)}%`;
      const fill = lang.color || fallback[i % fallback.length];
      const item = `
    <circle cx="${legendX + 4}" cy="${barY + 36}" r="4" fill="${fill}"/>
    <text x="${legendX + 15}" y="${barY + 40}" font-family="${SANS}" font-size="11.5" fill="${
        c.inkSoft
      }">${esc(label)}</text>`;
      legendX += 30 + label.length * 6.1;
      return item;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="GitHub activity summary for ${esc(
    LOGIN
  )}">
  <defs>
    <clipPath id="cardClip"><rect x="0" y="0" width="${W}" height="${H}" rx="10"/></clipPath>
  </defs>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${c.bg}" stroke="${c.line}"/>
  <g clip-path="url(#cardClip)">
    <rect x="0" y="0" width="120" height="3" fill="${c.accent}"/>
    <rect x="123" y="0" width="46" height="3" fill="${c.secondary}"/>
  </g>

  <text x="${PAD}" y="${PAD + 18}" font-family="${SANS}" font-size="11" font-weight="600" letter-spacing="2.4" fill="${
    c.accentStrong
  }">AT A GLANCE</text>
  <text x="${W - PAD}" y="${PAD + 18}" text-anchor="end" font-family="${SANS}" font-size="10.5" fill="${
    c.muted
  }">updated ${esc(updated)}</text>
  <line x1="${PAD}" y1="${PAD + 32}" x2="${W - PAD}" y2="${PAD + 32}" stroke="${c.line}"/>
  ${metricRow}
  <line x1="${PAD}" y1="150" x2="${W - PAD}" y2="150" stroke="${c.line}"/>
  ${segments}${legend}
</svg>
`;
}

/* -------------------------------------------------- contribution calendar */

const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;
const CAL_LEFT = PAD + 26; // room for the Mon/Wed/Fri labels
const CAL_TOP = 96;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The palette is a five-step ramp from the neutral rule colour to full accent, so an
// empty day still reads as part of the grid rather than as a hole in it.
function ramp(theme) {
  const c = THEMES[theme];
  return theme === "light"
    ? [c.line, "#e6cfc3", "#dba98e", "#c97a55", c.accentStrong]
    : ["#272c2a", "#4a342b", "#79503c", "#b0704f", c.accentStrong];
}

function calendarCard(stats, theme, updated) {
  const c = THEMES[theme];
  const colours = ramp(theme);
  const weeks = stats.weeks;

  const counts = weeks.flatMap((w) => w.contributionDays.map((d) => d.contributionCount)).filter((n) => n > 0).sort((a, b) => a - b);
  // quartile thresholds, so the ramp adapts to how active the year actually was
  const q = (p) => counts.length ? counts[Math.min(counts.length - 1, Math.floor(counts.length * p))] : 1;
  const cuts = [q(0.25), q(0.5), q(0.75), q(0.9)];
  const level = (n) => {
    if (n <= 0) return 0;
    let l = 1;
    for (const cut of cuts) if (n > cut) l++;
    return Math.min(4, l);
  };

  const width = CAL_LEFT + weeks.length * STEP + PAD - GAP;
  const height = CAL_TOP + 7 * STEP + 46;

  let cells = "";
  let monthLabels = "";
  let lastMonth = -1;
  weeks.forEach((week, wi) => {
    const x = CAL_LEFT + wi * STEP;
    const first = week.contributionDays[0];
    if (first) {
      const m = Number(first.date.slice(5, 7)) - 1;
      const dayOfMonth = Number(first.date.slice(8, 10));
      // The window opens mid-month, so week 0 usually belongs to the previous month and
      // its label would sit one column away from the next one. Drop that leading label.
      const leadingStub = wi === 0 && dayOfMonth > 7;
      if (m !== lastMonth) {
        lastMonth = m;
        if (!leadingStub && wi < weeks.length - 1) {
          monthLabels += `\n  <text x="${x}" y="${CAL_TOP - 10}" font-family="${SANS}" font-size="10.5" fill="${
            c.muted
          }">${MONTHS[m]}</text>`;
        }
      }
    }
    for (const day of week.contributionDays) {
      const y = CAL_TOP + day.weekday * STEP;
      cells += `\n  <rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2.5" fill="${
        colours[level(day.contributionCount)]
      }"><title>${esc(day.date)}: ${day.contributionCount}</title></rect>`;
    }
  });

  const dayLabels = [[1, "Mon"], [3, "Wed"], [5, "Fri"]]
    .map(
      ([i, label]) =>
        `\n  <text x="${CAL_LEFT - 8}" y="${CAL_TOP + i * STEP + 9}" text-anchor="end" font-family="${SANS}" font-size="10" fill="${
          c.muted
        }">${label}</text>`
    )
    .join("");

  const legendY = CAL_TOP + 7 * STEP + 24;
  const legendX = width - PAD - 5 * (CELL + 2) - 66;
  const legendCells = colours
    .map(
      (fill, i) =>
        `\n  <rect x="${legendX + 34 + i * (CELL + 2)}" y="${legendY - 9}" width="${CELL}" height="${CELL}" rx="2.5" fill="${fill}"/>`
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${stats.contributions} contributions in the last year">
  <defs>
    <clipPath id="calClip"><rect x="0" y="0" width="${width}" height="${height}" rx="10"/></clipPath>
  </defs>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${c.bg}" stroke="${c.line}"/>
  <g clip-path="url(#calClip)">
    <rect x="0" y="0" width="120" height="3" fill="${c.accent}"/>
    <rect x="123" y="0" width="46" height="3" fill="${c.secondary}"/>
  </g>
  <text x="${PAD}" y="${PAD + 18}" font-family="${SANS}" font-size="11" font-weight="600" letter-spacing="2.4" fill="${
    c.accentStrong
  }">CONTRIBUTIONS</text>
  <text x="${width - PAD}" y="${PAD + 18}" text-anchor="end" font-family="${SANS}" font-size="10.5" fill="${
    c.muted
  }">${stats.contributions.toLocaleString("en-US")} in the last year · updated ${esc(updated)}</text>
  <line x1="${PAD}" y1="${PAD + 32}" x2="${width - PAD}" y2="${PAD + 32}" stroke="${c.line}"/>${monthLabels}${dayLabels}${cells}
  <text x="${legendX}" y="${legendY}" font-family="${SANS}" font-size="10.5" fill="${c.muted}">Less</text>${legendCells}
  <text x="${legendX + 34 + 5 * (CELL + 2) + 4}" y="${legendY}" font-family="${SANS}" font-size="10.5" fill="${
    c.muted
  }">More</text>
</svg>
`;
}

/* --------------------------------------------------------------------- main */

const stats = await collect();
const updated = new Date().toISOString().slice(0, 10);
mkdirSync(OUT_DIR, { recursive: true });
for (const theme of ["light", "dark"]) {
  writeFileSync(resolve(OUT_DIR, `stats-${theme}.svg`), card(stats, theme, updated));
  writeFileSync(resolve(OUT_DIR, `contributions-${theme}.svg`), calendarCard(stats, theme, updated));
}
console.log(`wrote 4 cards to ${OUT_DIR}`);
console.log({ ...stats, weeks: `${stats.weeks.length} weeks` });
