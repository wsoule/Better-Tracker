'use client';

import { TaskDetail } from '@better-tracker/ui';

import type { IssueTaskModel } from '../../../../lib/adapters/issue';
import {
  IssueHeaderActions,
  useIssueTaskProps,
} from '../../components/issue-task';
import css from './page.module.css';

/* The issue page's client island: the task view in the page layout
   (properties in a right rail when there is room), with the edit controls
   from components/issue-task.tsx. Relation rows link to the other issue's
   page. */
export default function IssuePageView({ model }: { model: IssueTaskModel }) {
  const props = useIssueTaskProps(model);
  return (
    <div className={css.page}>
      <TaskDetail
        key={model.issueId}
        {...props}
        layout="page"
        headingLevel={1}
        headerActions={<IssueHeaderActions model={model} compact={false} />}
      />
    </div>
  );
}
