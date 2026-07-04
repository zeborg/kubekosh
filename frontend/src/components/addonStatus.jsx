// Shared presentation metadata for addon statuses and targets.
// `tone` maps to a CSS-module class suffix (statusGrey/Green/Amber/Red).

export const STATUS_META = {
  available:      { label: 'Available',  tone: 'Grey'  },
  queued:         { label: 'Queued',     tone: 'Amber', busy: true },
  installing:     { label: 'Installing', tone: 'Amber', busy: true },
  installed:      { label: 'Installed',  tone: 'Green' },
  removing:       { label: 'Removing',   tone: 'Amber', busy: true },
  install_failed: { label: 'Failed',     tone: 'Red'   },
  remove_failed:  { label: 'Remove failed', tone: 'Red' },
}

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.available
}

export function targetLabel(target) {
  return target === 'cluster' ? 'Cluster' : 'OS'
}
