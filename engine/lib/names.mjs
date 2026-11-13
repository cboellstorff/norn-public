// Agent names (META-UX-R1 addendum C): a stable, distinguishable human name per run, deterministic from the run id so it is
// never re-rolled. RUN-n -> ADJECTIVES[n*17 mod 61] + NOUNS[n*23 mod 64]: 61 and 64 are coprime and the strides are units, so
// (Chinese remainder theorem) RUN-1 .. RUN-3903 all differ and neighbours differ in both words; past the table a "-<cycle>"
// suffix keeps names unique. The records lib stores the name in the RUN start event (every launcher, any harness).
export const ADJECTIVES = ['amber', 'ashen', 'azure', 'bold', 'brisk', 'bronze', 'calm', 'cedar', 'clever', 'cobalt', 'coral', 'crimson',
  'dapper', 'dusky', 'eager', 'early', 'fern', 'fleet', 'frosty', 'gentle', 'gilded', 'glad', 'golden', 'granite', 'hazel', 'honest',
  'indigo', 'ivory', 'jade', 'jolly', 'keen', 'lively', 'lucky', 'lunar', 'maple', 'mellow', 'merry', 'misty', 'nimble', 'noble', 'ochre',
  'olive', 'opal', 'plucky', 'quiet', 'rapid', 'rosy', 'russet', 'sable', 'sage', 'silver', 'snowy', 'solar', 'steady', 'sunny', 'swift',
  'tawny', 'teal', 'velvet', 'vivid', 'witty'];
export const NOUNS = ['badger', 'bison', 'crane', 'curlew', 'dipper', 'eagle', 'egret', 'falcon', 'ferret', 'finch', 'fox', 'gannet',
  'gecko', 'grouse', 'hare', 'hawk', 'heron', 'ibis', 'jackal', 'jay', 'kestrel', 'kite', 'koala', 'lark', 'lemur', 'linnet', 'lynx',
  'magpie', 'marten', 'merlin', 'mink', 'moose', 'newt', 'ocelot', 'osprey', 'otter', 'owl', 'panda', 'petrel', 'pika', 'plover', 'puffin',
  'quail', 'raven', 'robin', 'salmon', 'seal', 'shrike', 'skua', 'sparrow', 'stoat', 'swallow', 'stork', 'tern', 'thrush', 'toucan',
  'trout', 'weasel', 'vole', 'walrus', 'wombat', 'wren', 'yak', 'zebra'];
const SPAN = ADJECTIVES.length * NOUNS.length;

/** 'RUN-n' -> 'adjective-noun' (or 'adjective-noun-<cycle>' past 3,903 runs); null for a non-run id. */
export function agentName(id) {
  const m = String(id ?? '').match(/^RUN-(\d+)$/); if (!m) return null;
  const n = Number(m[1]), cycle = Math.floor(n / SPAN) + 1, k = n % SPAN;
  return `${ADJECTIVES[(k * 17) % ADJECTIVES.length]}-${NOUNS[(k * 23) % NOUNS.length]}${cycle > 1 ? '-' + cycle : ''}`;
}
/** A run item's name: the one stored at launch, else (runs recorded before names) the same derived name. */
export const runName = r => r?.data?.name ?? agentName(r?.id);
