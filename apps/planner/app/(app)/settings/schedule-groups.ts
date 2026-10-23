import {
  TUNING_FIELDS,
  type TuningField,
  type TuningNumberKey,
} from '../../../lib/adapters/settings';

/* Settings → Schedule in Gr8r's settings layout groups its rows under
   small headings: the timezone (Time), the tuning numbers (Risk and
   warnings; My week and the timeline) and the active project statuses
   (Projects). The groups are presentation only, kept beside the form so
   the adapter's fields and their order stay as they are; the guest's
   read-only rows use the same headings. */

export const SCHEDULE_TIME_GROUP = 'Time';
export const SCHEDULE_PROJECTS_GROUP = 'Projects';

const TUNING_GROUPS: readonly {
  title: string;
  keys: readonly TuningNumberKey[];
}[] = [
  {
    title: 'Risk and warnings',
    keys: ['warnLeadDays', 'stallDays', 'paceWindowDays', 'overdueRepeatDays'],
  },
  {
    title: 'My week and the timeline',
    keys: ['newBadgeDays', 'timelineDaysBack', 'timelineDaysAhead'],
  },
];

/** A field no group names (one added to the adapter later) still shows,
    under this heading. */
const OTHER_GROUP = 'Other numbers';

/** The heading a tuning number sits under. */
export function tuningGroupTitle(key: string): string {
  return (
    TUNING_GROUPS.find((group) =>
      (group.keys as readonly string[]).includes(key)
    )?.title ?? OTHER_GROUP
  );
}

/** TUNING_FIELDS under their headings, in heading order and, within one,
    in the adapter's order; empty headings are left out. */
export function tuningFieldGroups(): {
  title: string;
  fields: TuningField[];
}[] {
  const titles = [...TUNING_GROUPS.map((group) => group.title), OTHER_GROUP];
  return titles
    .map((title) => ({
      title,
      fields: TUNING_FIELDS.filter(
        (field) => tuningGroupTitle(field.key) === title
      ),
    }))
    .filter((group) => group.fields.length > 0);
}

/** The heading of one of scheduleReadOnlyRows' rows (by its id). */
export function scheduleRowGroup(id: string): string {
  if (id === 'timezone') return SCHEDULE_TIME_GROUP;
  if (id === 'statuses') return SCHEDULE_PROJECTS_GROUP;
  return tuningGroupTitle(id);
}
