// Source adapter: Wikimedia Commons. Searches the Commons image namespace for a
// query, downloads a reasonably-sized thumbnail, validates the type/size, and
// extracts attribution + license from the file metadata. Public API, no key.
const UA = 'Wondry/0.1 (educational kids kiosk; https://github.com/danny-hines/wondry-ai)';
const stripHtml = (s) =>
  String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export default {
  id: 'wikimedia',
  label: 'Wikimedia Commons',
  capabilities:
    'Real photographs and reference images of animals, places, science, nature, history, and objects. Best for factual subjects; not cartoons or fictional/trademarked characters.',

  async resolve(query, { maxBytes = 3_000_000 } = {}) {
    const params = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: query,
      gsrnamespace: '6',
      gsrlimit: '8',
      prop: 'imageinfo',
      iiprop: 'url|mime|size|extmetadata',
      iiurlwidth: '800',
      format: 'json',
      origin: '*',
    });
    const r = await fetch('https://commons.wikimedia.org/w/api.php?' + params, {
      headers: { 'user-agent': UA },
    });
    if (!r.ok) return null;
    const data = await r.json();
    const pages = data && data.query && data.query.pages ? Object.values(data.query.pages) : [];
    pages.sort((a, b) => (a.index || 0) - (b.index || 0)); // search relevance order

    for (const p of pages) {
      const ii = p.imageinfo && p.imageinfo[0];
      if (!ii) continue;
      const mime = ii.mime || '';
      if (!/^image\/(jpeg|png|gif|webp)$/.test(mime)) continue;
      const url = ii.thumburl || ii.url;
      if (!url) continue;
      let buf;
      try {
        const img = await fetch(url, { headers: { 'user-agent': UA } });
        if (!img.ok) continue;
        buf = new Uint8Array(await img.arrayBuffer());
      } catch {
        continue;
      }
      if (maxBytes && buf.byteLength > maxBytes) continue;

      const meta = ii.extmetadata || {};
      const artist = stripHtml(meta.Artist && meta.Artist.value) || 'Wikimedia Commons';
      const license = stripHtml(meta.LicenseShortName && meta.LicenseShortName.value);
      const credit = `${artist}${license ? ', ' + license : ''} (via Wikimedia Commons)`.slice(
        0,
        180,
      );
      const ext = mime.split('/')[1].replace('jpeg', 'jpg');
      return { bytes: buf, mime, ext, credit, license, sourceUrl: ii.descriptionurl || url };
    }
    return null;
  },
};
