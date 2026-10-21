'use client';

import { Link } from '../lib/link';
import styles from './button.module.css';
import { cx } from './class-names';
import type { ButtonProps } from './types';

/* The system's button: a mono uppercase label in a square box that floods
   the accent on hover (gated off touch). 2px is emphasis, so primary and
   secondary carry a 2px rule; quiet is the bare label for toolbars; danger
   has no red to reach for, so it is the accent as an outline. With href it
   renders through the host's <Link>, so it can sit in any router. */
export function Button(props: ButtonProps) {
  const {
    variant = 'secondary',
    size = 'md',
    icon,
    iconAfter,
    children,
    className,
  } = props;
  const classes = cx(
    styles.button,
    styles[variant],
    styles[size],
    children === undefined || children === null ? styles.iconOnly : undefined,
    className
  );
  const body = (
    <>
      {icon !== undefined ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children !== undefined && children !== null ? (
        <span className={styles.text}>{children}</span>
      ) : null}
      {iconAfter !== undefined ? (
        <span className={styles.icon} aria-hidden="true">
          {iconAfter}
        </span>
      ) : null}
    </>
  );

  if (props.href !== undefined) {
    const external = props.external === true;
    return (
      <Link
        href={props.href}
        className={classes}
        aria-label={props['aria-label']}
        title={props.title}
        onClick={props.onClick}
        target={external ? '_blank' : undefined}
        rel={external ? 'noreferrer noopener' : undefined}
      >
        {body}
        {external ? (
          <span className="srOnly"> (opens in a new tab)</span>
        ) : null}
      </Link>
    );
  }

  return (
    <button
      type={props.type ?? 'button'}
      className={classes}
      disabled={props.disabled}
      onClick={props.onClick}
      aria-label={props['aria-label']}
      aria-pressed={props['aria-pressed']}
      aria-expanded={props['aria-expanded']}
      aria-controls={props['aria-controls']}
      title={props.title}
      data-variant={variant}
    >
      {body}
    </button>
  );
}
