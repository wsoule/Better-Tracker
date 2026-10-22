import { type ReactNode, useId } from 'react';

import { Link } from '../lib/link';
import AlertStrip from '../shell/alert-strip';
import PropertyList from '../shell/property-list';
import { cx } from '../tasks/class-names';
import { StateGlyph } from '../tasks/task-glyphs';
import {
  DEFAULT_TASK_LABELS,
  Heading,
  isClosedState,
  isExternalHref,
} from './shared';
import { TaskActivityList } from './task-activity-list';
import { TaskCommentList } from './task-comment-list';
import commentStyles from './task-comment-list.module.css';
import { TaskCrumbs } from './task-crumbs';
import { TaskDescription } from './task-description';
import styles from './task-detail.module.css';
import { TaskRelationList } from './task-relation-list';
import { TaskDetailSection } from './task-section';
import type { TaskDetailLabels, TaskDetailProps } from './types';

/** True when a slot was given something to draw. */
function hasNode(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false;
}

/* The key in the status line: a link to the tracker when there is one
   (new tab for http URLs), plain mono text otherwise. */
function TaskKey({
  taskKey,
  href,
  newTabLabel,
}: {
  taskKey: string;
  href: string | undefined;
  newTabLabel: string;
}): ReactNode {
  if (href === undefined) return <span className={styles.key}>{taskKey}</span>;
  const external = isExternalHref(href);
  return (
    <Link
      href={href}
      className={cx(styles.key, styles.keyLink)}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
    >
      {taskKey}
      {external ? (
        <>
          <span aria-hidden="true"> ↗</span>
          <span className="srOnly"> ({newTabLabel})</span>
        </>
      ) : null}
    </Link>
  );
}

/**
 * The content of a task (issue) view, in Gr8r's task-drawer order: a
 * hatched header bar (breadcrumb, actions), the title, a status line (state
 * and key), the alert stack, the host's property sheet and `rail` sections,
 * then Description, Blocked by, Blocks, Comments, Activity and any host
 * sections. `sectionMeta` puts a host's controls (an "+ Add" relation
 * picker, an Edit button) in those sections' headings.
 *
 * `layout="drawer"` is one column for a slide-over or split pane;
 * `layout="page"` puts the properties (and `rail`) in a right rail beside
 * the main column when the view itself is at least 760px wide (a container
 * query, so it works inside a sidebar shell), and stacks below that.
 *
 * Read-only or editable is the host's call: property values, the title
 * and status controls, the rail and the header actions are nodes. Not a client module: with
 * plain data it renders in a server component; only the description's
 * clamp toggle and the activity's "Show all" hydrate.
 */
export function TaskDetail({
  taskKey,
  title,
  titleControl,
  href,
  breadcrumb,
  headerActions,
  status,
  statusMeta,
  alerts,
  properties,
  rail,
  relations,
  onOpenRelation,
  description,
  comments,
  sectionMeta,
  activity,
  activityLimit,
  children,
  layout = 'drawer',
  header = true,
  headingLevel = 2,
  labels: labelOverrides,
  id,
  className,
}: TaskDetailProps): ReactNode {
  const labels: TaskDetailLabels = {
    ...DEFAULT_TASK_LABELS,
    ...labelOverrides,
  };
  const titleId = useId();
  // headingLevel is 1…5, so the sections' level is always 2…6.
  const sectionLevel = (headingLevel + 1) as 2 | 3 | 4 | 5 | 6;
  const closed = isClosedState(status.kind);

  const bar = header ? (
    <div className={styles.bar}>
      <div className={styles.crumb}>
        <TaskCrumbs
          breadcrumb={breadcrumb}
          taskKey={taskKey}
          label={labels.breadcrumb}
        />
      </div>
      {hasNode(headerActions) ? (
        <div className={styles.actions}>{headerActions}</div>
      ) : null}
    </div>
  ) : null;

  const lead = (
    <div className={styles.lead}>
      {header ? (
        // A host's title editor sits inside the heading, so the heading
        // (and the article it names) still reads as the task's title.
        <Heading
          level={headingLevel}
          id={titleId}
          className={styles.title}
          dir={hasNode(titleControl) ? undefined : 'auto'}
        >
          {hasNode(titleControl) ? titleControl : title}
        </Heading>
      ) : null}
      <div className={styles.statusLine}>
        <TaskKey
          taskKey={taskKey}
          href={href}
          newTabLabel={labels.opensInNewTab}
        />
        {hasNode(status.control) ? (
          <span className={styles.control}>{status.control}</span>
        ) : (
          <span className={styles.state} data-kind={status.kind}>
            <StateGlyph kind={status.kind} size={13} />
            {status.label}
          </span>
        )}
        {hasNode(statusMeta) ? (
          <span className={styles.statusMeta}>{statusMeta}</span>
        ) : null}
      </div>
      {alerts !== undefined && alerts.length > 0 ? (
        <div className={styles.alerts}>
          {alerts.map((alert, i) => (
            <AlertStrip
              key={alert.id ?? `${i}:${alert.label}`}
              label={alert.label}
              tone={alert.tone}
              action={alert.action}
            >
              {alert.message}
            </AlertStrip>
          ))}
        </div>
      ) : null}
    </div>
  );

  const propertySheet = (
    <TaskDetailSection
      title={labels.properties}
      headingLevel={sectionLevel}
      hideTitle={layout === 'drawer'}
      className={styles.properties}
    >
      <PropertyList items={properties} label={labels.propertiesList} />
    </TaskDetailSection>
  );

  const sections = (
    <>
      {description !== undefined ? (
        <TaskDetailSection
          title={labels.description}
          headingLevel={sectionLevel}
          meta={sectionMeta?.description}
        >
          {/* Keyed by task: a drawer that swaps tasks starts each one
              collapsed. */}
          <TaskDescription
            key={taskKey}
            {...description}
            emptyLabel={labels.noDescription}
            loadingLabel={labels.loadingDescription}
            errorLabel={labels.error}
            retryLabel={labels.retry}
            showMoreLabel={labels.showMore}
            showLessLabel={labels.showLess}
          />
        </TaskDetailSection>
      ) : null}
      {relations !== undefined ? (
        <>
          <TaskDetailSection
            title={labels.blockedBy}
            headingLevel={sectionLevel}
            count={relations.blockedBy.length}
            meta={sectionMeta?.blockedBy}
          >
            <TaskRelationList
              items={relations.blockedBy}
              label={labels.blockedBy}
              emptyLabel={labels.nothingBlocks}
              onOpen={onOpenRelation}
              externalLabel={labels.external}
              resolvedLabel={labels.resolved}
              unassignedLabel={labels.unassigned}
              newTabLabel={labels.opensInNewTab}
              removeLabel={labels.remove}
              notSavedLabel={labels.notSaved}
            />
          </TaskDetailSection>
          <TaskDetailSection
            title={labels.blocks}
            headingLevel={sectionLevel}
            count={relations.blocks.length}
            meta={sectionMeta?.blocks}
          >
            <TaskRelationList
              items={relations.blocks}
              label={labels.blocks}
              emptyLabel={labels.blocksNothing}
              onOpen={onOpenRelation}
              externalLabel={labels.external}
              resolvedLabel={labels.resolved}
              unassignedLabel={labels.unassigned}
              newTabLabel={labels.opensInNewTab}
              removeLabel={labels.remove}
              notSavedLabel={labels.notSaved}
            />
          </TaskDetailSection>
        </>
      ) : null}
      {comments !== undefined ? (
        <TaskDetailSection
          title={labels.comments}
          headingLevel={sectionLevel}
          count={
            comments.loading === true ||
            (comments.error !== undefined &&
              comments.error !== null &&
              comments.error !== '')
              ? undefined
              : comments.items.length
          }
          meta={sectionMeta?.comments}
        >
          <TaskCommentList
            items={comments.items}
            label={labels.comments}
            emptyLabel={labels.noComments}
            loading={comments.loading}
            loadingLabel={labels.loadingComments}
            error={comments.error}
            errorLabel={labels.error}
            onRetry={comments.onRetry}
            retryLabel={labels.retry}
            openLabel={labels.openComment}
            newTabLabel={labels.opensInNewTab}
          />
          {hasNode(comments.composer) ? (
            <div className={commentStyles.composer}>{comments.composer}</div>
          ) : null}
        </TaskDetailSection>
      ) : null}
      {activity !== undefined ? (
        <TaskDetailSection
          title={labels.activity}
          headingLevel={sectionLevel}
          meta={sectionMeta?.activity}
        >
          <TaskActivityList
            key={taskKey}
            items={activity}
            label={labels.activity}
            emptyLabel={labels.noActivity}
            limit={activityLimit}
            showAllLabel={labels.showAll}
            showFewerLabel={labels.showFewer}
            newTabLabel={labels.opensInNewTab}
          />
        </TaskDetailSection>
      ) : null}
      {children}
    </>
  );

  const Root = header ? 'article' : 'div';
  return (
    <Root
      id={id}
      className={cx(
        styles.detail,
        layout === 'page' ? styles.page : styles.drawer,
        header ? styles.withHeader : undefined,
        className
      )}
      aria-labelledby={header ? titleId : undefined}
      data-layout={layout}
      data-closed={closed ? 'true' : undefined}
    >
      {bar}
      {layout === 'page' ? (
        <div className={styles.grid}>
          <div className={styles.head}>{lead}</div>
          <div className={styles.rail}>
            {propertySheet}
            {rail}
          </div>
          <div className={styles.body}>{sections}</div>
        </div>
      ) : (
        <div className={styles.column}>
          {lead}
          {propertySheet}
          {rail}
          {sections}
        </div>
      )}
    </Root>
  );
}
