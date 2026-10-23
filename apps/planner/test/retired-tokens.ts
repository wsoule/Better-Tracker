// The pre-Gr8r token names (docs/architecture.md §8.2 "Old token names"):
// the Analytics names the ui package's tokens.css kept as migration
// aliases while the screens moved to the Gr8r tokens, removed once every
// screen and every branch written before the restyle had moved. The style
// tests check that no planner file reads one and that tokens.css declares
// none of them again.

export const RETIRED_TOKENS = [
  '--paper',
  '--ink',
  '--background',
  '--foreground',
  '--muted',
  '--ink-soft',
  '--grey',
  '--grey-2',
  '--grey-2-ink',
  '--grey-3',
  '--grey-4',
  '--tint',
  '--hairline-faint',
  '--hatch',
  '--red-ink',
  '--amber-ink',
  '--amber-ink-strong',
  '--green-ink',
  '--blue-ink',
  '--muted-inverse',
  '--ink-soft-inverse',
  '--hairline-inverse',
  '--ease-out-quint',
  '--ease-out-expo',
] as const;
