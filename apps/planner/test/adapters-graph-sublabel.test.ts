import {
  createFixtureWorkspace,
  createShowcaseWorkspace,
} from '@better-tracker/linear';
import { measureNode } from '@better-tracker/ui';
import { describe, expect, test } from 'bun:test';

import { fitSublabel } from '../lib/adapters/graph';
import { formatDate } from '../lib/format';

// A graph box has one sublabel line, and ui's measureNode cuts a longer
// one at its end. A milestone's line ends in its date, so the planner
// cuts the project name instead (architecture §8.4 "Graph": Canvas).

/** The line a drawn box shows for `sublabel` (every drawn box has a mark). */
function shown(sublabel: string): string {
  return measureNode({
    id: 'm',
    label: 'Milestone',
    sublabel,
    tone: 'default',
    status: 'on_track',
  }).sublabelLine;
}

describe('fitSublabel', () => {
  test('a line that fits is unchanged', () => {
    expect(fitSublabel('Atlas billing migration', 'Oct 20')).toBe(
      'Atlas billing migration · Oct 20'
    );
    expect(shown('Atlas billing migration · Oct 20')).toBe(
      'Atlas billing migration · Oct 20'
    );
  });

  test('a long project name gives way, the date stays whole', () => {
    for (const date of ['Dec 20', 'Jan 1, 2027', 'Dec 20, 2027', 'no date']) {
      const line = fitSublabel('Saffron pricing and plans for teams', date);
      expect(line.endsWith(`… · ${date}`)).toBe(true);
      expect(line.startsWith('Saffron')).toBe(true);
      // The box draws it as is: nothing more is cut.
      expect(shown(line)).toBe(line);
    }
  });

  test('a tail too long to leave room is left to the box', () => {
    const tail = 'a very long tail that fills the line';
    expect(fitSublabel('Project', tail)).toBe(`Project · ${tail}`);
  });

  test('every milestone keeps its date in its box, on any day', () => {
    // Cross-year dates ("Jan 4, 2027") are the longest, and the demo's
    // dates move with today, so a few todays across a year boundary.
    for (const today of ['2026-10-23', '2026-12-07', '2027-03-01']) {
      for (const data of [
        createFixtureWorkspace(today),
        createShowcaseWorkspace(today),
      ]) {
        const projects = new Map(data.projects.map((p) => [p.id, p.name]));
        for (const milestone of data.milestones) {
          const date =
            milestone.targetDate === null
              ? 'no date'
              : formatDate(milestone.targetDate, today);
          const line = fitSublabel(
            projects.get(milestone.projectId) ?? 'No project',
            date
          );
          expect(shown(line)).toBe(line);
          expect(line.endsWith(` · ${date}`)).toBe(true);
        }
      }
    }
  });
});
