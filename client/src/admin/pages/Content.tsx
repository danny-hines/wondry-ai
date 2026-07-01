import { useState } from 'react';
import { Create } from './Create';
import { Pages } from './Pages';

// The "Content" tab: create new content at the top, then the list of everything
// generated (held for review, publish/share/delete, with its est. cost) below.
export function Content() {
  const [v, setV] = useState(0);
  return (
    <>
      <Create onCreated={() => setV((n) => n + 1)} />
      <Pages refreshKey={v} />
    </>
  );
}
