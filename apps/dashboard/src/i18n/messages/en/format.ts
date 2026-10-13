/** English source strings for 'format' (keys are prefixed 'format.'): dates, durations and sizes. */
export const format = {
  'format.today': 'Today',
  'format.yesterday': 'Yesterday',
  'format.justNow': 'just now',
  'format.duration.s': '{s}s',
  'format.duration.ms': '{m}m {s}s',
  'format.duration.hm': '{h}h {m}m',
  'format.duration.dh': '{d}d {h}h',
  'format.durationLong.hours': '{n, plural, one {# hour} other {# hours}}',
  'format.durationLong.minutes': '{n, plural, one {# minute} other {# minutes}}',
  'format.durationLong.seconds': '{n, plural, one {# second} other {# seconds}}',
  'format.durationLong.joiner': ' ',
  'format.bytes.b': '{n} B',
  'format.bytes.kb': '{n} KB',
  'format.bytes.mb': '{n} MB',
} satisfies Record<string, string>;
