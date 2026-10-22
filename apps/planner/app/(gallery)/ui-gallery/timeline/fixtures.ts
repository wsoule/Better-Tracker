import type {
  TimelineBar,
  TimelineDependency,
  TimelineGroup,
  UiStatus,
} from '@better-tracker/ui';

// Fixture props for /ui-gallery/timeline: the same fictional workspace as
// the tasks gallery, on Wednesday, October 21, 2026. Two initiatives plus
// "No initiative", eight projects: an overdue next milestone, an at-risk
// 3/7 with two days left, missing-input bars, done bars in the past, an
// inactive project, a project with no lead, undated milestones, a weight
// tag and a dependency risk chain. Shapes only; nothing here is computed
// by the engine.

export const TODAY = '2026-10-21';
export const WINDOW_START = '2026-09-21';
export const WINDOW_END = '2027-01-17';

const STATUS_LABEL: Record<UiStatus, string> = {
  done: 'Complete',
  on_track: 'On track',
  at_risk: 'At risk',
  overdue: 'Overdue',
  missing: 'Missing input',
};

function bar(
  id: string,
  label: string,
  start: string,
  end: string,
  status: UiStatus,
  extra: Partial<TimelineBar> = {}
): TimelineBar {
  return {
    id,
    label,
    start,
    end,
    status,
    statusLabel: STATUS_LABEL[status],
    ...extra,
  };
}

export const GROUPS: TimelineGroup[] = [
  {
    id: 'ini-payments',
    label: 'Payments platform',
    lanes: [
      {
        id: 'p-atlas',
        label: 'Atlas migration',
        href: '/timeline?project=p-atlas',
        sublabel: 'Pat Lee',
        bars: [
          bar(
            'm-atlas-kickoff',
            'Kickoff',
            '2026-08-03',
            '2026-08-28',
            'done',
            {
              progressLabel: '3/3',
            }
          ),
          bar(
            'm-atlas-schema',
            'Schema freeze',
            '2026-08-28',
            '2026-09-25',
            'done',
            { progressLabel: '6/6' }
          ),
          bar(
            'm-atlas-dual',
            'Dual-write',
            '2026-09-25',
            '2026-10-08',
            'done',
            {
              progressLabel: '9/9',
            }
          ),
          bar(
            'm-atlas-rehearsal',
            'Cutover rehearsal',
            '2026-10-08',
            '2026-10-19',
            'overdue',
            { progressLabel: '4/7', tags: ['Next'], editable: true }
          ),
          bar(
            'm-atlas-cutover',
            'Cutover',
            '2026-10-19',
            '2026-11-06',
            'on_track',
            {
              progressLabel: '0/5',
              editable: true,
            }
          ),
          bar(
            'm-atlas-decom',
            'Decommission legacy ledger',
            '2026-11-06',
            '2026-12-04',
            'on_track',
            { progressLabel: '0/3', editable: true }
          ),
        ],
        undated: [],
      },
      {
        id: 'p-beacon',
        label: 'Beacon',
        href: '/timeline?project=p-beacon',
        sublabel: 'Sam Ortiz',
        bars: [
          bar(
            'm-beacon-private',
            'Private beta',
            '2026-09-21',
            '2026-10-02',
            'done',
            { progressLabel: '8/8' }
          ),
          bar(
            'm-beacon-public',
            'Public beta',
            '2026-10-02',
            '2026-10-23',
            'at_risk',
            { progressLabel: '3/7', tags: ['Next', '↑2'], editable: true }
          ),
          bar(
            'm-beacon-ga',
            'General availability',
            '2026-10-23',
            '2026-11-20',
            'on_track',
            { progressLabel: '0/9', editable: true }
          ),
        ],
        undated: [
          {
            id: 'm-beacon-pricing',
            label: 'Pricing page',
            status: 'missing',
            statusLabel: 'No target date',
          },
        ],
      },
      {
        id: 'p-ledger',
        label: 'Ledger API',
        href: '/timeline?project=p-ledger',
        sublabel: 'No lead',
        sublabelTone: 'warning',
        bars: [
          bar(
            'm-ledger-v2',
            'v2 endpoints',
            '2026-09-28',
            '2026-11-02',
            'missing',
            {
              progressLabel: '2/11',
              tags: ['Next'],
              missing: 'Missing: done means',
              editable: true,
            }
          ),
          bar(
            'm-ledger-sdk',
            'SDK release',
            '2026-11-02',
            '2026-12-01',
            'missing',
            {
              progressLabel: '0/4',
              missing: 'Missing: project lead',
              editable: true,
            }
          ),
        ],
        undated: [],
      },
    ],
  },
  {
    id: 'ini-growth',
    label: 'Growth',
    lanes: [
      {
        id: 'p-cobalt',
        label: 'Cobalt',
        href: '/timeline?project=p-cobalt',
        sublabel: 'Ana Ruiz',
        bars: [
          bar(
            'm-cobalt-csv',
            'CSV export',
            '2026-10-05',
            '2026-10-22',
            'on_track',
            { progressLabel: '5/6', tags: ['Next'], editable: true }
          ),
          bar(
            'm-cobalt-invoices',
            'Invoices v2',
            '2026-10-22',
            '2026-10-26',
            'on_track',
            { progressLabel: '1/4', editable: true }
          ),
          bar(
            'm-cobalt-dunning',
            'Dunning emails',
            '2026-10-26',
            '2026-12-11',
            'on_track',
            { progressLabel: '0/6', editable: true }
          ),
        ],
        undated: [],
      },
      {
        id: 'p-echo',
        label: 'Echo',
        href: '/timeline?project=p-echo',
        sublabel: 'Kim Park',
        bars: [
          bar(
            'm-echo-handover',
            'Pilot customer handover',
            '2026-09-30',
            '2026-10-24',
            'on_track',
            { progressLabel: '6/9', tags: ['Next'], editable: true }
          ),
          bar(
            'm-echo-onboarding',
            'Self-serve onboarding',
            '2026-10-24',
            '2026-12-18',
            'missing',
            {
              progressLabel: '0/0',
              missing: 'Missing: issues',
              editable: true,
            }
          ),
        ],
        undated: [],
      },
      {
        id: 'p-delta',
        label: 'Delta',
        href: '/timeline?project=p-delta',
        sublabel: 'Inactive · Lee Chen',
        muted: true,
        bars: [
          bar(
            'm-delta-archive',
            'Archive exports',
            '2026-09-14',
            '2026-10-01',
            'done',
            { progressLabel: '4/4' }
          ),
          bar(
            'm-delta-retention',
            'Retention policy',
            '2026-10-01',
            '2026-11-30',
            'on_track',
            { progressLabel: '1/6' }
          ),
        ],
        undated: [],
      },
    ],
  },
  {
    id: 'ini-none',
    label: 'No initiative',
    lanes: [
      {
        id: 'p-foundry',
        label: 'Foundry',
        href: '/timeline?project=p-foundry',
        sublabel: 'Pat Lee',
        bars: [
          bar(
            'm-foundry-tokens',
            'Design tokens',
            '2026-09-21',
            '2026-09-30',
            'done',
            { progressLabel: '12/12' }
          ),
          bar(
            'm-foundry-audit',
            'Component audit',
            '2026-09-30',
            '2026-11-13',
            'on_track',
            { progressLabel: '4/10', tags: ['Next'], editable: true }
          ),
          bar(
            'm-foundry-platform',
            'Platform 2.0',
            '2026-11-13',
            '2027-02-12',
            'on_track',
            { progressLabel: '0/14', editable: true }
          ),
        ],
        undated: [],
      },
      {
        id: 'p-halo',
        label: 'Halo',
        href: '/timeline?project=p-halo',
        sublabel: 'Rin Sato',
        bars: [
          bar(
            'm-halo-prototype',
            'Clickable prototype',
            '2026-10-12',
            '2026-10-30',
            'on_track',
            { progressLabel: '2/5', tags: ['Next'], editable: true }
          ),
          bar(
            'm-halo-usability',
            'Usability study',
            '2026-10-30',
            '2026-10-30',
            'on_track',
            { progressLabel: '0/2', editable: true }
          ),
        ],
        undated: [
          {
            id: 'm-halo-discovery',
            label: 'Discovery interviews',
            status: 'missing',
            statusLabel: 'No target date',
          },
          {
            id: 'm-halo-brief',
            label: 'Launch brief',
            status: 'missing',
            statusLabel: 'No target date',
          },
        ],
      },
    ],
  },
];

export const DEPENDENCIES: TimelineDependency[] = [
  // The risk chain: the overdue rehearsal holds up Beacon's public beta,
  // which holds up Echo's onboarding.
  { from: 'm-atlas-rehearsal', to: 'm-beacon-public', onRiskChain: true },
  { from: 'm-beacon-public', to: 'm-echo-onboarding', onRiskChain: true },
  // Ledger has no lead, so its open issues are unassigned: a risk too.
  { from: 'm-ledger-v2', to: 'm-beacon-ga', onRiskChain: true },
  // Ordinary edges.
  { from: 'm-foundry-audit', to: 'm-atlas-decom', onRiskChain: false },
  { from: 'm-cobalt-csv', to: 'm-echo-handover', onRiskChain: false },
  { from: 'm-halo-prototype', to: 'm-cobalt-dunning', onRiskChain: false },
];

/* What the gallery's fake save does once it "succeeds": move the bar's
   due date, pull the next milestone's start along when it began there,
   and recompute overdue-ness the way the engine would (before today with
   open issues = overdue). */
export function redateFixture(
  groups: TimelineGroup[],
  barId: string,
  newEnd: string
): TimelineGroup[] {
  return groups.map((group) => ({
    ...group,
    lanes: group.lanes.map((lane) => {
      const target = lane.bars.find((b) => b.id === barId);
      if (target === undefined) return lane;
      const oldEnd = target.end;
      return {
        ...lane,
        bars: lane.bars.map((b) => {
          if (b.id === barId) {
            let status = b.status;
            if (status !== 'done' && status !== 'missing') {
              if (newEnd < TODAY) status = 'overdue';
              else if (status === 'overdue') status = 'at_risk';
            }
            return {
              ...b,
              end: newEnd,
              start: b.start > newEnd ? newEnd : b.start,
              status,
              statusLabel: STATUS_LABEL[status],
            };
          }
          if (b.start === oldEnd) {
            return { ...b, start: newEnd > b.end ? b.end : newEnd };
          }
          return b;
        }),
      };
    }),
  }));
}

/** Every milestone by id, for the gallery's "opened" read-out. */
export function findMilestone(
  groups: TimelineGroup[],
  id: string
): { project: string; label: string; detail: string } | null {
  for (const group of groups) {
    for (const lane of group.lanes) {
      for (const b of lane.bars) {
        if (b.id === id) {
          return {
            project: lane.label,
            label: b.label,
            detail: [b.statusLabel, `due ${b.end}`, b.progressLabel, b.missing]
              .filter((part) => part !== undefined)
              .join(' · '),
          };
        }
      }
      for (const u of lane.undated) {
        if (u.id === id) {
          return { project: lane.label, label: u.label, detail: u.statusLabel };
        }
      }
    }
  }
  return null;
}
