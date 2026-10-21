import { ThemeToggle } from '@better-tracker/ui';

import { THEME_STORAGE_KEY } from '../../../fonts';
import GraphGallery from './graph-gallery';

export const metadata = { title: 'UI gallery · graph' };

/* /ui-gallery/graph: the "graph" family of @better-tracker/ui with fixture
   props — the /graph page composition (level switch, legend, pan/zoom
   graph, Copy Mermaid) at milestone and issue level, the selection
   slide-over, a top-to-bottom read-only graph and the empty state. */
export default function GraphGalleryPage() {
  return (
    <GraphGallery
      themeToggle={<ThemeToggle storageKey={THEME_STORAGE_KEY} />}
    />
  );
}
