'use client';

import type { TaskRowData } from '@better-tracker/ui';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type { IssueListPageModel } from '../../../../lib/adapters/issue-list';
import type {
  IssueChange,
  RowMenuAction,
  RowMenuStage,
} from '../../../../lib/adapters/issue-moves';
import { type MoveTargets, RowMenu } from './issue-row-actions';
import type { IssueListOptionsState } from './use-issue-list-options';

/** Which row's "…" menu is open, at which stage, and where: under the
    "…" button (point null), or at the pointer of a right-click. */
export interface MenuState {
  rowId: string;
  stage: RowMenuStage;
  open: boolean;
  point: { x: number; y: number } | null;
  /** A row key (m, a, s, p) on the row's title opened it: Esc or a choice
      puts focus back on that title, not on the "…" button. */
  fromKey: boolean;
}

type MenuUpdate =
  | MenuState
  | null
  | ((current: MenuState | null) => MenuState | null);

/** The open row menu, outside React state: each row's menu slot reads
    only its own row's entry, so opening one menu redraws that row, not
    the whole list. */
export interface RowMenuStore {
  get: () => MenuState | null;
  set: (next: MenuUpdate) => void;
  subscribe: (listener: () => void) => () => void;
}

/** One RowMenuStore for the life of the screen. */
export function useRowMenuStore(): RowMenuStore {
  const [store] = useState<RowMenuStore>(() => {
    let menu: MenuState | null = null;
    const listeners = new Set<() => void>();
    return {
      get: () => menu,
      set(next) {
        const value = typeof next === 'function' ? next(menu) : next;
        if (value === menu) return;
        menu = value;
        for (const listener of listeners) listener();
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  });
  return store;
}

/** The list's selection, read by the one row whose menu is open (its
    menu acts on the selection when the row is in it). */
export const SelectionContext = createContext<ReadonlySet<string>>(new Set());

// Layout effects do nothing on the server; this keeps React quiet there.
const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * A function that keeps one identity for the life of the component and
 * always runs the latest render's `fn`. For callbacks the list's rows
 * call on an event (a menu choice, a drop), so that passing them never
 * redraws a row.
 */
export function useEventCallback<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  const ref = useRef(fn);
  useClientLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/** A row's title (its link, or its button without an href). */
export function rowTitle(rowId: string): HTMLElement | null {
  const row = `[data-nav-item="row"][data-row-id="${CSS.escape(rowId)}"]`;
  return document.querySelector<HTMLElement>(
    `${row} [data-nav-target] > a, ${row} [data-nav-target] > button`
  );
}

/** The issues a row's menu or keys act on: the selection when the row
    is in it (and holds more than the row), else the row. */
export function targetsOf(
  selected: ReadonlySet<string>,
  rowId: string,
  rowFacts: IssueListPageModel['rowFacts']
): MoveTargets {
  const ids =
    selected.has(rowId) && selected.size > 1 ? [...selected] : [rowId];
  return {
    ids,
    facts: ids.map((id) => rowFacts[id]).filter((f) => f !== undefined),
  };
}

interface RowMenuSlotProps {
  row: TaskRowData;
  menus: RowMenuStore;
  rowFacts: IssueListPageModel['rowFacts'];
  readOnly: boolean;
  canWriteLinear: boolean;
  optionsState: IssueListOptionsState;
  today: string;
  viewerId: string;
  /** A menu item that is not a field change (open, copy link, …). */
  onAction: (action: RowMenuAction, row: TaskRowData) => void;
  /** A field change chosen in a stage of the row's menu. */
  onPick: (rowId: string, change: IssueChange) => void;
}

/**
 * A row's "…" cell (TaskGroupTable's rowActions). It follows the open
 * menu through the store, so only the row whose menu opens, moves stage
 * or closes redraws; the row whose menu it is also reads the selection,
 * which its menu acts on.
 */
export function RowMenuSlot(props: RowMenuSlotProps): ReactNode {
  const { menus, row } = props;
  const rowId = row.id;
  const menu = useSyncExternalStore(
    menus.subscribe,
    () => {
      const current = menus.get();
      return current !== null && current.rowId === rowId ? current : null;
    },
    () => null
  );
  return menu === null ? (
    <RowMenuView {...props} menu={null} targets={{ ids: [rowId], facts: [] }} />
  ) : (
    <OpenRowMenu {...props} menu={menu} />
  );
}

/** The slot of the row whose menu it is: its targets follow the
    selection. */
function OpenRowMenu(props: RowMenuSlotProps & { menu: MenuState }): ReactNode {
  const selected = useContext(SelectionContext);
  return (
    <RowMenuView
      {...props}
      targets={targetsOf(selected, props.row.id, props.rowFacts)}
    />
  );
}

function RowMenuView({
  row,
  menu,
  targets,
  menus,
  rowFacts,
  readOnly,
  canWriteLinear,
  optionsState,
  today,
  viewerId,
  onAction,
  onPick,
}: RowMenuSlotProps & {
  menu: MenuState | null;
  targets: MoveTargets;
}): ReactNode {
  const rowId = row.id;
  return (
    <RowMenu
      row={row}
      facts={rowFacts[rowId]}
      targets={targets}
      stage={menu === null ? 'menu' : menu.stage}
      open={menu !== null && menu.open}
      anchorPoint={menu === null ? null : menu.point}
      returnFocus={
        menu !== null && menu.fromKey ? () => rowTitle(rowId) : undefined
      }
      onOpen={() =>
        menus.set({
          rowId,
          stage: 'menu',
          open: true,
          point: null,
          fromKey: false,
        })
      }
      onClose={() =>
        menus.set((current) =>
          current === null || current.rowId !== rowId
            ? current
            : { ...current, open: false }
        )
      }
      onStage={(stage) =>
        menus.set((current) => ({
          rowId,
          stage,
          open: true,
          point: current?.rowId === rowId ? current.point : null,
          fromKey: current?.rowId === rowId ? current.fromKey : false,
        }))
      }
      onAction={(action) => onAction(action, row)}
      onPick={(change) => onPick(rowId, change)}
      readOnly={readOnly}
      canWriteLinear={canWriteLinear}
      optionsState={optionsState}
      today={today}
      viewerId={viewerId}
    />
  );
}
