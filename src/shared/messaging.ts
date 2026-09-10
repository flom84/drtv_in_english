// Episode id extraction shared by content + background.
//
// Supported episode URLs on DRTV are only the actual on-demand episode pages:
//   /drtv/se/<slug>_<id>
//   /drtv/episode/<id>
// /drtv/kanal/... is a live channel page, not an episode, and must be ignored.

export function extractEpisodeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("dr.dk")) return null;
    const m =
      u.pathname.match(/\/drtv\/se\/[^/]*_([^/?#]+)/) ??
      u.pathname.match(/\/drtv\/episode\/([^/?#]+)/);
    if (!m) return null;
    const id = m[1] ?? null;
    if (!id) return null;
    const underscore = id.lastIndexOf("_");
    return underscore >= 0 ? id.slice(underscore + 1) : id;
  } catch {
    return null;
  }
}
