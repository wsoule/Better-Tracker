'use client';

import { type ReactNode, useEffect, useRef } from 'react';

import SlideOver from '../shell/slide-over';
import { DEFAULT_TASK_LABELS, isClosedState } from './shared';
import { TaskCrumbs } from './task-crumbs';
import { TaskDetail } from './task-detail';
import styles from './task-detail.module.css';
import type { TaskSlideOverProps } from './types';

/** The nearest ancestor that scrolls vertically (the slide-over's body). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return node;
  }
  return null;
}

/**
 * A task in the shell's slide-over: the drawer's hatched bar carries the
 * breadcrumb and header actions, its h2 the title (or `titleControl`), and
 * TaskDetail (drawer layout, no header of its own) fills the body with
 * sections at h3. Focus, Esc and the phone scrim stay the SlideOver's.
 *
 * When the drawer swaps to another task while open (a relation row opened
 * in place), the body scrolls back to the top and focus that was inside
 * the drawer moves to the panel, so assistive tech announces the new
 * title and Tab starts from the top.
 */
export function TaskSlideOver({
  open,
  onClose,
  closeLabel,
  initialFocusRef,
  ...detail
}: TaskSlideOverProps): ReactNode {
  const contentRef = useRef<HTMLDivElement>(null);
  const shownKey = useRef<string | null>(null);

  useEffect(() => {
    const previous = shownKey.current;
    shownKey.current = open ? detail.taskKey : null;
    const el = contentRef.current;
    if (!open || previous === null || previous === detail.taskKey) return;
    if (el === null) return;
    const scroller = scrollParent(el);
    if (scroller !== null) scroller.scrollTop = 0;
    // Focus that was in the drawer (or was dropped to <body> because the
    // row that had it unmounted) moves to the panel; focus out on the page
    // (a list row that swapped the drawer) stays where it is.
    const panel = el.closest<HTMLElement>('[role="dialog"]');
    const active = document.activeElement;
    if (
      panel !== null &&
      (active === null || active === document.body || panel.contains(active))
    ) {
      panel.focus();
    }
  }, [open, detail.taskKey]);

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      closeLabel={closeLabel}
      initialFocusRef={initialFocusRef}
      title={
        // A host's title editor goes in the drawer's heading as is; plain
        // titles read in their own direction and go quiet once closed,
        // like the page layout's.
        detail.titleControl !== undefined &&
        detail.titleControl !== null &&
        detail.titleControl !== false ? (
          detail.titleControl
        ) : (
          <span
            dir="auto"
            className={
              isClosedState(detail.status.kind) ? styles.closedTitle : undefined
            }
            data-closed={isClosedState(detail.status.kind) ? 'true' : undefined}
          >
            {detail.title}
          </span>
        )
      }
      breadcrumb={
        <TaskCrumbs
          breadcrumb={detail.breadcrumb}
          taskKey={detail.taskKey}
          label={detail.labels?.breadcrumb ?? DEFAULT_TASK_LABELS.breadcrumb}
        />
      }
      actions={detail.headerActions}
    >
      <div ref={contentRef}>
        <TaskDetail
          {...detail}
          layout="drawer"
          header={false}
          headingLevel={2}
        />
      </div>
    </SlideOver>
  );
}
