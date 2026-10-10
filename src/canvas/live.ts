/**
 * Live-reload client for pages opened outside the design canvas (the split
 * preview's "interact" tab shares the agent instead; this one is for the
 * system browser). Stylesheet changes are swapped in place; anything else
 * reloads the page.
 */

(function live() {
  if (!('EventSource' in window)) return;
  const source = new EventSource('/__wp/events');
  let reloading = false;

  source.onmessage = (event) => {
    let change: { kind: 'css' | 'reload'; paths: string[] };
    try {
      change = JSON.parse(event.data);
    } catch {
      return;
    }
    if (change.kind === 'css') {
      const stamp = String(Date.now());
      document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]').forEach((link) => {
        let url: URL;
        try {
          url = new URL(link.href);
        } catch {
          return;
        }
        if (url.origin !== location.origin) return;
        url.searchParams.set('__v', stamp);
        const fresh = link.cloneNode() as HTMLLinkElement;
        fresh.href = url.toString();
        fresh.addEventListener('load', () => link.remove(), { once: true });
        fresh.addEventListener('error', () => link.remove(), { once: true });
        link.after(fresh);
      });
      return;
    }
    if (reloading) return;
    reloading = true;
    // Coalesce a burst of saves into one reload.
    setTimeout(() => location.reload(), 60);
  };
})();
