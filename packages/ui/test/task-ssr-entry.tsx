import { renderToString } from 'react-dom/server';

import { TaskDetail, type TaskDetailProps, TaskSlideOver } from '../src/index';

// Run by task-ssr.test.tsx in a child `bun run`, which has no happy-dom
// preload: there is no window or document here, exactly like a Next server
// render. TaskDetail and TaskSlideOver must render without touching either.

const props: TaskDetailProps = {
  taskKey: 'ENG-24',
  title: 'Search analytics events',
  href: 'https://linear.app/northwind/issue/ENG-24',
  breadcrumb: [
    { label: 'Beacon search', href: '/timeline?project=beacon' },
    { label: 'ENG-24' },
  ],
  status: { kind: 'unstarted', label: 'Todo' },
  alerts: [{ label: 'Stalled', message: 'In Todo for 9 days.' }],
  properties: [{ label: 'Assignee', value: 'Ana Moreno' }],
  description: {
    text: `<script>alert(1)</script>\n${Array.from(
      { length: 20 },
      (_, i) => `Line ${i + 1}`
    ).join('\n')}`,
    sourceLabel: 'From Linear',
  },
  relations: {
    blockedBy: [
      {
        id: 'eng-23',
        taskKey: 'ENG-23',
        title: 'Typo tolerance',
        href: 'https://linear.app/northwind/issue/ENG-23',
        state: { kind: 'started', label: 'In Progress' },
        assignee: 'Dev Patel',
      },
    ],
    blocks: [],
  },
  activity: [{ id: 'a', at: 'Oct 21', label: 'Flagged as stalled' }],
};

console.log(
  JSON.stringify({
    hasWindow: typeof window !== 'undefined',
    hasDocument: typeof document !== 'undefined',
    page: renderToString(<TaskDetail {...props} layout="page" />),
    drawer: renderToString(
      <TaskSlideOver {...props} open onClose={() => undefined} />
    ),
  })
);
